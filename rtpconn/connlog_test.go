package rtpconn

import (
	"errors"
	"fmt"
	"io"
	"net"
	"strings"
	"testing"

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
