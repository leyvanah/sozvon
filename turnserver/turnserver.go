package turnserver

import (
	"crypto/rand"
	"crypto/tls"
	"encoding/base64"
	"errors"
	"log"
	"net"
	"strconv"
	"strings"
	"sync"

	"github.com/pion/turn/v5"
	"github.com/pion/webrtc/v4"
)

var username string
var password string
var Address string

// TLSAddress makes the built-in server offer TURN over TLS in addition to
// the cleartext listeners.  Unlike Address it is a *name* with an optional
// port, not an address: it is what clients are told to connect to, so it
// must be a name the server's certificate covers.  Empty disables it.
//
// Wrapping the relay in TLS matters where cleartext TURN is recognised on
// the wire: the protocol's magic cookie sits in the first bytes of every
// packet, which is trivially identified by a middlebox.  Pointing this at
// port 443 goes further, making a call look like a request to the same
// host that served the page.  (Sozvon)
var TLSAddress string

// Certificate returns the certificate for the TLS listener.  The web
// server owns certificate loading and renewal and sets this; since it
// starts *after* us (galene.go calls ice.Update before webserver.Serve),
// we read it at handshake time rather than when the listener is built.
// (Sozvon)
var Certificate func(*tls.ClientHelloInfo) (*tls.Certificate, error)

// tlsAddr is the address of the TLS listener.  It is a type of its own so
// that ICEServers can tell it apart from a cleartext TCP listener and
// advertise a turns: URL, and it carries a hostname rather than an IP
// because that is what the client must connect to for the certificate to
// validate.  (Sozvon)
type tlsAddr struct {
	host string
	port int
}

func (a *tlsAddr) Network() string {
	return "tcp"
}

func (a *tlsAddr) String() string {
	return net.JoinHostPort(a.host, strconv.Itoa(a.port))
}

var server struct {
	mu        sync.Mutex
	addresses []net.Addr
	server    *turn.Server
}

func publicAddresses() ([]net.IP, error) {
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return nil, err
	}

	var as []net.IP

	for _, addr := range addrs {
		switch addr := addr.(type) {
		case *net.IPNet:
			a := addr.IP.To4()
			if a == nil {
				continue
			}
			if !a.IsGlobalUnicast() {
				continue
			}
			if a[0] == 10 ||
				a[0] == 172 && a[1] >= 16 && a[1] < 32 ||
				a[0] == 192 && a[1] == 168 {
				continue
			}
			as = append(as, a)
		}
	}
	return as, nil
}

func listener(a net.IP, port int, relay net.IP) (*turn.PacketConnConfig, *turn.ListenerConfig) {
	var pcc *turn.PacketConnConfig
	var lc *turn.ListenerConfig
	s := net.JoinHostPort(a.String(), strconv.Itoa(port))

	var g turn.RelayAddressGenerator
	if relay == nil || relay.IsUnspecified() {
		g = &turn.RelayAddressGeneratorNone{
			Address: a.String(),
		}
	} else {
		g = &turn.RelayAddressGeneratorStatic{
			RelayAddress: relay,
			Address:      a.String(),
		}
	}

	p, err := net.ListenPacket("udp4", s)
	if err == nil {
		pcc = &turn.PacketConnConfig{
			PacketConn:            p,
			RelayAddressGenerator: g,
		}
	} else {
		log.Printf("TURN: listenPacket(%v): %v", s, err)
	}

	l, err := net.Listen("tcp4", s)
	if err == nil {
		lc = &turn.ListenerConfig{
			Listener:              l,
			RelayAddressGenerator: g,
		}
	} else {
		log.Printf("TURN: listen(%v): %v", s, err)
	}

	return pcc, lc
}

// splitTLSAddress parses TLSAddress, a hostname with an optional port.  We
// default to 5349, the registered port for TURN over TLS; a deployment that
// wants the relay to be indistinguishable from web traffic says 443
// explicitly.  (Sozvon)
func splitTLSAddress(a string) (string, int, error) {
	host, port, err := net.SplitHostPort(a)
	if err != nil {
		// no port given: the whole value is the hostname
		return a, 5349, nil
	}
	if host == "" {
		return "", 0, errors.New("TURN over TLS needs a hostname")
	}
	p, err := strconv.Atoi(port)
	if err != nil || p <= 0 || p > 65535 {
		return "", 0, errors.New("bad port for TURN over TLS")
	}
	return host, p, nil
}

// tlsListener builds the TURN-over-TLS listener.  It binds every interface,
// since it is the hostname in TLSAddress that clients connect to, and
// relays from relay, the address that hostname resolves to.  (Sozvon)
func tlsListener(port int, relay net.IP) *turn.ListenerConfig {
	s := net.JoinHostPort("", strconv.Itoa(port))
	l, err := net.Listen("tcp4", s)
	if err != nil {
		log.Printf("TURN: listen(TLS, %v): %v", s, err)
		return nil
	}

	cf := &tls.Config{
		MinVersion: tls.VersionTLS12,
		GetCertificate: func(hello *tls.ClientHelloInfo) (*tls.Certificate, error) {
			get := Certificate
			if get == nil {
				return nil, errors.New(
					"no certificate for TURN over TLS",
				)
			}
			return get(hello)
		},
	}

	return &turn.ListenerConfig{
		Listener: tls.NewListener(l, cf),
		RelayAddressGenerator: &turn.RelayAddressGeneratorStatic{
			RelayAddress: relay,
			Address:      "0.0.0.0",
		},
	}
}

