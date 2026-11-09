// A phone's camera that does not come back with the page.  (Sozvon)
//
// Run with:  node --test static/test/
//
// Firefox on Android, 2026-11-09: a call put in the background and brought
// back sent no picture again until the page was reloaded.  The track stayed
// "live", unmuted and enabled, and the element showing it "playing"; no
// frame came.  checkCameraAfterReturn() in galene.js watches the frames the
// camera's canvas draws, and opens the camera again when none come.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function lift(name) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'galene.js'), 'utf8');
    const start = src.indexOf('function ' + name + '(');
    assert.ok(start >= 0, `galene.js no longer declares ${name}()`);
    const end = src.indexOf('\n}\n', start);
    return src.slice(start, end + 3);
}

/** A page coming back to the front with a phone's camera in a canvas. */
function page({phone = true, live = true} = {}) {
    const timers = [];
    class Filter {}
    const f = new Filter();
    f.drawn = 100;
    f.inputStream = {getVideoTracks: () => [
        {readyState: live ? 'live' : 'ended', enabled: true}]};
    const c = {userdata: {filter: f}};
    const reopened = [];
    const ctx = vm.createContext({
        console: {warn() {}},
        document: {visibilityState: 'visible'},
        Filter,
        CAMERA_RETURN_CHECK: 2500,
        pausesWhenHidden: () => phone,
        findUpMedia: () => c,
        replaceCameraStream: () => reopened.push(true),
        setTimeout: (fn, ms) => timers.push({fn, ms}),
    });
    vm.runInContext(lift('checkCameraAfterReturn'), ctx);
    return {ctx, f, c, reopened,
            later() { timers.splice(0).forEach(t => t.fn()); }};
}

test('a camera that gives no frame after the return is opened again', () => {
    const p = page();
    p.ctx.checkCameraAfterReturn();
    p.later();
    assert.deepStrictEqual(p.reopened, [true]);
});

test('a camera that came back is left alone', () => {
    const p = page();
    p.ctx.checkCameraAfterReturn();
    p.f.drawn += 60;
    p.later();
    assert.deepStrictEqual(p.reopened, []);
});

test('nothing is done once the page is hidden again, or the camera replaced', () => {
    let p = page();
    p.ctx.checkCameraAfterReturn();
    p.ctx.document.visibilityState = 'hidden';
    p.later();
    assert.deepStrictEqual(p.reopened, []);

    p = page();
    p.ctx.checkCameraAfterReturn();
    p.c.userdata.filter = null;
    p.later();
    assert.deepStrictEqual(p.reopened, []);
});

test('a computer, whose camera goes on in the background, is not checked', () => {
    const p = page({phone: false});
    p.ctx.checkCameraAfterReturn();
    p.later();
    assert.deepStrictEqual(p.reopened, []);
});

test('an ended camera is not this case', () => {
    // an ended track closes the stream on its own (upTrackEnded)
    const p = page({live: false});
    p.ctx.checkCameraAfterReturn();
    p.later();
    assert.deepStrictEqual(p.reopened, []);
});
