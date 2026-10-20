package turnserver

import (
	"net"
	"strconv"
	"testing"
	"time"

	"github.com/pion/turn/v5"
)

func TestIsInternal(t *testing.T) {
	internal := []string{"127.0.0.1", "10.1.2.3", "172.16.0.1",
		"192.168.0.1", "169.254.1.1", "100.64.0.2", "0.0.0.0",
		"224.0.0.1", "::1", "fd00::1", "fe80::1"}
	for _, s := range internal {
		if !isInternal(net.ParseIP(s)) {
			t.Errorf("%v: not internal", s)
		}
	}
	for _, s := range []string{"8.8.8.8", "203.0.113.7", "100.128.0.1",
		"2001:4860:4860::8888"} {
		if isInternal(net.ParseIP(s)) {
			t.Errorf("%v: internal", s)
		}
	}
}

// ownIPv4 is a non-loopback IPv4 address of this machine: what the SFU's
// candidates are, and so the one private destination the relay must keep.
func ownIPv4(t *testing.T) net.IP {
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		t.Fatal(err)
	}
	for _, a := range addrs {
		if n, ok := a.(*net.IPNet); ok && !n.IP.IsLoopback() &&
			!n.IP.IsLinkLocalUnicast() && n.IP.To4() != nil {
			return n.IP.To4()
		}
	}
	t.Skip("no IPv4 address besides loopback")
	return nil
}

func received(t *testing.T, l net.PacketConn) bool {
	t.Helper()
	l.SetReadDeadline(time.Now().Add(time.Second))
	buf := make([]byte, 100)
	n, _, err := l.ReadFrom(buf)
	return err == nil && string(buf[:n]) == "hello"
}

// TestRelayDestinations runs the relay as a client would use it, and asks
// it to send where a participant could try to: our own media port, another
// port here, loopback, an address on the home network, and the internet.
func TestRelayDestinations(t *testing.T) {
	own := ownIPv4(t)

	media, err := net.ListenPacket("udp4", net.JoinHostPort(own.String(), "0"))
	if err != nil {
		t.Fatal(err)
	}
	defer media.Close()
	other, err := net.ListenPacket("udp4", net.JoinHostPort(own.String(), "0"))
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	mediaPort := media.LocalAddr().(*net.UDPAddr).Port

	oldAddress, oldTLS, oldMin, oldMax :=
		Address, TLSAddress, MediaPortMin, MediaPortMax
	t.Cleanup(func() {
		Stop()
		Address, TLSAddress = oldAddress, oldTLS
		MediaPortMin, MediaPortMax = oldMin, oldMax
	})
	port := freePort(t)
	Address = net.JoinHostPort(own.String(), strconv.Itoa(port))
	TLSAddress = ""
	MediaPortMin, MediaPortMax = uint16(mediaPort), uint16(mediaPort)
	if err := Start(); err != nil {
		t.Fatalf("Start: %v", err)
	}
	servers := ICEServers()
	server := net.JoinHostPort(own.String(), strconv.Itoa(port))

	conn, err := net.ListenPacket("udp4", "0.0.0.0:0")
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	client, err := turn.NewClient(&turn.ClientConfig{
		TURNServerAddr: server,
		Username:       servers[0].Username,
		Password:       servers[0].Credential.(string),
		Realm:          "galene.org",
		Conn:           conn,
	})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	if err := client.Listen(); err != nil {
		t.Fatal(err)
	}
	relay, err := client.Allocate()
	if err != nil {
		t.Fatalf("Allocate: %v", err)
	}
	defer relay.Close()

	// Our own media port: what the relay is for.
	if _, err := relay.WriteTo([]byte("hello"), media.LocalAddr()); err != nil {
		t.Fatalf("to our media port: %v", err)
	}
	if !received(t, media) {
		t.Error("nothing arrived at our own media port")
	}

	// Another service on this machine, on the same address: the
	// permission is per address, so the send is accepted, but nothing
	// may arrive.
	relay.WriteTo([]byte("hello"), other.LocalAddr())
	if received(t, other) {
		t.Error("the relay reached a non-media port on this machine")
	}

	// Loopback and the home network: refused at the permission.
	for _, a := range []string{"127.0.0.1:53", "192.168.77.1:53", "10.9.8.7:161"} {
		ua, _ := net.ResolveUDPAddr("udp4", a)
		if err := client.CreatePermission(ua); err == nil {
			t.Errorf("permission granted for %v", a)
		}
	}

	// The internet stays open.
	ua, _ := net.ResolveUDPAddr("udp4", "8.8.8.8:53")
	if err := client.CreatePermission(ua); err != nil {
		t.Errorf("permission refused for a public address: %v", err)
	}
}

// TestNoTCPRelay checks that a TCP allocation, which would let a client
// open TCP connections from this machine, is refused.
func TestNoTCPRelay(t *testing.T) {
	oldAddress, oldTLS := Address, TLSAddress
	t.Cleanup(func() {
		Stop()
		Address, TLSAddress = oldAddress, oldTLS
	})
	port := freePort(t)
	Address = "127.0.0.1:" + strconv.Itoa(port)
	TLSAddress = ""
	if err := Start(); err != nil {
		t.Fatalf("Start: %v", err)
	}
	servers := ICEServers()

	c, err := net.Dial("tcp4", Address)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	client, err := turn.NewClient(&turn.ClientConfig{
		TURNServerAddr: Address,
		Username:       servers[0].Username,
		Password:       servers[0].Credential.(string),
		Realm:          "galene.org",
		Conn:           turn.NewSTUNConn(c),
	})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	if err := client.Listen(); err != nil {
		t.Fatal(err)
	}
	if a, err := client.AllocateTCP(); err == nil {
		a.Close()
		t.Error("TCP allocation granted")
	}
}
