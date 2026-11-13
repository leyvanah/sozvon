'use strict';

// What kind of connection to the internet this computer has: the default
// gateway, and whether the address the router has outside is one the
// internet can reach -- a "white IP" -- or the inside of a provider's NAT.
//
// The question is answered by two observers who cannot both be wrong in the
// same way.  The router says what address it holds on its WAN side
// (UPnP's GetExternalIPAddress, or PCP/NAT-PMP's answer); a server outside
// says what address our connection arrives from.  If the router's address is
// private or in the carrier-grade range, there is a second NAT above it and
// no forward on this router can be reached from the internet.  If it is
// public but the outside sees another one, something between the router and
// the internet translates too -- a provider NAT using public addresses, or a
// VPN on this computer -- and a forward is no use either, at least on the
// path the check took.  Only when the two agree is a forward worth making.
//
// SOZVON is a fork of Galène (MIT); see LICENCE.

const { execFile } = require('child_process');
const fs = require('fs');
const https = require('https');
const net = require('net');

/**
 * What an IPv4 address is, as far as reaching it from the internet goes.
 *
 * @returns {'public'|'private'|'cgnat'|'loopback'|'link-local'|
 *   'unspecified'|'reserved'|'invalid'}
 */
function classify(ip) {
  if (!net.isIPv4(ip)) return 'invalid';
  const [a, b] = ip.split('.').map(Number);
  if (a === 0) return 'unspecified';
  if (a === 10) return 'private';
  if (a === 172 && b >= 16 && b <= 31) return 'private';
  if (a === 192 && b === 168) return 'private';
  // RFC 6598, the shared space providers number their NAT's inside with.
  if (a === 100 && b >= 64 && b <= 127) return 'cgnat';
  if (a === 127) return 'loopback';
  if (a === 169 && b === 254) return 'link-local';
  // Documentation, benchmarking, multicast and the rest of class E: none of
  // them is an address a router legitimately holds outside.
  if (a === 192 && b === 0) return 'reserved';
  if (a === 198 && (b === 18 || b === 19 || b === 51)) return 'reserved';
  if (a === 203 && b === 0) return 'reserved';
  if (a >= 224) return 'reserved';
  return 'public';
}

/**
 * The verdict on a connection.
 *
 * @param {{router?: string, observed?: string[]}} o - what the router says
 *   its WAN address is, and what each outside observer saw
 * @returns {{verdict: 'white'|'cgnat'|'double-nat'|'translated'|
 *   'no-wan-address'|'unknown', publicAddress?: string, detail: string}}
 */
function assess({ router, observed = [] }) {
  const seen = [...new Set(observed.filter((ip) => net.isIPv4(ip)))];
  if (!router) {
    return {
      verdict: 'unknown',
      detail: 'the router did not say what its outside address is',
    };
  }
  const kind = classify(router);
  if (kind === 'cgnat') {
    return {
      verdict: 'cgnat',
      detail: `the router's outside address ${router} is in the provider's shared range: the provider puts many customers behind one address`,
    };
  }
  if (kind === 'private') {
    return {
      verdict: 'double-nat',
      detail: `the router's outside address ${router} is private: there is another router between it and the internet`,
    };
  }
  if (kind !== 'public') {
    return {
      verdict: 'no-wan-address',
      detail: `the router's outside address ${router} is not a usable one (${kind}); it may not be connected yet`,
    };
  }
  if (seen.length === 0) {
    return {
      verdict: 'unknown',
      publicAddress: router,
      detail: 'no outside service could be asked which address we arrive from',
    };
  }
  if (seen.length > 1) {
    return {
      verdict: 'unknown',
      publicAddress: router,
      detail: `outside services disagree about our address (${seen.join(', ')})`,
    };
  }
  if (seen[0] !== router) {
    return {
      verdict: 'translated',
      publicAddress: router,
      detail: `the router holds ${router} but the internet sees ${seen[0]}: the provider translates again, or this computer is on a VPN`,
    };
  }
  return { verdict: 'white', publicAddress: router, detail: `${router} is a public address on the router` };
}

