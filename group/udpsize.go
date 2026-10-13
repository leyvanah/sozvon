package group

// Sozvon: datagrams larger than an Ethernet frame.
//
// pion's ICE layer reads UDP into 8192-byte buffers, but the WebRTC layer
// above it read each datagram into a buffer of receiveMTU, 1500 bytes, and
// one that did not fit was dropped with "mux: failed to read from
// packetio.Buffer short buffer".  On 2026-10-12 a participant under a VPN
// produced 126 of those in ten seconds while the server measured 15.6% loss
// on their stream (sozvon-tasks#63).  Browsers do not send RTP that large, so
// something on that path glued or grew the datagrams, and which it was is
// not known yet: the receive buffer now matches the ICE layer's
// (ReceiveMTU), and the datagrams that would have been dropped are counted
// and their sizes logged, without addresses.  Sizes in multiples of a
// browser's packet point at coalescing; others at datagrams sent that large.

import (
	"fmt"
	"log"
	"net"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/pion/transport/v4"
	"github.com/pion/transport/v4/stdnet"
)

// ReceiveMTU is the largest datagram the WebRTC layer reads whole: the
// same as pion's ICE layer, which reads every datagram before it.
const ReceiveMTU = 8192

// oversized is the size above which a datagram used to be dropped.
const oversized = 1500

// LogOversized enables the log of datagrams over 1500 bytes (set from
// -log-connections).
var LogOversized bool

// oversizeStats counts datagrams over 1500 bytes over an interval.
type oversizeStats struct {
	mu    sync.Mutex
	sizes map[int]int
}

var oversize = &oversizeStats{}

func (s *oversizeStats) note(n int) {
	s.mu.Lock()
	if s.sizes == nil {
		s.sizes = make(map[int]int)
	}
	s.sizes[n]++
	s.mu.Unlock()
}

// take returns and resets what was counted.
func (s *oversizeStats) take() map[int]int {
	s.mu.Lock()
	defer s.mu.Unlock()
	m := s.sizes
	s.sizes = nil
	return m
}

// oversizeLine describes the datagrams counted in an interval: how many,
// the largest, and the commonest sizes.  "" if there were none.
func oversizeLine(sizes map[int]int, interval time.Duration) string {
	if len(sizes) == 0 {
		return ""
	}
	type sc struct{ size, count int }
	var all []sc
	total, largest := 0, 0
	for size, count := range sizes {
		all = append(all, sc{size, count})
		total += count
		if size > largest {
			largest = size
		}
	}
	sort.Slice(all, func(i, j int) bool {
		if all[i].count != all[j].count {
			return all[i].count > all[j].count
		}
		return all[i].size < all[j].size
	})
	var common []string
	for i := 0; i < len(all) && i < 5; i++ {
		common = append(common,
			fmt.Sprintf("%d×%d", all[i].size, all[i].count))
	}
	return fmt.Sprintf("udp: %d datagram(s) over %d bytes in %v, "+
		"largest %d, commonest %s",
		total, oversized, interval, largest, strings.Join(common, " "))
}

// reportOversized logs what was counted, every interval, while there is
// anything to say.
func reportOversized(interval time.Duration) {
	for range time.Tick(interval) {
		line := oversizeLine(oversize.take(), interval)
		if line != "" && LogOversized {
			log.Print(line)
		}
	}
}

// sizingNet is the network pion's UDP mux listens on, with every UDP
// socket wrapped to count datagrams over 1500 bytes.
type sizingNet struct {
	transport.Net
}

func (n sizingNet) ListenUDP(network string, laddr *net.UDPAddr) (transport.UDPConn, error) {
	c, err := n.Net.ListenUDP(network, laddr)
	if err != nil {
		return nil, err
	}
	return sizingConn{c}, nil
}

type sizingConn struct {
	transport.UDPConn
}

func (c sizingConn) ReadFrom(b []byte) (int, net.Addr, error) {
	n, addr, err := c.UDPConn.ReadFrom(b)
	if err == nil && n > oversized {
		oversize.note(n)
	}
	return n, addr, err
}

func newSizingNet() (transport.Net, error) {
	n, err := stdnet.NewNet()
	if err != nil {
		return nil, err
	}
	return sizingNet{n}, nil
}
