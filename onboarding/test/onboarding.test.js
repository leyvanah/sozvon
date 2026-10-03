// Tests for the onboarding's decisions, its texts and the link minter.
// (Sozvon)
//
// Run with:  node --test onboarding/test/
//
// Nothing here needs a window or a phone: flow.js and i18n.js are plain
// functions, and the minter is driven against a fake WebSocket that plays the
// server's side of the protocol -- the same messages rtpconn/webclient.go
// sends, in the same order.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const Flow = require('../flow.js');
const Text = require('../i18n.js');

const dir = path.join(__dirname, '..');

// ------------------------------------------------------------ addresses ---

test('an invitation is found inside a whole pasted message', () => {
  const r = Flow.parseInvite('Заходи в звонок: https://meet.example.com/group/team/ — жду!');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.origin, 'https://meet.example.com');
  assert.strictEqual(r.kind, 'room');
  assert.strictEqual(r.room, 'team');
});

test('trailing punctuation is not part of the link', () => {
  const r = Flow.parseInvite('Link: https://meet.example.com/group/team/.');
  assert.strictEqual(r.url, 'https://meet.example.com/group/team/');
});

test('the forms a server hands out are told apart', () => {
  const link = Flow.parseInvite('https://m.example.com/k7m2qx/?token=abc#Anna');
  assert.strictEqual(link.kind, 'link');
  assert.strictEqual(link.room, 'k7m2qx');
  // The token and the name after '#' travel with the link untouched.
  assert.ok(link.url.includes('token=abc'));
  assert.ok(link.url.endsWith('#Anna'));

  const hub = Flow.parseInvite('https://m.example.com/');
  assert.strictEqual(hub.kind, 'server');
  assert.strictEqual(hub.room, null);

  const sub = Flow.parseInvite('https://m.example.com:8443/group/hub/client%20one/');
  assert.strictEqual(sub.kind, 'room');
  assert.strictEqual(sub.room, 'hub/client one');
  assert.strictEqual(sub.origin, 'https://m.example.com:8443');
});

test('a bare host is taken as https', () => {
  const r = Flow.parseInvite('meet.example.com');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.url, 'https://meet.example.com/');
});

test('what is not an https address is turned away with a reason', () => {
  assert.deepStrictEqual(Flow.parseInvite('   '), { ok: false, error: 'empty' });
  assert.deepStrictEqual(Flow.parseInvite('just some words'), { ok: false, error: 'not-url' });
  assert.deepStrictEqual(Flow.parseInvite('http://meet.example.com/group/a/'),
    { ok: false, error: 'not-https' });
});

test('a server address keeps the origin and offers the room it named', () => {
  const r = Flow.parseServer('https://meet.example.com:8443/group/daily/');
  assert.deepStrictEqual(r, {
    ok: true, origin: 'https://meet.example.com:8443',
    host: 'meet.example.com:8443', room: 'daily',
  });
  assert.strictEqual(Flow.parseServer('meet.example.com').room, null);
});

test('room addresses are built the way the client builds them', () => {
  assert.strictEqual(Flow.roomUrl('https://a.example/', ''), 'https://a.example/');
  assert.strictEqual(Flow.roomUrl('https://a.example', 'team'), 'https://a.example/group/team/');
  assert.strictEqual(Flow.roomUrl('https://a.example', ' hub/one two '),
    'https://a.example/group/hub/one%20two/');
});

test('a deployed server is reached at the origin the installer reported', () => {
  assert.strictEqual(Flow.deployOrigin({ origin: 'https://h.example:8443/', hostname: 'h.example' }),
    'https://h.example:8443');
  // Older installers: recovered from the room address, port and all.
  assert.strictEqual(Flow.deployOrigin({ url: 'https://h.example:8443/group/meet/', hostname: 'h.example' }),
    'https://h.example:8443');
  assert.strictEqual(Flow.deployOrigin({ hostname: 'h.example' }), 'https://h.example');
});

test('a client room name is random and from the readable alphabet', () => {
  const a = Flow.randomSlug();
  const b = Flow.randomSlug();
  assert.match(a, /^[a-km-np-z2-9]{10}$/);
  assert.notStrictEqual(a, b);
  assert.strictEqual(Flow.inviteUrl('https://h.example/', 'abc', 't+/='),
    'https://h.example/abc/?token=t%2B%2F%3D');
});

// ---------------------------------------------------------------- steps ---

