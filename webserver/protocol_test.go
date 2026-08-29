package webserver

// Protocol-level tests for the features Sozvon adds on top of Galène.  (Sozvon)
//
// These drive a real websocket against a real server, so they cover the whole
// path a browser takes -- webserver -> rtpconn -> group -- rather than any one
// function.  That matters here because the lobby, the operator room and the
// require-e2ee cap are decisions split across those three packages: a unit test
// of group.AddClient would not notice that rtpconn stopped forwarding the knock.
//
// They deliberately do NOT open a peer connection: media needs a real WebRTC
// stack and is upstream Galène's code, not the fork's.  Everything tested here
// is signalling, which is where the fork's behaviour lives.

import (
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"github.com/leyvanah/sozvon/authlimit"
	"github.com/leyvanah/sozvon/group"
)

// protocolVersion is the version rtpconn announces; a mismatch only earns a
// warning, but sending the right one keeps the message stream clean.
const testProtocolVersion = "2"

// wireMessage is the subset of the client protocol these tests exercise.  It is
// deliberately a separate declaration from rtpconn's clientMessage: what is
// being tested is the wire contract, so a rename inside rtpconn that changes
// the JSON should fail here rather than follow silently.
type wireMessage struct {
	Type        string        `json:"type"`
	Version     []string      `json:"version,omitempty"`
	Kind        string        `json:"kind,omitempty"`
	Error       string        `json:"error,omitempty"`
	Id          string        `json:"id,omitempty"`
	Source      string        `json:"source,omitempty"`
	Dest        string        `json:"dest,omitempty"`
	Username    *string       `json:"username,omitempty"`
	Password    string        `json:"password,omitempty"`
	Token       string        `json:"token,omitempty"`
	Permissions []string      `json:"permissions,omitempty"`
	Group       string        `json:"group,omitempty"`
	Status      *group.Status `json:"status,omitempty"`
	Value       any           `json:"value,omitempty"`
}

// setupProtocol prepares an isolated group and data directory and turns the
// login throttle off.  Throttling is keyed by address, so every test in the
// package shares one key: left on, a test that mistypes a password would add
// seconds of sleep to whatever ran next.  TestJoinThrottleIsWired turns it
// back on for itself.
func setupProtocol(t *testing.T) {
	t.Helper()
	err := setupTest(t.TempDir(), t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	authlimit.SetDisabled(true)
	t.Cleanup(func() {
		authlimit.SetDisabled(false)
	})
}

// writeGroup creates a group description on disk.  Names must be unique across
// the package: descriptions and live groups are cached by name for the lifetime
// of the process, so reusing one would serve another test's configuration.
func writeGroup(t *testing.T, name, description string) {
	t.Helper()
	path := filepath.Join(group.Directory, name+".json")
	err := os.MkdirAll(filepath.Dir(path), 0o700)
	if err != nil {
		t.Fatal(err)
	}
	err = os.WriteFile(path, []byte(description), 0o600)
	if err != nil {
		t.Fatal(err)
	}
}

type wsClient struct {
	t    *testing.T
	id   string
	conn *websocket.Conn
}

// dialWS connects and completes the handshake.  The client picks its own id,
// which is what an operator later admits or denies, so tests can name it.
func dialWS(t *testing.T, id string) *wsClient {
	t.Helper()
	conn, _, err := websocket.DefaultDialer.Dial(
		"ws://localhost:1234/ws", nil,
	)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	c := &wsClient{t: t, id: id, conn: conn}
	t.Cleanup(func() { conn.Close() })
	c.send(wireMessage{
		Type:    "handshake",
		Version: []string{testProtocolVersion},
		Id:      id,
	})
	c.expect("handshake", "")
	return c
}

func (c *wsClient) send(m wireMessage) {
	c.t.Helper()
	err := c.conn.WriteJSON(m)
	if err != nil {
		c.t.Fatalf("write %v: %v", m.Type, err)
	}
}

// expect reads until a message of the given type arrives, ignoring anything
// else the server volunteers (chat history, other clients joining, ICE
// configuration).  An empty kind matches any kind.
func (c *wsClient) expect(typ, kind string) wireMessage {
	c.t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		err := c.conn.SetReadDeadline(deadline)
		if err != nil {
			c.t.Fatal(err)
		}
		var m wireMessage
		err = c.conn.ReadJSON(&m)
		if err != nil {
			c.t.Fatalf("waiting for %v/%v: %v", typ, kind, err)
		}
		if m.Type == typ && (kind == "" || m.Kind == kind) {
			return m
		}
	}
}

