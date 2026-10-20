// A home server behind a router.  (Sozvon)
//
// contrib/install.sh notices when the server's own address is a private one,
// tells Sozvon the router's public address, and lists the ports the router
// has to forward -- which it cannot set up itself.  It writes that list to
// result.json, and to state.json too, so a run that stopped for want of the
// forwards (code port-forward) can still show it.  Each entry is one line:
//
//   "443/tcp -> 192.168.0.60:8444"
//
// This turns those lines into rows for a table, and tells from the address
// the user typed whether they are about to install on such a server.  Plain
// functions, no DOM: desktop/test/home-server.test.js runs them under Node.

(function (global) {
  'use strict';

  /**
   * Whether an address is one the internet cannot reach: the same ranges
   * install.sh's is_private() treats as "behind a router".  Only a literal
   * IPv4 address counts; a name says nothing until it is resolved, and the
   * installer finds out for itself either way.
   *
   * @param {string} host
   */
  function isPrivateIPv4(host) {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(host || '').trim());
    if (!m) return false;
    const [a, b] = [Number(m[1]), Number(m[2])];
    if ([a, b, Number(m[3]), Number(m[4])].some((n) => n > 255)) return false;
    return a === 10 || a === 127 ||
      (a === 192 && b === 168) ||
      (a === 172 && b >= 16 && b <= 31);
  }

  /**
   * One forward, as a row: the router's port and protocol, and where on the
   * LAN it goes.  null for a line that is not in the installer's format, so
   * a reworded line drops out of the table rather than showing half parsed.
   *
   * @param {string} line
   * @returns {{port: number, proto: string, toHost: string, toPort: number, line: string}|null}
   */
  function parseForward(line) {
    const m = /^\s*(\d+)\/(tcp|udp)\s*->\s*([^\s:]+):(\d+)\s*$/.exec(String(line || ''));
    if (!m) return null;
    return { port: Number(m[1]), proto: m[2], toHost: m[3], toPort: Number(m[4]),
      line: String(line).trim() };
  }

  /** @param {unknown} list */
  function parseForwards(list) {
    if (!Array.isArray(list)) return [];
    return list.map(parseForward).filter(Boolean);
  }

  /**
   * What the installer said about the router, from its result or its state.
   * An installer from before home servers reports none of it: that reads as
   * "not behind a router", which is what it assumed.
   *
   * @param {object|null|undefined} r  result.json, or state.json
   */
  function homeServerOf(r) {
    const forwards = parseForwards(r && r.forwards);
    return {
      behindNat: !!(r && r.behind_nat) || forwards.length > 0,
      publicIp: (r && typeof r.public_ip === 'string') ? r.public_ip : '',
      lanIp: (r && typeof r.lan_ip === 'string') ? r.lan_ip : '',
      forwards,
    };
  }

  /**
   * Install options for "443 on this server is taken": listen on another
   * port here, and have the router forward its own 443 to it.  Let's Encrypt
   * still reaches the server on 443 that way, and the address needs no port.
   *
   * @param {number|string} localPort
   * @returns {{httpsPort: number, publicPort: number}|null}  null for a port
   *   that cannot be used
   */
  function portOptions(localPort) {
    const n = Number(localPort);
    if (!Number.isInteger(n) || n < 1 || n > 65535 || n === 443) return null;
    return { httpsPort: n, publicPort: 443 };
  }

  /** The forwards as plain text, for "copy the details". */
  function forwardsText(forwards) {
    return forwards.map((f) => `${f.port}/${f.proto} → ${f.toHost}:${f.toPort}`).join('\n');
  }

  const api = { isPrivateIPv4, parseForward, parseForwards, homeServerOf, portOptions,
    forwardsText };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.HomeServer = api;
})(this);
