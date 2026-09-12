package group

import (
	"os"
	"path/filepath"
	"testing"
)

// Tests for the bookkeeping behind the waiting room. (Sozvon)
//
// The behaviour a browser sees — a guest knocks, the operator admits or
// denies, the guest gets in or does not — is covered end to end by
// webserver/protocol_test.go, over a real websocket, and that is the right
// level for it: it also catches rtpconn dropping the knock on the way.
//
// What a protocol test cannot see is the state the group keeps while that
// happens: `admitted` holds a one-shot permission to bypass the lobby, and
// `knocking` holds the pending requests an operator acts on. Both are
// unexported, so only a test inside this package can assert they are emptied
// when they should be. Neither is visible from outside: delete the line that
// spends the admission, or the line that drops a denied request, and every
// websocket test still passes while the group quietly keeps a permission or a
// ghost request. These tests exist for exactly that, and each one fails if its
// line is removed.

// setupGroups points the package at empty directories and empties the group
// registry, which is global and would otherwise carry groups between tests.
func setupGroups(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	if err := setupTest(dir, t.TempDir(), true); err != nil {
		t.Fatalf("setupTest: %v", err)
	}
	groups.groups = nil
	return dir
}

// writeGroup writes a group description straight to disk.  It cannot go
// through UpdateDescription, which refuses any description carrying users.
func writeGroup(t *testing.T, dir, name, conf string) {
	t.Helper()
	filename := filepath.Join(dir, name+".json")
	if err := os.MkdirAll(filepath.Dir(filename), 0o700); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	if err := os.WriteFile(filename, []byte(conf), 0o600); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
}

// A room with a lobby, one operator account and anonymous guests.
const lobbyConf = `{
	"lobby": true,
	"users": {"boss": {"password": "oppass", "permissions": "op"}},
	"wildcard-user": {
		"password": {"type": "wildcard"},
		"permissions": "present"
	}
}`

func opCreds() ClientCredentials {
	username := "boss"
	return ClientCredentials{Username: &username, Password: "oppass"}
}

func guestCreds(username string) ClientCredentials {
	return ClientCredentials{Username: &username}
}

// addOperator joins an operator and fails the test if it cannot get in.
func addOperator(t *testing.T, group string, c *fakeClient) *Group {
	t.Helper()
	g, err := AddClient(group, c, opCreds())
	if err != nil {
		t.Fatalf("AddClient(operator): %v", err)
	}
	return g
}

// knock puts a guest in the lobby and fails the test if it got anywhere else.
func knock(t *testing.T, group string, c *fakeClient, username string) {
	t.Helper()
	if _, err := AddClient(group, c, guestCreds(username)); err != ErrKnocking {
		t.Fatalf("guest %v: got %v, expected ErrKnocking", c.id, err)
	}
}

// An admission is spent by the re-join it authorises.  If it were not, the
// entry would sit in `admitted` for the lifetime of the group and let that
// client id walk back in past the lobby.
func TestLobbyAdmissionIsConsumed(t *testing.T) {
	dir := setupGroups(t)
	writeGroup(t, dir, "admit", lobbyConf)

	op := &fakeClient{id: "op-1"}
	g := addOperator(t, "admit", op)

	guest := &fakeClient{id: "guest-1"}
	knock(t, "admit", guest, "visitor")

	if err := g.Admit("guest-1"); err != nil {
		t.Fatalf("Admit: %v", err)
	}
	if !g.admitted["guest-1"] {
		t.Fatalf("Admit did not record the admission")
	}
	if kind := guest.lastJoined(); kind != "rejoin" {
		t.Errorf("admitted guest: got %v, expected rejoin", kind)
	}

	if _, err := AddClient("admit", guest, guestCreds("visitor")); err != nil {
		t.Fatalf("admitted guest could not re-join: %v", err)
	}
	if _, held := g.admitted["guest-1"]; held {
		t.Errorf("the admission outlived the re-join it authorised")
	}
}

