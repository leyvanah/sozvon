package group

import (
	"errors"
	"io"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/pion/stun/v3"
)

func TestOversizeLine(t *testing.T) {
	if oversizeLine(nil, 10*time.Second) != "" {
		t.Error("nothing counted: want no line")
	}
	s := &oversizeStats{}
	for i := 0; i < 3; i++ {
		s.note(2456)
	}
	s.note(1600)
	line := oversizeLine(s.take(), 10*time.Second)
	for _, want := range []string{"4 datagram(s) over 1500 bytes in 10s",
		"largest 2456", "commonest 2456×3 1600×1"} {
		if !strings.Contains(line, want) {
			t.Errorf("%q: want %q", line, want)
		}
	}
	if s.take() != nil {
		t.Error("take does not reset")
	}
}

// sozvon-tasks#63.  A datagram over 1500 bytes reaches the connection it
// belongs to through the server's UDP mux whole, but a reader with a
// 1500-byte buffer -- pion's WebRTC layer at its default receive MTU -- gets
// "short buffer" and loses it.  With ReceiveMTU it is read whole, and the
// mux's socket counts it.
func TestLargeDatagramsThroughTheMux(t *testing.T) {
	l, err := net.ListenPacket("udp", ":0")
	if err != nil {
		t.Fatal(err)
	}
	port := l.LocalAddr().(*net.UDPAddr).Port
	l.Close()
	if err := SetUDPMux(port); err != nil {
		t.Skipf("no UDP mux here: %v", err)
	}
	defer func() {
		udpMux.Close()
		udpMux = nil
	}()

	// the mux listens on every interface but loopback
	var server *net.UDPAddr
	for _, a := range udpMux.GetListenAddresses() {
		if u, ok := a.(*net.UDPAddr); ok && u.IP.To4() != nil {
			server = u
			break
		}
	}
	if server == nil {
		t.Skip("no IPv4 interface besides loopback")
	}

	const ufrag = "sozvontest"
	conn, err := udpMux.GetConn(ufrag, server)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()

	peer, err := net.ListenUDP("udp4", &net.UDPAddr{IP: server.IP})
	if err != nil {
		t.Fatal(err)
	}
	defer peer.Close()

	// A binding request names the connection, as a browser's does.
	req, err := stun.Build(stun.TransactionID, stun.BindingRequest,
		stun.NewUsername(ufrag+":peer"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := peer.WriteTo(req.Raw, server); err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, ReceiveMTU)
	conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	_, from, err := conn.ReadFrom(buf)
	if err != nil {
		t.Skipf("the binding request did not get through: %v", err)
	}
	// The connection answers, as ICE does; that ties the peer's address
	// to it, and what comes from there next is routed to it.
	if _, err := conn.WriteTo([]byte("answer"), from); err != nil {
		t.Fatal(err)
	}
	oversize.take()

	large := make([]byte, 2000)
	large[0] = 0x80 // looks like RTP
	send := func() {
		if _, err := peer.WriteTo(large, server); err != nil {
			t.Fatal(err)
		}
	}

	// As before: a 1500-byte reader loses it.
	send()
	_, _, err = conn.ReadFrom(make([]byte, 1500))
	if !errors.Is(err, io.ErrShortBuffer) {
		t.Errorf("a 1500-byte reader: got %v, want a short buffer", err)
	}

	// Now: read whole.
	send()
	n, _, err := conn.ReadFrom(buf)
	if err != nil || n != len(large) {
		t.Errorf("a %d-byte reader: got %d bytes, %v", ReceiveMTU, n, err)
	}

	if got := oversize.take()[len(large)]; got != 2 {
		t.Errorf("counted %d datagrams of %d bytes, want 2", got, len(large))
	}
}
