// The clock a camera canvas is drawn by.  (Sozvon)
//
// Run with:  node --test static/test/
//
// Measured on 2026-11-09, with the picture format putting a computer's camera
// through a canvas for the first time: in Firefox 159 the canvas sent one
// frame a second whenever another window covered the call, because a page in
// the background has its timers held to one a second, and the check for a
// new camera frame (requestVideoFrameCallback) stops with the page's
// rendering.  And a clock at the camera's own rate drifted against it and
// lost a frame in five.  The ticks now come from a worker at twice the
// camera's rate; a hidden page on a computer draws every tick at the
// camera's rate, while a phone, whose camera stops in the background, keeps
// the check.  The drawing itself needs a browser: fps-probe.html measures it.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const staticDir = path.join(__dirname, '..');

/** filter.js in a page that is visible or not, on a phone or not. */
function page({hidden = false, phone = false, worker = true} = {}) {
    const clock = {now: 0};
    const workers = [];
    class FakeWorker {
        constructor(url) {
            this.url = url;
            this.sent = [];
            this.terminated = false;
            workers.push(this);
        }
        postMessage(m) { this.sent.push(m); }
        terminate() { this.terminated = true; }
    }
    const intervals = [];
    const track = {kind: 'video', getSettings: () => ({frameRate: 20}),
                   stop() {}, requestFrame() {}};
    const element = () => ({
        getContext: () => ({}),
        captureStream: () => ({getTracks: () => [track]}),
        play: () => Promise.resolve(),
    });
    const ctx = vm.createContext({
        console: {log() {}, warn() {}, error() {}},
        document: {visibilityState: hidden ? 'hidden' : 'visible',
                   createElement: element},
        HTMLCanvasElement: {prototype: {captureStream() {}}},
        MediaStream: class { addTrack() {} },
        Worker: worker ? FakeWorker : undefined,
        setInterval: (f, ms) => { intervals.push(ms); return intervals.length; },
        clearInterval() {},
        pausesWhenHidden: () => phone,
        Date: {now: () => clock.now},
    });
    vm.runInContext(
        fs.readFileSync(path.join(staticDir, 'filter.js'), 'utf8') +
            '\nthis.Filter = Filter;', ctx);
    const f = new ctx.Filter({getTracks: () => [track]}, {draw() {}});
    f.frameRate = 20;
    return {f, ctx, workers, intervals, clock};
}

test('the clock is a worker, at twice the camera rate', () => {
    const {f, workers, intervals} = page();
    f.tick(f.tickInterval());
    assert.strictEqual(workers.length, 1);
    assert.strictEqual(workers[0].url, '/filter-tick.js');
    assert.deepStrictEqual(workers[0].sent, [25]);
    assert.deepStrictEqual(intervals, []);
});

test('changing the rate reuses the worker; stopping it ends it', () => {
    const {f, workers} = page();
    f.tick(25);
    f.tick(50);
    assert.strictEqual(workers.length, 1);
    assert.deepStrictEqual(workers[0].sent, [25, 50]);
    f.tick(0);
    assert.deepStrictEqual(workers[0].sent, [25, 50, 0]);
});

test('without workers, a timer of the page does it, as before', () => {
    const {f, intervals} = page({worker: false});
    f.tick(f.tickInterval());
    assert.deepStrictEqual(intervals, [25]);
});

test('a worker that fails to load hands the clock to the page', () => {
    // the script missing from the server, or refused: the error comes
    // later, as an event, and without a clock the canvas never draws
    const {f, workers, intervals} = page();
    f.running = true;
    f.tick(25);
    workers[0].onerror({preventDefault() {}});
    assert.strictEqual(workers[0].terminated, true);
    assert.strictEqual(f.ticker, null);
    assert.deepStrictEqual(intervals, [25]);
    // and does not try another worker on the next change of rate
    f.tick(50);
    assert.strictEqual(workers.length, 1);
    assert.deepStrictEqual(intervals, [25, 50]);
});

test('a worker failing after the filter stopped changes nothing', () => {
    const {f, workers, intervals} = page();
    f.running = true;
    f.tick(25);
    let w = workers[0];
    f.stop();
    w.onerror({});
    assert.deepStrictEqual(intervals, []);
});

test('a visible page draws only new camera frames', () => {
    const {f} = page();
    f.callbackFrames = 7;
    assert.strictEqual(f.newFrame(), true);
    assert.strictEqual(f.newFrame(), false);
    f.callbackFrames = 8;
    assert.strictEqual(f.newFrame(), true);
});

test('a hidden computer draws every tick, at the camera rate', () => {
    const {f} = page({hidden: true});
    f.callbackFrames = 7;
    assert.strictEqual(f.newFrame(), true);
    assert.strictEqual(f.newFrame(), true);
    assert.strictEqual(f.tickInterval(), 50);
});

test('a hidden computer draws at the rate the camera was measured at', () => {
    // the camera says 20 and gives 15: drawn blind at 20, every fourth
    // frame would be the one before it again
    const {f, ctx, clock} = page();
    f.callbackFrames = 100;
    f.newFrame();
    clock.now = 2000;
    f.callbackFrames = 130;
    f.newFrame();
    assert.strictEqual(f.cameraRate, 15);
    ctx.document.visibilityState = 'hidden';
    assert.strictEqual(f.tickInterval(), 1000 / 15);
    // a rate above the reported one is a miscount, not a faster camera
    f.cameraRate = 45;
    assert.strictEqual(f.tickInterval(), 50);
});

test('a hidden phone keeps the check: its camera has stopped', () => {
    const {f} = page({hidden: true, phone: true});
    f.callbackFrames = 7;
    assert.strictEqual(f.newFrame(), true);
    assert.strictEqual(f.newFrame(), false);
    assert.strictEqual(f.tickInterval(), 25);
});
