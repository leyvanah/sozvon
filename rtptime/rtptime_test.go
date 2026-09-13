package rtptime

import (
	"testing"
	"time"
)

func TestDuration(t *testing.T) {
	a := FromDuration(time.Second, 48000)
	if a != 48000 {
		t.Errorf("Expected 48000, got %v", a)
	}

	b := FromDuration(-time.Second, 48000)
	if b != -48000 {
		t.Errorf("Expected -48000, got %v", b)
	}

	c := ToDuration(48000, 48000)
	if c != time.Second {
		t.Errorf("Expected %v, got %v", time.Second, c)
	}

	d := ToDuration(-48000, 48000)
	if d != -time.Second {
		t.Errorf("Expected %v, got %v", -time.Second, d)
	}
}

func TestDurationOverflow(t *testing.T) {
	delta := 10 * time.Minute
	dj := FromDuration(delta, JiffiesPerSec)
	var prev int64
	for d := time.Duration(0); d < time.Duration(1000*time.Hour); d += delta {
		jiffies := FromDuration(d, JiffiesPerSec)
		if d != 0 {
			if jiffies != prev+dj {
				t.Errorf("%v: %v, %v", d, jiffies, prev)
			}
		}
		d2 := ToDuration(jiffies, JiffiesPerSec)
		if d2 != d {
			t.Errorf("%v != %v (%v)", d2, d, jiffies)
		}
		prev = jiffies
	}
}

func differs(a, b, delta uint64) bool {
	if a < b {
		a, b = b, a
	}
	return a-b >= delta
}

// TestTime checks that the clocks advance in real time at the rate asked
// for.
//
// It compares each clock against the interval that actually elapsed, not
// against the interval that was requested.  time.Sleep guarantees only a
// lower bound: it overshoots by whatever the timer granularity and the
// machine's load add -- about 15.6ms on Windows, and unbounded on a loaded
// CI runner.  Comparing a clock against the sleep it was asked for therefore
// measures the scheduler rather than the clock, and fails at random; this
// test did so on Windows and on CI alike.  Bracketing the sleep with
// time.Now removes the scheduler from the comparison, which lets the
// tolerance be *tighter* than before -- one millisecond, covering only the
// gap between the two clock reads.  (Sozvon)
func TestTime(t *testing.T) {
	const sleep = 50 * time.Millisecond

	// tolerance is one millisecond expressed in the clock's own units
	tolerance := func(hz uint32) uint64 {
		return uint64(FromDuration(time.Millisecond, hz))
	}
	expected := func(d time.Duration, hz uint32) uint64 {
		return uint64(FromDuration(d, hz))
	}

	start := time.Now()
	a := Now(48000)
	time.Sleep(sleep)
	b := Now(48000) - a
	elapsed := time.Since(start)
	if e := expected(elapsed, 48000); differs(b, e, tolerance(48000)) {
		t.Errorf("Now(48000): expected %v, got %v (elapsed %v)",
			e, b, elapsed)
	}

	start = time.Now()
	c := Microseconds()
	time.Sleep(sleep)
	d := Microseconds() - c
	elapsed = time.Since(start)
	if e := expected(elapsed, 1000000); differs(d, e, tolerance(1000000)) {
		t.Errorf("Microseconds: expected %v, got %v (elapsed %v)",
			e, d, elapsed)
	}

	start = time.Now()
	c = Jiffies()
	time.Sleep(sleep)
	d = Jiffies() - c
	elapsed = time.Since(start)
	if e := expected(elapsed, JiffiesPerSec); differs(d, e, tolerance(JiffiesPerSec)) {
		t.Errorf("Jiffies: expected %v, got %v (elapsed %v)",
			e, d, elapsed)
	}
}

func TestNTP(t *testing.T) {
	now := time.Now()
	ntp := TimeToNTP(now)
	now2 := NTPToTime(ntp)
	ntp2 := TimeToNTP(now2)

	diff1 := now2.Sub(now).Abs()
	if diff1 > time.Nanosecond {
		t.Errorf("Expected %v, got %v (diff=%v)",
			now, now2, diff1)
	}

	diff2 := int64(ntp2 - ntp)
	if diff2 < 0 {
		diff2 = -diff2
	}
	if diff2 > (1 << 8) {
		t.Errorf("Expected %v, got %v (diff=%v)",
			ntp, ntp2, float64(diff2)/float64(1<<32))
	}

}
