package rtpconn

// Sozvon: a tag for the network a client connects from.
//
// A client that finds UDP broken stops using it and remembers that for a
// few hours (static/turn-fallback.js), but a browser cannot tell one network
// from another: with relaying forced it gathers no candidate that shows its
// public address.  So on 2026-10-12 a decision taken under a VPN outlived the
// VPN, and the call went on over the TCP relay for an hour on a network
// where UDP worked.  The server sees the address, so it tells the client
// which network it is on -- as a tag, not the address: a salted hash of its
// /24 (IPv4) or /56 (IPv6) prefix, the salt drawn afresh at every start, so
// the tag says nothing about where the client is and cannot be matched
// across restarts.  A restart only makes a remembered decision be taken
// again.

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"net"
	"net/netip"
)

var networkSalt = func() []byte {
	b := make([]byte, 16)
	rand.Read(b)
	return b
}()

// networkTag returns the tag of the network addr belongs to, or "" if addr
// is not an IP address.
func networkTag(addr net.Addr) string {
	if addr == nil {
		return ""
	}
	var a netip.Addr
	switch v := addr.(type) {
	case *net.TCPAddr:
		a = v.AddrPort().Addr()
	case *net.UDPAddr:
		a = v.AddrPort().Addr()
	default:
		ap, err := netip.ParseAddrPort(addr.String())
		if err != nil {
			return ""
		}
		a = ap.Addr()
	}
	a = a.Unmap()
	if !a.IsValid() {
		return ""
	}
	bits := 24
	if a.Is6() {
		bits = 56
	}
	p, err := a.Prefix(bits)
	if err != nil {
		return ""
	}
	h := sha256.New()
	h.Write(networkSalt)
	h.Write([]byte(p.String()))
	return hex.EncodeToString(h.Sum(nil)[:8])
}
