package webserver

import (
	"errors"
	"net"
	"net/http"
	"net/netip"
	"strings"
)

// trustedProxies is the set of reverse proxies whose X-Forwarded-For
// header is believed (Sozvon).  Empty by default: the header is then
// ignored and every client is known by its connection's address, which
// is the only safe choice when nothing is known about the network.
var trustedProxies []netip.Prefix

// SetTrustedProxies parses a comma-separated list of IP addresses and
// CIDR prefixes of trusted reverse proxies.
func SetTrustedProxies(list string) error {
	var prefixes []netip.Prefix
	for _, s := range strings.Split(list, ",") {
		s = strings.TrimSpace(s)
		if s == "" {
			continue
		}
		var p netip.Prefix
		var err error
		if strings.ContainsRune(s, '/') {
			p, err = netip.ParsePrefix(s)
		} else {
			var a netip.Addr
			a, err = netip.ParseAddr(s)
			if err == nil {
				p = netip.PrefixFrom(a, a.BitLen())
			}
		}
		if err != nil {
			return err
		}
		prefixes = append(prefixes, p.Masked())
	}
	trustedProxies = prefixes
	return nil
}

func isTrustedProxy(a netip.Addr) bool {
	a = a.Unmap()
	for _, p := range trustedProxies {
		if p.Contains(a) {
			return true
		}
	}
	return false
}

// remoteAddr returns the address of the client that made the request, as
// "host:port".  Behind a trusted reverse proxy that is the address the
// proxy reports in X-Forwarded-For, not the proxy's own: without this,
// every client behind the proxy shares one login-throttle key, and one
// person's failed logins lock everyone out.
//
// X-Forwarded-For is walked from the right, skipping trusted proxies, and
// the first address that is not one is the client.  Everything to its
// left was written by the client itself and cannot be believed.  A port
// is not forwarded, so the returned address carries port 0.
func remoteAddr(r *http.Request) string {
	peer, err := netip.ParseAddrPort(r.RemoteAddr)
	if err != nil || !isTrustedProxy(peer.Addr()) {
		return r.RemoteAddr
	}
	client, ok := forwardedClient(r.Header.Values("X-Forwarded-For"))
	if !ok {
		return r.RemoteAddr
	}
	return netip.AddrPortFrom(client, 0).String()
}

func forwardedClient(headers []string) (netip.Addr, bool) {
	var hops []string
	for _, h := range headers {
		hops = append(hops, strings.Split(h, ",")...)
	}
	for i := len(hops) - 1; i >= 0; i-- {
		a, err := netip.ParseAddr(strings.TrimSpace(hops[i]))
		if err != nil {
			// garbage we cannot vouch for: stop rather than
			// guess past it
			return netip.Addr{}, false
		}
		a = a.Unmap()
		if !isTrustedProxy(a) {
			return a, true
		}
	}
	return netip.Addr{}, false
}

// remoteTCPAddr is remoteAddr as a net.Addr, for the clients that keep one.
func remoteTCPAddr(r *http.Request) (net.Addr, error) {
	ap, err := netip.ParseAddrPort(remoteAddr(r))
	if err != nil {
		return nil, errors.New("bad remote address " + r.RemoteAddr)
	}
	return net.TCPAddrFromAddrPort(ap), nil
}
