package rtpconn

import (
	"testing"

	"github.com/leyvanah/sozvon/conn"
)

// fakeUp is a stream sent by the client with id owner.
type fakeUp struct {
	id, owner string
}

func (up *fakeUp) AddLocal(conn.Down) error { return nil }
func (up *fakeUp) DelLocal(conn.Down) bool  { return false }
func (up *fakeUp) Id() string               { return up.id }
func (up *fakeUp) Label() string            { return "camera" }
func (up *fakeUp) User() (string, string)   { return up.owner, up.owner }

// subscribe gives c a down connection for the stream up, as the SFU does
// when c receives it.
func subscribe(c *webClient, up *fakeUp) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.down == nil {
		c.down = make(map[string]*rtpDownConnection)
	}
	c.down[up.id] = &rtpDownConnection{id: up.id, remote: up}
}

func unsubscribe(c *webClient, id string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.down, id)
}

// relayed reports whether a sozvon-bitrate request from c to dest reaches
// dest through the server.
func relayed(t *testing.T, c, dest *webClient, value any) bool {
	t.Helper()
	err := handleClientMessage(c, clientMessage{
		Type:   "usermessage",
		Source: c.id,
		Dest:   dest.id,
		Kind:   bitrateAskKind,
		Value:  value,
	})
	if err != nil {
		t.Fatalf("handleClientMessage: %v", err)
	}
	select {
	case m := <-dest.writeCh:
		mm, ok := m.(clientMessage)
		if !ok || mm.Kind != bitrateAskKind {
			t.Fatalf("unexpected message %#v", m)
		}
		return true
	default:
		return false
	}
}

// A participant can no longer hold someone's video at the floor without
// receiving it (sozvon-tasks#35): the request must name a stream the
// requester receives from the one it is sent to.
func TestBitrateAskNeedsSubscription(t *testing.T) {
	setupGroupWith(t, "bitrate", `{"users": {
		"alice": {"password": "a", "permissions": "present"},
		"bob":   {"password": "b", "permissions": "present"},
		"eve":   {"password": "e", "permissions": "message"}
	}}`)
	alice := joinForTest(t, "bitrate", "alice-id", "alice", "a")
	bob := joinForTest(t, "bitrate", "bob-id", "bob", "b")
	eve := joinForTest(t, "bitrate", "eve-id", "eve", "e")
	for _, c := range []*webClient{alice, bob, eve} {
		c.writeCh = make(chan interface{}, 8)
	}

	camera := &fakeUp{id: "alice-camera", owner: alice.id}
	ask := map[string]any{"stream": camera.id, "cap": 150000.0}
	lift := map[string]any{"stream": camera.id, "cap": nil}

	subscribe(bob, camera)
	if !relayed(t, bob, alice, ask) {
		t.Error("a receiver's request was dropped")
	}

	if relayed(t, eve, alice, ask) {
		t.Error("a request from someone not receiving the stream was relayed")
	}

	// Eve received the stream, then unsubscribed.
	subscribe(eve, camera)
	if !relayed(t, eve, alice, ask) {
		t.Error("a subscribed request was dropped")
	}
	unsubscribe(eve, camera.id)
	if relayed(t, eve, alice, ask) {
		t.Error("a request after unsubscribing was relayed")
	}

	// Lifting needs no subscription: a receiver lifts on leaving the stream.
	if !relayed(t, eve, alice, lift) {
		t.Error("lifting a cap was dropped")
	}
	if !relayed(t, eve, alice, map[string]any{"stream": camera.id}) {
		t.Error("a request with no cap was dropped")
	}

	// The stream must belong to the one the request is sent to.
	if relayed(t, bob, eve, ask) {
		t.Error("a request sent to someone other than the stream's owner was relayed")
	}

	// Malformed requests go nowhere.
	for _, v := range []any{
		nil, "x", 150000.0,
		map[string]any{"cap": 150000.0},
		map[string]any{"stream": 1.0, "cap": 150000.0},
		map[string]any{"stream": "", "cap": nil},
	} {
		if relayed(t, bob, alice, v) {
			t.Errorf("malformed request %#v was relayed", v)
		}
	}
}

// Broadcasting a cap reaches everyone without naming an owner, so it is
// never relayed.
func TestBitrateAskNotBroadcast(t *testing.T) {
	c := &webClient{id: "c"}
	subscribe(c, &fakeUp{id: "s", owner: "o"})
	if bitrateAskAllowed(c, "", map[string]any{"stream": "s", "cap": 1.0}) {
		t.Error("a broadcast request was allowed")
	}
	if !bitrateAskAllowed(c, "o", map[string]any{"stream": "s", "cap": 1.0}) {
		t.Error("a request to the stream's owner was refused")
	}
}
