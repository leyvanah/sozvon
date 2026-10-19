package group

import (
	"errors"
	"net"

	"github.com/pion/webrtc/v4"
)

// PublicIP, when set, is the address the internet reaches this server at
// when that address is on none of its interfaces: a home server behind a
// router that forwards ports to it.  Every local host candidate is then
// advertised a second time under this address, with the same port, so a
// remote peer can reach us through the forward while a peer on the same
// LAN still goes straight to the local address.  This only works when the
// port is one the router forwards, which in practice means a single-port
// -udp-range.  (Sozvon)
var PublicIP net.IP

// ParsePublicIP validates the value of -public-ip.  It must be a global
// IPv4 address: the built-in TURN server is IPv4-only, and a private
// address here would be advertised to peers that cannot reach it -- the
// very thing the option exists to avoid.  (Sozvon)
func ParsePublicIP(s string) (net.IP, error) {
	ip := net.ParseIP(s)
	if ip == nil {
		return nil, errors.New("not an IP address: " + s)
	}
	a := ip.To4()
	if a == nil {
		return nil, errors.New("not an IPv4 address: " + s)
	}
	if !a.IsGlobalUnicast() || a.IsPrivate() ||
		// 100.64.0.0/10: carrier-grade NAT.  An address from it
		// means the provider's router, not ours, is in the way, and
		// no port forward at home will help.
		a[0] == 100 && a[1]&0xc0 == 64 {
		return nil, errors.New("not a public address: " + s)
	}
	return a, nil
}

func publicIPRule() webrtc.ICEAddressRewriteRule {
	return webrtc.ICEAddressRewriteRule{
		External:        []string{PublicIP.String()},
		AsCandidateType: webrtc.ICECandidateTypeHost,
		Mode:            webrtc.ICEAddressRewriteAppend,
		Networks:        []webrtc.NetworkType{webrtc.NetworkTypeUDP4},
	}
}
