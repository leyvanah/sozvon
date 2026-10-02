package rtpconn

// Signalling resume.  (Sozvon)
//
// A session used to live exactly as long as its websocket.  When the socket
// went silent -- a TCP path that stalls on a mobile network while the media,
// on its own path, keeps flowing -- the server declared the client dead after
// 45 seconds and tore down its media with it, and the client did the same on
// its side.  A participant who could be heard and seen until that moment
// dropped out of the call and came back a minute later.
//
// A client that opts in ("sozvon-resumable" in its handshake) receives a
// secret.  When its socket dies or goes silent, it opens a new one and
// presents its id and the secret; the session, its peer connections and its
// place in the group carry on as if nothing had happened.
//
// Nothing is lost on the way.  Both sides number the messages they send,
// handshakes and the resume messages themselves excepted, and keep the last
// few hundred.  On resume the client says how many it has received, the
// server sends the rest and says how many it has received in turn, and the
// client sends the rest of its own.  Whatever was stuck in the dead socket
// arrives once, in order, and the messages themselves need no change.
//
// What keeps a session waiting is its media, not its socket.  While one of
// its peer connections is connected the server waits up to two minutes for
// the client to come back: the participant is still in the call.  Once its
// media is gone too, it is dropped within 15 to 25 seconds -- sooner than the
// 45 seconds of old -- so a participant who has really gone does not linger
// as a phantom.  A socket closed normally (leaving, closing the page) ends
// the session at once, as before.  Clients that do not opt in keep the old
// rules unchanged.

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"math"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/pion/webrtc/v4"
)

const (
	// a resumable client is pinged after this much silence; it answers
	// at once, so a live client is never silent much longer than this
	resumePing = 10 * time.Second
	// silence after which a client with no live media is dropped
	silentNoMedia = 25 * time.Second
	// the same once its socket is gone: a client that is still there
	// comes back within a round trip or two
	detachedNoMedia = 15 * time.Second
	// how long a client whose media is alive may go without signalling
	resumeGrace = 2 * time.Minute

	// bounds on the messages kept for replay
	replayMaxMessages = 512
	replayMaxBytes    = 2 << 20

	// close code telling a client that its session cannot be resumed
	closeNoResume = 4001
)

var (
	errNoSignalling  = errors.New("no signalling and no live media")
	errResumeExpired = errors.New("signalling not resumed in time")
	errResumeGap     = errors.New("cannot resume: messages lost")
)

// countedType reports whether a message of type t is numbered for replay.
// The client counts the same set.
func countedType(t string) bool {
	switch t {
	case "handshake", "sozvon-session", "sozvon-resumed":
		return false
	}
	return true
}

// replayRing keeps the last messages sent, numbered from 1.
type replayRing struct {
	msgs  [][]byte
	next  uint64 // the number the next message will get
	bytes int
}

func newReplayRing() *replayRing {
	return &replayRing{next: 1}
}

// push adds a message and returns its number.
func (r *replayRing) push(b []byte) uint64 {
	r.msgs = append(r.msgs, b)
	r.bytes += len(b)
	for len(r.msgs) > replayMaxMessages ||
		(len(r.msgs) > 1 && r.bytes > replayMaxBytes) {
		r.bytes -= len(r.msgs[0])
		r.msgs[0] = nil
		r.msgs = r.msgs[1:]
	}
	n := r.next
	r.next++
	return n
}

// after returns the messages following the first n, or false if some of
// them are no longer kept (or n is more than was ever sent).
func (r *replayRing) after(n uint64) ([][]byte, bool) {
	first := r.next - uint64(len(r.msgs))
	if n+1 < first || n >= r.next {
		return nil, false
	}
	return r.msgs[n+1-first:], true
}

// resumable sessions by client id
var resumables struct {
	mu       sync.Mutex
	sessions map[string]*webClient
}

func newResumeSecret() string {
	b := make([]byte, 16)
	rand.Read(b)
	return hex.EncodeToString(b)
}

// registerResumable makes c resumable, unless its id is empty or already
// taken by a live session.
func registerResumable(c *webClient) bool {
	if c.id == "" {
		return false
	}
	resumables.mu.Lock()
	defer resumables.mu.Unlock()
	if resumables.sessions == nil {
		resumables.sessions = make(map[string]*webClient)
	}
	if resumables.sessions[c.id] != nil {
		return false
	}
	resumables.sessions[c.id] = c
	return true
}