// relayAddress resolves the TLS hostname to the IPv4 address that the
// server relays from.  (Sozvon)
func relayAddress(host string) (net.IP, error) {
	ips, err := net.LookupIP(host)
	if err != nil {
		return nil, err
	}
	for _, ip := range ips {
		if a := ip.To4(); a != nil {
			return a, nil
		}
	}
	return nil, errors.New("no IPv4 address for " + host)
}

func Start() error {
	server.mu.Lock()
	defer server.mu.Unlock()

	if server.server != nil {
		return nil
	}

	if Address == "" && TLSAddress == "" {
		return errors.New("built-in TURN server disabled")
	}

	username = "galene"
	buf := make([]byte, 6)
	_, err := rand.Read(buf)
	if err != nil {
		return err
	}

	buf2 := make([]byte, 8)
	base64.RawStdEncoding.Encode(buf2, buf)
	password = string(buf2)

	var lcs []turn.ListenerConfig
	var pccs []turn.PacketConnConfig

	if Address != "" {
		ad := Address
		if Address == "auto" {
			ad = ":1194"
		}
		addr, err := net.ResolveUDPAddr("udp4", ad)
		if err != nil {
			return err
		}

		if addr.IP != nil && !addr.IP.IsUnspecified() {
			a := addr.IP.To4()
			if a == nil {
				return errors.New("couldn't parse address")
			}
			pcc, lc := listener(net.IP{0, 0, 0, 0}, addr.Port, a)
			if pcc != nil {
				pccs = append(pccs, *pcc)
				server.addresses = append(server.addresses, &net.UDPAddr{
					IP:   a,
					Port: addr.Port,
				})
			}
			if lc != nil {
				lcs = append(lcs, *lc)
				server.addresses = append(server.addresses, &net.TCPAddr{
					IP:   a,
					Port: addr.Port,
				})
			}
		} else {
			as, err := publicAddresses()
			if err != nil {
				return err
			}

			if len(as) == 0 {
				return errors.New("no public addresses")
			}

			for _, a := range as {
				pcc, lc := listener(a, addr.Port, nil)
				if pcc != nil {
					pccs = append(pccs, *pcc)
					server.addresses = append(server.addresses,
						&net.UDPAddr{
							IP:   a,
							Port: addr.Port,
						},
					)
				}
				if lc != nil {
					lcs = append(lcs, *lc)
					server.addresses = append(server.addresses,
						&net.TCPAddr{
							IP:   a,
							Port: addr.Port,
						},
					)
				}
			}
		}

	}

	// TURN over TLS.  Advertised under a name rather than an address, so
	// that the certificate validates in the client.  (Sozvon)
	if TLSAddress != "" {
		host, port, err := splitTLSAddress(TLSAddress)
		if err != nil {
			return err
		}
		relay, err := relayAddress(host)
		if err != nil {
			return err
		}
		lc := tlsListener(port, relay)
		if lc != nil {
			lcs = append(lcs, *lc)
			server.addresses = append(server.addresses,
				&tlsAddr{host: host, port: port},
			)
		}
	}

	if len(pccs) == 0 && len(lcs) == 0 {
		return errors.New("couldn't establish any listeners")
	}

	var bound []string
	for _, a := range server.addresses {
		bound = append(bound, a.String())
	}
	log.Printf("Starting built-in TURN server on %v",
		strings.Join(bound, ", "))

	server.server, err = turn.NewServer(turn.ServerConfig{
		Realm: "galene.org",
		AuthHandler: func(ra *turn.RequestAttributes) (string, []byte, bool) {
			if ra.Username != username || ra.Realm != "galene.org" {
				return "", nil, false
			}
			return ra.Username, turn.GenerateAuthKey(ra.Username, ra.Realm, password), true
		},
		ListenerConfigs:   lcs,
		PacketConnConfigs: pccs,
	})

	if err != nil {
		server.addresses = nil
		return err
	}

	return nil
}

func ICEServers() []webrtc.ICEServer {
	server.mu.Lock()
	defer server.mu.Unlock()

	if len(server.addresses) == 0 {
		return nil
	}

	var urls []string
	for _, a := range server.addresses {
		switch a := a.(type) {
		case *net.UDPAddr:
			urls = append(urls, "turn:"+a.String())
		case *net.TCPAddr:
			urls = append(urls, "turn:"+a.String()+"?transport=tcp")
		case *tlsAddr:
			urls = append(urls, "turns:"+a.String()+"?transport=tcp")
		default:
			log.Printf("unexpected TURN address %T", a)
		}
	}

	return []webrtc.ICEServer{
		{
			URLs:       urls,
			Username:   username,
			Credential: password,
		},
	}

}

func Stop() error {
	server.mu.Lock()
	defer server.mu.Unlock()

	server.addresses = nil
	if server.server == nil {
		return nil
	}
	log.Printf("Stopping built-in TURN server")
	err := server.server.Close()
	server.server = nil
	return err
}

func StartStop(start bool) error {
	// A TLS listener is never automatic: asking for one is a deliberate
	// choice, and it is usually meant to sit *alongside* whatever
	// data/ice-servers.json supplies rather than to replace it.  Say
	// -turn "" to run the TLS listener on its own.  (Sozvon)
	if TLSAddress != "" {
		return Start()
	}
	if Address == "auto" {
		if start {
			return Start()
		}
		return Stop()
	} else if Address == "" {
		return Stop()
	}
	return Start()
}
