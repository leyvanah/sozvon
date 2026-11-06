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
		{"ask", "d1", m("cap", 600000.0, "audioDelay", 0.31,
			"videoDelay", 0.12, "jitter", 0.004, "processing", 0.021,
			"freeze", 0.0, "concealed", 0.012),
			who + " down=" + down + " asks the sender for 600 kbit/s: " +
				"audio delay 310ms video delay 120ms jitter 4ms " +
				"processing 21ms freeze 0.0s concealed 1.2%"},
		{"ask", "d1", m("cap", 195000.0, "audioDelay", 0.3,
			"pathAudio", 0.28, "pathVideo", 0.05),
			who + " down=" + down + " asks the sender for 195 kbit/s: " +
				"audio delay 300ms path audio 280ms path video 50ms"},
		// the decoding alone and what each jitter buffer aimed for come
		// last, so the figures logged before them keep their places
		{"ask", "d1", m("cap", 150000.0, "audioDelay", 0.3,
			"audioTarget", 0.29, "audioMinimum", 0.04,
			"videoDelay", 0.32, "videoTarget", 0.31, "videoMinimum", 0.09,
			"processing", 0.322, "decode", 0.002, "pathAudio", 0.28),
			who + " down=" + down + " asks the sender for 150 kbit/s: " +
				"audio delay 300ms video delay 320ms processing 322ms " +
				"path audio 280ms decode 2ms " +
				"audio target 290ms audio minimum 40ms " +
				"video target 310ms video minimum 90ms"},
		// a browser that reports a target but no minimum or decoding time
		{"ask", "d1", m("cap", 150000.0, "audioDelay", 0.3,
			"audioTarget", 0.29, "audioMinimum", nil, "decode", nil),
			who + " down=" + down + " asks the sender for 150 kbit/s: " +
				"audio delay 300ms audio target 290ms"},
		{"ask", "d1", m("cap", 195000.0, "pathAudio", nil),
			who + " down=" + down + " asks the sender for 195 kbit/s"},
		// evidence that is not a sane number is left out, not the line
		{"ask", "d1", m("cap", 600000.0, "jitter", "<b>", "audioDelay", -1.0,
			"processing", 0.05),
			who + " down=" + down + " asks the sender for 600 kbit/s: " +
				"processing 50ms"},
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
		{"path", "u1", m("type", "srflx", "relay", "udp"),
			who + " up=" + up + " client path srflx/udp"},
		{"transport", "", m("udp", false, "reason", "loss"),
			who + " gives up UDP (loss), falling back to the relay over TCP/TLS"},
		{"restart", "u1", m("reason", "resumed"),
			who + " up=" + up + " restarts ICE after the signalling resumed"},
		{"restart", "d1", m("reason", "disconnected"),
			who + " down=" + down + " restarts ICE after staying disconnected"},
		{"restart", "d1", m("reason", "<b>"), ""},
		{"restart", "nope", m("reason", "resumed"), ""},
		{"picture", "d1", m("width", 640.0, "height", 480.0, "fps", 29.6,
			"minFps", 24.2, "rate", 2412000.0, "cap", 2500000.0),
			who + " down=" + down + " receives 640x480 at 30 fps (worst 24), " +
				"2412 kbit/s, cap 2500 kbit/s"},
		{"picture", "d1", m("width", 640.0, "height", 480.0, "fps", 30.0,
			"minFps", 30.0, "rate", 900000.0, "cap", nil),
			who + " down=" + down + " receives 640x480 at 30 fps (worst 30), " +
				"900 kbit/s, no cap"},
		{"picture", "d1", m("width", 640.0, "height", 480.0, "fps", 30.0,
			"minFps", 28.0, "rate", 300000.0, "cap", 329000.0,
			"audioDelay", 0.3, "audioTarget", 0.29, "audioMinimum", 0.04,
			"videoDelay", 0.32, "videoTarget", nil, "videoMinimum", "<b>"),
			who + " down=" + down + " receives 640x480 at 30 fps (worst 28), " +
				"300 kbit/s, cap 329 kbit/s, " +
				"audio delay 300ms audio target 290ms audio minimum 40ms, " +
				"video delay 320ms"},
		// no audio played out over the minutes: no audio figures at all
		{"picture", "d1", m("width", 640.0, "height", 480.0, "fps", 30.0,
			"minFps", 30.0, "rate", 300000.0, "cap", nil,
			"audioDelay", nil, "audioTarget", nil, "audioMinimum", nil,
			"videoDelay", 0.2, "videoTarget", 0.21, "videoMinimum", 0.25),
			who + " down=" + down + " receives 640x480 at 30 fps (worst 30), " +
				"300 kbit/s, no cap, " +
				"video delay 200ms video target 210ms video minimum 250ms"},
		{"picture", "u1", m("width", 640.0, "height", 480.0, "fps", 30.0,
			"minFps", 30.0), ""},
		{"picture", "d1", m("width", "wide", "height", 480.0, "fps", 30.0,
			"minFps", 30.0), ""},
		// a phone whose picture gets all the way through the canvas
		{"camera", "u1", m("after", 6.0, "os", "android", "app", nil,
			"browser", "chrome", "touch", true, "canvas", "orientation",
			"track", "live", "muted", false, "enabled", true,
			"width", 640.0, "height", 480.0, "fps", 30.0, "delivered", nil,
			"paused", false, "ready", 4.0,
			"elementWidth", 640.0, "elementHeight", 480.0,
			"play", "ok", "drawn", 178.0,
			"source", 176.0, "encoded", 175.0, "sent", 912.0,
			"limit", "none", "preview", 170.0),
			who + " up=" + up + " camera after 6s: android/chrome touch; " +
				"track live 640x480 30fps; " +
				"canvas orientation, element playing ready 4 640x480, " +
				"play ok, drawn 178; " +
				"sender got 176 frames, encoded 175, sent 912 packets; " +
				"preview 170 frames"},
		// the 2026-10-21 case as this would have shown it, were the
		// element refused: everything after the element is zero
		{"camera", "u1", m("after", 6.0, "os", "ios", "browser", "safari",
			"touch", true, "canvas", "orientation", "track", "live",
			"muted", false, "enabled", true,
			"paused", true, "ready", 0.0,
			"elementWidth", 0.0, "elementHeight", 0.0,
			"play", "NotAllowedError", "drawn", 0.0,
			"source", 0.0, "encoded", 0.0, "sent", 0.0, "preview", 0.0),
			who + " up=" + up + " camera after 6s: ios/safari touch; " +
				"track live; " +
				"canvas orientation, element paused ready 0 0x0, " +
				"play NotAllowedError, drawn 0; " +
				"sender got 0 frames, encoded 0, sent 0 packets; " +
				"preview 0 frames"},
		// a desktop app with no canvas; counters the browser does not
		// report are left out, a muted camera and a limit are said
		{"camera", "u1", m("after", 6.4, "os", "windows", "app", "desktop",
			"browser", "chrome", "touch", false, "canvas", "none",
			"track", "live", "muted", true, "enabled", false,
			"width", 1280.0, "height", 720.0, "fps", nil, "delivered", 0.0,
			"source", nil, "encoded", 0.0, "sent", 0.0, "limit", "cpu",
			"preview", nil),
			who + " up=" + up + " camera after 6s: windows/chrome app desktop; " +
				"track live muted disabled 1280x720, delivered 0 frames; " +
				"no canvas; encoded 0, sent 0 packets, limited by cpu"},
		// malformed fields are left out, the rest of the line kept
		{"camera", "u1", m("after", 6.0, "os", "mac", "browser", "safari",
			"canvas", "filter", "track", "ended", "app", "<b>",
			"muted", "yes", "width", -1.0, "height", 480.0,
			"play", "<script>", "drawn", 1e12, "encoded", "many",
			"sent", 10.0, "limit", "evil"),
			who + " up=" + up + " camera after 6s: mac/safari; " +
				"track ended; canvas filter; sent 10 packets"},
		// what identifies the line is required
		{"camera", "u1", m("after", 6.0, "os", "linux-6.1", "browser",
			"chrome", "canvas", "none", "track", "live"), ""},
		{"camera", "u1", m("after", 6.0, "os", "mac", "browser",
			"Chrome/141.0.7390.54", "canvas", "none", "track", "live"), ""},
		{"camera", "u1", m("os", "mac", "browser", "chrome",
			"canvas", "none", "track", "live"), ""},
		{"camera", "d1", m("after", 6.0, "os", "mac", "browser", "chrome",
			"canvas", "none", "track", "live"), ""},
		{"path", "u1", m("type", "evil"), ""},
		{"transport", "", m("udp", false, "reason", "because"), ""},
		{"transport", "", m("udp", true, "reason", "loss"), ""},
		{"transport", "", m("udp", true, "reason", "network"),
			who + " tries UDP again on a new network"},
		{"transport", "", m("udp", "yes", "reason", "network"), ""},

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