func unregisterResumable(c *webClient) {
	resumables.mu.Lock()
	defer resumables.mu.Unlock()
	if resumables.sessions[c.id] == c {
		delete(resumables.sessions, c.id)
	}
}

func lookupResumable(id, secret string) *webClient {
	resumables.mu.Lock()
	c := resumables.sessions[id]
	resumables.mu.Unlock()
	if c == nil || subtle.ConstantTimeCompare(
		[]byte(c.resumeSecret), []byte(secret)) != 1 {
		return nil
	}
	return c
}

// attachRequest asks the writer to carry on over a new connection.
type attachRequest struct {
	conn     *websocket.Conn
	received uint64 // numbered messages the client has received
	ack      uint64 // numbered messages we have received from it
	reply    chan attachResult
}

type attachResult struct {
	replayed int
	err      error
}

// resumeAction hands a new connection to the session's own goroutine.
type resumeAction struct {
	conn     *websocket.Conn
	received uint64
	reply    chan resumeReply
}

type resumeReply struct {
	err    error
	handed bool // the writer owns the connection now
}

// parseResume extracts the secret and the client's count from the value
// of a resume handshake.
func parseResume(v interface{}) (string, uint64, bool) {
	m, ok := v.(map[string]interface{})
	if !ok {
		return "", 0, false
	}
	secret, ok := m["secret"].(string)
	if !ok || secret == "" {
		return "", 0, false
	}
	n, ok := m["received"].(float64)
	if !ok || n < 0 || n != math.Trunc(n) || n > 1<<53 {
		return "", 0, false
	}
	return secret, uint64(n), true
}

func refuseResume(conn *websocket.Conn, why string) {
	conn.SetWriteDeadline(time.Now().Add(time.Second))
	conn.WriteMessage(websocket.CloseMessage,
		websocket.FormatCloseMessage(closeNoResume, why))
	conn.Close()
}

// resumeClient serves a handshake asking to resume session m.Id.  The
// connection is either handed over to that session or refused.
func resumeClient(conn *websocket.Conn, m clientMessage) error {
	secret, received, ok := parseResume(m.Value)
	var c *webClient
	if ok {
		c = lookupResumable(m.Id, secret)
	}
	if c == nil {
		connLogf("c=%v resume refused: no such session", connTag(m.Id))
		refuseResume(conn, "no such session")
		return nil
	}

	// The reply to the handshake goes out before the session's writer
	// owns the connection, so nothing else writes to it yet.
	conn.SetWriteDeadline(time.Now().Add(2 * time.Second))
	err := conn.WriteJSON(clientMessage{
		Type:    "handshake",
		Version: []string{protocolVersion},
	})
	if err != nil {
		conn.Close()
		return nil
	}
	conn.SetWriteDeadline(time.Time{})

	reply := make(chan resumeReply, 1)
	c.action(resumeAction{conn: conn, received: received, reply: reply})
	select {
	case r := <-reply:
		if !r.handed {
			refuseResume(conn, "session ended")
		}
	case <-c.done:
		// The session ended.  If it took the connection first, its
		// writer has closed it; otherwise the connection is still ours.
		select {
		case r := <-reply:
			if !r.handed {
				refuseResume(conn, "session ended")
			}
		default:
			refuseResume(conn, "session ended")
		}
	}
	return nil
}

func iceAlive(pc *webrtc.PeerConnection) bool {
	s := pc.ICEConnectionState()
	return s == webrtc.ICEConnectionStateConnected ||
		s == webrtc.ICEConnectionStateCompleted
}

// mediaAlive reports whether any of c's peer connections is connected.
func (c *webClient) mediaAlive() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	for _, u := range c.up {
		if iceAlive(u.pc) {
			return true
		}
	}
	for _, d := range c.down {
		if iceAlive(d.pc) {
			return true
		}
	}
	return false
}

// silenceLimit is how long a resumable client may go without sending
// anything, given whether its socket is gone and whether its media is alive.
func silenceLimit(detached, media bool) (time.Duration, error) {
	switch {
	case media:
		return resumeGrace, errResumeExpired
	case detached:
		return detachedNoMedia, errNoSignalling
	default:
		return silentNoMedia, errNoSignalling
	}
}