test('the permission step is counted only when there is something to ask', () => {
  assert.deepStrictEqual(Flow.progress('invite', 'media'), [3, 4]);
  assert.deepStrictEqual(Flow.progress('invite', 'ready', { skipMedia: true }), [3, 3]);
  assert.strictEqual(Flow.nextStep('invite', 'invite', { skipMedia: true }), 'ready');
  assert.strictEqual(Flow.nextStep('invite', 'invite'), 'media');
  assert.strictEqual(Flow.nextStep('server', 'role'), 'media');
  assert.strictEqual(Flow.nextStep('invite', 'ready'), null);
});

test('the VPS guide is a side trip that comes back to the checklist', () => {
  assert.deepStrictEqual(Flow.progress('own', 'guide-order'), Flow.progress('own', 'need'));
  let step = Flow.GUIDE[0];
  const seen = [step];
  while ((step = Flow.nextStep('own', step)) !== 'need') seen.push(step);
  assert.deepStrictEqual(seen, Flow.GUIDE);
});

test('the onboarding greets nobody who has been anywhere already', () => {
  assert.strictEqual(Flow.shouldShow({ done: false, servers: 0 }), true);
  assert.strictEqual(Flow.shouldShow({ done: true, servers: 0 }), false);
  assert.strictEqual(Flow.shouldShow({ done: false, servers: 2 }), false);
  assert.strictEqual(Flow.shouldShow({ done: false, servers: 0, deepLink: true }), false);
  assert.strictEqual(Flow.shouldShow({ done: false, servers: 0, changeServer: true }), false);
});

// ---------------------------------------------------------------- texts ---

test('both languages carry exactly the same keys', () => {
  const ru = Object.keys(Text.tables.ru).sort();
  const en = Object.keys(Text.tables.en).sort();
  assert.deepStrictEqual(en.filter(k => !ru.includes(k)), [], 'in English only');
  assert.deepStrictEqual(ru.filter(k => !en.includes(k)), [], 'in Russian only');
});

test('every key the screens ask for exists', () => {
  // The keys app.js names outright, plus the ones it builds from a path,
  // a role or a guide step.  A missing one would show as the bare key.
  const src = fs.readFileSync(path.join(dir, 'app.js'), 'utf8');
  // Whole keys only: t('error.' + x) is a built one, listed below.
  const literal = [...src.matchAll(/\bt\('([a-z][\w.-]*[\w-])'\s*[,)]/g)].map(m => m[1]);
  const built = [];
  for (const p of ['invite', 'server', 'own'])
    built.push(`choose.${p}.title`, `choose.${p}.text`);
  for (const r of ['hub', 'room'])
    built.push(`role.${r}.title`, `role.${r}.text`);
  for (const s of ['find', 'signup', 'order', 'panel', 'copy', 'paste'])
    built.push(`guide.${s}.title`, `guide.${s}.text`);
  for (const e of ['empty', 'not-url', 'not-https']) built.push(`error.${e}`);
  const missing = [...literal, ...built].filter(k => !(k in Text.tables.ru));
  assert.deepStrictEqual(missing, []);
});

test('placeholders are filled and unknown ones left visible', () => {
  assert.strictEqual(Text.t('ru', 'common.step', { n: 2, total: 4 }), 'Шаг 2 из 4');
  assert.strictEqual(Text.t('en', 'common.step', { n: 2 }), 'Step 2 of {total}');
  assert.strictEqual(Text.pick('ru-RU'), 'ru');
  assert.strictEqual(Text.pick('en-GB'), 'en');
  assert.strictEqual(Text.pick(undefined), 'ru');
});

// --------------------------------------------------------------- minter ---

/**
 * A WebSocket that answers like a Sozvon server.  `script` decides how the
 * join and the token request go.
 */
function fakeServer(script) {
  const sent = [];
  class FakeSocket {
    constructor(url) {
      this.url = url;
      FakeSocket.last = this;
      setTimeout(() => this.onopen && this.onopen(), 0);
    }
    send(data) {
      const m = JSON.parse(data);
      sent.push(m);
      const reply = (r) => setTimeout(() => this.onmessage({ data: JSON.stringify(r) }), 0);
      if (m.type === 'handshake') {
        reply({ type: 'handshake', version: ['2'] });
        reply({ type: 'ping' });
      }
      if (m.type === 'join') reply(script.join(m));
      if (m.type === 'groupaction' && m.kind === 'maketoken') reply(script.token(m));
    }
    close() {
      this.closed = true;
    }
  }
  return { FakeSocket, sent };
}

