'use strict';

// UPnP Internet Gateway Device: asking a home router to forward ports to us.
//
// Plain Node with no Electron imports and no dependencies, so it runs from the
// command line against a real router (scripts/portmap.js) and in the tests
// against a fake one.  The protocol is three steps:
//
//   1. SSDP: an M-SEARCH datagram to 239.255.255.250:1900; every gateway on
//      the LAN answers with the URL of its device description.
//   2. The description (XML over HTTP) names the WAN connection service and
//      the URL its actions are posted to.
//   3. SOAP actions on that URL: GetExternalIPAddress, AddPortMapping,
//      GetSpecificPortMappingEntry, DeletePortMapping.
//
// Two things here are not in the specification but in the routers.  A
// laptop's default multicast interface is often not its LAN -- a VPN adapter,
// Hyper-V's virtual switch, WSL -- and an M-SEARCH sent there reaches no
// router at all, so the search goes out on every IPv4 interface separately.
// And the address to map ports to is the one this machine used to reach the
// router, which only the router's own connection can tell us; it is read off
// the socket that fetched the description, not guessed from a list of
// interfaces.
//
// SOZVON is a fork of Galène (MIT); see LICENCE.

const dgram = require('dgram');
const http = require('http');
const os = require('os');

const SSDP_ADDRESS = '239.255.255.250';
const SSDP_PORT = 1900;

// What to search for.  IGD:1 is what nearly every router announces; some
// answer only to the service type, and a few IGD:2 routers only to :2.
const SEARCH_TARGETS = [
  'urn:schemas-upnp-org:device:InternetGatewayDevice:1',
  'urn:schemas-upnp-org:device:InternetGatewayDevice:2',
  'urn:schemas-upnp-org:service:WANIPConnection:1',
  'urn:schemas-upnp-org:service:WANIPConnection:2',
  'urn:schemas-upnp-org:service:WANPPPConnection:1',
];

// The services that carry port mappings, best first.  A router dialling PPPoE
// usually exposes WANPPPConnection; some expose both, and then the IP one is
// the one that is actually connected about as often as not, so both are kept
// and tried in order (see Gateway.connect).
const SERVICE_TYPES = [
  'urn:schemas-upnp-org:service:WANIPConnection:2',
  'urn:schemas-upnp-org:service:WANIPConnection:1',
  'urn:schemas-upnp-org:service:WANPPPConnection:1',
];

// UPnP error codes worth telling apart.  The rest are reported as they come.
const ERRORS = {
  401: 'invalid-action',
  402: 'invalid-args',
  501: 'action-failed',
  606: 'not-authorized',
  714: 'no-such-entry',
  715: 'wildcard-not-permitted-in-src-ip',
  716: 'wildcard-not-permitted-in-ext-port',
  718: 'conflict',
  724: 'same-port-values-required',
  725: 'only-permanent-leases-supported',
  726: 'remote-host-only-supports-wildcard',
  727: 'external-port-only-supports-wildcard',
  728: 'no-port-maps-available',
  729: 'conflict-with-other-mechanisms',
};

class UpnpError extends Error {
  /**
   * @param {string} message
   * @param {{code?: string, upnpCode?: number}} [opts]
   */
  constructor(message, opts = {}) {
    super(message);
    this.name = 'UpnpError';
    this.code = opts.code || 'upnp-failed';
    this.upnpCode = opts.upnpCode;
  }
}

/** The non-internal IPv4 addresses of this machine. */
function ipv4Addresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal) {
        out.push(a.address);
      }
    }
  }
  return out;
}

function parseHeaders(text) {
  const headers = {};
  const lines = text.split(/\r?\n/);
  for (const line of lines.slice(1)) {
    const i = line.indexOf(':');
    if (i > 0) {
      headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
    }
  }
  return { status: lines[0] || '', headers };
}

/**
 * Searches the LAN for gateways.
 *
 * @param {Object} [opts]
 * @param {number} [opts.timeout=2500] - how long to listen for answers, ms
 * @param {string} [opts.address] - where to send the search (tests use a
 *   unicast address; the default is the SSDP multicast group)
 * @param {number} [opts.port]
 * @param {string[]} [opts.interfaces] - local addresses to search from;
 *   default every IPv4 interface, plus the system's choice
 * @returns {Promise<Array<{location: string, from: string, via: string,
 *   st: string, server: string}>>} one entry per distinct description URL
 */
