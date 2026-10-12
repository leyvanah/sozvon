package rtpconn

import (
	"net"
	"strings"
	"testing"
)

func TestNetworkTag(t *testing.T) {
	tcp := func(s string) net.Addr {
		a, err := net.ResolveTCPAddr("tcp", s)
		if err != nil {
			t.Fatalf("%v: %v", s, err)
		}
		return a
	}
	home := networkTag(tcp("203.0.113.7:51000"))
	if len(home) != 16 {
		t.Fatalf("tag %q: want 16 hex digits", home)
	}
	if strings.Contains(home, "203") && strings.Contains(home, "113") {
		t.Errorf("tag %q looks like it carries the address", home)
	}

	same := []string{
		"203.0.113.200:443",      // another host, same /24
		"[::ffff:203.0.113.9]:1", // the same, as IPv4-mapped IPv6
	}
	for _, s := range same {
		if got := networkTag(tcp(s)); got != home {
			t.Errorf("%v: tag %q, want %q (same network)", s, got, home)
		}
	}
	if networkTag(tcp("203.0.114.7:51000")) == home {
		t.Error("another /24 got the same tag")
	}

	v6 := networkTag(tcp("[2001:db8:1:2a::1]:1"))
	if networkTag(tcp("[2001:db8:1:2b::99]:1")) != v6 {
		t.Error("the same IPv6 /56 got different tags")
	}
	if networkTag(tcp("[2001:db8:1:100::1]:1")) == v6 {
		t.Error("another IPv6 /56 got the same tag")
	}

	if networkTag(nil) != "" {
		t.Error("no address: want no tag")
	}
	if networkTag(&net.UnixAddr{Name: "/tmp/x", Net: "unix"}) != "" {
		t.Error("not an IP address: want no tag")
	}
}

func TestNetworkMessageIsNotCounted(t *testing.T) {
	// The client counts the same set (static/signalling-resume.js).
	if countedType("sozvon-network") {
		t.Error("sozvon-network must not be numbered for replay")
	}
}
