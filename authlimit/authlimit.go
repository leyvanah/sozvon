// Package authlimit throttles repeated failed authentications, to slow
// down guessing of passwords.  It is shared by every authentication
// surface (WebSocket group joins, the recordings pages, the
// administrative API), so failures on one surface escalate the delay on
// all of them.
//
// Each failed attempt from an address sleeps for an exponentially
// growing delay, so a guesser is slowed to a crawl while a user who
// merely mistyped their password a few times is barely affected — and is
// cleared immediately once they get in.  After banThreshold failures the
// address is refused outright for banDuration; the last BanWarn attempts
// before that carry a warning, so a legitimate user is never banned
// without notice.  Every failure is logged with the offending address, so
// an external tool such as fail2ban can ban persistent guessers at the
// firewall (see contrib/fail2ban/).
//
// NB: the key is the connection's remote address.  Behind a reverse proxy
// that does not preserve it, all clients share one key — and a ban then
// hits everyone behind it.
package authlimit

import (
	"log"
	"net"
	"sync"
	"sync/atomic"
	"time"
)

const (
	authBaseDelay = 200 * time.Millisecond // delay after the first failure
	authMaxDelay  = 15 * time.Second       // cap on the per-attempt delay
	authForget    = 10 * time.Minute       // forget an address after this idle

	banThreshold = 10               // failures that trigger a temporary ban
	banDuration  = 15 * time.Minute // how long a banned address is refused

	// BanWarn is how many attempts before the ban the user should start
	// being warned.
	BanWarn = 3
)

type authRecord struct {
	failures    int
	last        time.Time
	bannedUntil time.Time
}

var (
	authMu      sync.Mutex
	authRecords = make(map[string]*authRecord)
)

// delayForFailures maps a running failure count to a delay: 200ms, 400ms,
// 800ms, ... doubling up to authMaxDelay.
func delayForFailures(n int) time.Duration {
	if n <= 1 {
		return authBaseDelay
	}
	shift := n - 1
	if shift > 16 {
		shift = 16
	}
	d := authBaseDelay << uint(shift)
	if d <= 0 || d > authMaxDelay {
		return authMaxDelay
	}
	return d
}

// purgeAuthLocked drops records idle for longer than authForget, except
// those still serving a ban.  The caller must hold authMu.
func purgeAuthLocked(now time.Time) {
	for k, r := range authRecords {
		if now.Sub(r.last) > authForget && !now.Before(r.bannedUntil) {
			delete(authRecords, k)
		}
	}
}

// failureDelayAt records a failed attempt for key at time now.  It
// returns the delay the caller should wait before answering and the
// number of attempts left before the address is banned (0 meaning it now
// is).  Separated from the sleep so it can be unit-tested without real
// time.
func failureDelayAt(key string, now time.Time) (time.Duration, int) {
	authMu.Lock()
	defer authMu.Unlock()
	purgeAuthLocked(now)
	r := authRecords[key]
	if r == nil {
		r = &authRecord{}
		authRecords[key] = r
	}
	if now.Sub(r.last) > authForget {
		r.failures = 0
	}
	// an expired ban starts the count afresh
	if !r.bannedUntil.IsZero() && !now.Before(r.bannedUntil) {
		r.failures = 0
		r.bannedUntil = time.Time{}
	}
	r.failures++
	r.last = now
	remaining := banThreshold - r.failures
	if remaining <= 0 {
		remaining = 0
		r.bannedUntil = now.Add(banDuration)
	}
	return delayForFailures(r.failures), remaining
}

// bannedAt reports whether key is banned at time now and, if so, for how
// much longer.
func bannedAt(key string, now time.Time) (bool, time.Duration) {
	authMu.Lock()
	defer authMu.Unlock()
	r := authRecords[key]
	if r == nil || !now.Before(r.bannedUntil) {
		return false, 0
	}
	return true, r.bannedUntil.Sub(now)
}

// resetAt clears the failure record for key, called on a successful auth.
func resetAt(key string) {
	authMu.Lock()
	defer authMu.Unlock()
	delete(authRecords, key)
}

// AddrKey reduces a remote address to a stable key: its IP, without the
// port.
func AddrKey(addr net.Addr) string {
	if addr == nil {
		return ""
	}
	return HostKey(addr.String())
}

// HostKey reduces a "host:port" remote address (as found in an
// http.Request's RemoteAddr) to a stable key: the host without the port.
func HostKey(remoteAddr string) string {
	if host, _, err := net.SplitHostPort(remoteAddr); err == nil {
		return host
	}
	return remoteAddr
}

// disabled turns the whole package into a no-op; tests use it so that
// delays and bans don't interfere with unrelated test suites.
var disabled atomic.Bool

// SetDisabled turns throttling and banning off (or back on).  For tests.
func SetDisabled(v bool) {
	disabled.Store(v)
}

// Failure records a failed authentication for key on the given surface
// and sleeps for an exponentially growing delay.  It logs the failure in
// a fail2ban-friendly format and returns the number of attempts left
// before the address is temporarily banned (0 meaning it now is).
func Failure(key, what string) int {
	if disabled.Load() {
		return banThreshold
	}
	d, remaining := failureDelayAt(key, time.Now())
	log.Printf("Failed login from %v (%v)", key, what)
	if remaining == 0 {
		log.Printf("Too many failed logins from %v, blocked for %v",
			key, banDuration)
	}
	time.Sleep(d)
	return remaining
}

// Banned reports whether key is temporarily banned after too many failed
// authentications and, if so, for how much longer.  Callers should check
// it before evaluating any credentials.
func Banned(key string) (bool, time.Duration) {
	if disabled.Load() {
		return false, 0
	}
	return bannedAt(key, time.Now())
}

// Reset clears the throttle for key after a successful authentication.
func Reset(key string) {
	resetAt(key)
}