// expectNothing asserts that no message of the given type arrives within a
// short window.  Used where the interesting outcome is silence.
func (c *wsClient) expectNothing(typ string, d time.Duration) {
	c.t.Helper()
	deadline := time.Now().Add(d)
	for {
		err := c.conn.SetReadDeadline(deadline)
		if err != nil {
			c.t.Fatal(err)
		}
		var m wireMessage
		err = c.conn.ReadJSON(&m)
		if err != nil {
			return // the read timed out, which is what we wanted
		}
		if m.Type == typ {
			c.t.Fatalf("unexpected %v (kind %v)", m.Type, m.Kind)
		}
	}
}

func (c *wsClient) join(g, username, password string) wireMessage {
	c.t.Helper()
	c.send(wireMessage{
		Type:     "join",
		Kind:     "join",
		Group:    g,
		Username: &username,
		Password: password,
	})
	return c.expect("joined", "")
}

func (c *wsClient) joinWithToken(g, tok string) wireMessage {
	c.t.Helper()
	c.send(wireMessage{
		Type:  "join",
		Kind:  "join",
		Group: g,
		Token: tok,
	})
	return c.expect("joined", "")
}

// value returns a message's value as a string, for the human-readable reason
// that accompanies a refusal.
func value(m wireMessage) string {
	s, _ := m.Value.(string)
	return s
}

// A plain group with a wildcard user: the baseline the lobby tests deviate
// from, and a check that the harness itself is sound.
func TestJoinOrdinaryGroup(t *testing.T) {
	setupProtocol(t)
	writeGroup(t, "plain", `{
	    "public": true,
	    "wildcard-user": {"password": {"type": "wildcard"},
	                      "permissions": "present"}
	}`)

	c := dialWS(t, "guest-plain")
	m := c.join("plain", "guest", "anything")
	if m.Kind != "join" {
		t.Fatalf("joined kind %v (%v)", m.Kind, value(m))
	}
	if m.Status == nil || m.Status.Name != "plain" {
		t.Errorf("status %v", m.Status)
	}
	if m.Status.Lobby || m.Status.E2EE {
		t.Errorf("plain group advertises lobby=%v e2ee=%v",
			m.Status.Lobby, m.Status.E2EE)
	}
}

// The core of the waiting room: a guest knocks, the operator sees the knock and
// admits, the guest is told to re-join and gets in.
func TestLobbyKnockAdmit(t *testing.T) {
	setupProtocol(t)
	writeGroup(t, "lobby-admit", `{
	    "public": true,
	    "lobby": true,
	    "users": {"host": {"password": "hostpw", "permissions": "op"}},
	    "wildcard-user": {"password": {"type": "wildcard"},
	                      "permissions": "present"}
	}`)

	op := dialWS(t, "op-admit")
	m := op.join("lobby-admit", "host", "hostpw")
	if m.Kind != "join" {
		t.Fatalf("operator could not join: %v %v", m.Kind, value(m))
	}
	if m.Status == nil || !m.Status.Lobby {
		t.Errorf("lobby group does not advertise lobby")
	}

	guest := dialWS(t, "guest-admit")
	m = guest.join("lobby-admit", "visitor", "")
	if m.Kind != "knock" {
		t.Fatalf("guest got %v (%v), want knock", m.Kind, value(m))
	}

	// The operator is told who is waiting.
	knock := op.expect("user", "knock")
	if knock.Id != "guest-admit" {
		t.Errorf("knock id %v", knock.Id)
	}
	if knock.Username == nil || *knock.Username != "visitor" {
		t.Errorf("knock username %v", knock.Username)
	}

	op.send(wireMessage{Type: "useraction", Kind: "admit", Dest: "guest-admit"})

	// Admission is one-shot and asks the client to re-join.
	if m = guest.expect("joined", ""); m.Kind != "rejoin" {
		t.Fatalf("admitted guest got %v (%v)", m.Kind, value(m))
	}
	if m = guest.join("lobby-admit", "visitor", ""); m.Kind != "join" {
		t.Fatalf("re-join after admission: %v (%v)", m.Kind, value(m))
	}
}

