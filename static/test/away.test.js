// Tests for a phone call put in the background.  (Sozvon)
//
// Run with:  node --test static/test/
//
// The case behind it (2026-10-23): a guest on a phone left the call in the
// background.  Her camera and microphone had been paused by the system, the
// others saw her last picture and heard nothing, and two minutes later the
// server ended her session; nobody had been told any of it.

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const a = require('../away.js');

test('only a phone or a tablet marks itself', () => {
    assert.strictEqual(a.pausesWhenHidden({touchPoints: 5, coarse: true}), true);
    // a laptop with a touch screen still has a mouse
    assert.strictEqual(a.pausesWhenHidden({touchPoints: 10, coarse: false}), false);
    assert.strictEqual(a.pausesWhenHidden({touchPoints: 0, coarse: false}), false);
    assert.strictEqual(a.pausesWhenHidden({touchPoints: 0, coarse: true}), false);
    assert.strictEqual(a.pausesWhenHidden(null), false);
});

test('a drop while hidden is explained on the way back', () => {
    const t = new a.Tracker();
    t.hidden(0);
    t.lost(70_000);
    t.shown(150_000);
    assert.strictEqual(t.back(), true);
    // and only once
    assert.strictEqual(t.back(), false);
});

test('a dead socket found just after coming back counts too', () => {
    // a hidden page does not see its socket close; it finds it dead on waking
    const t = new a.Tracker();
    t.hidden(0);
    t.shown(150_000);
    t.lost(150_000 + a.RETURN_GRACE - 1);
    assert.strictEqual(t.back(), true);
});

test('hiding during a reconnect counts', () => {
    const t = new a.Tracker();
    t.lost(0);
    t.hidden(1_000);
    t.shown(5_000);
    assert.strictEqual(t.back(), true);
});

test('an ordinary drop in front of the user is not blamed on the background', () => {
    const t = new a.Tracker();
    t.hidden(0);
    t.shown(10_000);
    t.lost(10_000 + a.RETURN_GRACE);
    assert.strictEqual(t.back(), false);

    const fresh = new a.Tracker();
    fresh.lost(0);
    assert.strictEqual(fresh.back(), false);
});

test('one outage is judged by how it began', () => {
    // retries of the same reconnect cycle do not move its start
    const t = new a.Tracker();
    t.lost(0);
    t.hidden(60_000);
    t.shown(61_000);
    t.lost(61_000 + 2 * a.RETURN_GRACE);
    assert.strictEqual(t.back(), true);
    // the next outage starts clean
    t.lost(500_000);
    assert.strictEqual(t.back(), false);
});
