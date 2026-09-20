package rtpconn

import (
	"encoding/json"
	"maps"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"sync"
	"testing"

	"github.com/leyvanah/sozvon/group"
	"github.com/leyvanah/sozvon/token"
	"github.com/leyvanah/sozvon/unbounded"
)

var tokens = []string{
	`{
	    "token": "a",
	    "group": "g",
	    "username": "u",
	    "permissions":["present"],
	    "expires": "2023-05-03T20:24:47.616624532+02:00"
	}`,
	`{
	    "token": "a",
	    "group": "g"
	}`,
	`{
	    "token": "a",
	    "group": "g",
            "username":""
	}`,
}

func TestParseStatefulToken(t *testing.T) {
	for i, tok := range tokens {
		var t1 *token.Stateful
		err := json.Unmarshal([]byte(tok), &t1)
		if err != nil {
			t.Errorf("Unmarshal %v: %v", i, err)
			continue
		}
		var m map[string]interface{}
		err = json.Unmarshal([]byte(tok), &m)
		if err != nil {
			t.Errorf("Unmarshal (map) %v: %v", i, err)
			continue
		}
		t2, err := parseStatefulToken(m)
		if err != nil {
			t.Errorf("parseStatefulToken %v: %v", i, err)
		}
		if !reflect.DeepEqual(t1, t2) {
			t.Errorf("Mismatch: %v, %v", t1, t2)
		}
	}
}

// A client that has left its group keeps its socket and its action queue,
// and the group pushes notifications to a member list it took before
// releasing the lock, so an action can still arrive for a client with no
// group.  Every case in handleAction that looks at the group copes with that
// except pushClientAction, which used to call Name() on nil.  (Sozvon)
func TestPushClientAfterLeave(t *testing.T) {
	err := handleAction(&webClient{}, pushClientAction{
		group:    "g",
		kind:     "add",
		id:       "other",
		username: "other",
	})
	if err != nil {
		t.Errorf("handleAction: %v", err)
	}
}

// setupPermissionsGroup writes a group with two operator accounts that use
// the named "op" permissions set, and points the group package at it.
func setupPermissionsGroup(t *testing.T, name string) {
	t.Helper()
	setupGroupWith(t, name, `{"users": {
		"boss":   {"password": "bosspass", "permissions": "op"},
		"deputy": {"password": "deputypass", "permissions": "op"}
	}}`)
}

// setupGroupWith writes a group with the description conf and points the
// group package at it.
func setupGroupWith(t *testing.T, name, conf string) {
	t.Helper()
	group.Directory = t.TempDir()
	group.DataDirectory = t.TempDir()
	err := os.WriteFile(
		filepath.Join(group.DataDirectory, "config.json"),
		[]byte(`{}`), 0o600,
	)
	if err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	err = os.WriteFile(
		filepath.Join(group.Directory, name+".json"),
		[]byte(conf), 0o600,
	)
	if err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
}

func joinForTest(t *testing.T, name, id, username, password string) *webClient {
	t.Helper()
	c := &webClient{id: id, actions: unbounded.New[any]()}
	g, err := group.AddClient(name, c, group.ClientCredentials{
		Username: &username,
		Password: password,
	})
	if err != nil {
		t.Fatalf("AddClient(%v): %v", username, err)
	}
	c.group = g
	t.Cleanup(func() { group.DelClient(c) })
	return c
}

// Taking away a member's operator status must not race with the group
// reading that member's permissions under its lock, here while another
// client joins.  "unop" is used because "op" takes the group lock before
// it returns, which could order the write before the read and hide the
// race.  This test only fails under -race.  (Sozvon)
func TestChangePermissionsWhileJoining(t *testing.T) {
	setupPermissionsGroup(t, "perms-race")
	boss := joinForTest(t, "perms-race", "boss-1", "boss", "bosspass")

	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		err := handleAction(boss, changePermissionsAction{kind: "unop"})
		if err != nil {
			t.Errorf("handleAction: %v", err)
		}
	}()

	joinForTest(t, "perms-race", "deputy-1", "deputy", "deputypass")
	wg.Wait()

	if slices.Contains(boss.Permissions(), "op") {
		t.Errorf("still an operator: %v", boss.Permissions())
	}
}

// Changing one member's permissions must not change anyone else's.  A
// named permissions set hands every member the same slice, so editing it
// in place rewrites the set itself for everyone who logs in later.
// (Sozvon)
func TestChangePermissionsLeavesNamedSetAlone(t *testing.T) {
	setupPermissionsGroup(t, "perms-shared")
	boss := joinForTest(t, "perms-shared", "boss-1", "boss", "bosspass")

	err := handleAction(boss, changePermissionsAction{kind: "unop"})
	if err != nil {
		t.Fatalf("handleAction: %v", err)
	}
	if slices.Contains(boss.Permissions(), "op") {
		t.Errorf("still an operator: %v", boss.Permissions())
	}

	deputy := joinForTest(t, "perms-shared", "deputy-1", "deputy", "deputypass")
	if !slices.Contains(deputy.Permissions(), "op") {
		t.Errorf("the next operator to log in is not one: %v",
			deputy.Permissions())
	}
}