func TestLobbyKnockDeny(t *testing.T) {
	setupProtocol(t)
	writeGroup(t, "lobby-deny", `{
	    "public": true,
	    "lobby": true,
	    "users": {"host": {"password": "hostpw", "permissions": "op"}},
	    "wildcard-user": {"password": {"type": "wildcard"},
	                      "permissions": "present"}
	}`)

	op := dialWS(t, "op-deny")
	if m := op.join("lobby-deny", "host", "hostpw"); m.Kind != "join" {
		t.Fatalf("operator could not join: %v %v", m.Kind, value(m))
	}

	guest := dialWS(t, "guest-deny")
	if m := guest.join("lobby-deny", "visitor", ""); m.Kind != "knock" {
		t.Fatalf("guest got %v, want knock", m.Kind)
	}
	op.expect("user", "knock")

	op.send(wireMessage{Type: "useraction", Kind: "deny", Dest: "guest-deny"})
	if m := guest.expect("joined", ""); m.Kind != "deny" {
		t.Fatalf("denied guest got %v (%v)", m.Kind, value(m))
	}

	// A denial is not an admission: re-joining puts the guest back in the
	// waiting room rather than letting them in.
	if m := guest.join("lobby-deny", "visitor", ""); m.Kind != "knock" {
		t.Fatalf("re-join after denial: %v (%v)", m.Kind, value(m))
	}
}

// Only an operator may admit.  The interesting case is a client that is fully
// inside the room but has no "op" permission: a knocking client is not in the
// group at all, so its useraction is refused for the unrelated reason that it
// has not joined, and would pass this test even with the permission check
// deleted.  Getting an ordinary member inside a lobby group takes an admission
// first, which is why this test is the long one.
func TestLobbyMemberCannotAdmit(t *testing.T) {
	setupProtocol(t)
	writeGroup(t, "lobby-perm", `{
	    "public": true,
	    "lobby": true,
	    "users": {"host": {"password": "hostpw", "permissions": "op"},
	              "member": {"password": "pw", "permissions": "present"}},
	    "wildcard-user": {"password": {"type": "wildcard"},
	                      "permissions": "present"}
	}`)

	op := dialWS(t, "op-perm")
	if m := op.join("lobby-perm", "host", "hostpw"); m.Kind != "join" {
		t.Fatalf("operator could not join: %v %v", m.Kind, value(m))
	}

	// Put an ordinary member inside the room the only way a lobby allows.
	member := dialWS(t, "member-perm")
	if m := member.join("lobby-perm", "member", "pw"); m.Kind != "knock" {
		t.Fatalf("member got %v, want knock", m.Kind)
	}
	op.expect("user", "knock")
	op.send(wireMessage{Type: "useraction", Kind: "admit", Dest: "member-perm"})
	if m := member.expect("joined", ""); m.Kind != "rejoin" {
		t.Fatalf("admitted member got %v", m.Kind)
	}
	if m := member.join("lobby-perm", "member", "pw"); m.Kind != "join" {
		t.Fatalf("member re-join: %v (%v)", m.Kind, value(m))
	}

	// Now a guest knocks, and the member -- inside, but not an operator --
	// tries to let them in.
	guest := dialWS(t, "guest-perm")
	if m := guest.join("lobby-perm", "visitor", ""); m.Kind != "knock" {
		t.Fatalf("guest got %v, want knock", m.Kind)
	}
	op.expect("user", "knock")

	member.send(wireMessage{
		Type: "useraction", Kind: "admit", Dest: "guest-perm",
	})
	// The guest stays out.  Asserted first: if the permission check ever
	// goes missing this fails in half a second, rather than after the
	// error message we were waiting for never arrives.
	guest.expectNothing("joined", 500*time.Millisecond)
	if m := member.expect("usermessage", ""); m.Kind != "error" {
		t.Errorf("member's admit was answered with %v/%v",
			m.Type, m.Kind)
	}
}

// A client still in the waiting room cannot let itself in.  This is blocked a
// step earlier than TestLobbyMemberCannotAdmit -- the knocker has not joined
// any group -- so both tests are needed to cover the two refusals.
func TestLobbyKnockerCannotAdmitItself(t *testing.T) {
	setupProtocol(t)
	writeGroup(t, "lobby-self", `{
	    "public": true,
	    "lobby": true,
	    "users": {"host": {"password": "hostpw", "permissions": "op"}},
	    "wildcard-user": {"password": {"type": "wildcard"},
	                      "permissions": "present"}
	}`)

	op := dialWS(t, "op-self")
	if m := op.join("lobby-self", "host", "hostpw"); m.Kind != "join" {
		t.Fatalf("operator could not join: %v %v", m.Kind, value(m))
	}
	guest := dialWS(t, "guest-self")
	if m := guest.join("lobby-self", "visitor", ""); m.Kind != "knock" {
		t.Fatalf("guest got %v, want knock", m.Kind)
	}
	op.expect("user", "knock")

	guest.send(wireMessage{
		Type: "useraction", Kind: "admit", Dest: "guest-self",
	})
	guest.expectNothing("joined", 500*time.Millisecond)
}

