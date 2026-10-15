// The installer's failure codes, and what each client says for them.
// (Sozvon, tasks#19)
//
// Run with:  node --test desktop/test/
//
// contrib/install.sh names why it stopped with a code in its state file; the
// desktop app (src/renderer/install-errors.js) and the Android app
// (deploy/InstallErrors.kt and its string files) each turn the code into a
// sentence.  Nothing ties the three together but this test: a code added to
// the installer and to no client would show the user the installer's raw
// English again, which is the very thing this is for.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');

const { TEXT, installErrorText } =
  require('../src/renderer/install-errors.js');
const { Deployer } = require('../src/deploy/deployer');

/** Every code install.sh can write to its state file. */
function installerCodes() {
  const sh = read('contrib', 'install.sh');
  const codes = new Set();
  for (const m of sh.matchAll(/\bfail ([a-z-]+) "/g)) codes.add(m[1]);
  // the EXIT trap, for a failure nobody reported through fail()
  for (const m of sh.matchAll(/write_state failed "[^"]*" "[^"]*" ([a-z-]+)/g))
    codes.add(m[1]);
  // A call written the old way, without a code, would leave the state
  // file's code empty and the user with the raw message.
  const untagged = sh.split('\n').filter((l) => /\bfail "/.test(l));
  assert.deepStrictEqual(untagged, [], 'fail() called without a code');
  return codes;
}

/** code -> string resource name, from the Android map. */
function androidMap() {
  const kt = read('android', 'app', 'src', 'main', 'java', 'org', 'sozvon',
    'app', 'deploy', 'InstallErrors.kt');
  const map = new Map();
  for (const m of kt.matchAll(/"([a-z-]+)" to R\.string\.(\w+)/g))
    map.set(m[1], m[2]);
  return map;
}

function stringNames(dir) {
  const xml = read('android', 'app', 'src', 'main', 'res', dir, 'strings.xml');
  return new Set([...xml.matchAll(/<string name="(\w+)"/g)].map((m) => m[1]));
}

const sorted = (xs) => [...xs].sort();

test('the installer reports a code for every way it fails', () => {
  const codes = installerCodes();
  // Count first: a pattern that stopped matching would make every check
  // below pass on nothing.
  assert.ok(codes.size >= 10, `only ${codes.size} codes found in install.sh`);
  assert.ok(codes.has('aborted'), 'the EXIT trap writes no code');
});

test('the desktop app has a sentence for exactly the installer\'s codes', () => {
  assert.deepStrictEqual(sorted(Object.keys(TEXT)), sorted(installerCodes()));
});

test('the Android app has a sentence for exactly the installer\'s codes', () => {
  const map = androidMap();
  assert.deepStrictEqual(sorted(map.keys()), sorted(installerCodes()));
  for (const dir of ['values', 'values-ru']) {
    const names = stringNames(dir);
    for (const [code, name] of map)
      assert.ok(names.has(name), `${dir}/strings.xml has no ${name} (${code})`);
  }
});

test('a missing or unknown code falls back to the installer\'s own message', () => {
  // An installer older than the codes writes none; one newer than the app
  // may write a code it does not know.
  assert.strictEqual(installErrorText(undefined), null);
  assert.strictEqual(installErrorText(''), null);
  assert.strictEqual(installErrorText('from-the-future'), null);
  assert.strictEqual(installErrorText('toString'), null);
  assert.strictEqual(installErrorText('port-in-use'), TEXT['port-in-use']);
});

test('a failed install hands the code on with the installer\'s message', async () => {
  class Stub extends Deployer {
    async readState() {
      return { status: 'failed', stage: 'preflight',
        error: 'port 443 is already in use', code: 'port-in-use' };
    }
    async tail() { return 'the log'; }
  }
  const d = new Stub({ host: '203.0.113.7', onEvent() {} });
  await assert.rejects(d.waitForCompletion({ intervalMs: 1 }), (e) => {
    assert.strictEqual(e.code, 'install');
    assert.strictEqual(e.reason, 'port-in-use');
    assert.strictEqual(e.message, 'port 443 is already in use');
    assert.strictEqual(e.detail, 'the log');
    return true;
  });
});
