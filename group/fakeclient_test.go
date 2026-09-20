package group

import (
	"net"

	"github.com/leyvanah/sozvon/conn"
)

// fakeClient is a Client that records what the server tells it.  AddClient,
// Admit and Deny decide who may enter a group, but reaching them needed a
// WebSocket, a peer connection and a browser, so those decisions went
// untested.  This stub needs none of that: the media methods are never
// reached by the admission path, and the three that are — Init, Joined and
// PushClient — just record their arguments. (Sozvon)
type fakeClient struct {
	id       string
	username string
	perms    []string

	// joined records the kinds passed to Joined, in order: "join" on
	// entry, "rejoin" when an operator admits a waiting client, "deny"
	// when one is turned away, "change" when the lock changes.
	joined []string

	// pushed records what the server reported to this client about
	// others, which for an operator includes knocks arriving and being
	// withdrawn.
	pushed []pushedClient

	// kicked records the messages passed to Kick, so that a sweep that
	// leaves someone behind does not look like a success.
	kicked []string
}

type pushedClient struct {
	kind     string
	id       string
	username string
}

// lastJoined returns the most recent kind passed to Joined, or "" if the
// client was never told anything.
func (c *fakeClient) lastJoined() string {
	if len(c.joined) == 0 {
		return ""
	}
	return c.joined[len(c.joined)-1]
}

// wasPushed reports whether this client was told kind about id.  An operator
// watching a lobby gets "knock" when someone arrives and "knockcancel" when
// that request goes away, and which id it carried matters: cancelling the
// wrong one would leave a ghost in the operator's list.
func (c *fakeClient) wasPushed(kind, id string) bool {
	for _, p := range c.pushed {
		if p.kind == kind && p.id == id {
			return true
		}
	}
	return false
}

func (c *fakeClient) Group() *Group    { return nil }
func (c *fakeClient) Addr() net.Addr   { return nil }
func (c *fakeClient) Id() string       { return c.id }
func (c *fakeClient) Username() string { return c.username }

func (c *fakeClient) Init(username string, perms []string) {
	c.username = username
	c.perms = perms
}

func (c *fakeClient) Permissions() []string        { return c.perms }
func (c *fakeClient) Data() map[string]interface{} { return nil }

func (c *fakeClient) PushConn(g *Group, id string, up conn.Up, tracks []conn.UpTrack, replace string) error {
	return nil
}

func (c *fakeClient) RequestConns(target Client, g *Group, id string) error {
	return nil
}

func (c *fakeClient) Joined(group, kind string) error {
	c.joined = append(c.joined, kind)
	return nil
}

func (c *fakeClient) PushClient(group, kind, id, username string, perms []string, data map[string]interface{}) error {
	c.pushed = append(c.pushed, pushedClient{kind: kind, id: id, username: username})
	return nil
}

func (c *fakeClient) Kick(id string, user *string, message string) error {
	c.kicked = append(c.kicked, message)
	return nil
}