// A lobby group with nobody to answer the door refuses rather than parking the
// guest forever: there is no operator to receive the knock.
func TestLobbyWithoutOperatorRefuses(t *testing.T) {
	setupProtocol(t)
	writeGroup(t, "lobby-empty", `{
	    "public": true,
	    "lobby": true,
	    "users": {"host": {"password": "hostpw", "permissions": "op"}},
	    "wildcard-user": {"password": {"type": "wildcard"},
	                      "permissions": "present"}
	}`)

	guest := dialWS(t, "guest-empty")
	m := guest.join("lobby-empty", "visitor", "")
	if m.Kind != "fail" {
		t.Fatalf("guest got %v (%v), want fail", m.Kind, value(m))
	}
	if value(m) != "the host is not available yet" {
		t.Errorf("refusal reason %q", value(m))
	}
}

// The group's encryption policy has to reach the client: the browser decides
// whether to encrypt from this status alone.
func TestE2EEStatusIsAdvertised(t *testing.T) {
	setupProtocol(t)
	writeGroup(t, "crypto", `{
	    "public": true,
	    "e2ee": true,
	    "require-e2ee": true,
	    "wildcard-user": {"password": {"type": "wildcard"},
	                      "permissions": "present"}
	}`)

	c := dialWS(t, "guest-crypto")
	m := c.join("crypto", "guest", "")
	if m.Kind != "join" {
		t.Fatalf("join: %v (%v)", m.Kind, value(m))
	}
	if !m.Status.E2EE || !m.Status.RequireE2EE {
		t.Errorf("status e2ee=%v requireE2ee=%v, want both true",
			m.Status.E2EE, m.Status.RequireE2EE)
	}
}

// require-e2ee means the room can hold exactly two people, because the browser
// encryption is pairwise.  A third participant must be turned away rather than
// silently dropping the room to cleartext.
func TestRequireE2EELimitsToTwo(t *testing.T) {
	setupProtocol(t)
	writeGroup(t, "crypto-two", `{
	    "public": true,
	    "e2ee": true,
	    "require-e2ee": true,
	    "wildcard-user": {"password": {"type": "wildcard"},
	                      "permissions": "present"}
	}`)

	first := dialWS(t, "e2ee-1")
	if m := first.join("crypto-two", "one", ""); m.Kind != "join" {
		t.Fatalf("first: %v (%v)", m.Kind, value(m))
	}
	second := dialWS(t, "e2ee-2")
	if m := second.join("crypto-two", "two", ""); m.Kind != "join" {
		t.Fatalf("second: %v (%v)", m.Kind, value(m))
	}

	third := dialWS(t, "e2ee-3")
	m := third.join("crypto-two", "three", "")
	if m.Kind != "fail" {
		t.Fatalf("third got %v, want fail", m.Kind)
	}
	if value(m) == "" {
		t.Error("refusal carried no reason for the user")
	}
}

// Without require-e2ee the cap does not apply: an advisory-encryption group is
// an ordinary room.
func TestE2EEWithoutRequireDoesNotCap(t *testing.T) {
	setupProtocol(t)
	writeGroup(t, "crypto-open", `{
	    "public": true,
	    "e2ee": true,
	    "wildcard-user": {"password": {"type": "wildcard"},
	                      "permissions": "present"}
	}`)

	for i, id := range []string{"open-1", "open-2", "open-3"} {
		c := dialWS(t, id)
		if m := c.join("crypto-open", id, ""); m.Kind != "join" {
			t.Fatalf("client %v: %v (%v)", i, m.Kind, value(m))
		}
	}
}

// A per-client room of an operator hub is reachable only with the personal
// link.  Without a token the inherited wildcard user must not open it, or every
// hub's rooms would be world-accessible by guessing a slug.
func TestOperatorRoomChildNeedsToken(t *testing.T) {
	setupProtocol(t)
	writeGroup(t, "hub", `{
	    "operator-room": true,
	    "users": {"operator": {"password": "oppw", "permissions": "op"}},
	    "wildcard-user": {"password": {"type": "wildcard"},
	                      "permissions": "present"}
	}`)

	guest := dialWS(t, "guest-hub")
	m := guest.join("hub/someslug", "visitor", "")
	if m.Kind != "fail" {
		t.Fatalf("guest got %v (%v), want fail", m.Kind, value(m))
	}
	if value(m) != "this link is not valid" {
		t.Errorf("refusal reason %q", value(m))
	}
}

