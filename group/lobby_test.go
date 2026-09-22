package group

import (
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"testing"
	"time"

	"github.com/leyvanah/sozvon/token"
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

// memberClient is a fakeClient that knows its group, so that DelClient can
// remove it the way the websocket layer does when a client leaves.
type memberClient struct {
	*fakeClient
	group *Group
}

func (c *memberClient) Group() *Group { return c.group }

// A knocker and an operator leaving at the same moment must not race on the
// operator's permissions.  This test only fails under -race.
//
// A client's permissions belong to its own goroutine: rtpconn's leaveGroup
// clears them as soon as DelClient returns, holding no lock.  The group may
// therefore read them only under g.mu, while the client is known to be a
// member.  RemoveKnock used to snapshot the member list, release the lock and
// only then ask each member whether it was an operator — by which time the
// operator could have left and be rewriting the very field being read.  The
// field is a slice, so a torn read is a garbage pointer, not a wrong answer.
//
// Waiting for the knock to disappear, under the lock, orders the operator's
// departure after RemoveKnock's critical section but not after anything
// RemoveKnock does once it has released the lock.  The detector sees any read
// of the operator's permissions made there, however the goroutines happen to
// be scheduled, instead of only when the two leaves collide. (Sozvon)
func TestLobbyKnockWithdrawnWhileOperatorLeaves(t *testing.T) {
	dir := setupGroups(t)
	writeGroup(t, dir, "both", lobbyConf)

	op := &memberClient{fakeClient: &fakeClient{id: "op-1"}}
	g, err := AddClient("both", op, opCreds())
	if err != nil {
		t.Fatalf("AddClient(operator): %v", err)
	}
	op.group = g

	guest := &fakeClient{id: "guest-1"}
	knock(t, "both", guest, "visitor")

	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		g.RemoveKnock("guest-1")
	}()

	// Bounded by the clock, not by waiting on the goroutine: hearing from
	// it would order everything it did, the read included, before the
	// operator's departure, and hide the race from the detector.
	deadline := time.Now().Add(10 * time.Second)
	for {
		g.mu.Lock()
		pending := g.knocking["guest-1"] != nil
		g.mu.Unlock()
		if !pending {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("RemoveKnock did not drop the request")
		}
		runtime.Gosched()
	}

	// What leaveGroup does for the operator.
	DelClient(op)
	op.perms = nil

	wg.Wait()

	if !op.wasPushed("knockcancel", "guest-1") {
		t.Errorf("the operator was not told the request went away: %v",
			op.pushed)
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

// admitGuest knocks, is admitted and re-joins, as a browser does; it fails the
// test if the guest does not end up inside.
func admitGuest(t *testing.T, g *Group, c *fakeClient, username string) {
	t.Helper()
	knock(t, g.Name(), c, username)
	if err := g.Admit(c.id); err != nil {
		t.Fatalf("Admit(%v): %v", c.id, err)
	}
	if _, err := AddClient(g.Name(), c, guestCreds(username)); err != nil {
		t.Fatalf("admitted guest %v: %v", c.id, err)
	}
}

// A knock at a room with no seat left is refused at the door, with the
// reason, instead of being accepted and then failing on the re-join after
// the operator admits it.  The operator is still told, as "knockrefused"
// rather than "knock": there is nothing to admit, but a host whose guests
// are being turned away needs to know it is time to free a seat.
//
// All three limits are exercised, because each is checked in its own way:
// max-clients and the 1-on-1 lock exempt operators, require-e2ee does not,
// and the 1-on-1 lock is runtime state rather than configuration. (Sozvon)
func TestLobbyKnockIntoFullRoom(t *testing.T) {
	tests := []struct {
		name string
		conf string
		// fill brings the room to its limit, the operator already in.
		fill func(t *testing.T, g *Group)
		want *FullError
	}{
		{
			name: "max-clients",
			conf: `{
				"lobby": true,
				"max-clients": 1,
				"users": {"boss": {"password": "oppass", "permissions": "op"}},
				"wildcard-user": {
					"password": {"type": "wildcard"},
					"permissions": "present"
				}
			}`,
			fill: func(t *testing.T, g *Group) {},
			want: ErrGroupFull,
		},
		{
			name: "1-on-1 lock",
			conf: lobbyConf,
			fill: func(t *testing.T, g *Group) {
				admitGuest(t, g, &fakeClient{id: "guest-0"}, "first")
				g.SetLocked1on1(true)
			},
			want: ErrGroupOneOnOne,
		},
		{
			name: "require-e2ee",
			conf: `{
				"lobby": true,
				"e2ee": true,
				"require-e2ee": true,
				"users": {"boss": {"password": "oppass", "permissions": "op"}},
				"wildcard-user": {
					"password": {"type": "wildcard"},
					"permissions": "present"
				}
			}`,
			fill: func(t *testing.T, g *Group) {
				admitGuest(t, g, &fakeClient{id: "guest-0"}, "first")
			},
			want: ErrGroupE2EEFull,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dir := setupGroups(t)
			writeGroup(t, dir, "busy", tt.conf)

			op := &fakeClient{id: "op-1"}
			g := addOperator(t, "busy", op)
			tt.fill(t, g)

			guest := &fakeClient{id: "guest-1"}
			_, err := AddClient("busy", guest, guestCreds("visitor"))
			if err != tt.want {
				t.Fatalf("knocking at a full room: got %v, "+
					"expected %v", err, tt.want)
			}

			g.mu.Lock()
			waiting := g.knocking["guest-1"] != nil
			g.mu.Unlock()
			if waiting {
				t.Errorf("the refused guest was left waiting in the lobby")
			}
			if op.wasPushed("knock", "guest-1") {
				t.Errorf("the operator was offered a knock " +
					"that cannot be admitted")
			}
			if !op.wasPushed("knockrefused", "guest-1") {
				t.Errorf("the operator was not told a guest "+
					"was turned away: %v", op.pushed)
			}
		})
	}
}

// A knock taken while there was a seat can still find the room full by the
// time the operator admits it.  The re-join is then refused with the same
// coded error as a knock at the door, so the guest reads why rather than a
// bare "too many users" after being told to come in. (Sozvon)
func TestLobbyAdmittedIntoRoomThatFilled(t *testing.T) {
	dir := setupGroups(t)
	writeGroup(t, dir, "busy", `{
		"lobby": true,
		"max-clients": 2,
		"users": {"boss": {"password": "oppass", "permissions": "op"}},
		"wildcard-user": {
			"password": {"type": "wildcard"},
			"permissions": "present"
		}
	}`)

	op := &fakeClient{id: "op-1"}
	g := addOperator(t, "busy", op)

	// One seat is left, so both knocks are taken.
	first := &fakeClient{id: "guest-1"}
	second := &fakeClient{id: "guest-2"}
	knock(t, "busy", first, "first")
	knock(t, "busy", second, "second")

	for _, id := range []string{"guest-1", "guest-2"} {
		if err := g.Admit(id); err != nil {
			t.Fatalf("Admit(%v): %v", id, err)
		}
	}
	if _, err := AddClient("busy", first, guestCreds("first")); err != nil {
		t.Fatalf("first admitted guest: %v", err)
	}
	if _, err := AddClient("busy", second, guestCreds("second")); err != ErrGroupFull {
		t.Fatalf("the room had filled: got %v, expected %v", err, ErrGroupFull)
	}
}

// A room that sends everyone away once no operator is left, with two
// operator accounts.
const autokickConf = `{
	"autokick": true,
	"users": {
		"boss": {"password": "oppass", "permissions": "op"},
		"deputy": {"password": "deputypass", "permissions": "op"}
	}
}`

// When a member leaves, DelClient checks whether an operator is still
// there, which reads the remaining members' permissions.  That must happen
// under g.mu, where their permissions change.  The test waits, under the
// lock, for the leaving operator to be gone, and only then changes the
// other operator's permissions the way rtpconn does.  That orders the change
// after DelClient's critical section but not after anything DelClient does
// once unlocked, so -race reports an unlocked read on every run.  It passes
// without -race. (Sozvon)
func TestPermissionsChangeWhileOperatorLeaves(t *testing.T) {
	dir := setupGroups(t)
	writeGroup(t, dir, "autokick", autokickConf)

	boss := &memberClient{fakeClient: &fakeClient{id: "boss-1"}}
	g, err := AddClient("autokick", boss, opCreds())
	if err != nil {
		t.Fatalf("AddClient(boss): %v", err)
	}
	boss.group = g

	username := "deputy"
	deputy := &memberClient{fakeClient: &fakeClient{id: "deputy-1"}}
	_, err = AddClient("autokick", deputy, ClientCredentials{
		Username: &username, Password: "deputypass",
	})
	if err != nil {
		t.Fatalf("AddClient(deputy): %v", err)
	}
	deputy.group = g

	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		DelClient(boss)
	}()

	// Bounded by the clock, not by waiting on the goroutine, for the
	// same reason as in TestLobbyKnockWithdrawnWhileOperatorLeaves.
	deadline := time.Now().Add(10 * time.Second)
	for {
		g.mu.Lock()
		present := g.clients["boss-1"] != nil
		g.mu.Unlock()
		if !present {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("DelClient did not remove the operator")
		}
		runtime.Gosched()
	}

	// What rtpconn does on "unop".
	g.SetPermissions(func() {
		deputy.perms = []string{"present", "message"}
	})

	wg.Wait()

	if !deputy.wasPushed("delete", "boss-1") {
		t.Errorf("the other operator was not told: %v", deputy.pushed)
	}
}

