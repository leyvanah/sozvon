// Tests for reopening a microphone that dropped out mid-call.  (Sozvon)
//
// Run with:  node --test static/test/
//
// The swap itself (replaceTrack on the live sender) needs a browser; what can
// go wrong quietly is the policy around it: giving up too early, retrying
// after the user refused permission, or opening the device for a stream that
// is already gone and leaving the microphone on with nobody using it.

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const r = require('../mic-recovery.js');

const noSleep = () => Promise.resolve();

function fakeTrack() {
    return {stopped: false, stop() { this.stopped = true; }};
}

function err(name) {
    let e = new Error(name);
    e.name = name;
    return e;
}

test('returns the first track that opens', async () => {
    let t = fakeTrack();
    let calls = 0;
    let got = await r.reopen({
        open: async () => { calls++; return t; },
        wanted: () => true,
        sleep: noSleep,
    });
    assert.strictEqual(got, t);
    assert.strictEqual(calls, 1);
});

test('keeps trying while the device is missing', async () => {
    let t = fakeTrack();
    let calls = 0;
    let got = await r.reopen({
        open: async () => {
            calls++;
            if(calls < 3)
                throw err('NotFoundError');
            return t;
        },
        wanted: () => true,
        sleep: noSleep,
    });
    assert.strictEqual(got, t);
    assert.strictEqual(calls, 3);
});

test('gives up after the last attempt', async () => {
    let calls = 0;
    let got = await r.reopen({
        open: async () => { calls++; throw err('NotReadableError'); },
        wanted: () => true,
        sleep: noSleep,
    });
    assert.strictEqual(got, null);
    assert.strictEqual(calls, r.DELAYS.length);
});

test('stops at once when permission is refused', async () => {
    let calls = 0;
    let got = await r.reopen({
        open: async () => { calls++; throw err('NotAllowedError'); },
        wanted: () => true,
        sleep: noSleep,
    });
    assert.strictEqual(got, null);
    assert.strictEqual(calls, 1);
});

test('does not open anything once the stream is gone', async () => {
    let calls = 0;
    let got = await r.reopen({
        open: async () => { calls++; return fakeTrack(); },
        wanted: () => false,
        sleep: noSleep,
    });
    assert.strictEqual(got, null);
    assert.strictEqual(calls, 0);
});

test('releases a track that arrives after the stream went away', async () => {
    let t = fakeTrack();
    let wanted = true;
    let got = await r.reopen({
        open: async () => { wanted = false; return t; },
        wanted: () => wanted,
        sleep: noSleep,
    });
    assert.strictEqual(got, null);
    assert.strictEqual(t.stopped, true,
                       'the device must not stay open with nobody using it');
});

test('waits before every attempt, the first one included', async () => {
    let waits = [];
    await r.reopen({
        open: async () => { throw err('NotFoundError'); },
        wanted: () => true,
        sleep: ms => { waits.push(ms); return Promise.resolve(); },
    });
    assert.deepStrictEqual(waits, r.DELAYS);
    assert.ok(waits[0] > 0, 'reopening in the same tick finds the device ' +
              'still gone');
    let total = waits.reduce((a, b) => a + b, 0);
    assert.ok(total >= 5000 && total <= 15000,
              `total patience ${total} ms should cover a headset re-pairing ` +
              'without leaving the user waiting forever');
});
