package rtpconn

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestReplayRing(t *testing.T) {
	r := newReplayRing()
	if msgs, ok := r.after(0); !ok || len(msgs) != 0 {
		t.Fatalf("empty ring: %v %v", msgs, ok)
	}
	for i := 0; i < 3; i++ {
		r.push([]byte{byte('a' + i)})
	}
	msgs, ok := r.after(1)
	if !ok || len(msgs) != 2 || string(msgs[0]) != "b" {
		t.Errorf("after(1) = %q %v", msgs, ok)
	}
	if msgs, ok := r.after(3); !ok || len(msgs) != 0 {
		t.Errorf("after(3) = %q %v", msgs, ok)
	}
	if _, ok := r.after(4); ok {
		t.Errorf("after(4) succeeded, but only 3 were sent")
	}

	for i := 0; i < replayMaxMessages; i++ {
		r.push([]byte("x"))
	}
	if _, ok := r.after(2); ok {
		t.Errorf("after(2) succeeded, but those messages are gone")
	}
	if msgs, ok := r.after(3); !ok || len(msgs) != replayMaxMessages {
		t.Errorf("after(3): %v messages, %v", len(msgs), ok)
	}

	big := newReplayRing()
	big.push(make([]byte, replayMaxBytes))
	big.push([]byte("y"))
	if msgs, ok := big.after(1); !ok || string(msgs[0]) != "y" {
		t.Errorf("byte bound: %q %v", msgs, ok)
	}
	if _, ok := big.after(0); ok {
		t.Errorf("byte bound: the big message was kept")
	}
}

func TestParseResume(t *testing.T) {
	good := map[string]interface{}{"secret": "s", "received": float64(7)}
	if s, n, ok := parseResume(good); !ok || s != "s" || n != 7 {
		t.Errorf("parseResume(good) = %v %v %v", s, n, ok)
	}
	for _, v := range []interface{}{
		nil,
		"s",
		map[string]interface{}{"secret": "", "received": float64(1)},
		map[string]interface{}{"secret": "s"},
		map[string]interface{}{"secret": "s", "received": float64(-1)},
		map[string]interface{}{"secret": "s", "received": 1.5},
	} {
		if _, _, ok := parseResume(v); ok {
			t.Errorf("parseResume(%v) succeeded", v)
		}
	}
}

func TestSilenceLimit(t *testing.T) {
	if d, err := silenceLimit(true, true); d != resumeGrace ||
		!errors.Is(err, errResumeExpired) {
		t.Errorf("live media: %v %v", d, err)
	}
	if d, _ := silenceLimit(false, true); d != resumeGrace {
		t.Errorf("live media, silent socket: %v", d)
	}
	if d, err := silenceLimit(true, false); d != detachedNoMedia ||
		!errors.Is(err, errNoSignalling) {
		t.Errorf("no media, socket gone: %v %v", d, err)
	}
	if d, _ := silenceLimit(false, false); d != silentNoMedia {
		t.Errorf("no media, silent socket: %v", d)
	}
	// A live client is pinged well before it may be dropped.
	if resumePing >= detachedNoMedia || detachedNoMedia > silentNoMedia {
		t.Errorf("limits out of order")
	}
}

// wsServer serves sessions the way the web server does.
func wsServer(t *testing.T) string {
	upgrader := websocket.Upgrader{}
	s := httptest.NewServer(http.HandlerFunc(
		func(w http.ResponseWriter, r *http.Request) {
			conn, err := upgrader.Upgrade(w, r, nil)
			if err != nil {
				return
			}
			go StartClient(conn, nil)
		}))
	t.Cleanup(s.Close)
	return "ws" + strings.TrimPrefix(s.URL, "http")
}

func dial(t *testing.T, url string, hello clientMessage) *websocket.Conn {
	t.Helper()
	conn, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { conn.Close() })
	hello.Type = "handshake"
	hello.Version = []string{protocolVersion}
	if err := conn.WriteJSON(hello); err != nil {
		t.Fatalf("handshake: %v", err)
	}
	return conn
}

func expect(t *testing.T, conn *websocket.Conn, typ string) clientMessage {
	t.Helper()
	conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	var m clientMessage
	if err := conn.ReadJSON(&m); err != nil {
		t.Fatalf("waiting for %v: %v", typ, err)
	}
	if m.Type != typ {
		t.Fatalf("got %v, expected %v", m.Type, typ)
	}
	return m
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %v", what)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func registered(id string) *webClient {
	resumables.mu.Lock()
	defer resumables.mu.Unlock()
	return resumables.sessions[id]
}

