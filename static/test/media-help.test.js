// Tests for the advice shown when the camera or microphone is refused.  (Sozvon)
//
// Run with:  node --test static/test/
//
// What can go wrong quietly here is the choice of message: the overlay advice
// missing on the one platform where it is the answer, a blocked site sent to
// press a button that cannot help, and a key built at runtime that no table
// defines -- i18n.test.js only sees keys written out as literals, so this file
// checks the computed ones.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const h = require('../media-help.js');

const UA = {
    androidChrome: 'Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
    androidApp: 'Mozilla/5.0 (Linux; Android 12; SM-S9080 Build/SP1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0.0.0 Mobile Safari/537.36 SozvonApp/0.4.0',
    iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
    ipadDesktop: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
    windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    linux: 'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0',
};

const keys = a => a.steps.map(s => s.key);

test('tells the platforms apart', () => {
    assert.deepStrictEqual(h.detectPlatform({ua: UA.androidChrome}),
                           {os: 'android', app: null});
    assert.deepStrictEqual(h.detectPlatform({ua: UA.androidApp, bridge: true}),
                           {os: 'android', app: 'android'});
    assert.deepStrictEqual(h.detectPlatform({ua: UA.iphone}),
                           {os: 'ios', app: null});
    // an iPad asking for the desktop page
    assert.deepStrictEqual(h.detectPlatform({ua: UA.ipadDesktop, touchPoints: 5}),
                           {os: 'ios', app: null});
    assert.deepStrictEqual(h.detectPlatform({ua: UA.ipadDesktop, touchPoints: 0}),
                           {os: 'mac', app: null});
    assert.deepStrictEqual(h.detectPlatform({ua: UA.windows, bridge: true}),
                           {os: 'windows', app: 'desktop'});
    assert.deepStrictEqual(h.detectPlatform({ua: UA.linux}),
                           {os: 'other', app: null});
});

test('one blocked device makes the request blocked', () => {
    assert.strictEqual(h.combineStates(['granted', 'denied']), 'denied');
    assert.strictEqual(h.combineStates(['prompt', 'denied']), 'denied');
    assert.strictEqual(h.combineStates(['granted', 'granted']), 'granted');
    assert.strictEqual(h.combineStates(['granted', 'prompt']), null);
    assert.strictEqual(h.combineStates(['granted', null]), null);
    assert.strictEqual(h.combineStates([null]), null);
    assert.strictEqual(h.combineStates([]), null);
});

test('a prompt that never came: Android hears about other apps\' windows', () => {
    let a = h.advice({kind: 'audio', state: null,
                      platform: {os: 'android', app: null}});
    assert.strictEqual(a.title, 'mediaHelp.title.audio');
    assert.strictEqual(a.reason.key, 'mediaHelp.reason.dismissed');
    assert.deepStrictEqual(keys(a), [
        'mediaHelp.step.retryAllow',
        'mediaHelp.step.overlay',
        'mediaHelp.step.orSite',
    ]);
    assert.deepStrictEqual(a.steps[2].params, {
        device: 'mediaHelp.device.audio',
        path: 'mediaHelp.path.android',
    });
});

test('the overlay advice is for Android only', () => {
    for(let os of ['ios', 'windows', 'mac', 'other']) {
        let a = h.advice({kind: 'audio', state: 'prompt',
                          platform: {os: os, app: null}});
        assert.ok(keys(a).indexOf('mediaHelp.step.overlay') < 0, os);
        assert.strictEqual(a.reason.key, 'mediaHelp.reason.dismissed', os);
    }
});

test('a blocked site goes straight to the site settings', () => {
    let a = h.advice({kind: 'both', state: 'denied',
                      platform: {os: 'android', app: null}});
    assert.strictEqual(a.reason.key, 'mediaHelp.reason.blocked');
    assert.deepStrictEqual(keys(a), ['mediaHelp.step.site']);
    assert.deepStrictEqual(a.steps[0].params, {
        device: 'mediaHelp.device.both',
        path: 'mediaHelp.path.android',
    });
    let ios = h.advice({kind: 'video', state: 'denied',
                        platform: {os: 'ios', app: null}});
    assert.strictEqual(ios.steps[0].params.path, 'mediaHelp.path.ios');
    let mac = h.advice({kind: 'video', state: 'denied',
                        platform: {os: 'mac', app: null}});
    assert.strictEqual(mac.steps[0].params.path, 'mediaHelp.path.desktop');
});

test('an allowed site that is still refused points at the system', () => {
    let a = h.advice({kind: 'audio', state: 'granted',
                      platform: {os: 'windows', app: null}});
    assert.strictEqual(a.reason.key, 'mediaHelp.reason.system');
    assert.deepStrictEqual(keys(a), ['mediaHelp.step.system.windows']);
});

test('the apps have no site settings', () => {
    let android = h.advice({kind: 'audio', state: 'denied',
                            platform: {os: 'android', app: 'android'}});
    assert.strictEqual(android.reason.key, 'mediaHelp.reason.app');
    assert.deepStrictEqual(keys(android), [
        'mediaHelp.step.retryAllow',
        'mediaHelp.step.appSettings',
    ]);
    let desktop = h.advice({kind: 'audio', state: null,
                            platform: {os: 'mac', app: 'desktop'}});
    assert.strictEqual(desktop.reason.key, 'mediaHelp.reason.systemApp');
    assert.deepStrictEqual(keys(desktop), ['mediaHelp.step.system.mac']);
});

test('every key the advice can name is in both tables', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'i18n.js'), 'utf8');
    let seen = new Set();
    let note = k => seen.add(k);
    for(let kind of ['audio', 'video', 'both'])
    for(let state of ['denied', 'granted', 'prompt', null])
    for(let os of ['android', 'ios', 'windows', 'mac', 'other'])
    for(let app of [null, 'android', 'desktop']) {
        let a = h.advice({kind, state, platform: {os, app}});
        note(a.title);
        for(let line of [a.reason, ...a.steps]) {
            note(line.key);
            for(let p in line.params || {})
                note(line.params[p]);
        }
    }
    // the card's own button
    note('mediaHelp.retry');
    for(let k of seen) {
        let n = src.split(`'${k}':`).length - 1;
        assert.strictEqual(n, 2, `${k} is defined ${n} times, want en + ru`);
    }
});
