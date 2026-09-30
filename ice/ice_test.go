package ice

import (
	"crypto/hmac"
	"crypto/sha1"
	"encoding/base64"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"

	"github.com/leyvanah/sozvon/turnserver"
)

func TestPassword(t *testing.T) {
	s := Server{
		URLs:       []string{"turn:turn.example.org"},
		Username:   "jch",
		Credential: "secret",
	}

	ss := webrtc.ICEServer{
		URLs:       []string{"turn:turn.example.org"},
		Username:   "jch",
		Credential: "secret",
	}

	sss, err := getServer(s)

	if err != nil || !reflect.DeepEqual(sss, ss) {
		t.Errorf("Got %v, expected %v", sss, ss)
	}
}

func TestHMAC(t *testing.T) {
	s := Server{
		URLs:           []string{"turn:turn.example.org"},
		Username:       "jch",
		Credential:     "secret",
		CredentialType: "hmac-sha1",
	}

	ss := webrtc.ICEServer{
		URLs: []string{"turn:turn.example.org"},
	}

	sss, err := getServer(s)

	if !strings.HasSuffix(sss.Username, ":"+s.Username) {
		t.Errorf("username is %v", ss.Username)
	}
	ss.Username = sss.Username

	mac := hmac.New(sha1.New, []byte(s.Credential.(string)))
	mac.Write([]byte(sss.Username))
	buf := strings.Builder{}
	e := base64.NewEncoder(base64.StdEncoding, &buf)
	e.Write(mac.Sum(nil))
	e.Close()
	ss.Credential = buf.String()

	if err != nil || !reflect.DeepEqual(sss, ss) {
		t.Errorf("Got %v, expected %v", sss, ss)
	}
}

func TestICEConfiguration(t *testing.T) {
	ICEFilename = "/tmp/no/such/file"
	turnserver.Address = ""

	conf := ICEConfiguration()
	if conf == nil {
		t.Errorf("conf is nil")
	}
	conf2 := ICEConfiguration()
	if conf2 != conf {
		t.Errorf("conf2 != conf")
	}

	if len(conf.ICEServers) != 0 {
		t.Errorf("len(ICEServers) = %v", len(conf.ICEServers))
	}
}

func TestRelayTest(t *testing.T) {
	ICEFilename = "/tmp/no/such/file"
	turnserver.Address = ""

	_, err := RelayTest(200 * time.Millisecond)
	if err == nil || !os.IsTimeout(err) {
		t.Errorf("Relay test returned %v", err)
	}
}

func TestClientsOnly(t *testing.T) {
	f, err := os.CreateTemp(t.TempDir(), "ice-servers-*.json")
	if err != nil {
		t.Fatal(err)
	}
	f.WriteString(`[
	  {"urls": ["turn:relay.example:3479?transport=udp"],
	   "username": "u", "credential": "c", "clientsOnly": true},
	  {"urls": ["turns:relay.example:5349?transport=tcp"],
	   "username": "u", "credential": "c"}
	]`)
	f.Close()

	saved, savedRelay := ICEFilename, ICERelayOnly
	defer func() {
		ICEFilename, ICERelayOnly = saved, savedRelay
		Update()
	}()
	ICEFilename = f.Name()
	ICERelayOnly = true
	Update()

	urls := func(c *webrtc.Configuration) []string {
		var l []string
		for _, s := range c.ICEServers {
			l = append(l, s.URLs...)
		}
		return l
	}
	server, client := ICEConfiguration(), ClientICEConfiguration()
	if got := urls(server); !reflect.DeepEqual(got,
		[]string{"turns:relay.example:5349?transport=tcp"}) {
		t.Errorf("server uses %v, want the TLS relay only", got)
	}
	if got := urls(client); !reflect.DeepEqual(got, []string{
		"turn:relay.example:3479?transport=udp",
		"turns:relay.example:5349?transport=tcp"}) {
		t.Errorf("clients are offered %v, want both relays", got)
	}
	if server.ICETransportPolicy != webrtc.ICETransportPolicyRelay ||
		client.ICETransportPolicy != webrtc.ICETransportPolicyRelay {
		t.Errorf("relay-only must hold on both sides")
	}
}
