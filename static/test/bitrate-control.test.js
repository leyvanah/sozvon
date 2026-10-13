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
         * @param {number} [o.height] - lines of the picture arriving
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
            c.vDecoded = (c.vDecoded || 0) + 60;
            let h = o.height ?? 480;
            return {time: t, audio: true, video: o.video ?? true, ...c,
                    vHeight: h, vWidth: Math.round(h * 4 / 3)};
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

test('assess reports arrival jitter and frame processing time (tasks#32)', () => {
    let at = (t, jitter, proc, decoded) => b.snapshot([
        {type: 'inbound-rtp', kind: 'audio', jitterBufferDelay: t * 2,
         jitterBufferEmittedCount: t * 50, jitter: jitter},
        {type: 'inbound-rtp', kind: 'video', totalProcessingDelay: proc,
         framesDecoded: decoded, bytesReceived: t * 1000},
    ], t * 1000);
    let r = b.assess(at(1, 0.002, 1.0, 30), at(3, 0.045, 2.5, 90));
    assert.strictEqual(r.jitter, 0.045, 'the current estimate, not a delta');
    assert.ok(Math.abs(r.processing - 0.025) < 1e-9, '1.5 s over 60 frames');
    // no frame decoded in the interval: nothing to divide by
    assert.strictEqual(b.assess(at(1, 0, 1, 30), at(3, 0, 1, 30)).processing, 0);
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

test('lag that persists keeps shrinking, down to the floor', () => {
    let ctl = new b.Controller();
    let rx = receiver();
    feed(ctl, rx, WARM);
    let caps = [];
    for(let i = 0; i < 100 && ctl.cap !== b.MIN_CAP; i++) {
        // The sender obeys: what arrives is the cap.
        let bps = ctl.cap === null ? 4000000 : ctl.cap;
        caps.push(ctl.update(rx.next({audioDelay: 0.5, bps})).cap);
    }
    let distinct = [...new Set(caps.filter(c => c !== null))];
    for(let i = 1; i < distinct.length; i++)
        assert.ok(distinct[i] < distinct[i - 1], 'caps only go down');
    assert.strictEqual(ctl.cap, b.MIN_CAP);
    // Decreases are spaced out, not one per poll.
    let changes = caps.filter((c, i) => i > 0 && c !== caps[i - 1]).length;
    assert.ok(changes <= Math.ceil(caps.length * STEP / b.MIN_DECREASE_GAP) + 1);
    // And never below it, however bad it gets.
    let out = feed(ctl, rx, 3, {audioDelay: 0.9, bps: b.MIN_CAP});
    assert.ok(out.every(o => o.cap === b.MIN_CAP));
});

// tasks#62: the calls of 2026-10-09 and 2026-10-12.  The buffer sat at
// 260-330 ms whatever the sender sent, and the cap stayed at the floor for
// the rest of the call -- an hour in one of them.
test("delay the floor does not cure is the path's: the cap climbs back", () => {
    let ctl = new b.Controller(b.START_CAP);
    let rx = receiver();
    let caps = [];
    for(let i = 0; i < 600; i++) {   // 20 minutes
        let bps = ctl.cap === null ? 4000000 : ctl.cap;
        caps.push(ctl.update(rx.next({audioDelay: 0.3, bps})).cap);
    }
    let floor = caps.indexOf(b.MIN_CAP);
    assert.ok(floor >= 0, 'cut to the floor first: nothing yet says it is the path');
    let atFloor = caps.slice(floor).filter(c => c === b.MIN_CAP).length;
    assert.ok(atFloor * STEP <= 60000,
              `${atFloor * STEP / 1000} s at the floor in 20 minutes`);
    assert.ok(caps.lastIndexOf(b.MIN_CAP) - floor < 60,
              'and does not fall back to it once the path is known');
    assert.strictEqual(ctl.cap, null, 'full quality once proven harmless');
});

test('a path with its own delay still caps what the sender adds', () => {
    // The path holds 0.3 s; past 600 kbit/s the sender queues on top of it
    // (as the TCP relay does), a little more each interval it stays there.
    let ctl = new b.Controller(b.START_CAP);
    let rx = receiver();
    let queue = 0;
    let caps = [];
    for(let i = 0; i < 900; i++) {   // 30 minutes
        let bps = ctl.cap === null ? 4000000 : ctl.cap;
        queue = bps > 600000 ? queue + 0.05 * (bps / 600000) :
            Math.max(0, queue - 0.1);
        caps.push(ctl.update(rx.next({audioDelay: 0.3 + queue, bps})).cap);
    }
    let late = caps.slice(300);          // after the first 10 minutes
    let over = late.filter(c => c === null || c > 600000).length;
    let floor = late.filter(c => c === b.MIN_CAP).length;
    assert.ok(over / late.length < 0.3,
              `above what the path carries ${Math.round(over / late.length * 100)}% of the time`);
    assert.ok(floor / late.length < 0.3,
              `at the floor ${Math.round(floor / late.length * 100)}% of the time`);
    let avg = late.reduce((a, c) => a + (c === null ? 4000000 : c), 0) / late.length;
    assert.ok(avg > 300000, `settles near what the path carries, not the floor: ${Math.round(avg / 1000)} kbit/s`);
});

test('without a lower cap to compare with, the fixed thresholds stand', () => {
    let ctl = new b.Controller(b.START_CAP);
    let rx = receiver();
    // a delay that has been there since the stream started, at the start
    // cap: it may well be the sender's, so it is cut
    feed(ctl, rx, WARM + b.BAD_TO_DECREASE, {audioDelay: 0.3, bps: b.START_CAP});
    assert.ok(ctl.cap < b.START_CAP);
    assert.strictEqual(ctl.pathEvidence(1e9), null, 'and forgotten in time');
});

test("the path's delay is the least seen well below the current cap", () => {
    let ctl = new b.Controller();
    let at = (time, cap, a, v) => ctl.seen.push(
        {time, cap, audioDelay: a, videoDelay: v});
    at(1000, 1000000, 0.1, 0.05);
    at(2000, 600000, 0.3, 0.2);
    at(3000, b.MIN_CAP, 0.35, 0.25);
    at(4000, b.MIN_CAP, 0.28, 0.3);
    ctl.cap = 1000000;
    assert.deepStrictEqual(ctl.pathDelay(5000), {audioDelay: 0.28, videoDelay: 0.2});
    ctl.cap = 800000;            // 600k is not well below 800k
    assert.deepStrictEqual(ctl.pathDelay(5000), {audioDelay: 0.28, videoDelay: 0.25});
    ctl.cap = b.MIN_CAP;         // at the floor, the floor counts
    assert.deepStrictEqual(ctl.pathDelay(5000), {audioDelay: 0.28, videoDelay: 0.25});
    ctl.cap = null;              // uncapped: every capped sample is lower
    assert.deepStrictEqual(ctl.pathDelay(5000), {audioDelay: 0.1, videoDelay: 0.05});
    assert.strictEqual(ctl.pathEvidence(4000 + b.PATH_MEMORY + 1), null);
});

test('a known path delay holds while it explains the delay, and goes when not', () => {
    let ctl = new b.Controller();
    ctl.path = {audioDelay: 0.3, videoDelay: 0.03};
    ctl.pathUntil = 10000;
    ctl.confirmPath({state: 'good', audioDelay: 0.31, videoDelay: 0.03}, 9000);
    let t = 9000 + b.PATH_MEMORY - 1;
    assert.strictEqual(ctl.pathDelay(t).audioDelay, 0.3);
    // a delay it no longer explains does not keep it alive
    ctl.confirmPath({state: 'bad', audioDelay: 0.9, videoDelay: 0.03}, t);
    assert.strictEqual(ctl.pathDelay(9000 + b.PATH_MEMORY), null);
});

test('a path that gets better is followed down, not on one interval', () => {
    let ctl = new b.Controller();
    ctl.path = {audioDelay: 0.3, videoDelay: 0.2};
    ctl.pathUntil = 1e9;
    let s = a => ({state: 'good', audioDelay: a, videoDelay: 0.05});
    ctl.confirmPath(s(0.3), 0);
    ctl.confirmPath(s(0.3), 1);
    ctl.confirmPath(s(0.05), 2);
    assert.strictEqual(ctl.path.audioDelay, 0.3, 'one low interval is not enough');
    ctl.confirmPath(s(0.06), 3);
    ctl.confirmPath(s(0.05), 4);
    assert.strictEqual(ctl.path.audioDelay, 0.06);
    assert.strictEqual(ctl.path.videoDelay, 0.05);
});

test('a path delay raises the thresholds, never lowers them', () => {
    let rx = receiver();
    let p = rx.next();
    let deep = rx.next({audioDelay: 0.3});
    assert.strictEqual(b.assess(p, deep).state, 'bad');
    let path = {audioDelay: 0.28, videoDelay: 0.03};
    assert.strictEqual(b.assess(p, deep, path).state, 'good');
    let more = rx.next({audioDelay: 0.5});
    assert.strictEqual(b.assess(deep, more, path).state, 'bad', 'sender adds 0.22 s');
    // a shallow path changes nothing
    let q = rx.next();
    let r = rx.next({audioDelay: 0.18});
    assert.strictEqual(b.assess(q, r, {audioDelay: 0, videoDelay: 0}).state, 'hold');
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

test('a start cap is asked for at once, then opened while healthy', () => {
    let ctl = new b.Controller(b.START_CAP);
    let rx = receiver();
    let first = ctl.update(rx.next({bps: 300000}));
    assert.strictEqual(first.cap, b.START_CAP);
    assert.ok(first.changed && first.send, 'sent before the sender climbs');

    // The sender obeys and the link keeps up.
    let caps = [];
    for(let i = 0; i < 300 && ctl.cap !== null; i++)
        caps.push(ctl.update(rx.next({bps: ctl.cap})).cap);
    assert.strictEqual(ctl.cap, null, 'full quality once it has proved itself');
    let firstRise = caps.findIndex(c => c !== b.START_CAP);
    assert.ok((firstRise + 1) * STEP >= b.MIN_INCREASE_GAP,
              'not opened in the first seconds');
    assert.ok(caps.length * STEP <= 120000,
              `lifted after ${caps.length * STEP / 1000} s`);
});

test('a start cap the path cannot carry still shrinks', () => {
    let ctl = new b.Controller(b.START_CAP);
    let rx = receiver();
    feed(ctl, rx, WARM + b.BAD_TO_DECREASE,
         {audioDelay: 0.5, bps: b.START_CAP});
    assert.ok(ctl.cap !== null && ctl.cap < b.START_CAP);
});

test('video that stops and resumes starts again from the start cap', () => {
    let ctl = new b.Controller(b.START_CAP);
    let rx = receiver();
    feed(ctl, rx, 3);
    let off = ctl.update(rx.next({video: false}));
    assert.strictEqual(off.cap, null);
    let on = ctl.update(rx.next());
    assert.strictEqual(on.cap, b.START_CAP);
    assert.ok(on.send);
});

test('a start cap from the wire is sanitised like any other', () => {
    assert.strictEqual(new b.Controller(NaN).startCap, null);
    assert.strictEqual(new b.Controller(1).startCap, b.MIN_CAP);
    assert.strictEqual(new b.Controller().startCap, null);
});

// tasks#65: on 2026-10-13 a camera was lifted 26 times in an hour; each time
// its sender went to 7-10 Mbit/s and the receiver lost audio.

/** A call where the sender obeys the cap, uncapped meaning 8 Mbit/s. */
function obeying(ctl, rx, n, o = {}) {
    let caps = [];
    for(let i = 0; i < n; i++) {
        let bps = ctl.cap === null ? 8000000 : ctl.cap;
        let extra = typeof o === 'function' ? o(bps) : o;
        caps.push(ctl.update(rx.next({bps, ...extra})).cap);
    }
    return caps;
}

test('snapshot keeps the largest picture arriving', () => {
    let s = b.snapshot([
        {type: 'inbound-rtp', kind: 'video', frameWidth: 320, frameHeight: 240},
        {type: 'inbound-rtp', kind: 'video', frameWidth: 640, frameHeight: 480},
    ], 1);
    assert.strictEqual(s.vWidth, 640);
    assert.strictEqual(s.vHeight, 480);
    let a = b.assess({...s, time: 0, vDecoded: 0}, {...s, time: 2000, vDecoded: 60});
    assert.strictEqual(a.fps, 30);
    assert.strictEqual(a.height, 480);
});

test('a camera rises to its ceiling and stays there', () => {
    let ctl = new b.Controller(b.START_CAP, 'camera');
    let caps = obeying(ctl, receiver(), 300);   // ten healthy minutes
    assert.ok(caps.every(c => c !== null), 'never lifted');
    assert.ok(caps.every(c => c <= 2500000), 'never above the ceiling');
    assert.strictEqual(ctl.cap, 2500000);
    assert.strictEqual(ctl.ceiling(), 2500000, '640x480 gets 2.5 Mbit/s');
});

test('the ceiling follows the tallest picture the camera has shown', () => {
    let ctl = new b.Controller(b.START_CAP, 'camera');
    let rx = receiver();
    obeying(ctl, rx, 200, {height: 720});
    assert.strictEqual(ctl.cap, 4000000);
    obeying(ctl, rx, 200, {height: 1080});
    assert.strictEqual(ctl.cap, 6000000);
    // a picture the sender shrinks for a while does not lower it
    obeying(ctl, rx, 50, {height: 540});
    assert.strictEqual(ctl.ceiling(), 6000000);
    assert.strictEqual(ctl.cap, 6000000);
});

test('a camera at its ceiling is still cut when playback suffers', () => {
    let ctl = new b.Controller(b.START_CAP, 'camera');
    let rx = receiver();
    obeying(ctl, rx, 200);
    obeying(ctl, rx, b.BAD_TO_DECREASE, {audioDelay: 0.5});
    assert.ok(ctl.cap < 2500000);
});

test('a shared screen or a video file is still lifted', () => {
    for(let label of ['screenshare', 'video', undefined]) {
        let ctl = new b.Controller(b.START_CAP, label);
        obeying(ctl, receiver(), 300);
        assert.strictEqual(ctl.cap, null, String(label));
        assert.strictEqual(ctl.ceiling(), null);
    }
});

test('the call of 2026-10-13: a camera no longer breaks the audio', () => {
    // The receiver copes up to 3.5 Mbit/s; above that, audio breaks up.
    let link = bps => bps > 3500000 ? {concealed: 0.3} : {};
    let breaks = label => {
        let ctl = new b.Controller(b.START_CAP, label);
        let rx = receiver();
        let n = 0;
        for(let i = 0; i < 1800; i++) {    // an hour
            let bps = ctl.cap === null ? 8000000 : ctl.cap;
            let o = link(bps);
            // the first poll comes before any cap could be asked for
            if(o.concealed && i > 0)
                n++;
            ctl.update(rx.next({bps, ...o}));
        }
        return n;
    };
    let before = breaks(undefined);
    let after = breaks('camera');
    assert.ok(before >= 10, `the old behaviour breaks up (${before} intervals)`);
    assert.strictEqual(after, 0, 'a camera at its ceiling never gets there');
});
