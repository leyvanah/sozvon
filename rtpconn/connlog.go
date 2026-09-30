package rtpconn

// An anonymous log of connection events, so that a call that kept breaking
// can be explained afterwards.  (Sozvon)
//
// Without it the server says nothing about why a participant dropped out: a
// websocket closed by a page reload counts as a normal close and is not
// logged, and ICE failures are acted upon silently.  Each line here tells
// what happened to whom and when -- and nothing about who that is.
//
// A participant is a short tag, a hash of their client id salted with a value
// drawn when the server starts.  Lines about the same person in one call can
// be put together; lines from different server runs cannot, and nothing leads
// back to a name.  There are no addresses, no usernames and no group names;
// candidate pairs are logged as their type and protocol only.

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"strings"
	"time"

	"github.com/gorilla/websocket"
	"github.com/pion/webrtc/v4"

	"github.com/leyvanah/sozvon/group"
)

// LogConnections turns the connection log on.
var LogConnections bool

var connLogSalt = func() []byte {
	b := make([]byte, 16)
	rand.Read(b)
	return b
}()

// connTag returns the anonymous tag for an id.
func connTag(id string) string {
	h := sha256.New()
	h.Write(connLogSalt)
	h.Write([]byte(id))
	return hex.EncodeToString(h.Sum(nil)[:3])
}

func connLogf(format string, args ...interface{}) {
	if !LogConnections {
		return
	}
	log.Printf("conn: "+format, args...)
}

// since formats the time elapsed since t, rounded for reading.
func since(t time.Time) time.Duration {
	d := time.Since(t)
	if d < time.Minute {
		return d.Round(100 * time.Millisecond)
	}
	return d.Round(time.Second)
}

// closeReason describes why a client's session ended, without anything
// that could identify the client: network errors carry addresses in their
// text, so only their kind is kept.
func closeReason(err error) string {
	if err == nil {
		return "closed"
	}
	var ce *websocket.CloseError
	if errors.As(err, &ce) {
		switch ce.Code {
		case websocket.CloseNormalClosure:
			return "close 1000 (normal)"
		case websocket.CloseGoingAway:
			return "close 1001 (going away: page closed or reloaded)"
		case websocket.CloseAbnormalClosure:
			return "close 1006 (abnormal: connection lost)"
		default:
			return fmt.Sprintf("close %d", ce.Code)
		}
	}
	var kick group.KickError
	if errors.As(err, &kick) {
		return "kicked"
	}
	if errors.Is(err, errClientDead) {
		return "timeout (nothing received for 45s)"
	}
	var ne net.Error
	if errors.As(err, &ne) && ne.Timeout() {
		return "timeout"
	}
	if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
		return "connection lost (eof)"
	}
	if strings.Contains(err.Error(), "connection reset") {
		return "connection lost (reset)"
	}
	var pe group.ProtocolError
	if errors.As(err, &pe) {
		return "protocol error"
	}
	return fmt.Sprintf("error (%T)", err)
}

// logICE installs a handler that logs the ICE states of pc for the
// connection id of client c.  The previous handler, if any, is still
// called.  kind is "up" or "down".
func logICE(c *webClient, kind, id string, pc *webrtc.PeerConnection,
	next func(webrtc.ICEConnectionState)) {
	start := time.Now()
	client := connTag(c.id)
	conn := connTag(id)
	pc.OnICEConnectionStateChange(func(state webrtc.ICEConnectionState) {
		if LogConnections {
			if state == webrtc.ICEConnectionStateConnected {
				// the selected pair is read through the ICE
				// agent, which must not be called from its own
				// callback
				go connLogf("c=%v %v=%v ice %v +%v %v",
					client, kind, conn, state, since(start),
					selectedPair(pc))
			} else {
				connLogf("c=%v %v=%v ice %v +%v",
					client, kind, conn, state, since(start))
			}
		}
		if next != nil {
			next(state)
		}
	})
}

// selectedPair describes the candidate pair in use as local/remote type and
// protocol, e.g. "relay/udp-srflx/udp".  A relay candidate's protocol is that
// of the relayed address, which is always UDP; how this server reaches the
// relay is added after it, e.g. "relay/udp(via tls)".
func selectedPair(pc *webrtc.PeerConnection) string {
	var t *webrtc.DTLSTransport
	for _, r := range pc.GetReceivers() {
		if t = r.Transport(); t != nil {
			break
		}
	}
	if t == nil {
		for _, s := range pc.GetSenders() {
			if t = s.Transport(); t != nil {
				break
			}
		}
	}
	if t == nil || t.ICETransport() == nil {
		return "pair unknown"
	}
	p, err := t.ICETransport().GetSelectedCandidatePair()
	if err != nil || p == nil || p.Local == nil || p.Remote == nil {
		return "pair unknown"
	}
	via := ""
	if p.Local.Typ == webrtc.ICECandidateTypeRelay {
		if ps, ok := t.ICETransport().GetSelectedCandidatePairStats(); ok {
			if s, ok := pc.GetStats()[ps.LocalCandidateID].(webrtc.ICECandidateStats); ok && s.RelayProtocol != "" {
				via = "(via " + s.RelayProtocol + ")"
			}
		}
	}
	return fmt.Sprintf("%v/%v%v-%v/%v",
		p.Local.Typ, p.Local.Protocol, via, p.Remote.Typ, p.Remote.Protocol)
}
