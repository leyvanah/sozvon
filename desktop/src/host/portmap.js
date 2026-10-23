'use strict';

// Keeps a set of ports forwarded from the router to this computer, by
// whichever protocol the router answers: UPnP IGD first, then PCP, then
// NAT-PMP.
//
// "Keeps" is the point.  A mapping is not made once: it carries a lease the
// router forgets it after, the router forgets all of it when it reboots, and
// a laptop's LAN address changes when DHCP hands it a new one or it moves to
// another network -- after which the router is forwarding to an address that
// is no longer us.  So the whole mapping is redone on a timer and whenever
// this computer's addresses change, and redoing it is safe: a port already
// mapped to us is renewed, one mapped by us to our previous address is moved,
// and one somebody else holds is left alone and reported.
//
// Ports below 1024 deserve a word.  Let's Encrypt has to reach us on 443, and
// a good share of routers refuse to map anything below 1024 by UPnP -- the
// default rules of miniupnpd, which most routers' UPnP is built on, allow
// only 1024-65535, and refuse with the same error code (718) as a port held
// by another machine.  An entry nobody holds that still conflicts is
// reported as "refused", which is what it is.
//
// SOZVON is a fork of Galène (MIT); see LICENCE.

const EventEmitter = require('events');
const os = require('os');

const upnp = require('./upnp');
const natpmp = require('./natpmp');
const netaddr = require('./netaddr');

/**
 * @typedef {Object} PortSpec
 * @property {'TCP'|'UDP'} protocol
 * @property {number} externalPort - on the router
 * @property {number} internalPort - on this computer
 * @property {boolean} [required=true] - mapping fails without it
 */

/**
 * @typedef {Object} PortResult
 * @property {'TCP'|'UDP'} protocol
 * @property {number} externalPort
 * @property {number} internalPort
 * @property {boolean} ok
 * @property {boolean} required
 * @property {string} [code] - why not: 'conflict' (another machine holds it),
 *   'refused' (the router will not map it), or the protocol's own error
 * @property {string} [holder] - the LAN address holding a conflicting port
 * @property {string} [error]
 */

/**
 * @typedef {Object} MapState
 * @property {'upnp'|'pcp'|'natpmp'|null} method
 * @property {string} [gateway]
 * @property {string} [localAddress] - this computer, as the router sees it
 * @property {string} [externalAddress] - the router's WAN address
 * @property {PortResult[]} ports
 * @property {boolean} ok - every required port is mapped
 * @property {Array<{method: string, code: string, error: string}>} tried
 */

const DEFAULT_LEASE = 7200;

function fingerprint() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal) out.push(`${name}=${a.address}`);
    }
  }
  return out.sort().join(',');
}

class PortMapper extends EventEmitter {
  /**
   * @param {Object} o
   * @param {PortSpec[]} o.ports
   * @param {string} [o.description='Sozvon'] - how our mappings are labelled
   *   on the router, and how we recognise our own stale ones
   * @param {number} [o.lease=7200] - seconds
   * @param {string[]} [o.methods] - default ['upnp', 'pcp', 'natpmp']
   * @param {Object} [o.upnp] - options for upnp.findGateway (tests point it
   *   at a fake router)
   * @param {{gateway?: string, port?: number}} [o.natpmp] - the gateway for
   *   PCP and NAT-PMP; default the system's default gateway
   * @param {(line: string) => void} [o.log]
   */
  constructor(o) {
    super();
    this.ports = o.ports.map((p) => ({ required: true, ...p }));
    this.description = o.description || 'Sozvon';
    this.lease = o.lease ?? DEFAULT_LEASE;
    this.methods = o.methods || ['upnp', 'pcp', 'natpmp'];
    this.upnpOpts = o.upnp || {};
    this.natpmpOpts = o.natpmp || {};
    this.log = o.log || (() => {});
    // PCP identifies a mapping by its nonce: renewing or deleting it needs
    // the one it was made with.
    this.nonces = new Map();
    this.state = { method: null, ports: [], ok: false, tried: [] };
    this.timer = null;
    this.watcher = null;
    this.running = null;
  }

  /** Maps every port, by the first method that maps the required ones. */
  async map() {
    // Overlapping runs -- a timer firing during a network change -- would
    // race each other on the router; the second waits for the first.
    while (this.running) await this.running.catch(() => {});
    this.running = this._map();
    try {
      return await this.running;
    } finally {
      this.running = null;
    }
  }