// An invitation link skips the waiting room, which is the point of it.  It
// must not also skip the lock: "lock" is the operator saying that nobody
// else comes in now, and a token holder is refused by it in a group without
// a lobby.  Until this was fixed the lock was never even consulted in a
// lobby group, so the same link opened the room the product calls the
// private one while being turned away from the plain one. (Sozvon)
func TestLockRefusesATokenHolderInALobbyGroup(t *testing.T) {
	dir := setupGroups(t)
	writeGroup(t, dir, "private", lobbyConf)
	tok := issueToken(t, "private")

	op := &fakeClient{id: "op-1"}
	g := addOperator(t, "private", op)

	// Unlocked, the link is a pass: straight in, no knock.
	early := &fakeClient{id: "early-1"}
	if _, err := AddClient("private", early, tokenCreds(tok)); err != nil {
		t.Fatalf("token holder into an unlocked lobby group: %v", err)
	}
	DelClient(early)

	g.SetLocked(true, "не сейчас")

	guest := &fakeClient{id: "guest-1"}
	_, err := AddClient("private", guest, tokenCreds(tok))
	if err == nil {
		t.Fatalf("token holder walked into a locked group")
	}
	if err == ErrKnocking {
		t.Fatalf("token holder was sent to the lobby, not refused: " +
			"the lock has to turn them away, as it does in a group " +
			"with no lobby")
	}
	if err.Error() != "не сейчас" {
		t.Errorf("got %q, expected the operator's own lock message",
			err)
	}

	// An operator is not held by their own lock.
	op2 := &fakeClient{id: "op-2"}
	if _, err := AddClient("private", op2, opCreds()); err != nil {
		t.Errorf("operator refused by their own lock: %v", err)
	}

	// Nor is a guest the operator has just admitted.
	waiting := &fakeClient{id: "waiting-1"}
	knock(t, "private", waiting, "visitor")
	if err := g.Admit("waiting-1"); err != nil {
		t.Fatalf("Admit: %v", err)
	}
	if _, err := AddClient("private", waiting, guestCreds("visitor")); err != nil {
		t.Errorf("admitted guest refused by the lock: %v", err)
	}

	// Lifting the lock restores the link.
	DelClient(guest)
	g.SetLocked(false, "")
	late := &fakeClient{id: "late-1"}
	if _, err := AddClient("private", late, tokenCreds(tok)); err != nil {
		t.Errorf("token holder after unlocking: %v", err)
	}
}

// issueToken mints a stateful invitation token for a group, the way an
// operator's /invite does, and points the token store at a file of this
// test's own.
func issueToken(t *testing.T, group string) string {
	t.Helper()
	token.SetStatefulFilename(
		filepath.Join(t.TempDir(), "tokens.jsonl"),
	)
	expires := time.Now().Add(time.Hour)
	// The token store keys on the string, and does not mint one -- the
	// server does, before it calls Update.
	tok, err := token.Update(&token.Stateful{
		Token:       "invite-" + group,
		Group:       group,
		Permissions: []string{"present", "message"},
		Expires:     &expires,
	}, "")
	if err != nil {
		t.Fatalf("token.Update: %v", err)
	}
	return tok.Token
}

func tokenCreds(tok string) ClientCredentials {
	username := "invited"
	return ClientCredentials{Username: &username, Token: tok}
}