function runMinter(FakeSocket, params) {
  const src = fs.readFileSync(path.join(dir, 'minter.js'), 'utf8');
  const window = {};
  const ctx = vm.createContext({
    window, WebSocket: FakeSocket, setTimeout, clearTimeout,
    crypto: require('node:crypto').webcrypto,
    location: { protocol: 'https:', host: 'h.example:8443', origin: 'https://h.example:8443' },
  });
  vm.runInContext(src, ctx);
  return { promise: vm.runInContext(`sozvonMint(${JSON.stringify(params)})`, ctx), window };
}

test('the minter asks for a perpetual link on a fresh child room', async () => {
  const { FakeSocket, sent } = fakeServer({
    join: () => ({ type: 'joined', kind: 'join', group: 'meet', permissions: ['op', 'present', 'token'] }),
    token: (m) => ({
      type: 'usermessage', kind: 'token', privileged: true,
      value: { token: 'T0k', group: m.value.group },
    }),
  });
  const { promise, window } = runMinter(FakeSocket,
    { group: 'meet', username: 'operator', password: 'pw', slug: 'abc23' });
  const r = await promise;
  assert.deepStrictEqual({ ...r }, { ok: true, token: 'T0k', url: 'https://h.example:8443/abc23/?token=T0k' });
  assert.strictEqual(FakeSocket.last.url, 'wss://h.example:8443/ws');
  assert.strictEqual(FakeSocket.last.closed, true, 'the socket is closed once the answer is in');
  assert.strictEqual(window.__sozvonMint.ok, true, 'Android polls for this');

  const join = sent.find(m => m.type === 'join');
  assert.deepStrictEqual({ ...join }, { type: 'join', kind: 'join', group: 'meet', username: 'operator', password: 'pw' });
  assert.ok(sent.some(m => m.type === 'pong'), 'a ping is answered');
  const ask = sent.find(m => m.kind === 'maketoken');
  assert.deepStrictEqual({ ...ask.value, permissions: [...ask.value.permissions] },
    { group: 'meet/abc23', expires: null, permissions: ['present', 'message'] });
});

test('a refused join and a refused token both come back as failures', async () => {
  const refused = fakeServer({
    join: () => ({ type: 'joined', kind: 'fail', value: 'not authorised' }),
    token: () => assert.fail('no token after a refused join'),
  });
  let r = await runMinter(refused.FakeSocket, { group: 'meet', username: 'o', password: 'x', slug: 's' }).promise;
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /not authorised/);

  const noPerm = fakeServer({
    join: () => ({ type: 'joined', kind: 'join', permissions: ['present'] }),
    token: () => assert.fail('no token request without the permission'),
  });
  r = await runMinter(noPerm.FakeSocket, { group: 'meet', username: 'o', password: 'x', slug: 's' }).promise;
  assert.strictEqual(r.ok, false);

  const tokenError = fakeServer({
    join: () => ({ type: 'joined', kind: 'join', permissions: ['token'] }),
    token: () => ({ type: 'usermessage', kind: 'token', privileged: true, error: 'error', value: 'wrong group in token' }),
  });
  r = await runMinter(tokenError.FakeSocket, { group: 'meet', username: 'o', password: 'x', slug: 's' }).promise;
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /wrong group/);
});

test('a server that never answers times out instead of hanging', async () => {
  class Silent {
    constructor() { setTimeout(() => this.onopen && this.onopen(), 0); }
    send() {}
    close() {}
  }
  const r = await runMinter(Silent, { group: 'g', username: 'u', password: 'p', slug: 's', timeoutMs: 50 }).promise;
  assert.deepStrictEqual({ ...r }, { ok: false, error: 'timeout' });
});

// ---------------------------------------------------------------- files ---

test('the page loads only files that exist, and nothing from the network', () => {
  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map(m => m[1]);
  assert.ok(refs.length >= 5, 'found the page\'s own files');
  for (const r of refs) {
    assert.ok(!/^[a-z]+:/i.test(r), `${r} is not a local file`);
    assert.ok(fs.existsSync(path.join(dir, r)), `${r} exists`);
  }
  assert.match(html, /connect-src 'none'/);
  assert.ok(fs.existsSync(path.join(dir, 'mark.svg')));
});
