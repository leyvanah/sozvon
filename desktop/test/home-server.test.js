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
