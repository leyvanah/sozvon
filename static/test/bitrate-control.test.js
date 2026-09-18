// Tests for receiver-driven bitrate caps.  (Sozvon)
//
// Run with:  node --test static/test/
//
// bitrate-control.js decides when a receiver asks its sender to send less
// video, and when it lets go again.  Getting it wrong either way is invisible
// in a local test call: a controller that never shrinks leaves the audio lag
// of 2026-09-17 in place, and one that shrinks on noise or never lets go makes
// every call blurry.  The message plumbing in galene.js needs two browsers;
// the decisions are here.

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const b = require('../bitrate-control.js');

const STEP = 2000; // the polling interval galene.js uses
// Healthy polls that take a controller past its warm-up.
const WARM = Math.ceil(b.WARMUP / STEP) + 2;

/**
 * A stream of receiver snapshots.  Each call to next() advances time by one
 * interval and grows the counters as the given interval describes.
 */
function receiver() {
    let t = 0;
    let c = {aDelay: 0, aEmitted: 0, aConcealed: 0, aSamples: 0,
             vDelay: 0, vEmitted: 0, vFreeze: 0, vBytes: 0};
    return {
        /**
         * @param {object} o
         * @param {number} [o.audioDelay] - seconds of buffer per sample
         * @param {number} [o.freeze] - seconds frozen in the interval
         * @param {number} [o.concealed] - fraction concealed
         * @param {number} [o.bps] - video arriving
         * @param {boolean} [o.video] - false: no inbound video at all
         */
        next(o = {}) {
            t += STEP;
            let samples = 96000;
            c.aEmitted += samples;
            c.aDelay += samples * (o.audioDelay ?? 0.04);
            c.aSamples += samples;
            c.aConcealed += samples * (o.concealed ?? 0);
            c.vEmitted += 60;
            c.vDelay += 60 * 0.03;
            c.vFreeze += o.freeze ?? 0;
            c.vBytes += (o.bps ?? 4000000) * STEP / 1000 / 8;
            return {time: t, audio: true, video: o.video ?? true, ...c};
        },
    };
}

function feed(ctl, rx, n, o) {
    let out = [];
    for(let i = 0; i < n; i++)
        out.push(ctl.update(rx.next(o)));
    return out;
}

test('snapshot sums inbound audio and video, ignoring silent concealment', () => {
    let s = b.snapshot([
        {type: 'inbound-rtp', kind: 'audio', jitterBufferDelay: 10,
         jitterBufferEmittedCount: 100, concealedSamples: 30,
         silentConcealedSamples: 20, totalSamplesReceived: 1000},
        {type: 'inbound-rtp', kind: 'video', jitterBufferDelay: 3,
         jitterBufferEmittedCount: 30, totalFreezesDuration: 1.5,
         bytesReceived: 5000},
        {type: 'outbound-rtp', kind: 'video', bytesSent: 99999},
    ], 7);
    assert.strictEqual(s.aConcealed, 10);
    assert.strictEqual(s.vBytes, 5000);
    assert.strictEqual(s.vFreeze, 1.5);
    assert.ok(s.audio && s.video);
});

test('assess separates bad, good and in-between intervals', () => {
    let rx = receiver();
    let p = rx.next();
    let r = b.assess(p, rx.next());
    assert.strictEqual(r.state, 'good');
    assert.ok(Math.abs(r.audioDelay - 0.04) < 1e-9);
    assert.ok(Math.abs(r.videoBps - 4000000) < 1);

    p = rx.next();
    assert.strictEqual(b.assess(p, rx.next({audioDelay: 0.4})).state, 'bad');
    p = rx.next();
    assert.strictEqual(b.assess(p, rx.next({freeze: 0.5})).state, 'bad');
    p = rx.next();
    assert.strictEqual(b.assess(p, rx.next({concealed: 0.1})).state, 'bad');
    p = rx.next();
    assert.strictEqual(b.assess(p, rx.next({audioDelay: 0.18})).state, 'hold');
    assert.strictEqual(b.assess(null, rx.next()).state, 'unknown');
});

test('a healthy call is never capped', () => {
    let ctl = new b.Controller();
    let out = feed(ctl, receiver(), 200);
    assert.ok(out.every(o => o.cap === null && !o.send));
});

