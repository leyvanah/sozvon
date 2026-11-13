// Tests for running the Sozvon server as a child of the app.  (Sozvon)
//
// Run with:  node --test desktop/test/
//
// The "server" here is Node running a few lines that behave like one --
// print a line, stay up, or die at once -- so the lifecycle is exercised
// with real processes on whatever system runs the tests, Windows included,
// without a Go build.  That the real binary accepts these arguments is
// checked by hand (scripts/host-here.js); see the pull request.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { ServerProcess, serverArgs, sslipName } = require('../src/host/server');

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sozvon-host-'));
}

// A stand-in server.  Its first argument says how to behave.
const FAKE = `
const mode = process.argv[2];
console.log('args ' + JSON.stringify(process.argv.slice(3)));
if (mode === 'crash') process.exit(3);
setInterval(() => {}, 1000);
`;

function fake(dir, mode, extra = []) {
  const script = path.join(dir, 'fake-server.js');
  fs.writeFileSync(script, FAKE);
  return { binary: process.execPath, args: [script, mode, ...extra] };
}

const waitFor = (emitter, event) => new Promise((r) => emitter.once(event, r));

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

test('sslip.io name from an address', () => {
  assert.strictEqual(sslipName('203.0.113.7'), '203-0-113-7.sslip.io');
});

test('arguments behind a router: certificate, relay over TLS, public address, one media port', () => {
  const a = serverArgs({ dir: path.join('C:', 'S'), staticDir: 'st', publicIP: '203.0.113.7' });
  const flag = (f) => a[a.indexOf(f) + 1];
  assert.strictEqual(flag('-http'), ':8443');
  assert.strictEqual(flag('-udp-range'), '8443');
  assert.strictEqual(flag('-letsencrypt'), '203-0-113-7.sslip.io');
  assert.strictEqual(flag('-turn-tls'), '203-0-113-7.sslip.io:5349');
  assert.strictEqual(flag('-public-ip'), '203.0.113.7');
  assert.ok(flag('-data').endsWith(path.sep), 'directories end in a separator, as the server expects');
});

test('arguments with no public address: no certificate name to ask for', () => {
  const a = serverArgs({ dir: 'd', staticDir: 'st', extra: ['-insecure'] });
  assert.ok(!a.includes('-letsencrypt'));
  assert.ok(!a.includes('-public-ip'));
  assert.strictEqual(a.at(-1), '-insecure');
});

test('starts, logs, stops, and does not come back after stop', async () => {
  const dir = tmpdir();
  const f = fake(dir, 'stay', ['-x']);
  const s = new ServerProcess({ ...f, dir });
  const line = waitFor(s, 'line');
  s.start();
  assert.match(await line, /^args \["-x"\]$/);
  const pid = Number(fs.readFileSync(path.join(dir, 'sozvon.pid'), 'utf8'));
  assert.strictEqual(pid, s.child.pid);
  for (const d of ['data', 'groups', 'recordings']) assert.ok(fs.existsSync(path.join(dir, d)));
  await s.stop();
  assert.strictEqual(s.child, null);
  assert.ok(!fs.existsSync(path.join(dir, 'sozvon.pid')));
  await new Promise((r) => setTimeout(r, 200));
  assert.strictEqual(s.child, null, 'no restart after a stop that was asked for');
});

test('a crashing server is started again, with growing delays', async () => {
  const dir = tmpdir();
  const s = new ServerProcess({ ...fake(dir, 'crash'), dir, backoff: [30, 60, 90] });
  const starts = [];
  s.on('start', () => starts.push(Date.now()));
  s.start();
  while (starts.length < 4) await waitFor(s, 'start');
  await s.stop();
  assert.ok(s.lines.some((l) => /exited \(3\); starting again in 0.03 s/.test(l)));
  assert.ok(s.lines.some((l) => /starting again in 0.09 s/.test(l)), 'the delay climbs and stays at the last step');
});

test('a server left running by a previous start is ended first', async () => {
  const dir = tmpdir();
  const f = fake(dir, 'stay');
  const orphan = spawn(f.binary, f.args, { stdio: 'ignore', windowsHide: true });
  await new Promise((r) => setTimeout(r, 300));
  fs.writeFileSync(path.join(dir, 'sozvon.pid'), String(orphan.pid));
  const exited = new Promise((r) => orphan.once('exit', r));
  const s = new ServerProcess({ ...f, dir });
  s.start();
  await exited;
  assert.ok(!alive(orphan.pid));
  assert.ok(s.lines.some((l) => l.includes(`pid ${orphan.pid}`)));
  assert.notStrictEqual(s.child.pid, orphan.pid);
  await s.stop();
});

test('a stale PID file naming some other program is left alone', async (t) => {
  const dir = tmpdir();
  const other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  t.after(() => other.kill());
  await new Promise((r) => setTimeout(r, 300));
  fs.writeFileSync(path.join(dir, 'sozvon.pid'), String(other.pid));
  // Our "binary" has another name than the running process.
  const s = new ServerProcess({ binary: path.join(dir, 'sozvon.exe'), args: [], dir });
  assert.strictEqual(s.reapLeftover(), process.platform === 'win32' ? false : true);
  // Elsewhere there is no portable way to ask a process its name, and the
  // PID file is trusted: the test documents that, rather than hiding it.
  if (process.platform === 'win32') assert.ok(alive(other.pid));
});
