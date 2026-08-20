package turnserver

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"math/big"
	"net"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/pion/turn/v5"
)

func TestSplitTLSAddress(t *testing.T) {
	tests := []struct {
		value string
		host  string
		port  int
		bad   bool
	}{
		{"example.org", "example.org", 5349, false},
		{"example.org:443", "example.org", 443, false},
		{"example.org:5349", "example.org", 5349, false},
		{":443", "", 0, true},
		{"example.org:0", "", 0, true},
		{"example.org:99999", "", 0, true},
		{"example.org:https", "", 0, true},
	}

	for _, test := range tests {
		host, port, err := splitTLSAddress(test.value)
		if test.bad {
			if err == nil {
				t.Errorf("splitTLSAddress(%v): expected error, got %v:%v",
					test.value, host, port)
			}
			continue
		}
		if err != nil {
			t.Errorf("splitTLSAddress(%v): %v", test.value, err)
			continue
		}
		if host != test.host || port != test.port {
			t.Errorf("splitTLSAddress(%v): got %v:%v, expected %v:%v",
				test.value, host, port, test.host, test.port)
		}
	}
}

// selfSigned returns a certificate for "localhost", standing in for the one
// the web server would lend us.
func selfSigned(t *testing.T) *tls.Certificate {
	t.Helper()

	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("GenerateKey: %v", err)
	}

	template := x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: "localhost"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(time.Hour),
		DNSNames:     []string{"localhost"},
		IPAddresses:  []net.IP{net.IPv4(127, 0, 0, 1)},
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}

	der, err := x509.CreateCertificate(
		rand.Reader, &template, &template, &key.PublicKey, key,
	)
	if err != nil {
		t.Fatalf("CreateCertificate: %v", err)
	}

	leaf, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatalf("ParseCertificate: %v", err)
	}

	return &tls.Certificate{
		Certificate: [][]byte{der},
		PrivateKey:  key,
		Leaf:        leaf,
	}
}

// freePort asks the OS for a port that is free right now.
func freePort(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("Listen: %v", err)
	}
	port := l.Addr().(*net.TCPAddr).Port
	l.Close()
	return port
}

// TestTLSListener runs the built-in server with a TLS listener only, then
// allocates on it as a client would: TLS on the wire, TURN inside.  It is
// the whole point of the feature, so it is tested end-to-end rather than by
// inspecting the listener.
func TestTLSListener(t *testing.T) {
	certificate := selfSigned(t)

	oldAddress, oldTLS, oldCert := Address, TLSAddress, Certificate
	t.Cleanup(func() {
		Stop()
		Address, TLSAddress, Certificate = oldAddress, oldTLS, oldCert
	})

	port := freePort(t)
	Address = ""
	TLSAddress = "localhost:" + strconv.Itoa(port)
	Certificate = func(*tls.ClientHelloInfo) (*tls.Certificate, error) {
		return certificate, nil
	}

	err := Start()
	if err != nil {
		t.Fatalf("Start: %v", err)
	}

	// The client is told a turns: URL under the name, not the address:
	// that is what makes the certificate validate.
	servers := ICEServers()
	if len(servers) != 1 || len(servers[0].URLs) != 1 {
		t.Fatalf("ICEServers: got %v", servers)
	}
	expect := "turns:localhost:" + strconv.Itoa(port) + "?transport=tcp"
	if servers[0].URLs[0] != expect {
		t.Errorf("ICEServers: got %v, expected %v",
			servers[0].URLs[0], expect)
	}

	addr := net.JoinHostPort("127.0.0.1", strconv.Itoa(port))
	conn, err := tls.Dial("tcp", addr, &tls.Config{
		ServerName: "localhost",
		// The certificate is generated above, not in any trust store.
		InsecureSkipVerify: true,
	})
	if err != nil {
		t.Fatalf("tls.Dial: %v", err)
	}
	defer conn.Close()

	client, err := turn.NewClient(&turn.ClientConfig{
		TURNServerAddr: addr,
		Username:       servers[0].Username,
		Password:       servers[0].Credential.(string),
		Realm:          "galene.org",
		Conn:           turn.NewSTUNConn(conn),
	})
	if err != nil {
		t.Fatalf("turn.NewClient: %v", err)
	}
	defer client.Close()

	err = client.Listen()
	if err != nil {
		t.Fatalf("client.Listen: %v", err)
	}

	relayed, err := client.Allocate()
	if err != nil {
		t.Fatalf("client.Allocate: %v", err)
	}
	defer relayed.Close()

	if relayed.LocalAddr() == nil {
		t.Errorf("Allocate: no relayed address")
	}
}

// TestTLSListenerLeavesAutoAlone checks that asking for a TLS listener does
// not reopen the cleartext ones on a deployment whose ice-servers.json took
// care to close them: -turn auto must still mean "not when that file
// supplies relays of its own".
func TestTLSListenerLeavesAutoAlone(t *testing.T) {
	certificate := selfSigned(t)

	oldAddress, oldTLS, oldCert := Address, TLSAddress, Certificate
	t.Cleanup(func() {
		Stop()
		Address, TLSAddress, Certificate = oldAddress, oldTLS, oldCert
	})

	port := freePort(t)
	Address = "auto"
	TLSAddress = "localhost:" + strconv.Itoa(port)
	Certificate = func(*tls.ClientHelloInfo) (*tls.Certificate, error) {
		return certificate, nil
	}

	// false: an ice-servers.json is present, so "auto" means off.
	err := StartStop(false)
	if err != nil {
		t.Fatalf("StartStop: %v", err)
	}

	servers := ICEServers()
	if len(servers) != 1 {
		t.Fatalf("ICEServers: got %v", servers)
	}
	for _, u := range servers[0].URLs {
		if !strings.HasPrefix(u, "turns:") {
			t.Errorf("ICEServers: got cleartext %v alongside TLS", u)
		}
	}
	if len(servers[0].URLs) != 1 {
		t.Errorf("ICEServers: got %v, expected the TLS URL alone",
			servers[0].URLs)
	}
}

// TestTLSListenerNoCertificate checks that a missing certificate fails the
// handshake rather than passing traffic in the clear.
func TestTLSListenerNoCertificate(t *testing.T) {
	oldAddress, oldTLS, oldCert := Address, TLSAddress, Certificate
	t.Cleanup(func() {
		Stop()
		Address, TLSAddress, Certificate = oldAddress, oldTLS, oldCert
	})

	port := freePort(t)
	Address = ""
	TLSAddress = "localhost:" + strconv.Itoa(port)
	Certificate = nil

	err := Start()
	if err != nil {
		t.Fatalf("Start: %v", err)
	}

	addr := net.JoinHostPort("127.0.0.1", strconv.Itoa(port))
	conn, err := tls.Dial("tcp", addr, &tls.Config{
		ServerName:         "localhost",
		InsecureSkipVerify: true,
	})
	if err == nil {
		conn.Close()
		t.Errorf("tls.Dial: succeeded with no certificate")
	}
}
