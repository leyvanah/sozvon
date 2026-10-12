// Tests for restarting ICE after a network change.  (Sozvon)
//
// Run with:  node --test static/test/
//
// The case behind it (2026-10-12): a VPN turned off under a call over the
// TCP relay.  The signalling resumed two seconds later, the media sat in
// "disconnected" until Chrome declared it failed 20 s on, and the participant
// reloaded the page.

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const r = require('../ice-recovery.js');

test('a short hiccup is left to Chrome', () => {
    const rec = new r.Recovery();
    assert.strictEqual(rec.update('u', 'connected', 0), null);
    assert.strictEqual(rec.update('u', 'disconnected', 1000), null);
    assert.strictEqual(rec.update('u', 'disconnected', 5000), null);
    assert.strictEqual(rec.update('u', 'connected', 6000), null);
    // the clock starts again from the next drop
    assert.strictEqual(rec.update('u', 'disconnected', 7000), null);
    assert.strictEqual(rec.update('u', 'disconnected',
                                  7000 + r.DISCONNECTED_FOR - 1), null);
});

test('staying disconnected gets a restart, long before "failed"', () => {
    const rec = new r.Recovery();
    rec.update('u', 'connected', 0);
    rec.update('u', 'disconnected', 1000);
    assert.strictEqual(rec.update('u', 'disconnected',
                                  1000 + r.DISCONNECTED_FOR), 'disconnected');
    assert.ok(r.DISCONNECTED_FOR < 20000);
});

test('it waits longer than the UDP fallback, which restarts on its own',
     () => {
    const f = require('../turn-fallback.js');
    // turn-fallback.js is polled every 2 s
    assert.ok(r.DISCONNECTED_FOR >= f.DISCONNECTED_FOR + 2000);
});

test('after a resume, a connection that is down is restarted at once', () => {
    const rec = new r.Recovery();
    rec.update('u', 'connected', 0);
    rec.update('d', 'connected', 0);
    rec.update('u', 'disconnected', 1000);
    rec.resumed(2000);
    assert.strictEqual(rec.update('u', 'disconnected', 2000), 'resumed');
    // still connected: nothing to do yet ...
    assert.strictEqual(rec.update('d', 'connected', 2000), null);
    // ... until ICE notices, a moment after the websocket did
    assert.strictEqual(rec.update('d', 'disconnected', 3500), 'resumed');
});

test('a resume does not touch what is up or already negotiating', () => {
    const rec = new r.Recovery();
    rec.resumed(0);
    for (const s of ['new', 'checking', 'connected', 'completed', 'failed',
                     'closed'])
        assert.strictEqual(rec.update(s, s, 100), null, s);
});

test('the suspicion after a resume wears off', () => {
    const rec = new r.Recovery();
    rec.update('u', 'connected', 0);
    rec.resumed(0);
    assert.strictEqual(rec.update('u', 'disconnected', r.SUSPECT_FOR), null);
});

test('restarts of one connection are spaced out', () => {
    const rec = new r.Recovery();
    rec.resumed(0);
    assert.strictEqual(rec.update('u', 'disconnected', 0), 'resumed');
    // the restart has not taken yet
    assert.strictEqual(rec.update('u', 'disconnected', 1000), null);
    assert.strictEqual(rec.update('u', 'checking', 2000), null);
    assert.strictEqual(rec.update('u', 'disconnected', r.MIN_GAP - 1), null);
    assert.strictEqual(rec.update('u', 'disconnected', r.MIN_GAP), 'resumed');
});

test('a connection that came back may be restarted again at once', () => {
    const rec = new r.Recovery();
    rec.resumed(0);
    assert.strictEqual(rec.update('u', 'disconnected', 0), 'resumed');
    rec.update('u', 'connected', 1000);
    assert.strictEqual(rec.update('u', 'disconnected', 1500), 'resumed');
});

test('connections are judged apart, and forgotten', () => {
    const rec = new r.Recovery();
    rec.update('a', 'disconnected', 0);
    rec.update('b', 'connected', 0);
    assert.strictEqual(rec.update('b', 'connected', r.DISCONNECTED_FOR), null);
    assert.strictEqual(rec.update('a', 'disconnected', r.DISCONNECTED_FOR),
                       'disconnected');
    rec.forget('a');
    assert.ok(!rec.streams.has('a'));
});

test('a restart made elsewhere is not repeated at once', () => {
    const rec = new r.Recovery();
    rec.resumed(0);
    rec.restarted('u', 0);
    assert.strictEqual(rec.update('u', 'disconnected', 100), null);
    assert.strictEqual(rec.update('u', 'disconnected', r.MIN_GAP), 'resumed');
});
