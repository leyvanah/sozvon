// A home server behind a router: what the installer reports about it, and
// how the app reads that.  (Sozvon)
//
// Run with:  node --test desktop/test/
//
// Behind a router the installer cannot finish the job by itself: someone has
// to forward ports on the router.  It writes the list of them to its state
// file and its result, and the app shows it -- after a successful install,
// and after one that stopped because the forwards were not in place yet.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..', '..');
const installer = fs.readFileSync(path.join(root, 'contrib', 'install.sh'), 'utf8')
  .replace(/\r\n/g, '\n');

/**
 * A shell function's definition, lifted out of install.sh as it is.  It ends
 * at the first "}" alone on a line that is not the close of a JSON heredoc.
 */
function shellFunction(name) {
  const m = installer.match(
    new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?\\n\\}\\n(?!EOF)`, 'm'));
  assert.ok(m, `install.sh defines no ${name}()`);
  return m[0];
}

/**
 * Run install.sh's own write_state with FORWARDS set as the firewall stage
 * sets it, and return the state file it writes, parsed.
 */
function stateWith(forwards, args) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sozvon-state-'));
  try {
    const script = [
      'set -eu',
      `STATE_DIR='${dir.replace(/\\/g, '/')}'`,
      'STAGE_NAME=verify', 'STAGE_INDEX=8', 'STAGE_TOTAL=9', 'VERSION=v0.0.0',
      `FORWARDS='${forwards}'`,
      shellFunction('json_escape'),
      shellFunction('forwards_json'),
      shellFunction('write_state'),
      `write_state ${args}`,
    ].join('\n');
    // From a file rather than `sh -c`: on Windows the command line is
    // re-parsed on its way into sh, and the quotes in it do not survive.
    fs.writeFileSync(path.join(dir, 'run.sh'), script + '\n');
    const r = spawnSync('sh', [path.join(dir, 'run.sh')], { encoding: 'utf8' });
    // No sh is a failure, not a skip: the test would otherwise pass having
    // run nothing.
    assert.ifError(r.error);
    assert.strictEqual(r.status, 0, r.stderr);
    return JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('a run that stops for want of port forwards lists them in its state', () => {
  // The same text the firewall stage builds: one line per forward, each
  // ending in a newline.
  const forwards =
    '443/tcp -> 192.168.0.60:8444\n' +
    '8443/udp -> 192.168.0.60:8443\n' +
    '1194/tcp -> 192.168.0.60:1194\n';
  const st = stateWith(forwards,
    'failed "failed during verify" "443 is not forwarded" port-forward');
  assert.strictEqual(st.status, 'failed');
  assert.strictEqual(st.code, 'port-forward');
  assert.deepStrictEqual(st.forwards, [
    '443/tcp -> 192.168.0.60:8444',
    '8443/udp -> 192.168.0.60:8443',
    '1194/tcp -> 192.168.0.60:1194',
  ]);
});

test('with no router in the way the state lists no forwards', () => {
  const st = stateWith('', 'running "opening the ports"');
  assert.deepStrictEqual(st.forwards, []);
});

test('the result lists the forwards the same way the state does', () => {
  // One function writes both, so a program reads one format.
  const result = installer.slice(installer.indexOf('result.json" <<EOF'));
  assert.match(result, /"forwards": \$\(forwards_json\)/);
});

// ------------------------------------------------------------- the app ---

const HomeServer = require('../src/renderer/home-server.js');
const { Deployer, originOf } = require('../src/deploy/deployer');

/** result.json as install.sh writes it for a home server. */
const NAT_RESULT = {
  schema: 1,
  url: 'https://203-0-113-7.sslip.io/',
  origin: 'https://203-0-113-7.sslip.io',
  hostname: '203-0-113-7.sslip.io',
  group: 'meet', hub: true,
  admin_user: 'operator', admin_password: 'pw',
  tls_mode: 'letsencrypt-sslip', cert_sha256: '', version: 'v0.4.0',
  prefix: '/opt/sozvon',
  behind_nat: true,
  public_ip: '203.0.113.7',
  lan_ip: '192.168.0.60',
  forwards: [
    '443/tcp -> 192.168.0.60:8444',
    '8443/udp -> 192.168.0.60:8443',
    '1194/tcp -> 192.168.0.60:1194',
    '1194/udp -> 192.168.0.60:1194',
    '5349/tcp -> 192.168.0.60:5349',
  ],
};

test('a LAN address is recognised as a home server, by the installer\'s ranges', () => {
  for (const a of ['192.168.0.60', '10.0.0.5', '172.16.0.1', '172.31.255.254', '127.0.0.1',
    ' 192.168.1.2 '])
    assert.ok(HomeServer.isPrivateIPv4(a), a);
  for (const a of ['203.0.113.7', '172.15.0.1', '172.32.0.1', '100.64.0.1', '192.169.0.1',
    '192.168.0.256', 'server.lan', 'meet.example.com', '', undefined, '::1', '192.168.0'])
    assert.ok(!HomeServer.isPrivateIPv4(a), String(a));
  // The same ranges as install.sh's is_private(): the app calls a server a
  // home server exactly where the installer would.
  const m = installer.match(/^is_private\(\) \{\n\tcase "\$1" in\n\t(.*?)\) return 0/m);
  assert.ok(m, 'install.sh has no is_private()');
  assert.strictEqual(m[1],
    '10.*|127.*|192.168.*|172.1[6-9].*|172.2[0-9].*|172.3[01].*');
});

test('a forward line becomes a table row', () => {
  assert.deepStrictEqual(HomeServer.parseForward('443/tcp -> 192.168.0.60:8444'), {
    port: 443, proto: 'tcp', toHost: '192.168.0.60', toPort: 8444,
    line: '443/tcp -> 192.168.0.60:8444',
  });
  assert.strictEqual(HomeServer.parseForward('  8443/udp -> 10.0.0.2:8443 ').proto, 'udp');
  // Anything else is left out rather than shown half parsed.
  for (const bad of ['', 'forward these ports', '443/sctp -> 1.2.3.4:443',
    '443 -> 1.2.3.4:443', '443/tcp -> 1.2.3.4', null, 42])
    assert.strictEqual(HomeServer.parseForward(bad), null, String(bad));
  assert.deepStrictEqual(HomeServer.parseForwards(['junk', '80/tcp -> 1.2.3.4:80'])
    .map((f) => f.port), [80]);
  assert.deepStrictEqual(HomeServer.parseForwards(undefined), []);
  assert.deepStrictEqual(HomeServer.parseForwards('443/tcp -> 1.2.3.4:443'), []);
});

test('a home server\'s result gives the router, the LAN address and the forwards', () => {
  const h = HomeServer.homeServerOf(NAT_RESULT);
  assert.strictEqual(h.behindNat, true);
  assert.strictEqual(h.publicIp, '203.0.113.7');
  assert.strictEqual(h.lanIp, '192.168.0.60');
  assert.deepStrictEqual(h.forwards.map((f) => `${f.port}/${f.proto}`),
    ['443/tcp', '8443/udp', '1194/tcp', '1194/udp', '5349/tcp']);
  assert.strictEqual(h.forwards[0].toPort, 8444);
  assert.match(HomeServer.forwardsText(h.forwards), /^443\/tcp → 192\.168\.0\.60:8444\n/);
});

test('a result with no router in it, or from an older installer, is not a home server', () => {
  const vps = { ...NAT_RESULT, behind_nat: false, public_ip: '', lan_ip: '', forwards: [] };
  assert.deepStrictEqual(HomeServer.homeServerOf(vps),
    { behindNat: false, publicIp: '', lanIp: '', forwards: [] });
  const old = { url: 'https://203-0-113-7.sslip.io/', hostname: '203-0-113-7.sslip.io' };
  assert.strictEqual(HomeServer.homeServerOf(old).behindNat, false);
  assert.strictEqual(HomeServer.homeServerOf(null).behindNat, false);
  // A state file carries the forwards but not behind_nat: forwards alone
  // mean a router.
  assert.strictEqual(HomeServer.homeServerOf({ forwards: NAT_RESULT.forwards }).behindNat, true);
});

test('the server saved is the router\'s public address, not the LAN one', () => {
  const origin = originOf(NAT_RESULT);
  assert.strictEqual(origin, 'https://203-0-113-7.sslip.io');
  assert.ok(!origin.includes(NAT_RESULT.lan_ip));
});

test('"443 is taken here" listens elsewhere and has the router forward 443', () => {
  assert.deepStrictEqual(HomeServer.portOptions('8444'), { httpsPort: 8444, publicPort: 443 });
  assert.deepStrictEqual(HomeServer.portOptions(8444), { httpsPort: 8444, publicPort: 443 });
  for (const bad of ['', '0', '443', '65536', 'abc', '84.5', undefined])
    assert.strictEqual(HomeServer.portOptions(bad), null, String(bad));

  const d = new Deployer({ host: '192.168.0.60' });
  const args = d.buildArgs({ tlsMode: 'letsencrypt-sslip', port: 8444, publicPort: 443 });
  assert.match(args, /'--port' '8444' '--public-port' '443'/);
  assert.doesNotMatch(d.buildArgs({ tlsMode: 'self-signed' }), /--public-port/);
});

test('a port-forward failure hands on the forwards from the state file', async () => {
  class Stub extends Deployer {
    async readState() {
      return { status: 'failed', stage: 'verify', code: 'port-forward',
        error: 'Let\'s Encrypt did not issue its certificate',
        forwards: NAT_RESULT.forwards };
    }
    async tail() { return 'the log'; }
  }
  const d = new Stub({ host: '192.168.0.60', onEvent() {} });
  await assert.rejects(d.waitForCompletion({ intervalMs: 1 }), (e) => {
    assert.strictEqual(e.reason, 'port-forward');
    assert.deepStrictEqual(e.forwards, NAT_RESULT.forwards);
    return true;
  });
});

test('a failure from an installer that lists no forwards hands on none', async () => {
  class Stub extends Deployer {
    async readState() {
      return { status: 'failed', stage: 'preflight', code: 'not-root', error: 'x' };
    }
    async tail() { return ''; }
  }
  const d = new Stub({ host: '203.0.113.7', onEvent() {} });
  await assert.rejects(d.waitForCompletion({ intervalMs: 1 }), (e) => {
    assert.deepStrictEqual(e.forwards, []);
    return true;
  });
});
