package rtpconn

import (
	"encoding/json"
	"reflect"
	"testing"

	"github.com/leyvanah/sozvon/token"
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