  async _map() {
    const tried = [];
    let best = null;
    for (const method of this.methods) {
      let state;
      try {
        state = await this[`_${method}`]();
      } catch (e) {
        this.log(`${method}: ${e.message}`);
        tried.push({ method, code: e.code || 'failed', error: e.message });
        continue;
      }
      state.tried = tried.slice();
      if (state.ok) {
        best = state;
        break;
      }
      tried.push({
        method,
        code: 'incomplete',
        error: state.ports.filter((p) => !p.ok).map((p) => `${p.protocol} ${p.externalPort}: ${p.code}`).join('; '),
      });
      // A method that mapped some ports is a better report than one that
      // found no router, even if a later one does no better.
      if (!best || state.ports.filter((p) => p.ok).length > best.ports.filter((p) => p.ok).length) {
        best = state;
      }
    }
    this.state = best ? { ...best, tried } : { method: null, ports: this.ports.map((p) => ({ ...p, ok: false, code: 'no-method' })), ok: false, tried };
    this.emit('state', this.state);
    return this.state;
  }

  // ---------------------------------------------------------------- UPnP --

  async _upnp() {
    // The router we used last time is asked first, which skips the search;
    // its description is fetched afresh all the same, because that fetch is
    // what tells us our own address, and our address is what changes.  On
    // another network the old URL fails (or finds that network's router),
    // and the search runs.
    let gw = null;
    if (this.gw) gw = await upnp.Gateway.connect(this.gw.location, this.upnpOpts).catch(() => null);
    if (!gw) gw = await upnp.findGateway(this.upnpOpts);
    this.gw = gw;
    const local = gw.localAddress;
    const results = [];
    for (const p of this.ports) {
      results.push(await this._upnpOne(gw, p, local));
    }
    return {
      method: 'upnp',
      gateway: new URL(gw.location).hostname,
      localAddress: local,
      externalAddress: gw.externalAddress,
      ports: results,
      ok: results.every((r) => r.ok || !r.required),
    };
  }

  async _upnpOne(gw, p, local) {
    const base = { protocol: p.protocol, externalPort: p.externalPort, internalPort: p.internalPort, required: p.required };
    try {
      const entry = await gw.getSpecificPortMappingEntry(p.protocol, p.externalPort);
      if (entry && entry.internalClient && entry.internalClient !== local) {
        if (entry.description !== this.description) {
          return { ...base, ok: false, code: 'conflict', holder: entry.internalClient, error: `held by ${entry.internalClient} (${entry.description || 'no description'})` };
        }
        // Ours, made when this computer had another address.
        this.log(`upnp: moving ${p.protocol} ${p.externalPort} from ${entry.internalClient} to ${local}`);
        await gw.deletePortMapping(p.protocol, p.externalPort);
      }
      const m = { ...p, internalClient: local, description: this.description, lease: this.lease };
      try {
        await gw.addPortMapping(m);
      } catch (e) {
        if (e.code === 'only-permanent-leases-supported' && m.lease !== 0) {
          await gw.addPortMapping({ ...m, lease: 0 });
        } else if (e.code === 'conflict' && !entry) {
          // Nobody holds it, yet it conflicts: the router's own rules, or a
          // service on the router itself (its admin page on 443).
          return { ...base, ok: false, code: 'refused', error: e.message };
        } else {
          throw e;
        }
      }
      return { ...base, ok: true };
    } catch (e) {
      return { ...base, ok: false, code: e.code || 'failed', error: e.message };
    }
  }

  // ------------------------------------------------------ PCP and NAT-PMP --

  async _gateway() {
    if (this.natpmpOpts.gateway) return this.natpmpOpts.gateway;
    const g = await netaddr.defaultGateway();
    if (!g) throw Object.assign(new Error('no default gateway'), { code: 'no-gateway' });
    return g.gateway;
  }

  async _pcp() {
    const gateway = await this._gateway();
    const results = [];
    let externalAddress;
    for (const p of this.ports) {
      const base = { protocol: p.protocol, externalPort: p.externalPort, internalPort: p.internalPort, required: p.required };
      const key = `${p.protocol}/${p.internalPort}`;
      if (!this.nonces.has(key)) this.nonces.set(key, natpmp.newNonce());
      const nonce = this.nonces.get(key);
      let r;
      try {
        r = await natpmp.pcpMap(gateway, { ...p, lifetime: this.lease, nonce }, this.natpmpOpts);
      } catch (e) {
        // The first port tells us whether the router speaks PCP at all.
        if (results.length === 0 && (e.code === 'unsupported-version' || e.code === 'timeout')) throw e;
        results.push({ ...base, ok: false, code: e.code, error: e.message });
        continue;
      }
      externalAddress = r.externalAddress;
      if (r.externalPort !== p.externalPort) {
        // The router gave us another port.  Useless for 443, and a
        // mapping we did not ask for: hand it back.
        await natpmp.pcpMap(gateway, { ...p, lifetime: 0, nonce }, this.natpmpOpts).catch(() => {});
        results.push({ ...base, ok: false, code: 'conflict', error: `the router offered ${r.externalPort} instead` });
        continue;
      }
      results.push({ ...base, ok: true, lifetime: r.lifetime });
    }
    return {
      method: 'pcp',
      gateway,
      externalAddress,
      ports: results,
      ok: results.every((r) => r.ok || !r.required),
    };
  }

