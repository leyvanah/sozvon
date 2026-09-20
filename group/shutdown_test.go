package group

import (
	"testing"
	"time"
)

// Tests for sending a whole group away at once. (Sozvon)

// A plain room: no lobby, no lock, anyone walks in.
const openConf = `{
	"wildcard-user": {
		"password": {"type": "wildcard"},
		"permissions": "present"
	}
}`

// recordingClient is a member that leaves the group by itself when it is
// kicked, the way the on-disk recorder does: diskwriter.Client.Kick closes
// the recording and calls group.DelClient, which takes g.mu.
type recordingClient struct {
	*memberClient
}

func (c *recordingClient) Kick(id string, user *string, message string) error {
	err := c.fakeClient.Kick(id, user, message)
	DelClient(c)
	return err
}

// Kicking a whole group must not be done with g.mu held.  A member whose
// Kick calls DelClient takes the same lock, which is not reentrant, so a
// sweep that walks the group under the lock does not come back.
//
// The test drives kickall rather than its caller Shutdown on purpose:
// Shutdown holds the group registry lock for its whole sweep, so a block
// there would strand a global lock and hang every later test in this
// package instead of failing this one.  kickall is all Shutdown does to a
// group.
func TestKickallWithASelfDeletingMember(t *testing.T) {
	dir := setupGroups(t)
	writeGroup(t, dir, "open", openConf)

	rec := &recordingClient{
		memberClient: &memberClient{fakeClient: &fakeClient{id: "rec-1"}},
	}
	g, err := AddClient("open", rec, guestCreds("recorder"))
	if err != nil {
		t.Fatalf("AddClient(recorder): %v", err)
	}
	rec.group = g

	watcher := &memberClient{fakeClient: &fakeClient{id: "watcher-1"}}
	if _, err := AddClient("open", watcher, guestCreds("watcher")); err != nil {
		t.Fatalf("AddClient(watcher): %v", err)
	}
	watcher.group = g

	done := make(chan struct{})
	go func() {
		defer close(done)
		kickall(g, "server is shutting down")
	}()

	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatalf("kickall did not return: " +
			"a member that calls DelClient from its own Kick " +
			"waits for the group lock kickall holds")
	}

	// Everyone is kicked, the one that deletes itself included, and the
	// member list is walked from a snapshot rather than from a map that
	// DelClient is emptying underneath.
	for _, c := range []*memberClient{rec.memberClient, watcher} {
		if len(c.kicked) != 1 {
			t.Errorf("%v was kicked %v times, expected once",
				c.id, len(c.kicked))
		}
	}
	if g.GetClient("rec-1") != nil {
		t.Errorf("the kicked recorder is still in the group")
	}
}