// Each permission change gives the expected result, and none of them
// writes into the array it started from, not even into its spare
// capacity: that array may belong to a group description or a named
// permissions set, and slices of it may be held by other goroutines.
// (Sozvon)
func TestChangePermissionsKinds(t *testing.T) {
	tests := []struct {
		kind       string
		start, end []string
	}{
		{"op", []string{"present"}, []string{"present", "op"}},
		{"op", []string{"op", "present"}, []string{"op", "present"}},
		{"unop", []string{"op", "record", "present"}, []string{"present"}},
		{"unop", []string{"present"}, []string{"present"}},
		{"present", []string{"message"}, []string{"message", "present"}},
		{"unpresent", []string{"present", "message"}, []string{"message"}},
		{"shutup", []string{"present", "message"}, []string{"present"}},
		{"unshutup", []string{"present"}, []string{"present", "message"}},
	}
	for _, tt := range tests {
		// Spare capacity, filled with a marker so that a write into
		// it shows.
		backing := make([]string, len(tt.start)+4)
		for i := range backing {
			backing[i] = "spare"
		}
		copy(backing, tt.start)
		before := slices.Clone(backing)

		c := &webClient{
			id:          "c",
			actions:     unbounded.New[any](),
			permissions: backing[:len(tt.start)],
		}
		err := handleAction(c, changePermissionsAction{kind: tt.kind})
		if err != nil {
			t.Errorf("%v %v: %v", tt.kind, tt.start, err)
			continue
		}
		if !slices.Equal(c.permissions, tt.end) {
			t.Errorf("%v %v: got %v, expected %v",
				tt.kind, tt.start, c.permissions, tt.end)
		}
		if !slices.Equal(backing, before) {
			t.Errorf("%v %v: the original array changed to %v",
				tt.kind, tt.start, backing)
		}
	}

	c := &webClient{id: "c", actions: unbounded.New[any]()}
	err := handleAction(c, changePermissionsAction{kind: "sudo"})
	if err == nil {
		t.Errorf("an unknown permission was accepted")
	}
}

// With recording allowed, "op" also grants "record", and "unop" takes
// both away.  Changing one member's permissions, which here come from the
// explicit list of the group's wildcard user, does not change what the
// next member logging in through that entry gets.  (Sozvon)
func TestChangePermissionsExplicitListWithRecording(t *testing.T) {
	setupGroupWith(t, "perms-record", `{
		"allow-recording": true,
		"users": {
			"boss": {"password": "bosspass", "permissions": "op"}
		},
		"wildcard-user": {
			"password": {"type": "wildcard"},
			"permissions": ["present", "message"]
		}
	}`)
	joinForTest(t, "perms-record", "boss-1", "boss", "bosspass")
	alice := joinForTest(t, "perms-record", "alice-1", "alice", "")

	steps := []struct {
		kind string
		want []string
	}{
		// first, since it is the one that edited the array it was
		// given, here the description's
		{"unpresent", []string{"message"}},
		{"present", []string{"message", "present"}},
		{"op", []string{"message", "present", "op", "record"}},
		{"unop", []string{"message", "present"}},
		{"shutup", []string{"present"}},
		{"unshutup", []string{"present", "message"}},
	}
	for _, s := range steps {
		err := handleAction(alice, changePermissionsAction{kind: s.kind})
		if err != nil {
			t.Fatalf("%v: %v", s.kind, err)
		}
		if !slices.Equal(alice.Permissions(), s.want) {
			t.Errorf("after %v: got %v, expected %v",
				s.kind, alice.Permissions(), s.want)
		}
	}

	bob := joinForTest(t, "perms-record", "bob-1", "bob", "")
	want := []string{"present", "message"}
	if !slices.Equal(bob.Permissions(), want) {
		t.Errorf("the next member with that entry got %v, expected %v",
			bob.Permissions(), want)
	}
}

// Changing a member's own data must not race with the group cloning that
// data under its lock, here while another client joins.  This test only
// fails under -race.  (Sozvon)
func TestSetDataWhileJoining(t *testing.T) {
	setupPermissionsGroup(t, "data-race")
	boss := joinForTest(t, "data-race", "boss-1", "boss", "bosspass")

	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; i < 200; i++ {
			boss.setData(map[string]interface{}{
				"muted": i%2 == 0,
			})
		}
	}()

	joinForTest(t, "data-race", "deputy-1", "deputy", "deputypass")
	wg.Wait()

	if _, ok := boss.Data()["muted"]; !ok {
		t.Errorf("no data after setData: %v", boss.Data())
	}
}

// A change to a member's data must build a new map rather than write
// into the old one: the group hands the old one to maps.Clone under its
// lock, and a write in place races with that clone.  (Sozvon)
func TestSetDataReplacesTheMap(t *testing.T) {
	c := &webClient{id: "c", actions: unbounded.New[any]()}

	c.setData(map[string]interface{}{"muted": true, "raisehand": true})
	old := c.data
	before := maps.Clone(old)

	c.setData(map[string]interface{}{"muted": nil, "caption": "hi"})

	want := map[string]interface{}{"raisehand": true, "caption": "hi"}
	if !reflect.DeepEqual(c.data, want) {
		t.Errorf("got %v, expected %v", c.data, want)
	}
	if !reflect.DeepEqual(old, before) {
		t.Errorf("the original map changed to %v", old)
	}
}
