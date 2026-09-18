package rtpconn

import (
	"encoding/json"
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
	group.Directory = t.TempDir()
	group.DataDirectory = t.TempDir()
	err := os.WriteFile(
		filepath.Join(group.DataDirectory, "config.json"),
		[]byte(`{}`), 0o600,
	)
	if err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	conf := `{"users": {
		"boss":   {"password": "bosspass", "permissions": "op"},
		"deputy": {"password": "deputypass", "permissions": "op"}
	}}`
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
