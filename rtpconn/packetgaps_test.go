package rtpconn

import (
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
)

func TestPacketGapHistory(t *testing.T) {
	var history packetGapHistory
	if history.snapshot(time.Second).seen {
		t.Fatal("empty history reported a packet")
	}
	history.record(time.Second)
	history.record(1030 * time.Millisecond)
	history.record(1510 * time.Millisecond)
	// Concurrent writers can report an earlier timestamp after a later one.
	history.record(1200 * time.Millisecond)
	history.record(1530 * time.Millisecond)
	s := history.snapshot(2 * time.Second)
	if !s.seen || s.last != 1530*time.Millisecond ||
		s.longest != (packetGap{1510 * time.Millisecond, 480 * time.Millisecond}) {
		t.Fatalf("snapshot = %+v", s)
	}
	s = history.snapshot(6 * time.Second)
	if s.longest.size != 0 || s.last != 1530*time.Millisecond {
		t.Fatalf("expired gap or current silence handled incorrectly: %+v", s)
	}
}

func TestPacketGapHistoryWrap(t *testing.T) {
	var history packetGapHistory
	now := time.Second
	history.record(now)
	for i := 0; i < 2*len(history.gaps); i++ {
		now += packetGapThreshold
		history.record(now)
	}
	now += 250 * time.Millisecond
	history.record(now)
	if s := history.snapshot(now); s.longest != (packetGap{now, 250 * time.Millisecond}) {
		t.Fatalf("snapshot after wrap = %+v", s)
	}
}

func TestMediaIncidentPacketGaps(t *testing.T) {
	local, err := webrtc.NewTrackLocalStaticRTP(
		webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8}, "video", "stream")
	if err != nil {
		t.Fatal(err)
	}
	up := &rtpUpTrack{}
	down := &rtpDownTrack{track: local, remote: up}
	conn := &rtpDownConnection{tracks: []*rtpDownTrack{down}}
	// A gap when forwarding a track whose incoming RTP continued.
	for _, ms := range []time.Duration{500, 540, 580, 620, 660, 700, 740, 780, 820, 860, 900} {
		up.packetGaps.record(ms * time.Millisecond)
	}
	for _, ms := range []time.Duration{500, 540, 900} {
		down.packetGaps.record(ms * time.Millisecond)
	}
	now := 930 * time.Millisecond
	value := map[string]interface{}{"event": "freeze", "age": 20.0}
	want := " rtp_window=4s video_in_idle=30ms video_out_idle=30ms" +
		" video_out_gap=360ms video_out_gap_age=30ms"
	if got := mediaIncidentPacketGaps(conn, value, now); got != want {
		t.Fatalf("gap details = %q, want %q", got, want)
	}
	for _, age := range []interface{}{nil, 1001.0, -1.0, "0"} {
		value["age"] = age
		if got := mediaIncidentPacketGaps(conn, value, now); got != "" {
			t.Errorf("gap details for report age %v = %q", age, got)
		}
	}
	value["age"] = 0.0
	value["event"] = "gray-on"
	if got := mediaIncidentPacketGaps(conn, value, now); got != "" {
		t.Errorf("gap details for gray-on = %q", got)
	}
}
