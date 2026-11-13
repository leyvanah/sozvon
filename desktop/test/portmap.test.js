// Tests for forwarding ports on the router: UPnP IGD, PCP and NAT-PMP, and
// the mapper that keeps them.  (Sozvon)
//
// Run with:  node --test desktop/test/
//
// Each protocol is spoken to a fake router on 127.0.0.1 -- an SSDP responder
// and an HTTP server for UPnP, a UDP server for PCP and NAT-PMP -- that
// behaves the way real ones were found to: miniupnpd's refusal of ports
// below 1024 with the code it also uses for a port somebody holds, routers
// that accept only permanent leases, a NAT-PMP-only gateway answering a PCP
// request in its own format.  What the fakes cannot stand in for is a real
// router's quirks we have not met yet; scripts/portmap.js runs the same code
// against one.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const dgram = require('node:dgram');
const http = require('node:http');

const upnp = require('../src/host/upnp');
const natpmp = require('../src/host/natpmp');
const netaddr = require('../src/host/netaddr');
const { PortMapper, sozvonPorts } = require('../src/host/portmap');

// --------------------------------------------------------- a fake IGD ----

const SERVICE = 'urn:schemas-upnp-org:service:WANIPConnection:1';

function description(controlPath, { pppoe = false } = {}) {
  // A router dialling PPPoE often lists the IP service as well, unconnected,
  // and that one ranks first: its actions fail and the PPP one must be used.
  const services = pppoe ? [
    ['urn:schemas-upnp-org:service:WANIPConnection:1', '/dead'],
    ['urn:schemas-upnp-org:service:WANPPPConnection:1', controlPath],
  ] : [[SERVICE, controlPath]];
  const list = services.map(([type, url]) => `
          <service>
            <serviceType>${type}</serviceType>
            <controlURL>${url}</controlURL>
          </service>`).join('');
  return `<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <device>
    <deviceType>urn:schemas-upnp-org:device:InternetGatewayDevice:1</deviceType>
    <deviceList><device>
      <deviceType>urn:schemas-upnp-org:device:WANDevice:1</deviceType>
      <deviceList><device>
        <deviceType>urn:schemas-upnp-org:device:WANConnectionDevice:1</deviceType>
        <serviceList>${list}
        </serviceList>
      </device></deviceList>
    </device></deviceList>
  </device>
</root>`;
}

function soapFault(code, desc) {
  return `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault><faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring><detail><UPnPError xmlns="urn:schemas-upnp-org:control-1-0"><errorCode>${code}</errorCode><errorDescription>${desc}</errorDescription></UPnPError></detail></s:Fault></s:Body></s:Envelope>`;
}

function soapOk(action, fields = {}) {
  const f = Object.entries(fields).map(([k, v]) => `<${k}>${v}</${k}>`).join('');
  return `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:${action}Response xmlns:u="${SERVICE}">${f}</u:${action}Response></s:Body></s:Envelope>`;
}

function arg(body, name) {
  const m = new RegExp(`<${name}>([^<]*)</${name}>`).exec(body);
  return m ? m[1] : null;
}

/**
 * @param {Object} [o]
 * @param {string} [o.externalIP]
 * @param {boolean} [o.minPort1024] - refuse external ports below 1024 the
 *   way miniupnpd's default rules do: 718, as if somebody held it
 * @param {boolean} [o.permanentOnly] - 725 on any non-zero lease
 * @param {boolean} [o.readOnly] - 606 on AddPortMapping (UPnP set to
 *   "read only" in the router's settings)
 * @param {boolean} [o.pppoe] - connected over PPP, with a dead IP service
 *   listed first
 */
