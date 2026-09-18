package webserver

import (
	"net/http"
	"testing"
)

func TestRemoteAddr(t *testing.T) {
	t.Cleanup(func() { SetTrustedProxies("") })

	tests := []struct {
		name    string
		trusted string
		remote  string
		xff     []string
		want    string
	}{
		{"no proxy configured ignores the header",
			"", "203.0.113.5:4000", []string{"198.51.100.7"},
			"203.0.113.5:4000"},
		{"untrusted peer cannot spoof",
			"192.0.2.1", "203.0.113.5:4000", []string{"198.51.100.7"},
			"203.0.113.5:4000"},
		{"trusted peer, one hop",
			"192.0.2.1", "192.0.2.1:4000", []string{"198.51.100.7"},
			"198.51.100.7:0"},
		{"client-written entries left of the real one are ignored",
			"192.0.2.1", "192.0.2.1:4000",
			[]string{"10.0.0.1, 198.51.100.7"},
			"198.51.100.7:0"},
		{"chained trusted proxies are skipped",
			"192.0.2.0/24", "192.0.2.1:4000",
			[]string{"198.51.100.7, 192.0.2.9"},
			"198.51.100.7:0"},
		{"several header lines are one list",
			"192.0.2.1", "192.0.2.1:4000",
			[]string{"10.0.0.1", "198.51.100.7"},
			"198.51.100.7:0"},
		{"trusted peer without the header",
			"192.0.2.1", "192.0.2.1:4000", nil,
			"192.0.2.1:4000"},
		{"garbage in the header falls back to the peer",
			"192.0.2.1", "192.0.2.1:4000", []string{"unknown"},
			"192.0.2.1:4000"},
		{"only trusted proxies in the header",
			"192.0.2.0/24", "192.0.2.1:4000", []string{"192.0.2.9"},
			"192.0.2.1:4000"},
		{"IPv6 client",
			"192.0.2.1", "192.0.2.1:4000", []string{"2001:db8::7"},
			"[2001:db8::7]:0"},
		{"IPv4-mapped proxy address",
			"192.0.2.1", "[::ffff:192.0.2.1]:4000",
			[]string{"198.51.100.7"},
			"198.51.100.7:0"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if err := SetTrustedProxies(tt.trusted); err != nil {
				t.Fatalf("SetTrustedProxies: %v", err)
			}
			r := &http.Request{
				RemoteAddr: tt.remote,
				Header:     http.Header{},
			}
			for _, v := range tt.xff {
				r.Header.Add("X-Forwarded-For", v)
			}
			if got := remoteAddr(r); got != tt.want {
				t.Errorf("got %v, want %v", got, tt.want)
			}
		})
	}
}

func TestSetTrustedProxiesRejectsGarbage(t *testing.T) {
	t.Cleanup(func() { SetTrustedProxies("") })
	for _, s := range []string{"proxy.example", "192.0.2.1/33", "1.2.3"} {
		if err := SetTrustedProxies(s); err == nil {
			t.Errorf("%q: accepted", s)
		}
	}
	if err := SetTrustedProxies(" 192.0.2.1 , 2001:db8::/32 "); err != nil {
		t.Errorf("valid list rejected: %v", err)
	}
}
