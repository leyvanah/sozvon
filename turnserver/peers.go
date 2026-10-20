package turnserver

import (
	"errors"
	"net"

	"github.com/pion/turn/v5"
)

// Where the relay may send.  (Sozvon)
//
// Anyone who has joined a call holds the relay's credentials until the
// server restarts, and an unfiltered relay sends wherever it is asked: to
// services on the machine itself, and -- on a home server behind a router
// -- to every device on the home network, which the router otherwise keeps
// out of reach.  The relay only ever needs to reach this server's own media
// sockets and the internet, so it is held to exactly that, in three places:
//
//   - permitPeer refuses TURN permissions for private and local addresses
//     other than our own.  Permissions name an address, not a port.
//   - filteredRelay drops a datagram to one of our own addresses unless it
//     goes to a media port, so the relay cannot be used to reach other UDP
//     services on this machine (a DNS server on the LAN address, say).
//   - TCP allocations (RFC 6062) are refused outright: they let a client
//     open TCP connections from here -- to a router's admin page, for
//     instance -- and no WebRTC client asks for one.

// MediaPortMin and MediaPortMax are the UDP ports the SFU receives media
// on (-udp-range), the only ports the relay may send to on this machine.
// Both zero means they are not fixed -- the SFU takes ephemeral ports --
// and any port on our own addresses is allowed.
var MediaPortMin, MediaPortMax uint16

var errTCPRelay = errors.New("TCP allocations are not offered")

func permitPeer(_ net.Addr, peer net.IP) bool {
	if peer.IsLoopback() {
		return false
	}
	if isOwnAddress(peer) {
		return true
	}
	return !isInternal(peer)
}

// permitDestination is permitPeer with the port: what filteredRelay
// checks for every datagram.
func permitDestination(addr *net.UDPAddr) bool {
	if !permitPeer(nil, addr.IP) {
		return false
	}
	if isInternal(addr.IP) || isOwnAddress(addr.IP) {
		return isMediaPort(addr.Port)
	}
	return true
}

func isMediaPort(port int) bool {
	if MediaPortMin == 0 && MediaPortMax == 0 {
		return true
	}
	return port >= int(MediaPortMin) && port <= int(MediaPortMax)
}

// isInternal reports addresses that lead into a private network or the
// machine itself rather than to the internet.
func isInternal(ip net.IP) bool {
	if a := ip.To4(); a != nil {
		ip = a
		// 100.64.0.0/10, carrier-grade NAT: a provider's private
		// network, and Tailscale's addresses.
		if a[0] == 100 && a[1]&0xc0 == 64 {
			return true
		}
	}
	return ip.IsLoopback() || ip.IsPrivate() || ip.IsUnspecified() ||
		ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() ||
		ip.IsInterfaceLocalMulticast() || ip.IsMulticast()
}

// isOwnAddress reports whether ip is on one of our interfaces, or is the
// public address given with -public-ip.  Read afresh on every call: a
// home server's LAN address can change under DHCP while it runs.
func isOwnAddress(ip net.IP) bool {
	if PublicIP != nil && ip.Equal(PublicIP) {
		return true
	}
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return false
	}
	for _, a := range addrs {
		if n, ok := a.(*net.IPNet); ok && n.IP.Equal(ip) {
			return true
		}
	}
	return false
}

// filteredRelay wraps a relay address generator so that every relay
// socket it hands out checks where it sends, and so that it hands out no
// TCP relays at all.
type filteredRelay struct {
	turn.RelayAddressGenerator
}

func (r filteredRelay) AllocatePacketConn(conf turn.AllocateListenerConfig) (net.PacketConn, net.Addr, error) {
	c, a, err := r.RelayAddressGenerator.AllocatePacketConn(conf)
	if err != nil {
		return nil, nil, err
	}
	return filteredConn{c}, a, nil
}

func (r filteredRelay) AllocateListener(turn.AllocateListenerConfig) (net.Listener, net.Addr, error) {
	return nil, nil, errTCPRelay
}

func (r filteredRelay) AllocateConn(turn.AllocateConnConfig) (net.Conn, error) {
	return nil, errTCPRelay
}

type filteredConn struct {
	net.PacketConn
}

func (c filteredConn) WriteTo(p []byte, addr net.Addr) (int, error) {
	if u, ok := addr.(*net.UDPAddr); ok && !permitDestination(u) {
		// Dropped as the network would drop it: UDP promises nothing,
		// and an error here would only end up in the server's log.
		return len(p), nil
	}
	return c.PacketConn.WriteTo(p, addr)
}
