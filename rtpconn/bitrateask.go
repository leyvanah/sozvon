package rtpconn

// Sozvon: a request to cap a stream only from someone receiving it.
//
// A receiver that plays a stream badly asks its sender to cap it, with a
// "sozvon-bitrate" user message (static/bitrate-control.js).  The sender
// applies the cap to the one stream it sends everybody, so the request
// affects every viewer, and the sender cannot check it: it does not know
// who receives what.  The SFU does.  Before this, anyone in the room with
// the "message" permission could unsubscribe from everything and still
// hold someone's video at the 150 kbit/s floor for the whole call
// (sozvon-tasks#35).
//
// So a request that tightens a cap is relayed only to the owner of the
// stream it names, and only while the requester has a down connection for
// that stream.  Lifting a cap needs no such proof -- it can only help, and
// an honest receiver lifts its cap precisely when it stops receiving.

const bitrateAskKind = "sozvon-bitrate"

// bitrateAskAllowed reports whether a "sozvon-bitrate" request from c to
// dest may be relayed.  One that may not is dropped without an error: a
// request crossing the close of the stream it names is ordinary.
func bitrateAskAllowed(c *webClient, dest string, value any) bool {
	if dest == "" {
		return false
	}
	v, ok := value.(map[string]any)
	if !ok {
		return false
	}
	stream, ok := v["stream"].(string)
	if !ok || stream == "" {
		return false
	}
	if v["cap"] == nil {
		return true
	}
	down := getDownConn(c, stream)
	if down == nil || down.remote == nil {
		return false
	}
	owner, _ := down.remote.User()
	return owner == dest
}
