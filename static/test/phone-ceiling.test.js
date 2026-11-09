// A phone's camera is held to 2.5 Mbit/s by the phone itself.  (Sozvon)
//
// Run with:  node --test static/test/
//
// On 2026-11-09 a phone cutting its camera to a format captured 1280x960,
// earned the 720p ceiling of 4 Mbit/s, and lost 4-35% of its packets three
// times in an hour as it climbed past 3.5 Mbit/s.  No receiver can tell a
// phone's picture from a computer's, so the sender holds to the ceiling:
// autoThroughput() and setUpStream() in galene.js, through
// withDeviceCeiling().

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const B = require('../bitrate-control.js');

function lift(name) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'galene.js'), 'utf8');
    const start = src.indexOf('function ' + name + '(');
    assert.ok(start >= 0, `galene.js no longer declares ${name}()`);
    const end = src.indexOf('\n}\n', start);
    return src.slice(start, end + 3);
}

function sender({phone, cap = null}) {
    const ctx = vm.createContext({
        bitrateApi: () => B,
        getSendCaps: () => ({get: () => cap}),
        pausesWhenHidden: () => phone,
        Date,
    });
    vm.runInContext(lift('autoThroughput') + lift('withDeviceCeiling'), ctx);
    return ctx;
}

test('a phone camera never sends more than 2.5 Mbit/s', () => {
    const p = sender({phone: true, cap: 4000000});
    assert.strictEqual(p.autoThroughput({label: 'camera', id: 'x'}, null, false),
                       2500000);
    // nor uncapped, nor under simulcast, nor at the start
    assert.strictEqual(sender({phone: true}).autoThroughput(
        {label: 'camera', id: 'x'}, null, false), 2500000);
    assert.strictEqual(p.autoThroughput({label: 'camera', id: 'x'}, null, true),
                       2500000);
    assert.strictEqual(p.withDeviceCeiling({label: 'camera'}, null), 2500000);
});

test('a lower cap or setting still wins on a phone', () => {
    const p = sender({phone: true, cap: 1000000});
    assert.strictEqual(p.autoThroughput({label: 'camera', id: 'x'}, null, false),
                       1000000);
    assert.strictEqual(p.withDeviceCeiling({label: 'camera'}, 700000), 700000);
});

test('a computer, and a phone sharing its screen, keep their own', () => {
    const c = sender({phone: false, cap: 4000000});
    assert.strictEqual(c.autoThroughput({label: 'camera', id: 'x'}, null, false),
                       4000000);
    const p = sender({phone: true, cap: null});
    assert.strictEqual(p.autoThroughput({label: 'screenshare', id: 'x'}, null, false),
                       null);
});
