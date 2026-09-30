package ice

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"strings"
	"sync/atomic"
	"time"

	"github.com/pion/webrtc/v4"

	"github.com/leyvanah/sozvon/turnserver"
)

type Server struct {
	URLs           []string    `json:"urls"`
	Username       string      `json:"username,omitempty"`
	Credential     interface{} `json:"credential,omitempty"`
	CredentialType string      `json:"credentialType,omitempty"`

	// ClientsOnly offers the server to clients without using it for the
	// server's own side of a connection.  A relay may be reachable from
	// clients over a transport that is bad from where the SFU runs -- UDP
	// from a foreign address into a Russian network is throttled, while
	// the same UDP from clients inside it is fine.  (Sozvon)
	ClientsOnly bool `json:"clientsOnly,omitempty"`
}

func getServer(server Server) (webrtc.ICEServer, error) {
	s := webrtc.ICEServer{
		URLs:       server.URLs,
		Username:   server.Username,
		Credential: server.Credential,
	}
	switch server.CredentialType {
	case "", "password":
		s.CredentialType = webrtc.ICECredentialTypePassword
	case "oauth":
		s.CredentialType = webrtc.ICECredentialTypeOauth
	case "hmac-sha1":
		cred, ok := server.Credential.(string)
		if !ok {
			return webrtc.ICEServer{},
				errors.New("credential is not a string")
		}
		ts := time.Now().Unix() + 86400
		var username string
		if server.Username == "" {
			username = fmt.Sprintf("%d", ts)
		} else {
			username = fmt.Sprintf("%d:%s", ts, server.Username)
		}
		mac := hmac.New(sha1.New, []byte(cred))
		mac.Write([]byte(username))
		buf := strings.Builder{}
		e := base64.NewEncoder(base64.StdEncoding, &buf)
		e.Write(mac.Sum(nil))
		e.Close()
		s.Username = username
		s.Credential = buf.String()
		s.CredentialType = webrtc.ICECredentialTypePassword
	default:
		return webrtc.ICEServer{}, errors.New("unsupported credential type")
	}
	return s, nil
}

var ICEFilename string
var ICERelayOnly bool

type configuration struct {
	conf      webrtc.Configuration
	client    webrtc.Configuration // what clients are told (Sozvon)
	timestamp time.Time
}

var conf atomic.Value

func Update() *configuration {
	now := time.Now()
	var cf webrtc.Configuration
	var clientServers []webrtc.ICEServer

	found := false
	if ICEFilename != "" {
		found = true
		file, err := os.Open(ICEFilename)
		if err != nil {
			if !errors.Is(err, os.ErrNotExist) {
				log.Printf("Open %v: %v", ICEFilename, err)
			} else {
				found = false
			}
		} else {
			defer file.Close()
			d := json.NewDecoder(file)
			var servers []Server
			err = d.Decode(&servers)
			if err != nil {
				log.Printf("Get ICE configuration: %v", err)
			}
			for _, s := range servers {
				ss, err := getServer(s)
				if err != nil {
					log.Printf("parse ICE server: %v", err)
					continue
				}
				clientServers = append(clientServers, ss)
				if !s.ClientsOnly {
					cf.ICEServers = append(cf.ICEServers, ss)
				}
			}
		}
	}

	err := turnserver.StartStop(!found)
	if err != nil {
		log.Printf("TURN: %v", err)
	}

	cf.ICEServers = append(cf.ICEServers, turnserver.ICEServers()...)
	clientServers = append(clientServers, turnserver.ICEServers()...)

	if ICERelayOnly {
		cf.ICETransportPolicy = webrtc.ICETransportPolicyRelay
	}

	client := cf
	client.ICEServers = clientServers

	iceConf := configuration{
		conf:      cf,
		client:    client,
		timestamp: now,
	}
	conf.Store(&iceConf)
	return &iceConf
}

func current() *configuration {
	conf, ok := conf.Load().(*configuration)
	if !ok || time.Since(conf.timestamp) > 5*time.Minute {
		conf = Update()
	} else if time.Since(conf.timestamp) > 2*time.Minute {
		go Update()
	}
	return conf
}

// ICEConfiguration returns the configuration for the server's own side of
// a connection.
func ICEConfiguration() *webrtc.Configuration {
	return &current().conf
}

// ClientICEConfiguration returns the configuration to hand to clients.  It
// differs from ICEConfiguration by the servers marked clientsOnly.  (Sozvon)
func ClientICEConfiguration() *webrtc.Configuration {
	return &current().client
}

func RelayTest(timeout time.Duration) (time.Duration, error) {

	conf := ICEConfiguration()
	conf2 := *conf
	conf2.ICETransportPolicy = webrtc.ICETransportPolicyRelay

	var s webrtc.SettingEngine
	s.SetHostAcceptanceMinWait(0)
	s.SetSrflxAcceptanceMinWait(0)
	s.SetPrflxAcceptanceMinWait(0)
	s.SetRelayAcceptanceMinWait(0)
	api := webrtc.NewAPI(webrtc.WithSettingEngine(s))

	pc1, err := api.NewPeerConnection(conf2)
	if err != nil {
		return 0, err
	}
	defer pc1.Close()
	pc2, err := api.NewPeerConnection(*conf)
	if err != nil {
		return 0, err
	}
	defer pc2.Close()

	pc1.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c != nil {
			pc2.AddICECandidate(c.ToJSON())
		}
	})
	pc2.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c != nil {
			pc1.AddICECandidate(c.ToJSON())
		}
	})

	d1, err := pc1.CreateDataChannel("loopback", nil)
	if err != nil {
		return 0, err
	}

	ch1 := make(chan error, 1)
	d1.OnOpen(func() {
		err := d1.Send([]byte(time.Now().Format(time.RFC3339Nano)))
		if err != nil {
			select {
			case ch1 <- err:
			default:
			}
		}
	})

	offer, err := pc1.CreateOffer(nil)
	if err != nil {
		return 0, err
	}
	err = pc1.SetLocalDescription(offer)
	if err != nil {
		return 0, err
	}
	err = pc2.SetRemoteDescription(*pc1.LocalDescription())
	if err != nil {
		return 0, err
	}
	answer, err := pc2.CreateAnswer(nil)
	if err != nil {
		return 0, err
	}
	err = pc2.SetLocalDescription(answer)
	if err != nil {
		return 0, err
	}
	err = pc1.SetRemoteDescription(*pc2.LocalDescription())
	if err != nil {
		return 0, err
	}

	ch2 := make(chan string, 1)
	pc2.OnDataChannel(func(d2 *webrtc.DataChannel) {
		d2.OnMessage(func(msg webrtc.DataChannelMessage) {
			select {
			case ch2 <- string(msg.Data):
			default:
			}
		})
	})

	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case err := <-ch1:
		return 0, err
	case msg := <-ch2:
		tm, err := time.Parse(time.RFC3339Nano, msg)
		if err != nil {
			return 0, err
		}
		return time.Since(tm), nil
	case <-timer.C:
		return 0, os.ErrDeadlineExceeded
	}
}