function discover(opts = {}) {
  const timeout = opts.timeout ?? 2500;
  const address = opts.address || SSDP_ADDRESS;
  const port = opts.port || SSDP_PORT;
  const multicast = address === SSDP_ADDRESS;
  // null stands for "let the system pick", which is the only option on a
  // machine whose interfaces cannot be listed, and costs nothing otherwise.
  const locals = opts.interfaces || [null, ...ipv4Addresses()];

  return new Promise((resolve) => {
    const found = new Map();
    const sockets = [];
    let done = false;

    function finish() {
      if (done) return;
      done = true;
      for (const s of sockets) {
        try { s.close(); } catch (_) { /* already closed */ }
      }
      resolve([...found.values()]);
    }

    for (const local of locals) {
      const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      sockets.push(s);
      // One unusable interface (down, or a VPN that refuses multicast) must
      // not cost us the others.
      s.on('error', () => { try { s.close(); } catch (_) { /* closed */ } });
      s.on('message', (msg, rinfo) => {
        const { status, headers } = parseHeaders(msg.toString('latin1'));
        if (!/^HTTP\/1\.[01] 200/i.test(status) || !headers.location) return;
        if (!found.has(headers.location)) {
          found.set(headers.location, {
            location: headers.location,
            from: rinfo.address,
            via: local || '',
            st: headers.st || '',
            server: headers.server || '',
          });
        }
      });
      s.bind({ port: 0, address: local || undefined }, () => {
        try {
          if (multicast && local) s.setMulticastInterface(local);
          if (multicast) s.setMulticastTTL(2);
        } catch (_) { /* not every interface can do multicast */ }
        for (const st of SEARCH_TARGETS) {
          const m = Buffer.from(
            'M-SEARCH * HTTP/1.1\r\n' +
            `HOST: ${SSDP_ADDRESS}:${SSDP_PORT}\r\n` +
            'MAN: "ssdp:discover"\r\n' +
            'MX: 2\r\n' +
            `ST: ${st}\r\n\r\n`, 'latin1');
          s.send(m, port, address, () => {});
        }
      });
    }
    setTimeout(finish, timeout);
  });
}

/**
 * GET or POST over plain HTTP, with a deadline.  Resolves with the status,
 * the body, and the local address of the connection -- which is the address
 * this machine reaches the router from.
 */