// Denying a request must drop it, not merely tell the guest no.  A request
// left in `knocking` stays in the operator's list and stays admittable.
func TestLobbyDenyDropsTheRequest(t *testing.T) {
	dir := setupGroups(t)
	writeGroup(t, dir, "deny", lobbyConf)

	op := &fakeClient{id: "op-1"}
	g := addOperator(t, "deny", op)

	guest := &fakeClient{id: "guest-1"}
	knock(t, "deny", guest, "visitor")
	if g.knocking["guest-1"] == nil {
		t.Fatalf("the knock was not recorded")
	}

	if err := g.Deny("guest-1"); err != nil {
		t.Fatalf("Deny: %v", err)
	}
	if kind := guest.lastJoined(); kind != "deny" {
		t.Errorf("denied guest: got %v, expected deny", kind)
	}
	if g.knocking["guest-1"] != nil {
		t.Errorf("the denied request is still pending")
	}
	if !op.wasPushed("knockcancel", "guest-1") {
		t.Errorf("the operator still sees the denied request: %v", op.pushed)
	}
	if err := g.Admit("guest-1"); err == nil {
		t.Errorf("a denied request could still be admitted")
	}

	// A denial is not a ban: the guest may ask again, and lands in the
	// lobby rather than in the room.
	knock(t, "deny", guest, "visitor")
	if g.GetClient("guest-1") != nil {
		t.Errorf("the denied guest is in the group")
	}
}

// A guest that gives up while waiting must leave nothing behind.
func TestLobbyKnockWithdrawnOnDisconnect(t *testing.T) {
	dir := setupGroups(t)
	writeGroup(t, dir, "leave", lobbyConf)

	op := &fakeClient{id: "op-1"}
	g := addOperator(t, "leave", op)

	guest := &fakeClient{id: "guest-1"}
	knock(t, "leave", guest, "visitor")

	// RemoveKnock is what the websocket layer calls when a waiting client
	// goes away; this drives it directly, so the link from a real
	// disconnect to this call belongs to the protocol tests.
	g.RemoveKnock("guest-1")

	if g.knocking["guest-1"] != nil {
		t.Errorf("the request outlived the client")
	}
	if !op.wasPushed("knockcancel", "guest-1") {
		t.Errorf("the operator still sees the request: %v", op.pushed)
	}
	if err := g.Admit("guest-1"); err == nil {
		t.Errorf("Admit accepted a request that no longer exists")
	}
}

// An admitted guest that never comes back must not leave its permission
// behind.  RemoveKnock drops the admission as well as the request, and that
// half is not reached by a test whose guest was still waiting: after Admit
// the request is already gone, so only `admitted` is left to clear.
func TestLobbyAdmissionDroppedOnDisconnect(t *testing.T) {
	dir := setupGroups(t)
	writeGroup(t, dir, "gone", lobbyConf)

	op := &fakeClient{id: "op-1"}
	g := addOperator(t, "gone", op)

	guest := &fakeClient{id: "guest-1"}
	knock(t, "gone", guest, "visitor")
	if err := g.Admit("guest-1"); err != nil {
		t.Fatalf("Admit: %v", err)
	}
	if !g.admitted["guest-1"] {
		t.Fatalf("Admit did not record the admission")
	}

	// Told to re-join, the guest closes the tab instead.
	g.RemoveKnock("guest-1")

	if _, held := g.admitted["guest-1"]; held {
		t.Errorf("the admission outlived the client it was granted to")
	}
}

// max-clients is the one capacity limit the protocol tests do not cover.
func TestMaxClientsRefusesNonOperators(t *testing.T) {
	dir := setupGroups(t)
	writeGroup(t, dir, "full", `{
		"max-clients": 1,
		"users": {"boss": {"password": "oppass", "permissions": "op"}},
		"wildcard-user": {
			"password": {"type": "wildcard"},
			"permissions": "present"
		}
	}`)

	op := &fakeClient{id: "op-1"}
	addOperator(t, "full", op)

	guest := &fakeClient{id: "guest-1"}
	_, err := AddClient("full", guest, guestCreds("visitor"))
	if err == nil {
		t.Fatalf("guest entered a full group")
	}
	if err.Error() != "too many users" {
		t.Errorf("got %q, expected too many users", err)
	}
}
