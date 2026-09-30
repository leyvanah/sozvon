package rtpconn

import (
	"errors"
	"fmt"
	"io"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/leyvanah/sozvon/group"
)

func TestConnTag(t *testing.T) {
	a := connTag("client-a")
	if len(a) != 6 {
		t.Errorf("tag %q, expected 6 hex digits", a)
	}
	if connTag("client-a") != a {
		t.Errorf("the same id must give the same tag within a run")
	}
	if connTag("client-b") == a {
		t.Errorf("different ids gave the same tag")
	}
	if strings.Contains(a, "client") {
		t.Errorf("tag %q leaks the id", a)
	}
}

func TestCloseReason(t *testing.T) {
	addr := &net.TCPAddr{IP: net.IPv4(203, 0, 113, 7), Port: 51234}
	netErr := &net.OpError{
		Op: "read", Net: "tcp", Addr: addr,
		Err: errors.New("connection reset by peer"),
	}
	tests := []struct {
		err  error
		want string
	}{
		{nil, "closed"},
		{&websocket.CloseError{Code: 1000}, "close 1000 (normal)"},
		{&websocket.CloseError{Code: 1001},
			"close 1001 (going away: page closed or reloaded)"},
		{&websocket.CloseError{Code: 1006},
			"close 1006 (abnormal: connection lost)"},
		{&websocket.CloseError{Code: 4000}, "close 4000"},
		{fmt.Errorf("wrapped: %w", errClientDead),
			"timeout (nothing received for 45s)"},
		{io.ErrUnexpectedEOF, "connection lost (eof)"},
		{netErr, "connection lost (reset)"},
		{group.ProtocolError("bad"), "protocol error"},
		{group.KickError{}, "kicked"},
	}
	for _, tt := range tests {
		got := closeReason(tt.err)
		if got != tt.want {
			t.Errorf("closeReason(%v) = %q, want %q", tt.err, got, tt.want)
		}
	}
}

// Whatever the error says, the address it carries must not reach the log.
func TestCloseReasonNoAddress(t *testing.T) {
	addr := &net.TCPAddr{IP: net.IPv4(203, 0, 113, 7), Port: 51234}
	errs := []error{
		&net.OpError{Op: "read", Net: "tcp", Addr: addr,
			Err: errors.New("connection reset by peer")},
		&net.OpError{Op: "write", Net: "tcp", Addr: addr,
			Err: errors.New("broken pipe")},
		fmt.Errorf("client at %v misbehaved", addr),
	}
	for _, err := range errs {
		got := closeReason(err)
		if strings.Contains(got, "203.0.113") || strings.Contains(got, "51234") {
			t.Errorf("closeReason(%v) = %q leaks the address", err, got)
		}
	}
}

func qualityClient() *webClient {
	return &webClient{
		id:   "client-q",
		up:   map[string]*rtpUpConnection{"u1": {}},
		down: map[string]*rtpDownConnection{"d1": {}},
	}
}

func TestQualityLine(t *testing.T) {
	c := qualityClient()
	up, down := connTag("u1"), connTag("d1")
	who := "c=" + connTag("client-q")
	m := func(kv ...interface{}) map[string]interface{} {
		r := map[string]interface{}{}
		for i := 0; i < len(kv); i += 2 {
			r[kv[i].(string)] = kv[i+1]
		}
		return r
	}
	tests := []struct {
		kind, id string
		value    interface{}
		want     string
	}{
		{"level", "d1", m("level", "weak", "previous", "good",
			"rtt", 0.42, "jitter", 0.012, "loss", 0.0),
			who + " down=" + down +
				" quality weak (was good): rtt 420ms jitter 12ms loss 0.0%"},
		{"level", "u1", m("level", "lost", "previous", "weak",
			"rtt", nil, "jitter", nil, "loss", nil, "ice", "failed"),
			who + " up=" + up + " quality lost (was weak): ice failed"},
		{"ask", "d1", m("cap", 450000.0),
			who + " down=" + down + " asks the sender for 450 kbit/s"},
		{"ask", "d1", m("cap", nil),
			who + " down=" + down + " asks the sender to lift its cap"},
		{"send", "u1", m("cap", 1000000.0),
			who + " up=" + up + " sends video at 1000 kbit/s"},
		{"everyone", "", m("degraded", true),
			who + " own link degraded: every remote stream is weak or worse"},
		{"everyone", "", m("degraded", false), who + " own link recovered"},
		{"path", "d1", m("type", "relay", "relay", "udp"),
			who + " down=" + down + " client path relay via udp"},
		{"path", "u1", m("type", "relay", "relay", nil),
			who + " up=" + up + " client path relay via unknown"},
		{"path", "u1", m("type", "host", "relay", nil),
			who + " up=" + up + " client path host"},
		{"transport", "", m("udp", false, "reason", "loss"),
			who + " gives up TURN over UDP (loss), falling back to TCP/TLS"},
		{"path", "u1", m("type", "evil"), ""},
		{"transport", "", m("udp", false, "reason", "because"), ""},
		{"transport", "", m("udp", true, "reason", "loss"), ""},

		// malformed or foreign: nothing
		{"level", "nope", m("level", "weak", "previous", "good"), ""},
		{"level", "d1", m("level", "<script>", "previous", "good"), ""},
		{"level", "d1", "not an object", ""},
		{"ask", "u1", m("cap", 1.0), ""},
		{"send", "d1", m("cap", 1.0), ""},
		{"send", "u1", m("cap", -5.0), ""},
		{"send", "u1", m("cap", "a lot"), ""},
		{"everyone", "", m("degraded", "yes"), ""},
		{"whatever", "u1", m(), ""},
	}
	for _, tt := range tests {
		got := qualityLine(c, tt.kind, tt.id, tt.value)
		if got != tt.want {
			t.Errorf("qualityLine(%v, %v, %v)\n got %q\nwant %q",
				tt.kind, tt.id, tt.value, got, tt.want)
		}
	}
}

// Free text from the client never reaches the log.
func TestQualityLineNoFreeText(t *testing.T) {
	c := qualityClient()
	line := qualityLine(c, "level", "d1", map[string]interface{}{
		"level": "weak", "previous": "good", "ice": "203.0.113.7",
		"rtt": "203.0.113.7", "jitter": nil, "loss": nil,
	})
	if strings.Contains(line, "203.0") {
		t.Errorf("line %q carries client text", line)
	}
}

func TestQualityRateLimit(t *testing.T) {
	c := qualityClient()
	now := time.Unix(1000, 0)
	n := 0
	for i := 0; i < 100; i++ {
		if qualityAllowed(c, now) {
			n++
		}
	}
	if n != qualityBurst {
		t.Errorf("burst: %v accepted, want %v", n, qualityBurst)
	}
	now = now.Add(10 * qualityRefill)
	n = 0
	for i := 0; i < 100; i++ {
		if qualityAllowed(c, now) {
			n++
		}
	}
	if n != 10 {
		t.Errorf("after 10 refills: %v accepted, want 10", n)
	}
}
