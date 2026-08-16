package authlimit

import (
	"net"
	"testing"
	"time"
)

func clearAuthRecords() {
	authMu.Lock()
	authRecords = make(map[string]*authRecord)
	authMu.Unlock()
}

func TestDelayForFailures(t *testing.T) {
	if d := delayForFailures(0); d != authBaseDelay {
		t.Errorf("delayForFailures(0) = %v, want %v", d, authBaseDelay)
	}
	if d := delayForFailures(1); d != authBaseDelay {
		t.Errorf("delayForFailures(1) = %v, want %v", d, authBaseDelay)
	}
	if d := delayForFailures(2); d != 2*authBaseDelay {
		t.Errorf("delayForFailures(2) = %v, want %v", d, 2*authBaseDelay)
	}
	if d := delayForFailures(3); d != 4*authBaseDelay {
		t.Errorf("delayForFailures(3) = %v, want %v", d, 4*authBaseDelay)
	}
	if d := delayForFailures(1000); d != authMaxDelay {
		t.Errorf("delayForFailures(1000) = %v, want cap %v", d, authMaxDelay)
	}
}

func TestAuthFailureEscalates(t *testing.T) {
	clearAuthRecords()
	now := time.Unix(1000, 0)
	d1, _ := failureDelayAt("1.2.3.4", now)
	d2, _ := failureDelayAt("1.2.3.4", now.Add(time.Second))
	d3, _ := failureDelayAt("1.2.3.4", now.Add(2*time.Second))
	if !(d1 < d2 && d2 < d3) {
		t.Errorf("delays should escalate: %v, %v, %v", d1, d2, d3)
	}
	// a different address is tracked independently
	if d, _ := failureDelayAt("5.6.7.8", now); d != authBaseDelay {
		t.Errorf("new address delay = %v, want %v", d, authBaseDelay)
	}
}

func TestAuthForgetAndReset(t *testing.T) {
	clearAuthRecords()
	now := time.Unix(2000, 0)
	failureDelayAt("1.2.3.4", now)
	failureDelayAt("1.2.3.4", now.Add(time.Second))
	// after the idle window the count restarts at the base delay
	later := now.Add(authForget + time.Minute)
	if d, _ := failureDelayAt("1.2.3.4", later); d != authBaseDelay {
		t.Errorf("after forget window delay = %v, want %v", d, authBaseDelay)
	}
	// an explicit reset (successful login) clears immediately
	failureDelayAt("1.2.3.4", later.Add(time.Second))
	resetAt("1.2.3.4")
	if d, _ := failureDelayAt("1.2.3.4", later.Add(2*time.Second)); d != authBaseDelay {
		t.Errorf("after reset delay = %v, want %v", d, authBaseDelay)
	}
}

func TestPurgeAuth(t *testing.T) {
	clearAuthRecords()
	now := time.Unix(3000, 0)
	failureDelayAt("1.2.3.4", now)
	// a later attempt by another address purges the stale first one
	failureDelayAt("5.6.7.8", now.Add(authForget+time.Minute))
	authMu.Lock()
	_, stalePresent := authRecords["1.2.3.4"]
	authMu.Unlock()
	if stalePresent {
		t.Error("stale record was not purged")
	}
}

func TestBan(t *testing.T) {
	clearAuthRecords()
	now := time.Unix(4000, 0)
	// the first banThreshold-BanWarn failures carry no warning,
	// the last BanWarn do, and the final one starts the ban
	for i := 1; i <= banThreshold; i++ {
		at := now.Add(time.Duration(i) * time.Second)
		_, remaining := failureDelayAt("1.2.3.4", at)
		want := banThreshold - i
		if remaining != want {
			t.Errorf("failure %d: remaining = %d, want %d",
				i, remaining, want)
		}
		banned, _ := bannedAt("1.2.3.4", at)
		if banned != (i == banThreshold) {
			t.Errorf("failure %d: banned = %v", i, banned)
		}
	}
	after := now.Add(time.Duration(banThreshold) * time.Second)
	banned, left := bannedAt("1.2.3.4", after)
	if !banned || left <= 0 || left > banDuration {
		t.Errorf("banned = %v, left = %v", banned, left)
	}
	// another address is unaffected
	if banned, _ := bannedAt("5.6.7.8", after); banned {
		t.Error("unrelated address is banned")
	}
	// the ban must survive the forget window...
	midBan := after.Add(authForget + time.Minute)
	if midBan.Before(after.Add(banDuration)) {
		failureDelayAt("9.9.9.9", midBan) // triggers a purge
		if banned, _ := bannedAt("1.2.3.4", midBan); !banned {
			t.Error("ban did not survive the purge")
		}
	}
	// ...and expire afterwards, starting the count afresh
	expired := after.Add(banDuration + time.Minute)
	if banned, _ := bannedAt("1.2.3.4", expired); banned {
		t.Error("ban did not expire")
	}
	if _, remaining := failureDelayAt("1.2.3.4", expired); remaining != banThreshold-1 {
		t.Errorf("after ban expiry remaining = %d, want %d",
			remaining, banThreshold-1)
	}
}

func TestBanReset(t *testing.T) {
	clearAuthRecords()
	now := time.Unix(5000, 0)
	for i := 0; i < banThreshold; i++ {
		failureDelayAt("1.2.3.4", now)
	}
	if banned, _ := bannedAt("1.2.3.4", now); !banned {
		t.Fatal("not banned after banThreshold failures")
	}
	resetAt("1.2.3.4")
	if banned, _ := bannedAt("1.2.3.4", now); banned {
		t.Error("ban survived a reset")
	}
}

func TestAddrKey(t *testing.T) {
	a := &net.TCPAddr{IP: net.ParseIP("203.0.113.5"), Port: 5000}
	if k := AddrKey(a); k != "203.0.113.5" {
		t.Errorf("AddrKey = %q, want 203.0.113.5", k)
	}
	if k := AddrKey(nil); k != "" {
		t.Errorf("AddrKey(nil) = %q, want empty string", k)
	}
	if k := HostKey("192.0.2.7:1234"); k != "192.0.2.7" {
		t.Errorf("HostKey = %q, want 192.0.2.7", k)
	}
	if k := HostKey("[2001:db8::1]:443"); k != "2001:db8::1" {
		t.Errorf("HostKey(v6) = %q, want 2001:db8::1", k)
	}
}