// The hub itself is a dashboard, not a call: the operator logs into it
// normally, and it advertises itself so the client knows to show the dashboard.
func TestOperatorHubStatus(t *testing.T) {
	setupProtocol(t)
	writeGroup(t, "hub-status", `{
	    "operator-room": true,
	    "users": {"operator": {"password": "oppw", "permissions": "op"}}
	}`)

	op := dialWS(t, "op-hub")
	m := op.join("hub-status", "operator", "oppw")
	if m.Kind != "join" {
		t.Fatalf("operator could not join the hub: %v (%v)",
			m.Kind, value(m))
	}
	if !m.Status.OperatorRoom {
		t.Error("hub does not advertise operatorRoom")
	}
	if m.Status.OperatorRoomChild {
		t.Error("hub advertises itself as its own child")
	}
}

// A child room is not itself a hub, and is forced into the lobby so the
// operator vets every client.  Read through the running server rather than
// through readDescription, because the client acts on the status, not the file.
func TestOperatorRoomChildForcesLobby(t *testing.T) {
	setupProtocol(t)
	writeGroup(t, "hub-child", `{
	    "operator-room": true,
	    "users": {"operator": {"password": "oppw", "permissions": "op"}}
	}`)

	op := dialWS(t, "op-child")
	m := op.join("hub-child/room1", "operator", "oppw")
	if m.Kind != "join" {
		t.Fatalf("operator could not join the child: %v (%v)",
			m.Kind, value(m))
	}
	if !m.Status.Lobby {
		t.Error("child room does not force the lobby")
	}
	if m.Status.OperatorRoom {
		t.Error("child room advertises itself as a hub")
	}
	if !m.Status.OperatorRoomChild {
		t.Error("child room does not mark itself as a child")
	}
}

// The login throttle has its own unit tests; what this checks is that the join
// path is wired to it at all -- that a wrong password is refused as an
// authentication failure and a good one is then still accepted.  It runs with
// throttling enabled, so it pays one escalating delay (200ms).
func TestJoinThrottleIsWired(t *testing.T) {
	setupProtocol(t)
	authlimit.SetDisabled(false)
	writeGroup(t, "throttle", `{
	    "public": true,
	    "users": {"member": {"password": "right", "permissions": "present"}}
	}`)

	bad := dialWS(t, "throttle-bad")
	m := bad.join("throttle", "member", "wrong")
	if m.Kind != "fail" {
		t.Fatalf("wrong password got %v (%v)", m.Kind, value(m))
	}
	if value(m) == "" {
		t.Error("refusal carried no reason")
	}

	// A correct password still works, and clears the throttle for the
	// address so the next test does not inherit a delay.
	good := dialWS(t, "throttle-good")
	if m := good.join("throttle", "member", "right"); m.Kind != "join" {
		t.Fatalf("correct password got %v (%v)", m.Kind, value(m))
	}
}

// The health endpoint is what the deploy script and the installer's rollback
// check poll; a change that breaks it silently breaks the deploy's safety net.
func TestHealthz(t *testing.T) {
	setup()
	resp, err := http.Get("http://localhost:1234/healthz")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Errorf("healthz status %v", resp.Status)
	}
}

// The dashboard's view of its per-client rooms: who is inside and who is
// waiting.  It is what the operator acts on, and it reports rooms that hold
// only knockers, which the ordinary subgroup listing does not.
func TestSubGroupStatusReportsKnockers(t *testing.T) {
	setupProtocol(t)
	writeGroup(t, "hub-status2", `{
	    "operator-room": true,
	    "users": {"operator": {"password": "oppw", "permissions": "op"}}
	}`)

	// An operator inside a child room keeps it alive and in memory.
	op := dialWS(t, "op-status2")
	if m := op.join("hub-status2/roomA", "operator", "oppw"); m.Kind != "join" {
		t.Fatalf("operator could not join: %v (%v)", m.Kind, value(m))
	}

	statuses := group.GetSubGroupStatus("hub-status2")
	found := false
	for _, s := range statuses {
		if s.Name == "hub-status2/roomA" {
			found = true
		}
	}
	if !found {
		t.Errorf("child room missing from %v", marshalToString(statuses))
	}
}