// Two independent services, so one being down or wrong does not decide.
const OBSERVERS = [
  'https://api.ipify.org/',
  'https://ipv4.icanhazip.com/',
];

/** GET a URL and return its body trimmed, or null. */
function fetchText(url, { timeout = 5000, localAddress } = {}) {
  return new Promise((resolve) => {
    const req = https.get(url, { timeout, localAddress, family: 4 }, (res) => {
      if (res.statusCode !== 200) { res.resume(); resolve(null); return; }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { if (body.length < 256) body += c; });
      res.on('end', () => resolve(body.trim()));
      res.on('error', () => resolve(null));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

/**
 * Asks the outside which address we arrive from.
 *
 * `localAddress` binds the request to the LAN interface, so the answer is
 * about the router's path even when a VPN is up.  On Windows that holds
 * only for a VPN that does not route by default; a full-tunnel one wins
 * regardless, and the verdict then says "translated" -- which is the honest
 * answer, because calls would go the same way.
 *
 * @returns {Promise<string[]>} the addresses seen, one per service that answered
 */
async function observedAddresses({ urls = OBSERVERS, localAddress, timeout, fetch = fetchText } = {}) {
  const answers = await Promise.all(urls.map((u) => fetch(u, { localAddress, timeout })));
  return answers.filter((a) => a && net.isIPv4(a));
}

// ---------------------------------------------------------- the gateway ----

/**
 * The IPv4 default gateway from `route print -4 0.0.0.0` on Windows.  The
 * headings are translated with the system language; the rows are not, so the
 * row is found by its shape: destination 0.0.0.0, mask 0.0.0.0, then the
 * gateway, the interface and the metric.  The lowest metric wins, as it does
 * for the system.
 */
function parseWindowsRoutes(text) {
  let best = null;
  for (const line of text.split(/\r?\n/)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 5 || f[0] !== '0.0.0.0' || f[1] !== '0.0.0.0') continue;
    if (!net.isIPv4(f[2]) || !net.isIPv4(f[3])) continue; // "On-link"
    const metric = Number(f[4]);
    if (!best || metric < best.metric) best = { gateway: f[2], interface: f[3], metric };
  }
  return best;
}

/** The default gateway from Linux's /proc/net/route (little-endian hex). */
function parseProcNetRoute(text) {
  let best = null;
  for (const line of text.split('\n').slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 8 || f[1] !== '00000000' || f[7] !== '00000000') continue;
    const g = parseInt(f[2], 16);
    if (!g) continue;
    const gateway = [g & 255, (g >>> 8) & 255, (g >>> 16) & 255, g >>> 24].join('.');
    const metric = Number(f[6]);
    if (!best || metric < best.metric) best = { gateway, interface: f[0], metric };
  }
  return best;
}

/** The default gateway from macOS's `route -n get default`. */
function parseBsdRoute(text) {
  const m = /gateway:\s*(\S+)/.exec(text);
  return m && net.isIPv4(m[1]) ? { gateway: m[1] } : null;
}

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 5000, windowsHide: true }, (err, stdout) => {
      resolve(err ? '' : stdout);
    });
  });
}

/** @returns {Promise<null|{gateway: string, interface?: string}>} */
async function defaultGateway() {
  if (process.platform === 'win32') {
    return parseWindowsRoutes(await run('route', ['print', '-4', '0.0.0.0']));
  }
  if (process.platform === 'linux') {
    try {
      return parseProcNetRoute(fs.readFileSync('/proc/net/route', 'utf8'));
    } catch (_) {
      return null;
    }
  }
  return parseBsdRoute(await run('route', ['-n', 'get', 'default']));
}

module.exports = {
  classify,
  assess,
  observedAddresses,
  defaultGateway,
  parseWindowsRoutes,
  parseProcNetRoute,
  parseBsdRoute,
  OBSERVERS,
};