function request(url, { method = 'GET', headers = {}, body, timeout = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        body: Buffer.concat(chunks).toString('utf8'),
        localAddress: res.socket && res.socket.localAddress,
      }));
      res.on('error', reject);
    });
    req.setTimeout(timeout, () => {
      req.destroy(new UpnpError(`no answer from ${url} in ${timeout} ms`, { code: 'timeout' }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function xmlText(xml, tag) {
  // Tags may carry a namespace prefix (<u:NewExternalIPAddress>, <s:Body>).
  const re = new RegExp(`<(?:[\\w-]+:)?${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${tag}>`, 'i');
  const m = re.exec(xml);
  return m ? unescapeXml(m[1].trim()) : null;
}

function unescapeXml(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function escapeXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Finds the port-mapping services in a device description.
 *
 * @returns {Array<{serviceType: string, controlURL: string}>} best first,
 *   control URLs made absolute
 */
function parseDescription(xml, location) {
  const base = xmlText(xml, 'URLBase') || location;
  const services = [];
  const re = /<(?:[\w-]+:)?service(?:\s[^>]*)?>([\s\S]*?)<\/(?:[\w-]+:)?service>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const type = xmlText(m[1], 'serviceType');
    const control = xmlText(m[1], 'controlURL');
    if (!type || !control) continue;
    const rank = SERVICE_TYPES.indexOf(type);
    if (rank < 0) continue;
    let controlURL;
    try {
      controlURL = new URL(control, base).toString();
    } catch (_) {
      continue;
    }
    services.push({ serviceType: type, controlURL, rank });
  }
  services.sort((a, b) => a.rank - b.rank);
  return services.map(({ serviceType, controlURL }) => ({ serviceType, controlURL }));
}

/**
 * One router's WAN connection service.
 */
class Gateway {
  /**
   * @param {Object} o
   * @param {string} o.location - the description URL
   * @param {string} o.serviceType
   * @param {string} o.controlURL
   * @param {string} o.localAddress - our address as the router sees it
   * @param {number} [o.timeout]
   */
  constructor(o) {
    this.location = o.location;
    this.serviceType = o.serviceType;
    this.controlURL = o.controlURL;
    this.localAddress = o.localAddress;
    this.timeout = o.timeout || 5000;
  }

  /**
   * Fetches a description and returns a Gateway for its best service that
   * answers.  "Answers" means GetExternalIPAddress works: a router listing
   * both WANIPConnection and WANPPPConnection answers on only one of them,
   * and which one is not predictable from the description.
   */
  static async connect(location, { timeout = 5000 } = {}) {
    const res = await request(location, { timeout });
    if (res.status !== 200) {
      throw new UpnpError(`${location}: HTTP ${res.status}`, { code: 'bad-description' });
    }
    const services = parseDescription(res.body, location);
    if (services.length === 0) {
      throw new UpnpError(`${location} describes no WAN connection service`, { code: 'not-a-gateway' });
    }
    let lastError;
    for (const s of services) {
      const gw = new Gateway({ location, ...s, localAddress: res.localAddress, timeout });
      try {
        gw.externalAddress = await gw.getExternalIPAddress();
        return gw;
      } catch (e) {
        lastError = e;
      }
    }
    throw lastError;
  }

  async action(name, args = []) {
    const params = args.map(([k, v]) => `<${k}>${escapeXml(v)}</${k}>`).join('');
    const body =
      '<?xml version="1.0"?>\r\n' +
      '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ' +
      's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
      `<s:Body><u:${name} xmlns:u="${this.serviceType}">${params}</u:${name}></s:Body>` +
      '</s:Envelope>\r\n';
    const res = await request(this.controlURL, {
      method: 'POST',
      timeout: this.timeout,
      headers: {
        'Content-Type': 'text/xml; charset="utf-8"',
        'Content-Length': Buffer.byteLength(body),
        SOAPAction: `"${this.serviceType}#${name}"`,
      },
      body,
    });
    if (res.status === 200) return res.body;
    const upnpCode = Number(xmlText(res.body, 'errorCode'));
    const desc = xmlText(res.body, 'errorDescription') || `HTTP ${res.status}`;
    throw new UpnpError(`${name}: ${upnpCode || ''} ${desc}`.replace(/\s+/g, ' '), {
      code: ERRORS[upnpCode] || 'upnp-failed',
      upnpCode: upnpCode || undefined,
    });
  }

  async getExternalIPAddress() {
    const body = await this.action('GetExternalIPAddress');
    return xmlText(body, 'NewExternalIPAddress') || '';
  }

  /**
   * @param {{protocol: 'TCP'|'UDP', externalPort: number, internalPort: number,
   *   internalClient?: string, description?: string, lease?: number}} m
   */
  async addPortMapping(m) {
    // The argument order is the specification's, and matters: some routers
    // read the arguments by position rather than by name.
    await this.action('AddPortMapping', [
      ['NewRemoteHost', ''],
      ['NewExternalPort', m.externalPort],
      ['NewProtocol', m.protocol],
      ['NewInternalPort', m.internalPort],
      ['NewInternalClient', m.internalClient || this.localAddress],
      ['NewEnabled', 1],
      ['NewPortMappingDescription', m.description || 'Sozvon'],
      ['NewLeaseDuration', m.lease ?? 0],
    ]);
  }

  /** @returns {Promise<null|{internalPort: number, internalClient: string,
   *   enabled: boolean, description: string, lease: number}>} */
  async getSpecificPortMappingEntry(protocol, externalPort) {
    let body;
    try {
      body = await this.action('GetSpecificPortMappingEntry', [
        ['NewRemoteHost', ''],
        ['NewExternalPort', externalPort],
        ['NewProtocol', protocol],
      ]);
    } catch (e) {
      // 714 is the specified "no such entry"; routers also answer 402 or a
      // bare 501 for a port nobody has mapped.
      if (e.upnpCode === 714 || e.upnpCode === 402 || e.upnpCode === 501) return null;
      throw e;
    }
    return {
      internalPort: Number(xmlText(body, 'NewInternalPort')),
      internalClient: xmlText(body, 'NewInternalClient') || '',
      enabled: xmlText(body, 'NewEnabled') === '1',
      description: xmlText(body, 'NewPortMappingDescription') || '',
      lease: Number(xmlText(body, 'NewLeaseDuration')) || 0,
    };
  }

  async deletePortMapping(protocol, externalPort) {
    await this.action('DeletePortMapping', [
      ['NewRemoteHost', ''],
      ['NewExternalPort', externalPort],
      ['NewProtocol', protocol],
    ]);
  }
}

/**
 * Discovers the LAN's gateways and connects to the first one whose WAN
 * service answers.
 *
 * @returns {Promise<Gateway>}
 */
async function findGateway(opts = {}) {
  const found = await discover(opts);
  if (found.length === 0) {
    throw new UpnpError('no UPnP gateway answered on this network', { code: 'no-gateway' });
  }
  let lastError;
  for (const f of found) {
    try {
      const gw = await Gateway.connect(f.location, opts);
      gw.ssdp = f;
      return gw;
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError;
}

module.exports = {
  discover,
  findGateway,
  parseDescription,
  Gateway,
  UpnpError,
  SSDP_ADDRESS,
  SSDP_PORT,
};