test('lag in the first seconds of a stream is not acted on', () => {
    let ctl = new b.Controller();
    let rx = receiver();
    let n = Math.floor(b.WARMUP / STEP);
    let out = feed(ctl, rx, n, {audioDelay: 0.8});
    assert.ok(out.every(o => o.cap === null), 'no cap while warming up');
    feed(ctl, rx, WARM, {audioDelay: 0.8});
    assert.notStrictEqual(ctl.cap, null, 'lag that outlasts it still counts');
});

test('a single bad interval does not cap', () => {
    let ctl = new b.Controller();
    let rx = receiver();
    feed(ctl, rx, WARM);
    feed(ctl, rx, 1, {audioDelay: 0.5});
    let out = feed(ctl, rx, 20);
    assert.ok(out.every(o => o.cap === null));
});

test('sustained lag caps below what was arriving, and says so', () => {
    let ctl = new b.Controller();
    let rx = receiver();
    feed(ctl, rx, WARM, {bps: 5000000});
    let out = feed(ctl, rx, b.BAD_TO_DECREASE,
                   {audioDelay: 0.5, bps: 5000000});
    let last = out[out.length - 1];
    assert.strictEqual(last.cap, Math.round(5000000 * b.DECREASE));
    assert.ok(last.changed && last.send);
});

test('lag that persists keeps shrinking, but not below the floor', () => {
    let ctl = new b.Controller();
    let rx = receiver();
    feed(ctl, rx, WARM);
    let caps = [];
    for(let i = 0; i < 100; i++) {
        // The sender obeys: what arrives is the cap.
        let bps = ctl.cap === null ? 4000000 : ctl.cap;
        caps.push(ctl.update(rx.next({audioDelay: 0.5, bps})).cap);
    }
    let distinct = [...new Set(caps.filter(c => c !== null))];
    for(let i = 1; i < distinct.length; i++)
        assert.ok(distinct[i] < distinct[i - 1], 'caps only go down');
    assert.strictEqual(caps[caps.length - 1], b.MIN_CAP);
    // Decreases are spaced out, not one per poll.
    let changes = caps.filter((c, i) => i > 0 && c !== caps[i - 1]).length;
    assert.ok(changes <= Math.ceil(100 * STEP / b.MIN_DECREASE_GAP) + 1);
});

test('once the link recovers the cap rises step by step and is lifted', () => {
    let ctl = new b.Controller();
    let rx = receiver();
    feed(ctl, rx, WARM, {bps: 1000000});
    feed(ctl, rx, 2, {audioDelay: 0.5, bps: 1000000});
    assert.strictEqual(ctl.cap, 600000);

    let caps = [];
    for(let i = 0; i < 300 && ctl.cap !== null; i++)
        caps.push(ctl.update(rx.next({bps: ctl.cap})).cap);
    assert.strictEqual(ctl.cap, null, 'full quality comes back');
    let steps = caps.filter((c, i) => i > 0 && c !== caps[i - 1]);
    assert.ok(steps.length >= 5, 'in several steps, not one jump');
    let first = caps.findIndex(c => c !== 600000);
    assert.ok((first + 1) * STEP >= b.MIN_INCREASE_GAP,
              'no increase right after a decrease');
});

test('a cap the sender does not use opens faster', () => {
    let ctl = new b.Controller();
    let rx = receiver();
    feed(ctl, rx, WARM, {bps: 1000000});
    feed(ctl, rx, 2, {audioDelay: 0.5, bps: 1000000});
    assert.strictEqual(ctl.cap, 600000);
    // The sender sends far less than it may (a still picture, say).
    let caps = [];
    for(let i = 0; i < 300 && ctl.cap !== null; i++)
        caps.push(ctl.update(rx.next({bps: 200000})).cap);
    assert.strictEqual(ctl.cap, null);
    let steps = caps.filter((c, i) => i > 0 && c !== caps[i - 1]).length;
    assert.ok(steps <= 4, `lifted in ${steps} steps`);
});

test('a standing cap is refreshed, a lifted one is not', () => {
    let ctl = new b.Controller();
    let rx = receiver();
    feed(ctl, rx, WARM);
    feed(ctl, rx, 2, {audioDelay: 0.5});
    let out = feed(ctl, rx, 20, {audioDelay: 0.18}); // hold: no change
    let sends = out.filter(o => o.send).length;
    assert.strictEqual(sends, Math.floor(20 * STEP / b.REFRESH));
});

