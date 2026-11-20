package rtpconn

import (
	"time"

	"github.com/pion/webrtc/v4"
)

// probeAudio reports how many audio RTP packets the SFU has written to the
// requester's own downstream tracks. It runs on demand over the signalling
// connection, so it can still answer when their media path is broken.
func probeAudio(c *webClient, m clientMessage) error {
	ids, ok := m.Value.([]interface{})
	now := time.Now()
	if !ok || len(ids) == 0 || len(ids) > 16 || len(m.Id) == 0 || len(m.Id) > 32 ||
		now.Sub(c.audioProbeTime) < time.Second {
		return nil
	}
	c.audioProbeTime = now
	counts := make(map[string]uint64, len(ids))
	for _, value := range ids {
		id, ok := value.(string)
		if !ok {
			continue
		}
		down := getDownConn(c, id)
		if down == nil {
			continue
		}
		for _, track := range down.getTracks() {
			if track.remote.Kind() == webrtc.RTPCodecTypeAudio {
				packets, _ := track.rate.Totals()
				counts[id] += packets
			}
		}
	}
	return c.write(clientMessage{Type: "sozvon-audio-probe", Id: m.Id, Value: counts})
}
