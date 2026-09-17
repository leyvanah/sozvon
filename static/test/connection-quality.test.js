// Tests for the call quality classifier.  (Sozvon)
//
// Run with:  node --test static/test/
//
// connection-quality.js decides when a call is announced as degraded.  Both
// ways it can be wrong are invisible in a healthy test call: announcing noise
// (a toast on every blip, which people learn to ignore) and staying silent
// while the link falls apart (the situation that prompted it).  The polling
// and the toasts in galene.js need a live call; the judgement is here.

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const q = require('../connection-quality.js');

/**
 * A snapshot as snapshot() would build it from an inbound-only report.
 *
 * @param {number} received
 * @param {number} lost
 * @param {object} [extra]
 */
function inbound(received, lost, extra) {
    return q.snapshot([
        Object.assign({type: 'inbound-rtp', packetsReceived: received,
                       packetsLost: lost, jitter: 0.005}, extra || {}),
    ], 0);
}

/**
 * Feed a tracker a series of snapshots with ICE connected and return the
 * settled levels after each one.
 */
function run(tracker, snaps) {
    return snaps.map(s => tracker.update('connected', s).level);
}

/** Cumulative counters growing by `step` packets with `lossPct` lost. */
function series(n, step, lossPct, start) {
    let out = [];
    let received = start ? start.received : 0;
    let lost = start ? start.lost : 0;
    for(let i = 0; i < n; i++) {
        let l = Math.round(step * lossPct / 100);
        received += step - l;
        lost += l;
        out.push(inbound(received, lost));
    }
    return out;
}

test('snapshot sums inbound streams and takes the worst remote figures', () => {
    let s = q.snapshot([
        {type: 'inbound-rtp', packetsReceived: 100, packetsLost: 5,
         jitter: 0.01},
        {type: 'inbound-rtp', packetsReceived: 50, packetsLost: -2,
         jitter: 0.03},
        {type: 'remote-inbound-rtp', fractionLost: 0.02, roundTripTime: 0.1},
        {type: 'remote-inbound-rtp', fractionLost: 0.07, roundTripTime: 0.05},
        {type: 'candidate-pair', nominated: true, state: 'succeeded',
         currentRoundTripTime: 0.2},
        {type: 'candidate-pair', nominated: false, state: 'waiting',
         currentRoundTripTime: 5},
    ], 42);
    assert.strictEqual(s.received, 150);
    assert.strictEqual(s.lost, 5, 'negative packetsLost is clamped to 0');
    assert.strictEqual(s.jitter, 0.03);
    assert.strictEqual(s.remoteLoss, 0.07);
    assert.strictEqual(s.remoteRtt, 0.1);
    assert.strictEqual(s.rtt, 0.2, 'only the selected pair counts');
    assert.ok(s.inbound && s.outbound);
});

test('assess grades loss, round trip and jitter', () => {
    let base = inbound(1000, 0);
    assert.strictEqual(q.assess(base, inbound(1100, 0)).level, 'good');
    assert.strictEqual(q.assess(base, inbound(1095, 5)).level, 'weak');
    assert.strictEqual(q.assess(base, inbound(1080, 20)).level, 'bad');

    let slow = q.snapshot([{type: 'candidate-pair', nominated: true,
                            state: 'succeeded', currentRoundTripTime: 0.5}], 0);
    assert.strictEqual(q.assess(null, slow).level, 'weak');
    slow.rtt = 1.2;
    assert.strictEqual(q.assess(null, slow).level, 'bad');

    let jittery = inbound(1100, 0, {jitter: 0.2});
    assert.strictEqual(q.assess(base, jittery).level, 'bad');

    let sending = q.snapshot([{type: 'remote-inbound-rtp',
                               fractionLost: 0.12, roundTripTime: 0.05}], 0);
    assert.strictEqual(q.assess(null, sending).level, 'bad',
                       'loss reported by the far end counts for up streams');
});

test('assess refuses to judge a nearly silent interval', () => {
    // Three lost out of eight is 37%, and meaningless.
    let r = q.assess(inbound(100, 0), inbound(105, 3));
    assert.strictEqual(r.level, null);
    assert.strictEqual(q.assess(null, inbound(100, 0)).level, null,
                       'no previous snapshot, no rate');
});

test('a single bad interval does not change the level', () => {
    let t = new q.Tracker();
    let good = series(3, 100, 0);
    let bad = series(1, 100, 20, {received: 300, lost: 0});
    let after = series(3, 100, 0, {received: 380, lost: 20});
    let levels = run(t, [...good, ...bad, ...after]);
    assert.ok(levels.every(l => l === 'good'), levels.join(','));
});

test('persistent loss degrades after WORSEN_AFTER intervals', () => {
    let t = new q.Tracker();
    let levels = run(t, [...series(2, 100, 0), ...series(
        q.WORSEN_AFTER, 100, 20, {received: 200, lost: 0})]);
    assert.strictEqual(levels[levels.length - 2], 'good');
    assert.strictEqual(levels[levels.length - 1], 'bad');
});

test('recovery is slower than degradation', () => {
    let t = new q.Tracker();
    let snaps = [...series(1, 100, 0),
                 ...series(q.WORSEN_AFTER, 100, 20,
                           {received: 100, lost: 0})];
    run(t, snaps);
    assert.strictEqual(t.level, 'bad');
    let last = snaps[snaps.length - 1];
    let recovering = series(q.IMPROVE_AFTER, 100, 0,
                            {received: last.received, lost: last.lost});
    let levels = run(t, recovering);
    assert.deepStrictEqual(
        levels,
        [...Array(q.IMPROVE_AFTER - 1).fill('bad'), 'good']);
});

test('a flapping link does not flap the level', () => {
    let t = new q.Tracker();
    let snaps = [];
    let received = 0, lost = 0;
    for(let i = 0; i < 20; i++) {
        let l = i % 2 ? 20 : 0;
        received += 100 - l;
        lost += l;
        snaps.push(inbound(received, lost));
    }
    let levels = run(t, snaps);
    assert.ok(levels.every(l => l === 'good'), levels.join(','));
});

test('ICE failure is announced at once and recovery at once', () => {
    let t = new q.Tracker();
    run(t, series(2, 100, 0));
    let r = t.update('failed', null);
    assert.deepStrictEqual(r, {level: 'lost', previous: 'good',
                               changed: true});
    r = t.update('checking', null);
    assert.strictEqual(r.changed, false);
    assert.strictEqual(r.level, 'lost');
    r = t.update('connected', inbound(10, 0));
    assert.deepStrictEqual(r, {level: 'good', previous: 'lost',
                               changed: true});
});

test('a brief "disconnected" is not a loss', () => {
    let t = new q.Tracker();
    run(t, series(2, 100, 0));
    assert.strictEqual(t.update('disconnected', null).level, 'good');
    assert.strictEqual(t.update('connected', inbound(10, 0)).level, 'good');

    for(let i = 0; i < q.WORSEN_AFTER; i++)
        t.update('disconnected', null);
    assert.strictEqual(t.level, 'lost');
});

test('worst orders the levels', () => {
    assert.strictEqual(q.worst(), 'good');
    assert.strictEqual(q.worst('weak', 'good'), 'weak');
    assert.strictEqual(q.worst('bad', 'lost', 'weak'), 'lost');
});
