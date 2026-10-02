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

// Quality reports.  (Sozvon)
//
// The client grades every stream it sends or receives (connection-quality.js)
// and runs the receiver-driven bitrate caps (bitrate-control.js); the server
// sees neither.  So the client reports each change -- a settled level, a cap
// asked for, a cap applied -- and it is logged next to the ICE lines of the
// same connection.  A client could send anything here, so every field is
// checked, numbers are bounded and the rate is limited: at worst a hostile
// client adds a few lines of well-formed nonsense to the log.

// qualityBurst reports are accepted at once, then one every
// qualityRefill.  A bad call changes level a few times a minute.
const (
	qualityBurst  = 20
	qualityRefill = 3 * time.Second
)

var qualityLevels = map[string]bool{
	"good": true, "weak": true, "bad": true, "lost": true,
}

var candidateTypes = map[string]bool{
	"host": true, "srflx": true, "prflx": true, "relay": true,
}

var relayProtocols = map[string]bool{"udp": true, "tcp": true, "tls": true}

var fallbackReasons = map[string]bool{
	"failed": true, "disconnected": true, "loss": true,
}

var iceStates = map[string]bool{
	"new": true, "checking": true, "connected": true, "completed": true,
	"disconnected": true, "failed": true, "closed": true,
}

// qualityAllowed implements the rate limit, a token bucket kept in the
// client.  It is only called from the client's own loop.
func qualityAllowed(c *webClient, now time.Time) bool {
	if c.qualityTime.IsZero() {
		c.qualityTokens = qualityBurst
	} else {
		c.qualityTokens += float64(now.Sub(c.qualityTime)) /
			float64(qualityRefill)
		if c.qualityTokens > qualityBurst {
			c.qualityTokens = qualityBurst
		}
	}
	c.qualityTime = now
	if c.qualityTokens < 1 {
		return false
	}
	c.qualityTokens--
	return true
}

// number returns v as a finite number within [0, max].
func number(v interface{}, max float64) (float64, bool) {
	f, ok := v.(float64)
	if !ok || f != f || f < 0 || f > max {
		return 0, false
	}
	return f, true
}

func word(v interface{}, allowed map[string]bool) (string, bool) {
	s, ok := v.(string)
	if !ok || !allowed[s] {
		return "", false
	}
	return s, true
}

// streamKind says whether id is one of c's up or down connections.
func streamKind(c *webClient, id string) (string, bool) {
	if id == "" {
		return "", false
	}
	if getUpConn(c, id) != nil {
		return "up", true
	}
	if getDownConn(c, id) != nil {
		return "down", true
	}
	return "", false
}

// kbps formats a bitrate in bits per second; null means no cap.
func kbps(v interface{}) (string, bool) {
	if v == nil {
		return "no cap", true
	}
	f, ok := number(v, 1e10)
	if !ok {
		return "", false
	}
	return fmt.Sprintf("%d kbit/s", int64(f/1000)), true
}

// qualityLine turns a report into a log line, or "" if it is malformed.
func qualityLine(c *webClient, kind, id string, value interface{}) string {
	v, _ := value.(map[string]interface{})
	if v == nil {
		return ""
	}
	who := "c=" + connTag(c.id)
	switch kind {
	case "level":
		dir, ok := streamKind(c, id)
		if !ok {
			return ""
		}
		level, ok1 := word(v["level"], qualityLevels)
		previous, ok2 := word(v["previous"], qualityLevels)
		if !ok1 || !ok2 {
			return ""
		}
		why := ""
		rtt, ok3 := number(v["rtt"], 3600)
		jitter, ok4 := number(v["jitter"], 3600)
		loss, ok5 := number(v["loss"], 1)
		if ok3 && ok4 && ok5 {
			why = fmt.Sprintf(": rtt %dms jitter %dms loss %.1f%%",
				int64(rtt*1000), int64(jitter*1000), loss*100)
		} else if ice, ok := word(v["ice"], iceStates); ok {
			why = ": ice " + ice
		}
		return fmt.Sprintf("%v %v=%v quality %v (was %v)%v",
			who, dir, connTag(id), level, previous, why)
	case "ask":
		dir, ok := streamKind(c, id)
		if !ok || dir != "down" {
			return ""
		}
		limit, ok := kbps(v["cap"])
		if !ok {
			return ""
		}
		if v["cap"] == nil {
			return fmt.Sprintf("%v down=%v asks the sender to lift its cap",
				who, connTag(id))
		}
		return fmt.Sprintf("%v down=%v asks the sender for %v",
			who, connTag(id), limit)
	case "send":
		dir, ok := streamKind(c, id)
		if !ok || dir != "up" {
			return ""
		}
		limit, ok := kbps(v["cap"])
		if !ok {
			return ""
		}
		if v["cap"] == nil {
			return fmt.Sprintf("%v up=%v sends video without a cap",
				who, connTag(id))
		}
		return fmt.Sprintf("%v up=%v sends video at %v",
			who, connTag(id), limit)
	case "path":
		// the path the client's side of a connection uses, which the
		// server cannot see: how the client reaches its relay
		dir, ok := streamKind(c, id)
		if !ok {
			return ""
		}
		typ, ok := word(v["type"], candidateTypes)
		if !ok {
			return ""
		}
		if typ != "relay" {
			// a direct path; its protocol, when the client says
			if proto, ok := word(v["relay"], relayProtocols); ok {
				return fmt.Sprintf("%v %v=%v client path %v/%v",
					who, dir, connTag(id), typ, proto)
			}
			return fmt.Sprintf("%v %v=%v client path %v",
				who, dir, connTag(id), typ)
		}
		relay, ok := word(v["relay"], relayProtocols)
		if !ok {
			relay = "unknown"
		}
		return fmt.Sprintf("%v %v=%v client path relay via %v",
			who, dir, connTag(id), relay)
	case "transport":
		// the client gave up TURN over UDP (static/turn-fallback.js)
		if udp, ok := v["udp"].(bool); !ok || udp {
			return ""
		}
		reason, ok := word(v["reason"], fallbackReasons)
		if !ok {
			return ""
		}
		return fmt.Sprintf("%v gives up UDP (%v), "+
			"falling back to the relay over TCP/TLS", who, reason)
	case "everyone":
		degraded, ok := v["degraded"].(bool)
		if !ok {
			return ""
		}
		if degraded {
			return who + " own link degraded: every remote stream is weak or worse"
		}
		return who + " own link recovered"
	}
	return ""
}

// gotQualityReport logs a client's quality report.  Malformed or excess
// reports are dropped silently: this is a log, not a protocol a client may
// get wrong.
func gotQualityReport(c *webClient, m clientMessage) {
	if !LogConnections || !qualityAllowed(c, time.Now()) {
		return
	}
	line := qualityLine(c, m.Kind, m.Id, m.Value)
	if line != "" {
		connLogf("%v", line)
	}
}
