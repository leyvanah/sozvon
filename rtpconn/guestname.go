package rtpconn

import (
	"github.com/leyvanah/sozvon/group"
)

// tokenUsername returns the username a new token for group g may carry.
//
// In a group with end-to-end encryption a guest's name must not reach the
// server: guests join under a pseudonym and send their name only inside the
// encrypted channel (static/guest-name.js), and the client puts a name
// meant for an invite link after '#', where browsers never send it.  An
// older client, or an app, could still ask for a token naming the guest, and
// the name would then be stored in the token file.  So in such a group a
// token may only name one of the group's own users -- an operator
// remembering a device, or an operator's session token -- and any other
// name is dropped: the link still works, and the guest types their name.
// (Sozvon)
func tokenUsername(g *group.Group, username *string) *string {
	if username == nil || *username == "" {
		return username
	}
	desc := g.Description()
	if desc == nil || !desc.E2EE || g.UserExists(*username) {
		return username
	}
	return nil
}