// openResumable starts a resumable session and returns its connection
// and secret.
func openResumable(t *testing.T, url, id string) (*websocket.Conn, string) {
	t.Helper()
	conn := dial(t, url, clientMessage{Id: id, Kind: "sozvon-resumable"})
	expect(t, conn, "handshake")
	m := expect(t, conn, "sozvon-session")
	secret, _ := m.Value.(string)
	if len(secret) != 32 {
		t.Fatalf("secret %q", secret)
	}
	return conn, secret
}

// cut drops a connection without a closing handshake, as a lost network
// path does.
func cut(conn *websocket.Conn) {
	conn.UnderlyingConn().Close()
}

func TestResumeKeepsSession(t *testing.T) {
	url := wsServer(t)
	ws1, secret := openResumable(t, url, "resume-keeps")
	c := registered("resume-keeps")
	if c == nil {
		t.Fatal("session not registered")
	}

	// one numbered message each way
	ws1.WriteJSON(clientMessage{Type: "ping"})
	expect(t, ws1, "pong")

	cut(ws1)
	// While the client is away, the server has something to say.
	c.write(clientMessage{Type: "usermessage", Kind: "test", Value: "1"})
	c.write(clientMessage{Type: "usermessage", Kind: "test", Value: "2"})

	ws2 := dial(t, url, clientMessage{
		Id:   "resume-keeps",
		Kind: "sozvon-resume",
		Value: map[string]interface{}{
			"secret": secret, "received": 1,
		},
	})
	expect(t, ws2, "handshake")
	m := expect(t, ws2, "sozvon-resumed")
	if n, _ := m.Value.(float64); n != 1 {
		t.Errorf("server says it received %v, expected 1", m.Value)
	}
	for _, v := range []string{"1", "2"} {
		m := expect(t, ws2, "usermessage")
		if m.Value != v {
			t.Errorf("replayed %v, expected %v", m.Value, v)
		}
	}
	ws2.WriteJSON(clientMessage{Type: "ping"})
	expect(t, ws2, "pong")
	if registered("resume-keeps") != c {
		t.Error("the session was replaced")
	}

	// Leaving on purpose ends the session at once.
	ws2.WriteMessage(websocket.CloseMessage,
		websocket.FormatCloseMessage(websocket.CloseGoingAway, ""))
	waitFor(t, "the session to end", func() bool {
		return registered("resume-keeps") == nil
	})
}

func TestResumeRefused(t *testing.T) {
	url := wsServer(t)
	ws1, secret := openResumable(t, url, "resume-refused")

	try := func(id, secret string, received int) error {
		ws := dial(t, url, clientMessage{
			Id:   id,
			Kind: "sozvon-resume",
			Value: map[string]interface{}{
				"secret": secret, "received": received,
			},
		})
		ws.SetReadDeadline(time.Now().Add(5 * time.Second))
		for {
			var m clientMessage
			if err := ws.ReadJSON(&m); err != nil {
				return err
			}
		}
	}

	refused := func(err error) bool {
		return websocket.IsCloseError(err, closeNoResume)
	}
	if err := try("resume-refused", "wrong", 0); !refused(err) {
		t.Errorf("wrong secret: %v", err)
	}
	if err := try("nobody", secret, 0); !refused(err) {
		t.Errorf("unknown id: %v", err)
	}
	if registered("resume-refused") == nil {
		t.Error("a refused attempt ended the session")
	}
	// more than the server ever sent
	if err := try("resume-refused", secret, 5); !refused(err) {
		t.Errorf("impossible count: %v", err)
	}
	waitFor(t, "the session to end", func() bool {
		return registered("resume-refused") == nil
	})
	ws1.Close()
}

func TestNotResumable(t *testing.T) {
	url := wsServer(t)
	ws := dial(t, url, clientMessage{Id: "plain"})
	expect(t, ws, "handshake")
	ws.WriteJSON(clientMessage{Type: "ping"})
	// no secret for a client that did not ask
	expect(t, ws, "pong")
	if registered("plain") != nil {
		t.Error("a client that did not opt in is resumable")
	}
}

func TestDuplicateIdNotResumable(t *testing.T) {
	url := wsServer(t)
	openResumable(t, url, "dup")
	ws := dial(t, url, clientMessage{Id: "dup", Kind: "sozvon-resumable"})
	expect(t, ws, "handshake")
	ws.WriteJSON(clientMessage{Type: "ping"})
	// the second session gets no secret
	expect(t, ws, "pong")
}