async function fakeIgd(o = {}) {
  const table = new Map();
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (req.method === 'GET' && req.url === '/desc.xml') {
        res.writeHead(200, { 'Content-Type': 'text/xml' });
        res.end(description('/ctl/IPConn', o));
        return;
      }
      if (req.url === '/dead') {
        res.writeHead(500, { 'Content-Type': 'text/xml' });
        res.end(soapFault(501, 'Action Failed'));
        return;
      }
      const action = /#(\w+)"?$/.exec(req.headers.soapaction || '')[1];
      calls.push({ action, body, from: req.socket.remoteAddress });
      const send = (status, xml) => {
        res.writeHead(status, { 'Content-Type': 'text/xml; charset="utf-8"' });
        res.end(xml);
      };
      const key = `${arg(body, 'NewProtocol')}/${arg(body, 'NewExternalPort')}`;
      switch (action) {
      case 'GetExternalIPAddress':
        send(200, soapOk(action, { NewExternalIPAddress: o.externalIP || '198.51.100.7' }));
        return;
      case 'AddPortMapping': {
        if (o.readOnly) { send(500, soapFault(606, 'Action not authorized')); return; }
        const ext = Number(arg(body, 'NewExternalPort'));
        const client = arg(body, 'NewInternalClient');
        const existing = table.get(key);
        if ((o.minPort1024 && ext < 1024) || (existing && existing.client !== client)) {
          send(500, soapFault(718, 'ConflictInMappingEntry'));
          return;
        }
        const lease = Number(arg(body, 'NewLeaseDuration'));
        if (o.permanentOnly && lease !== 0) {
          send(500, soapFault(725, 'OnlyPermanentLeasesSupported'));
          return;
        }
        table.set(key, {
          client,
          internalPort: Number(arg(body, 'NewInternalPort')),
          description: arg(body, 'NewPortMappingDescription'),
          lease,
        });
        send(200, soapOk(action));
        return;
      }
      case 'GetSpecificPortMappingEntry': {
        const e = table.get(key);
        if (!e) { send(500, soapFault(714, 'NoSuchEntryInArray')); return; }
        send(200, soapOk(action, {
          NewInternalPort: e.internalPort,
          NewInternalClient: e.client,
          NewEnabled: 1,
          NewPortMappingDescription: e.description,
          NewLeaseDuration: e.lease,
        }));
        return;
      }
      case 'DeletePortMapping':
        if (!table.delete(key)) { send(500, soapFault(714, 'NoSuchEntryInArray')); return; }
        send(200, soapOk(action));
        return;
      default:
        send(500, soapFault(401, 'Invalid Action'));
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const location = `http://127.0.0.1:${server.address().port}/desc.xml`;

  // The SSDP responder, answering M-SEARCH by unicast as routers do.
  const ssdp = dgram.createSocket('udp4');
  const searches = [];
  ssdp.on('message', (msg, rinfo) => {
    const text = msg.toString();
    searches.push(text);
    if (!text.startsWith('M-SEARCH')) return;
    const st = /\r\nST: *(.*)\r\n/i.exec(text)[1];
    ssdp.send(Buffer.from(
      'HTTP/1.1 200 OK\r\nCACHE-CONTROL: max-age=120\r\n' +
      `ST: ${st}\r\nUSN: uuid:fake::${st}\r\nEXT:\r\n` +
      'SERVER: Linux/5.4 UPnP/1.1 MiniUPnPd/2.3.3\r\n' +
      `LOCATION: ${location}\r\n\r\n`), rinfo.port, rinfo.address);
  });
  await new Promise((r) => ssdp.bind(0, '127.0.0.1', r));

  return {
    table,
    calls,
    searches,
    location,
    upnpOpts: { address: '127.0.0.1', port: ssdp.address().port, interfaces: [null], timeout: 300 },
    close() {
      ssdp.close();
      server.closeAllConnections?.();
      server.close();
    },
  };
}

// ---------------------------------------------- a fake PCP/NAT-PMP box ----

/**
 * @param {'pcp'|'natpmp'} speaks - 'pcp' answers both versions, as
 *   miniupnpd does; 'natpmp' answers a PCP request "unsupported version"
 * @param {Object} [o]
 * @param {number} [o.minPort] - refuse lower external ports (PCP:
 *   NOT_AUTHORIZED; NAT-PMP: refused)
 * @param {Object<string, number>} [o.reassign] - "TCP/443": 40443 gives
 *   another port than the one asked for
 */
async function fakeNatpmp(speaks, o = {}) {
  const s = dgram.createSocket('udp4');
  const requests = [];
  const mappings = new Map();
  const epoch = 1234;
  s.on('message', (msg, rinfo) => {
    requests.push(msg);
    const reply = (b) => s.send(b, rinfo.port, rinfo.address);
    if (msg[0] === 2) {
      if (speaks !== 'pcp') {
        const b = Buffer.alloc(8);
        b[0] = 0; b[1] = 128 + msg[1]; b.writeUInt16BE(1, 2); b.writeUInt32BE(epoch, 4);
        reply(b);
        return;
      }
      const b = Buffer.alloc(60);
      msg.copy(b, 24, 24, 60);
      b[0] = 2; b[1] = 0x81;
      const proto = msg[36] === 6 ? 'TCP' : 'UDP';
      const ext = msg.readUInt16BE(42);
      const lifetime = msg.readUInt32BE(4);
      const key = `${proto}/${ext}`;
      if (o.minPort && ext < o.minPort && lifetime > 0) {
        b[3] = 2;
      } else {
        const given = (o.reassign && o.reassign[key]) || ext;
        b.writeUInt16BE(given, 42);
        b[44 + 10] = 0xff; b[44 + 11] = 0xff;
        Buffer.from([198, 51, 100, 9]).copy(b, 56);
        b.writeUInt32BE(lifetime, 4);
        if (lifetime === 0) mappings.delete(`${proto}/${given}`);
        else mappings.set(`${proto}/${given}`, { client: [...msg.subarray(20, 24)].join('.'), lifetime });
      }
      b.writeUInt32BE(epoch, 8);
      reply(b);
      return;
    }
    if (msg[0] === 0 && msg[1] === 0) {
      const b = Buffer.alloc(12);
      b[1] = 128; b.writeUInt32BE(epoch, 4);
      Buffer.from([198, 51, 100, 9]).copy(b, 8);
      reply(b);
      return;
    }
    if (msg[0] === 0 && (msg[1] === 1 || msg[1] === 2)) {
      const proto = msg[1] === 1 ? 'UDP' : 'TCP';
      const internal = msg.readUInt16BE(4);
      const ext = msg.readUInt16BE(6);
      const lifetime = msg.readUInt32BE(8);
      const b = Buffer.alloc(16);
      b[1] = 128 + msg[1];
      b.writeUInt32BE(epoch, 4);
      b.writeUInt16BE(internal, 8);
      if (o.minPort && ext < o.minPort && lifetime > 0) {
        b.writeUInt16BE(2, 2);
      } else {
        const given = (o.reassign && o.reassign[`${proto}/${ext}`]) || ext;
        b.writeUInt16BE(given, 10);
        b.writeUInt32BE(lifetime, 12);
        if (lifetime === 0) [...mappings.keys()].filter((k) => k.startsWith(proto)).forEach((k) => mappings.delete(k));
        else mappings.set(`${proto}/${given}`, { lifetime });
      }
      reply(b);
    }
  });
  await new Promise((r) => s.bind(0, '127.0.0.1', r));
  return {
    requests,
    mappings,
    opts: { gateway: '127.0.0.1', port: s.address().port, tries: 3, initial: 50 },
    close() { s.close(); },
  };
}

// A UDP port nobody answers on: a router with the protocol switched off.
async function silentPort() {
  const s = dgram.createSocket('udp4');
  await new Promise((r) => s.bind(0, '127.0.0.1', r));
  return { port: s.address().port, close() { s.close(); } };
}

// ---------------------------------------------------------------- UPnP ----

test('SSDP: the search reaches the router and its answer is understood', async (t) => {
  const igd = await fakeIgd();
  t.after(() => igd.close());
  const found = await upnp.discover(igd.upnpOpts);
  assert.strictEqual(found.length, 1, 'one router, however many search targets it answers');
  assert.strictEqual(found[0].location, igd.location);
  assert.ok(igd.searches.some((s) => s.includes('ST: urn:schemas-upnp-org:device:InternetGatewayDevice:1')));
  assert.ok(igd.searches.every((s) => s.includes('MAN: "ssdp:discover"')));
});

test('SSDP: a search from a named interface is answered on it', async (t) => {
  const igd = await fakeIgd();
  t.after(() => igd.close());
  const found = await upnp.discover({ ...igd.upnpOpts, interfaces: ['127.0.0.1'] });
  assert.strictEqual(found.length, 1);
  assert.strictEqual(found[0].via, '127.0.0.1');
});

test('the description: control URL resolved, IP service ranked before PPP', () => {
  const xml = description('ctl/PPPConn', { pppoe: true });
  const s = upnp.parseDescription(xml, 'http://192.168.0.1:5000/rootDesc.xml');
  assert.deepStrictEqual(s.map((x) => x.serviceType), [SERVICE, 'urn:schemas-upnp-org:service:WANPPPConnection:1']);
  assert.strictEqual(s[1].controlURL, 'http://192.168.0.1:5000/ctl/PPPConn');
  const withBase = xml.replace('<device>', '<URLBase>http://192.168.0.1:49152/</URLBase><device>');
  assert.strictEqual(upnp.parseDescription(withBase, 'http://x/').at(1).controlURL, 'http://192.168.0.1:49152/ctl/PPPConn');
});

test('a PPPoE router: the dead IP service is passed over for the PPP one', async (t) => {
  const igd = await fakeIgd({ pppoe: true });
  t.after(() => igd.close());
  const gw = await upnp.findGateway(igd.upnpOpts);
  assert.strictEqual(gw.serviceType, 'urn:schemas-upnp-org:service:WANPPPConnection:1');
  assert.strictEqual(gw.externalAddress, '198.51.100.7');
  assert.strictEqual(gw.localAddress, '127.0.0.1', 'our address as the router saw the connection');
});

test('UPnP: maps, renews in place, and deletes', async (t) => {
  const igd = await fakeIgd();
  t.after(() => igd.close());
  const pm = new PortMapper({ ports: sozvonPorts(), upnp: igd.upnpOpts, methods: ['upnp'] });
  const s = await pm.map();
  assert.strictEqual(s.method, 'upnp');
  assert.ok(s.ok, JSON.stringify(s));
  assert.strictEqual(s.externalAddress, '198.51.100.7');
  assert.deepStrictEqual([...igd.table.keys()].sort(), ['TCP/1194', 'TCP/443', 'TCP/5349', 'UDP/1194', 'UDP/8443']);
  assert.deepStrictEqual(igd.table.get('TCP/443'), { client: '127.0.0.1', internalPort: 8443, description: 'Sozvon', lease: 7200 });

  const again = await pm.map();
  assert.ok(again.ok, 'renewing a mapping we hold is not a conflict');
  assert.ok(!igd.calls.some((c) => c.action === 'DeletePortMapping'), 'renewed in place, not deleted first');

  await pm.stop();
  assert.strictEqual(igd.table.size, 0);
});

test('UPnP: our own mapping left at our old address is moved to the new one', async (t) => {
  const igd = await fakeIgd();
  t.after(() => igd.close());
  igd.table.set('TCP/443', { client: '192.168.0.50', internalPort: 8443, description: 'Sozvon', lease: 7200 });
  const pm = new PortMapper({ ports: sozvonPorts({ turn: false }), upnp: igd.upnpOpts, methods: ['upnp'] });
  const s = await pm.map();
  assert.ok(s.ok, JSON.stringify(s));
  assert.strictEqual(igd.table.get('TCP/443').client, '127.0.0.1');
});

test("UPnP: somebody else's port is left alone and reported with its holder", async (t) => {
  const igd = await fakeIgd();
  t.after(() => igd.close());
  igd.table.set('TCP/443', { client: '192.168.0.60', internalPort: 443, description: 'NAS', lease: 0 });
  const pm = new PortMapper({ ports: sozvonPorts({ turn: false }), upnp: igd.upnpOpts, methods: ['upnp'] });
  const s = await pm.map();
  assert.strictEqual(s.ok, false);
  const p = s.ports.find((x) => x.externalPort === 443);
  assert.strictEqual(p.code, 'conflict');
  assert.strictEqual(p.holder, '192.168.0.60');
  assert.strictEqual(igd.table.get('TCP/443').client, '192.168.0.60', 'not taken over');
  assert.ok(s.ports.find((x) => x.protocol === 'UDP').ok, 'the other ports are still mapped');
});

test('UPnP: a router refusing ports below 1024 is "refused", not "conflict"', async (t) => {
  const igd = await fakeIgd({ minPort1024: true });
  t.after(() => igd.close());
  const pm = new PortMapper({ ports: sozvonPorts(), upnp: igd.upnpOpts, methods: ['upnp'] });
  const s = await pm.map();
  assert.strictEqual(s.ok, false, '443 is required');
  assert.strictEqual(s.ports.find((x) => x.externalPort === 443).code, 'refused');
  assert.ok(s.ports.filter((x) => x.externalPort !== 443).every((x) => x.ok));
});

test('UPnP: a router accepting only permanent leases gets one', async (t) => {
  const igd = await fakeIgd({ permanentOnly: true });
  t.after(() => igd.close());
  const pm = new PortMapper({ ports: sozvonPorts({ turn: false }), upnp: igd.upnpOpts, methods: ['upnp'] });
  const s = await pm.map();
  assert.ok(s.ok, JSON.stringify(s));
  assert.strictEqual(igd.table.get('TCP/443').lease, 0);
});

test('UPnP: a read-only router is reported as not authorizing', async (t) => {
  const igd = await fakeIgd({ readOnly: true });
  t.after(() => igd.close());
  const pm = new PortMapper({ ports: sozvonPorts({ turn: false }), upnp: igd.upnpOpts, methods: ['upnp'] });
  const s = await pm.map();
  assert.strictEqual(s.ok, false);
  assert.ok(s.ports.every((p) => p.code === 'not-authorized'), JSON.stringify(s.ports));
});

test('UPnP: no router on the network', async () => {
  const quiet = await silentPort();
  try {
    await assert.rejects(
      upnp.findGateway({ address: '127.0.0.1', port: quiet.port, interfaces: [null], timeout: 200 }),
      (e) => e.code === 'no-gateway');
  } finally {
    quiet.close();
  }
});

// ------------------------------------------------------ PCP / NAT-PMP ----

test('PCP: the MAP request is laid out as RFC 6887 says', () => {
  const nonce = Buffer.from('000102030405060708090a0b', 'hex');
  const b = natpmp.pcpMapRequest({
    protocol: 'UDP', internalPort: 8443, externalPort: 8443, lifetime: 7200,
    nonce, clientAddress: '192.168.0.105',
  });
  assert.strictEqual(b.length, 60);
  assert.strictEqual(b[0], 2, 'version');
  assert.strictEqual(b[1], 1, 'request, MAP');
  assert.strictEqual(b.readUInt32BE(4), 7200);
  assert.strictEqual(b.subarray(8, 24).toString('hex'), '00000000000000000000ffffc0a80069', 'client IP, IPv4-mapped');
  assert.ok(b.subarray(24, 36).equals(nonce));
  assert.strictEqual(b[36], 17, 'UDP');
  assert.strictEqual(b.readUInt16BE(40), 8443);
  assert.strictEqual(b.readUInt16BE(42), 8443);
  assert.strictEqual(b.subarray(44, 60).toString('hex'), '00000000000000000000ffff00000000', 'any IPv4');
});

test('PCP: maps, tells our own address in the request, renews with the same nonce, deletes', async (t) => {
  const box = await fakeNatpmp('pcp');
  t.after(() => box.close());
  const pm = new PortMapper({ ports: sozvonPorts({ turn: false }), natpmp: box.opts, methods: ['pcp'] });
  const s = await pm.map();
  assert.strictEqual(s.method, 'pcp');
  assert.ok(s.ok, JSON.stringify(s));
  assert.strictEqual(s.externalAddress, '198.51.100.9');
  assert.strictEqual(box.mappings.get('TCP/443').client, '127.0.0.1',
    'the client address field is the one the socket is bound to, not 0.0.0.0');
  const first = box.requests.map((r) => r.subarray(24, 36).toString('hex'));
  await pm.map();
  const second = box.requests.slice(first.length).map((r) => r.subarray(24, 36).toString('hex'));
  assert.deepStrictEqual(second, first, 'a renewal must carry the nonce the mapping was made with');
  await pm.stop();
  assert.strictEqual(box.mappings.size, 0);
});

test('PCP: another port than the one asked for is handed back, not used', async (t) => {
  const box = await fakeNatpmp('pcp', { reassign: { 'TCP/443': 40443 } });
  t.after(() => box.close());
  const pm = new PortMapper({ ports: sozvonPorts({ turn: false }), natpmp: box.opts, methods: ['pcp'] });
  const s = await pm.map();
  assert.strictEqual(s.ok, false);
  assert.strictEqual(s.ports.find((x) => x.externalPort === 443).code, 'conflict');
  assert.ok(!box.mappings.has('TCP/40443'), 'the unwanted mapping was deleted');
});

test('NAT-PMP: external address and a mapping', async (t) => {
  const box = await fakeNatpmp('natpmp');
  t.after(() => box.close());
  const a = await natpmp.natpmpExternalAddress('127.0.0.1', box.opts);
  assert.strictEqual(a.externalAddress, '198.51.100.9');
  const m = await natpmp.natpmpMap('127.0.0.1', { protocol: 'UDP', internalPort: 8443, externalPort: 8443, lifetime: 7200 }, box.opts);
  assert.strictEqual(m.externalPort, 8443);
  assert.strictEqual(m.lifetime, 7200);
});

test('a NAT-PMP-only gateway asked in PCP: PCP gives up, NAT-PMP maps', async (t) => {
  const box = await fakeNatpmp('natpmp');
  t.after(() => box.close());
  const pm = new PortMapper({ ports: sozvonPorts({ turn: false }), natpmp: box.opts, methods: ['pcp', 'natpmp'] });
  const s = await pm.map();
  assert.strictEqual(s.method, 'natpmp');
  assert.ok(s.ok, JSON.stringify(s));
  assert.deepStrictEqual(s.tried.map((x) => [x.method, x.code]), [['pcp', 'unsupported-version']]);
});

test('the chain: no UPnP, no PCP answer, NAT-PMP refuses 443 -- reported per port', async (t) => {
  const quiet = await silentPort();
  const box = await fakeNatpmp('natpmp', { minPort: 1024 });
  t.after(() => { quiet.close(); box.close(); });
  const pm = new PortMapper({
    ports: sozvonPorts({ turn: false }),
    upnp: { address: '127.0.0.1', port: quiet.port, interfaces: [null], timeout: 150 },
    natpmp: box.opts,
  });
  const s = await pm.map();
  assert.strictEqual(s.ok, false);
  assert.strictEqual(s.method, 'natpmp', 'the method that got furthest is the one reported');
  assert.strictEqual(s.ports.find((x) => x.externalPort === 443).code, 'not-authorized');
  assert.ok(s.ports.find((x) => x.protocol === 'UDP').ok);
  assert.deepStrictEqual(s.tried.map((x) => x.method), ['upnp', 'pcp', 'natpmp']);
});

test('a router that answers nothing at all', async (t) => {
  const quiet = await silentPort();
  t.after(() => quiet.close());
  const pm = new PortMapper({
    ports: sozvonPorts({ turn: false }),
    upnp: { address: '127.0.0.1', port: quiet.port, interfaces: [null], timeout: 150 },
    natpmp: { gateway: '127.0.0.1', port: quiet.port, tries: 2, initial: 50 },
  });
  const s = await pm.map();
  assert.strictEqual(s.ok, false);
  assert.strictEqual(s.method, null);
  assert.deepStrictEqual(s.tried.map((x) => [x.method, x.code]),
    [['upnp', 'no-gateway'], ['pcp', 'timeout'], ['natpmp', 'timeout']]);
});

// ------------------------------------------------- what kind of address ----

test('classify: white, private, carrier-grade and the rest', () => {
  assert.strictEqual(netaddr.classify('95.31.4.7'), 'public');
  assert.strictEqual(netaddr.classify('192.168.1.1'), 'private');
  assert.strictEqual(netaddr.classify('172.31.255.1'), 'private');
  assert.strictEqual(netaddr.classify('172.32.0.1'), 'public');
  assert.strictEqual(netaddr.classify('10.20.30.40'), 'private');
  assert.strictEqual(netaddr.classify('100.64.0.1'), 'cgnat');
  assert.strictEqual(netaddr.classify('100.127.255.254'), 'cgnat');
  assert.strictEqual(netaddr.classify('100.128.0.1'), 'public');
  assert.strictEqual(netaddr.classify('0.0.0.0'), 'unspecified');
  assert.strictEqual(netaddr.classify('169.254.3.4'), 'link-local');
  assert.strictEqual(netaddr.classify('not-an-ip'), 'invalid');
});

test('assess: the router and the outside must agree for a white IP', () => {
  assert.strictEqual(netaddr.assess({ router: '95.31.4.7', observed: ['95.31.4.7', '95.31.4.7'] }).verdict, 'white');
  assert.strictEqual(netaddr.assess({ router: '100.70.1.2', observed: ['95.31.4.7'] }).verdict, 'cgnat');
  assert.strictEqual(netaddr.assess({ router: '192.168.1.5', observed: ['95.31.4.7'] }).verdict, 'double-nat');
  assert.strictEqual(netaddr.assess({ router: '95.31.4.7', observed: ['185.1.2.3'] }).verdict, 'translated');
  assert.strictEqual(netaddr.assess({ router: '0.0.0.0', observed: [] }).verdict, 'no-wan-address');
  assert.strictEqual(netaddr.assess({ router: '95.31.4.7', observed: [] }).verdict, 'unknown');
  assert.strictEqual(netaddr.assess({ router: '95.31.4.7', observed: ['95.31.4.7', '185.1.2.3'] }).verdict, 'unknown');
  assert.strictEqual(netaddr.assess({ observed: ['95.31.4.7'] }).verdict, 'unknown');
});

test('observedAddresses: answers that are not addresses are dropped', async () => {
  const answers = { a: '95.31.4.7', b: '<html>blocked</html>', c: null };
  const seen = await netaddr.observedAddresses({ urls: ['a', 'b', 'c'], fetch: async (u) => answers[u] });
  assert.deepStrictEqual(seen, ['95.31.4.7']);
});

// ------------------------------------------------------------ the gateway --

test('the default gateway from Windows route print, in any language', () => {
  // Headings as a Russian Windows 11 prints them; the rows are the same in
  // every language.
  const text = [
    '===========================================================================',
    'Список интерфейсов',
    ' 12...a4 c3 f0 11 22 33 ......Intel(R) Wi-Fi 6E AX211 160MHz',
    '===========================================================================',
    '',
    'IPv4 таблица маршрута',
    '===========================================================================',
    'Активные маршруты:',
    'Сетевой адрес           Маска сети      Адрес шлюза       Интерфейс  Метрика',
    '          0.0.0.0          0.0.0.0      10.8.0.1        10.8.0.2     5000',
    '          0.0.0.0          0.0.0.0      192.168.0.1    192.168.0.105     35',
    '===========================================================================',
    'Постоянные маршруты:',
    '  Отсутствует',
  ].join('\r\n');
  assert.deepStrictEqual(netaddr.parseWindowsRoutes(text), { gateway: '192.168.0.1', interface: '192.168.0.105', metric: 35 });
  assert.strictEqual(netaddr.parseWindowsRoutes('          0.0.0.0          0.0.0.0         On-link     10.0.0.2    5'), null);
});

test('the default gateway from /proc/net/route and from BSD route', () => {
  const proc = 'Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT\n' +
    'eth0\t00000000\t0100A8C0\t0003\t0\t0\t100\t00000000\t0\t0\t0\n' +
    'eth0\t0000A8C0\t00000000\t0001\t0\t0\t100\t00FFFFFF\t0\t0\t0\n';
  assert.deepStrictEqual(netaddr.parseProcNetRoute(proc), { gateway: '192.168.0.1', interface: 'eth0', metric: 100 });
  assert.deepStrictEqual(netaddr.parseBsdRoute('   route to: default\ndestination: default\n    gateway: 192.168.1.1\n'), { gateway: '192.168.1.1' });
});