test('no video arriving means nothing to shrink', () => {
    let ctl = new b.Controller();
    let rx = receiver();
    feed(ctl, rx, 10, {audioDelay: 0.5, bps: 0});
    assert.strictEqual(ctl.cap, null);
});

test('the sender takes the tightest fresh cap and forgets stale ones', () => {
    let caps = new b.Caps();
    assert.strictEqual(caps.get('s', 0), null);
    assert.ok(caps.set('s', 'alice', 800000, 0));
    assert.ok(caps.set('s', 'bob', 500000, 1000));
    assert.strictEqual(caps.get('s', 1000), 500000);
    assert.ok(!caps.set('s', 'alice', 700000, 2000), 'bob still tighter');
    // bob stops refreshing.
    assert.strictEqual(caps.get('s', 1000 + b.TTL + 1), 700000);
    // alice lifts hers.
    assert.ok(caps.set('s', 'alice', null, 3000));
    assert.strictEqual(caps.get('s', 3000), null);
    // Silly values are floored, not obeyed.
    caps.set('t', 'eve', 1, 0);
    assert.strictEqual(caps.get('t', 0), b.MIN_CAP);
    assert.deepStrictEqual(caps.forget('eve'), ['t']);
    assert.strictEqual(caps.get('t', 0), null);
});

test('combine respects the user setting', () => {
    assert.strictEqual(b.combine(null, null), null);
    assert.strictEqual(b.combine(null, 500000), 500000);
    assert.strictEqual(b.combine(700000, 500000), 500000);
    assert.strictEqual(b.combine(300000, 500000), 300000);
    assert.strictEqual(b.combine(700000, null), 700000);
});

test('a receiver that stops receiving video lifts its cap at once', () => {
    let ctl = new b.Controller();
    let rx = receiver();
    feed(ctl, rx, WARM);
    feed(ctl, rx, b.BAD_TO_DECREASE, {audioDelay: 0.5});
    assert.notStrictEqual(ctl.cap, null);
    let r = ctl.update(rx.next({video: false}));
    assert.strictEqual(r.cap, null);
    assert.ok(r.changed && r.send);
    // And it does not keep refreshing, or re-cap on audio trouble alone.
    let later = feed(ctl, rx, 20, {video: false, audioDelay: 0.5});
    assert.ok(later.every(x => x.cap === null && !x.send));
});

test('a stale rate does not let audio trouble cap stopped video', () => {
    let ctl = new b.Controller();
    let rx = receiver();
    feed(ctl, rx, WARM);
    // Video stops flowing (the track stays), and only then audio lags.
    feed(ctl, rx, 3, {bps: 0});
    let out = feed(ctl, rx, 10, {audioDelay: 0.5, bps: 0});
    assert.ok(out.every(x => x.cap === null));
});

test('invalid caps from the wire never get below the minimum', () => {
    for(let v of [NaN, Infinity, -Infinity, -1, 0, '1', {}, [], true,
                  null, undefined, b.MAX_CAP + 1, 1e308])
        assert.strictEqual(b.sanitizeCap(v), null, String(v));
    assert.strictEqual(b.sanitizeCap(1), b.MIN_CAP);
    assert.strictEqual(b.sanitizeCap(1e-300), b.MIN_CAP);
    assert.strictEqual(b.sanitizeCap(500000.4), 500000);

    let caps = new b.Caps();
    caps.set('s', 'a', 1, 0);
    assert.strictEqual(caps.get('s', 0), b.MIN_CAP);
    for(let v of [NaN, Infinity, '1', -5]) {
        caps.set('s', 'b', v, 0);
        assert.strictEqual(caps.get('s', 0), b.MIN_CAP, String(v));
    }
    // A garbage value lifts that receiver's request rather than keep it.
    caps.set('s', 'a', 'x', 0);
    assert.strictEqual(caps.get('s', 0), null);
});

test('a receiver that leaves takes its caps with it', () => {
    let caps = new b.Caps();
    caps.set('s1', 'a', 400000, 0);
    caps.set('s2', 'a', 300000, 0);
    caps.set('s1', 'b', 800000, 0);
    assert.deepStrictEqual(caps.forget('a').sort(), ['s1', 's2']);
    assert.strictEqual(caps.get('s1', 1), 800000);
    assert.strictEqual(caps.get('s2', 1), null);
});