  async _natpmp() {
    const gateway = await this._gateway();
    const { externalAddress } = await natpmp.natpmpExternalAddress(gateway, this.natpmpOpts);
    const results = [];
    for (const p of this.ports) {
      const base = { protocol: p.protocol, externalPort: p.externalPort, internalPort: p.internalPort, required: p.required };
      try {
        const r = await natpmp.natpmpMap(gateway, { ...p, lifetime: this.lease }, this.natpmpOpts);
        if (r.externalPort !== p.externalPort) {
          await natpmp.natpmpMap(gateway, { ...p, lifetime: 0 }, this.natpmpOpts).catch(() => {});
          results.push({ ...base, ok: false, code: 'conflict', error: `the router offered ${r.externalPort} instead` });
          continue;
        }
        results.push({ ...base, ok: true, lifetime: r.lifetime });
      } catch (e) {
        results.push({ ...base, ok: false, code: e.code, error: e.message });
      }
    }
    return {
      method: 'natpmp',
      gateway,
      externalAddress,
      ports: results,
      ok: results.every((r) => r.ok || !r.required),
    };
  }

  // ----------------------------------------------------------- lifecycle --

  /**
   * Maps now, then keeps the mapping: again at half the lease, and whenever
   * this computer's IPv4 addresses change (checked every `watchEvery` ms --
   * Node has no event for it; the app should also call refresh() when the
   * system resumes from sleep).
   */
  async start({ watchEvery = 10000 } = {}) {
    const state = await this.map();
    this._schedule();
    this._fp = fingerprint();
    this.watcher = setInterval(() => {
      const fp = fingerprint();
      if (fp !== this._fp) {
        this._fp = fp;
        this.log('network changed; mapping again');
        this.refresh();
      }
    }, watchEvery);
    this.watcher.unref();
    return state;
  }

  _schedule() {
    clearTimeout(this.timer);
    // Half the lease, but not less than a minute; a permanent (0) lease is
    // still renewed hourly, because a router reboot forgets it all the same.
    const lease = this.lease || 7200;
    this.timer = setTimeout(() => this.refresh(), Math.max(60, lease / 2) * 1000);
    this.timer.unref();
  }

  async refresh() {
    try {
      return await this.map();
    } catch (e) {
      this.emit('error', e);
      return this.state;
    } finally {
      this._schedule();
    }
  }

  /** Stops renewing and removes the mappings this run made. */
  async stop() {
    clearTimeout(this.timer);
    clearInterval(this.watcher);
    this.timer = this.watcher = null;
    while (this.running) await this.running.catch(() => {});
    const s = this.state;
    for (const p of s.ports.filter((x) => x.ok)) {
      try {
        if (s.method === 'upnp') {
          await this.gw.deletePortMapping(p.protocol, p.externalPort);
        } else if (s.method === 'pcp') {
          const nonce = this.nonces.get(`${p.protocol}/${p.internalPort}`);
          await natpmp.pcpMap(s.gateway, { ...p, lifetime: 0, nonce }, this.natpmpOpts);
        } else if (s.method === 'natpmp') {
          await natpmp.natpmpMap(s.gateway, { ...p, lifetime: 0 }, this.natpmpOpts);
        }
      } catch (e) {
        this.log(`removing ${p.protocol} ${p.externalPort}: ${e.message}`);
      }
    }
    this.state = { method: null, ports: [], ok: false, tried: [] };
  }
}

/**
 * The ports a Sozvon server behind a router needs forwarded, as
 * contrib/install.sh lists them for a person to forward by hand.
 *
 * @param {{httpsPort?: number, udpPort?: number, turn?: boolean, turnsPort?: number}} [o]
 * @returns {PortSpec[]}
 */
function sozvonPorts({ httpsPort = 8443, udpPort = 8443, turn = true, turnsPort = 5349 } = {}) {
  const ports = [
    // The page, the WebSocket, and Let's Encrypt's TLS-ALPN-01 challenge,
    // which only ever comes to 443.
    { protocol: 'TCP', externalPort: 443, internalPort: httpsPort },
    // All media, on the one port -udp-range was given.
    { protocol: 'UDP', externalPort: udpPort, internalPort: udpPort },
  ];
  if (turn) {
    // The relay, for clients whose network blocks UDP to us.  A call between
    // two ordinary networks works without it, so it is not required.
    ports.push(
      { protocol: 'TCP', externalPort: 1194, internalPort: 1194, required: false },
      { protocol: 'UDP', externalPort: 1194, internalPort: 1194, required: false },
      { protocol: 'TCP', externalPort: turnsPort, internalPort: turnsPort, required: false },
    );
  }
  return ports;
}

module.exports = { PortMapper, sozvonPorts };
