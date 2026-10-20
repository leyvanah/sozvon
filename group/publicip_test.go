package group

import (
	"net"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
)

func TestParsePublicIP(t *testing.T) {
	good := []string{"203.0.113.7", "8.8.8.8"}
	for _, s := range good {
		if _, err := ParsePublicIP(s); err != nil {
			t.Errorf("%v: %v", s, err)
		}
	}
	bad := []string{
		"", "example.org", "2001:db8::1",
		"192.168.0.136", "10.0.0.1", "172.16.5.4",
		"127.0.0.1", "0.0.0.0", "169.254.1.1",
		"100.64.0.2", "100.127.255.254",
	}
	for _, s := range bad {
		if ip, err := ParsePublicIP(s); err == nil {
			t.Errorf("%v: accepted as %v", s, ip)
		}
	}
}

// offerCandidates gathers the server's candidates the way a real
// connection does, through the mux, and returns their "address port typ"
// triples.
func offerCandidates(t *testing.T) []string {
	t.Helper()
	api, err := APIFromCodecs([]webrtc.RTPCodecParameters{{
		RTPCodecCapability: webrtc.RTPCodecCapability{
			MimeType:  webrtc.MimeTypeOpus,
			ClockRate: 48000,
			Channels:  2,
		},
		PayloadType: 111,
	}})
	if err != nil {
		t.Fatal(err)
	}
	pc, err := api.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	defer pc.Close()
	_, err = pc.AddTransceiverFromKind(webrtc.RTPCodecTypeAudio)
	if err != nil {
		t.Fatal(err)
	}
	offer, err := pc.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	done := webrtc.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(offer); err != nil {
		t.Fatal(err)
	}
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("gathering did not complete")
	}

	var cands []string
	for _, line := range strings.Split(pc.LocalDescription().SDP, "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "a=candidate:") {
			continue
		}
		f := strings.Fields(line)
		// foundation component transport priority address port typ type
		if len(f) >= 8 {
			cands = append(cands, f[4]+" "+f[5]+" "+f[7])
		}
	}
	return cands
}

// A home server is reached from outside at its router's address and from
// its own LAN at its own.  With -public-ip it must offer both, on the one
// port the router forwards; without it, only the local one.
func TestPublicIPCandidates(t *testing.T) {
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

	var local net.IP
	for _, a := range udpMux.GetListenAddresses() {
		if u, ok := a.(*net.UDPAddr); ok && u.IP.To4() != nil {
			local = u.IP
			break
		}
	}
	if local == nil {
		t.Skip("no IPv4 interface besides loopback")
	}

	p := strconv.Itoa(port)
	public := "203.0.113.7 " + p + " host"
	lan := local.String() + " " + p + " host"

	has := func(cands []string, want string) bool {
		for _, c := range cands {
			if c == want {
				return true
			}
		}
		return false
	}

	cands := offerCandidates(t)
	if !has(cands, lan) || has(cands, public) {
		t.Errorf("without -public-ip: want %q and not %q, got %q",
			lan, public, cands)
	}

	PublicIP = net.IPv4(203, 0, 113, 7).To4()
	defer func() { PublicIP = nil }()
	cands = offerCandidates(t)
	if !has(cands, lan) || !has(cands, public) {
		t.Errorf("with -public-ip: want %q and %q, got %q",
			lan, public, cands)
	}
}
