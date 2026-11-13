'use strict';

// PCP (RFC 6887) and its predecessor NAT-PMP (RFC 6886): the other two ways a
// router may let us forward ports, tried when UPnP is off or absent.
//
// Both are a single UDP datagram to the default gateway's port 5351 and a
// single answer.  A PCP server that is asked in NAT-PMP's version answers in
// it, and a NAT-PMP-only server asked in PCP's version answers "unsupported
// version" in its own format -- so one client can ask PCP first and fall back
// on that answer, which is what RFC 6887 section 9 prescribes.
//
// Neither protocol tells us the gateway; the caller must (see netaddr.js).
//
// SOZVON is a fork of Galène (MIT); see LICENCE.

const crypto = require('crypto');
const dgram = require('dgram');

const PORT = 5351;

const PROTO = { TCP: 6, UDP: 17 };

const PCP_RESULTS = {
  1: 'unsupported-version',
  2: 'not-authorized',
  3: 'malformed-request',
  4: 'unsupported-opcode',
  5: 'unsupported-option',
  6: 'malformed-option',
  7: 'network-failure',
  8: 'no-resources',
  9: 'unsupported-protocol',
  10: 'user-exceeded-quota',
  11: 'cannot-provide-external',
  12: 'address-mismatch',
  13: 'excessive-remote-peers',
};

const NATPMP_RESULTS = {
  1: 'unsupported-version',
  2: 'not-authorized',
  3: 'network-failure',
  4: 'no-resources',
  5: 'unsupported-opcode',
};

class PortMapProtocolError extends Error {
  constructor(message, { code, protocol } = {}) {
    super(message);
    this.name = 'PortMapProtocolError';
    this.code = code || 'failed';
    this.protocol = protocol;
  }
}

/**
 * Sends one request and waits for an answer that `accept` takes, resending
 * on the RFC's schedule (250 ms, doubling).  Four tries -- under four
 * seconds -- rather than the RFC's nine: a router that has not answered by
 * then is not going to, and someone is watching a progress line.
 *
 * Resolves with {msg, localAddress}; the local address is the one the
 * gateway is reached from, which PCP needs inside its request.
 */
function exchange(gateway, port, build, accept, { tries = 4, initial = 250 } = {}) {
  return new Promise((resolve, reject) => {
    const s = dgram.createSocket('udp4');
    let timer;
    let left = tries;
    let wait = initial;
    let settled = false;

    function done(err, val) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { s.close(); } catch (_) { /* closed */ }
      if (err) reject(err); else resolve(val);
    }

    function send() {
      if (left-- <= 0) {
        done(new PortMapProtocolError(`no answer from ${gateway}:${port}`, { code: 'timeout' }));
        return;
      }
      s.send(build(s.address().address), (err) => { if (err) done(err); });
      timer = setTimeout(send, wait);
      wait *= 2;
    }

    s.on('error', (err) => done(err));
    // A connected socket receives only from the gateway's port, which is
    // the check RFC 6886 3.1 asks for.  Connecting also fixes the local
    // address to the one routed to the gateway and makes address() report
    // it.
    s.on('message', (msg) => {
      if (accept(msg)) done(null, { msg });
    });
    s.connect(port, gateway, (err) => {
      if (err) done(err); else send();
    });
  });
}

// ------------------------------------------------------------- NAT-PMP ----

/** @returns {Promise<{externalAddress: string, epoch: number}>} */
async function natpmpExternalAddress(gateway, opts = {}) {
  const port = opts.port || PORT;
  const { msg } = await exchange(gateway, port,
    () => Buffer.from([0, 0]),
    (m) => m.length >= 12 && m[0] === 0 && m[1] === 128 ? m : null,
    opts);
  const result = msg.readUInt16BE(2);
  if (result !== 0) {
    throw new PortMapProtocolError(`NAT-PMP: external address refused (${result})`,
      { code: NATPMP_RESULTS[result] || 'failed', protocol: 'natpmp' });
  }
  return {
    externalAddress: `${msg[8]}.${msg[9]}.${msg[10]}.${msg[11]}`,
    epoch: msg.readUInt32BE(4),
  };
}

/**
 * @param {string} gateway
 * @param {{protocol: 'TCP'|'UDP', internalPort: number, externalPort: number,
 *   lifetime: number}} m - lifetime 0 deletes the mapping
 * @returns {Promise<{externalPort: number, lifetime: number, epoch: number}>}
 */
