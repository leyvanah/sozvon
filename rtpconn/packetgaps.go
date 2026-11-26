package rtpconn

import (
	"fmt"
	"math"
	"strings"
	"sync"
	"time"

	"github.com/pion/webrtc/v4"
)

const (
	packetGapThreshold = 100 * time.Millisecond
	packetGapWindow    = 4 * time.Second
	packetGapReportAge = time.Second
)

var packetGapEpoch = time.Now()

type packetGap struct {
	ended time.Duration
	size  time.Duration
}

// packetGapHistory records pauses between RTP packets read from or written to
// Pion. It stores only times, and needs no timers or per-packet logging.
type packetGapHistory struct {
	mu   sync.Mutex
	last time.Duration
	next int
	// At most one completed gap per threshold interval can end in the
	// window, plus one that began before the window.
	gaps [packetGapWindow/packetGapThreshold + 1]packetGap
}

func (h *packetGapHistory) record(now time.Duration) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if now <= h.last {
		return
	}
	if gap := now - h.last; h.last != 0 && gap >= packetGapThreshold {
		h.gaps[h.next] = packetGap{ended: now, size: gap}
		h.next = (h.next + 1) % len(h.gaps)
	}
	h.last = now
}

type packetGapSnapshot struct {
	seen    bool
	longest packetGap
	last    time.Duration
}

func (h *packetGapHistory) snapshot(now time.Duration) packetGapSnapshot {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.last == 0 {
		return packetGapSnapshot{}
	}
	s := packetGapSnapshot{seen: true, last: min(h.last, now)}
	for _, gap := range h.gaps {
		if gap.size == 0 || gap.ended < now-packetGapWindow || gap.ended > now {
			continue
		}
		if gap.size > s.longest.size ||
			(gap.size == s.longest.size && gap.ended > s.longest.ended) {
			s.longest = gap
		}
	}
	return s
}

func (s packetGapSnapshot) appendTo(line *strings.Builder, field string, now time.Duration) {
	if !s.seen {
		return
	}
	fmt.Fprintf(line, " %s_idle=%dms", field, (now - s.last).Milliseconds())
	if s.longest.size >= packetGapThreshold {
		fmt.Fprintf(line, " %s_gap=%dms %s_gap_age=%dms", field,
			s.longest.size.Milliseconds(), field, (now - s.longest.ended).Milliseconds())
	}
}

// Report only recent playback incidents. With an older queued report we
// cannot line up the browser observation with this short server history.
func mediaIncidentPacketGaps(down *rtpDownConnection, v map[string]interface{},
	now time.Duration) string {
	age, ok := v["age"].(float64)
	if down == nil || !ok || age < 0 || age > float64(packetGapReportAge.Milliseconds()) ||
		age != math.Trunc(age) {
		return ""
	}
	if v["event"] != "freeze" && v["event"] != "stalled" {
		return ""
	}

	type directionPair struct {
		in, out packetGapSnapshot
		maxGap  time.Duration
	}
	var audio, video directionPair
	for _, track := range down.getTracks() {
		up, ok := track.remote.(*rtpUpTrack)
		if !ok {
			continue
		}
		// Keep the ingress and egress for the same track when more than
		// one track of a given media kind is being forwarded.
		in := up.packetGaps.snapshot(now)
		out := track.packetGaps.snapshot(now)
		if !in.seen && !out.seen {
			continue
		}
		pair := &audio
		if track.track.Kind() == webrtc.RTPCodecTypeVideo {
			pair = &video
		}
		maxGap := max(in.longest.size, out.longest.size)
		if in.seen {
			maxGap = max(maxGap, now-in.last)
		}
		if out.seen {
			maxGap = max(maxGap, now-out.last)
		}
		if !pair.in.seen && !pair.out.seen || maxGap > pair.maxGap {
			*pair = directionPair{in: in, out: out, maxGap: maxGap}
		}
	}
	var line strings.Builder
	audio.in.appendTo(&line, "audio_in", now)
	audio.out.appendTo(&line, "audio_out", now)
	video.in.appendTo(&line, "video_in", now)
	video.out.appendTo(&line, "video_out", now)
	if line.Len() == 0 {
		return ""
	}
	return fmt.Sprintf(" rtp_window=%s%s", packetGapWindow, line.String())
}