async function natpmpMap(gateway, m, opts = {}) {
  const port = opts.port || PORT;
  const op = m.protocol === 'UDP' ? 1 : 2;
  const req = Buffer.alloc(12);
  req[0] = 0;
  req[1] = op;
  req.writeUInt16BE(m.internalPort, 4);
  req.writeUInt16BE(m.lifetime === 0 ? 0 : m.externalPort, 6);
  req.writeUInt32BE(m.lifetime, 8);
  const { msg } = await exchange(gateway, port, () => req,
    (r) => r.length >= 16 && r[0] === 0 && r[1] === 128 + op &&
      r.readUInt16BE(8) === m.internalPort ? r : null,
    opts);
  const result = msg.readUInt16BE(2);
  if (result !== 0) {
    throw new PortMapProtocolError(`NAT-PMP: ${m.protocol} ${m.externalPort} refused (${result})`,
      { code: NATPMP_RESULTS[result] || 'failed', protocol: 'natpmp' });
  }
  return {
    externalPort: msg.readUInt16BE(10),
    lifetime: msg.readUInt32BE(12),
    epoch: msg.readUInt32BE(4),
  };
}

// ----------------------------------------------------------------- PCP ----

function ipv4Mapped(addr) {
  const b = Buffer.alloc(16);
  b[10] = 0xff;
  b[11] = 0xff;
  if (addr) {
    const parts = addr.split('.').map(Number);
    for (let i = 0; i < 4; i++) b[12 + i] = parts[i];
  }
  return b;
}

function fromIpv4Mapped(b) {
  return `${b[12]}.${b[13]}.${b[14]}.${b[15]}`;
}

/**
 * A PCP MAP request.  The nonce has to be the same for every request that
 * renews or deletes this mapping (RFC 6887 11.2), so it belongs to the
 * caller's mapping, not to the call.
 *
 * @param {{protocol: 'TCP'|'UDP', internalPort: number, externalPort: number,
 *   lifetime: number, nonce: Buffer, clientAddress: string,
 *   externalAddress?: string}} m
 */
function pcpMapRequest(m) {
  const b = Buffer.alloc(60);
  b[0] = 2; // version
  b[1] = 1; // MAP, request
  b.writeUInt32BE(m.lifetime, 4);
  ipv4Mapped(m.clientAddress).copy(b, 8);
  m.nonce.copy(b, 24);
  b[36] = PROTO[m.protocol];
  b.writeUInt16BE(m.internalPort, 40);
  b.writeUInt16BE(m.externalPort, 42);
  // All zeros in the IPv4-mapped form means "any IPv4 address of yours".
  ipv4Mapped(m.externalAddress || '0.0.0.0').copy(b, 44);
  return b;
}

/**
 * @returns {Promise<{externalAddress: string, externalPort: number,
 *   lifetime: number, epoch: number}>}
 */
async function pcpMap(gateway, m, opts = {}) {
  const port = opts.port || PORT;
  const { msg } = await exchange(gateway, port,
    (local) => pcpMapRequest({ ...m, clientAddress: local }),
    (r) => {
      // A NAT-PMP server's "unsupported version" is two bytes shorter than
      // anything PCP sends; recognise it so the caller can fall back.
      if (r.length >= 4 && r[0] === 0 && r[1] >= 128) return r;
      if (r.length >= 60 && r[0] === 2 && r[1] === 0x81 &&
          r.subarray(24, 36).equals(m.nonce)) return r;
      return null;
    },
    opts);
  if (msg[0] === 0) {
    throw new PortMapProtocolError('PCP: the gateway speaks only NAT-PMP',
      { code: 'unsupported-version', protocol: 'pcp' });
  }
  const result = msg[3];
  if (result !== 0) {
    throw new PortMapProtocolError(`PCP: ${m.protocol} ${m.externalPort} refused (${result})`,
      { code: PCP_RESULTS[result] || 'failed', protocol: 'pcp' });
  }
  return {
    externalAddress: fromIpv4Mapped(msg.subarray(44, 60)),
    externalPort: msg.readUInt16BE(42),
    lifetime: msg.readUInt32BE(4),
    epoch: msg.readUInt32BE(8),
  };
}

function newNonce() {
  return crypto.randomBytes(12);
}

module.exports = {
  natpmpExternalAddress,
  natpmpMap,
  pcpMap,
  pcpMapRequest,
  newNonce,
  PortMapProtocolError,
  PORT,
};
