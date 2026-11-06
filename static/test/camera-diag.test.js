// Tests for the camera check.  (Sozvon)
//
// Run with:  node --test static/test/
//
// camera-diag.js turns what galene.js reads from the browser into one report
// for the connection log.  Two things matter: a counter the browser does not
// report must stay null -- a zero there would point at the wrong step -- and
// nothing but fixed words, booleans and numbers may go out, the platform
// least of all.  Reading the real browser is test/browser/camera-check.spec.js.

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const d = require('../camera-diag.js');

const UA = {
    androidChrome: 'Mozilla/5.0 (Linux; Android 14; Pixel 7) ' +
        'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 ' +
        'Mobile Safari/537.36',
    androidWebView: 'Mozilla/5.0 (Linux; Android 14; Pixel 7; wv) ' +
        'AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 ' +
        'Chrome/141.0.0.0 Mobile Safari/537.36 SozvonApp/0.4.0',
    samsung: 'Mozilla/5.0 (Linux; Android 14; SM-S911B) ' +
        'AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 ' +
        'Chrome/122.0.0.0 Mobile Safari/537.36',
    yandex: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
        'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 ' +
        'YaBrowser/25.8.0.0 Safari/537.36',
    edge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
        'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 ' +
        'Safari/537.36 Edg/141.0.0.0',
    opera: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
        'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 ' +
        'Safari/537.36 OPR/124.0.0.0',
    firefox: 'Mozilla/5.0 (X11; Linux x86_64; rv:144.0) Gecko/20100101 ' +
        'Firefox/144.0',
    iphoneSafari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) ' +
        'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 ' +
        'Mobile/15E148 Safari/604.1',
    iphoneChrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) ' +
        'AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.0.0 ' +
        'Mobile/15E148 Safari/604.1',
    macSafari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) ' +
        'AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 ' +
        'Safari/605.1.15',
};

test('browser family, where every Chromium also says Chrome and Safari', () => {
    assert.strictEqual(d.browserFamily(UA.androidChrome), 'chrome');
    assert.strictEqual(d.browserFamily(UA.androidWebView), 'webview');
    assert.strictEqual(d.browserFamily(UA.samsung), 'samsung');
    assert.strictEqual(d.browserFamily(UA.yandex), 'yandex');
    assert.strictEqual(d.browserFamily(UA.edge), 'edge');
    assert.strictEqual(d.browserFamily(UA.opera), 'opera');
    assert.strictEqual(d.browserFamily(UA.firefox), 'firefox');
    assert.strictEqual(d.browserFamily(UA.iphoneSafari), 'safari');
    assert.strictEqual(d.browserFamily(UA.iphoneChrome), 'chrome');
    assert.strictEqual(d.browserFamily(UA.macSafari), 'safari');
    assert.strictEqual(d.browserFamily(''), 'other');
    assert.strictEqual(d.browserFamily(undefined), 'other');
    for(let ua of Object.values(UA))
        assert.ok(d.BROWSERS.indexOf(d.browserFamily(ua)) >= 0);
});

test('sender counters are summed over encodings, audio is ignored', () => {
    let s = d.senderStats([
        {type: 'media-source', kind: 'audio', audioLevel: 0.1},
        {type: 'media-source', kind: 'video', frames: 180},
        {type: 'outbound-rtp', kind: 'audio', packetsSent: 300},
        {type: 'outbound-rtp', kind: 'video', framesEncoded: 170,
         packetsSent: 800, qualityLimitationReason: 'none'},
        {type: 'outbound-rtp', kind: 'video', framesEncoded: 90,
         packetsSent: 100, qualityLimitationReason: 'bandwidth'},
    ]);
    assert.deepStrictEqual(s, {source: 180, encoded: 260, sent: 900,
                               limit: 'bandwidth'});
});

test('a counter the browser does not report stays null, not zero', () => {
    // no video sender in the report at all: a transceiver never negotiated
    assert.deepStrictEqual(d.senderStats([]),
                           {source: null, encoded: null, sent: null,
                            limit: null});
    // an older browser without media-source frames; mediaType is the old
    // name of kind
    assert.deepStrictEqual(
        d.senderStats([
            {type: 'media-source', kind: 'video', width: 640},
            {type: 'outbound-rtp', mediaType: 'video', framesEncoded: 0,
             packetsSent: 0, qualityLimitationReason: 'thermal'},
        ]),
        {source: null, encoded: 0, sent: 0, limit: 'other'});
});

function base(over) {
    return Object.assign({
        platform: {os: 'ios', app: null},
        ua: UA.iphoneSafari,
        touch: true,
        canvas: 'orientation',
        track: {readyState: 'live', muted: false, enabled: true,
                settings: {width: 640, height: 480, frameRate: 30},
                delivered: undefined},
        element: {paused: true, readyState: 0, videoWidth: 0,
                  videoHeight: 0, play: 'NotAllowedError', drawn: 0},
        sender: {source: 0, encoded: 0, sent: 0, limit: 'none'},
        preview: 0,
        after: 6012,
    }, over);
}

test('a report names each step of the chain', () => {
    assert.deepStrictEqual(d.report(base()), {
        after: 6, os: 'ios', app: null, browser: 'safari', touch: true,
        canvas: 'orientation', track: 'live', muted: false, enabled: true,
        width: 640, height: 480, fps: 30, delivered: null,
        paused: true, ready: 0, elementWidth: 0, elementHeight: 0,
        play: 'NotAllowedError', drawn: 0,
        source: 0, encoded: 0, sent: 0, limit: 'none', preview: 0,
    });
});

test('with no canvas there is no element to report', () => {
    let r = d.report(base({canvas: 'none'}));
    for(let k of ['paused', 'ready', 'elementWidth', 'elementHeight',
                  'play', 'drawn'])
        assert.strictEqual(r[k], null, k);
});

test('only fixed words, booleans, numbers and nulls go out', () => {
    let r = d.report(base({
        platform: {os: 'ios', app: 'android'},
        ua: UA.androidWebView,
        canvas: '<b>',
        track: {readyState: 'weird', muted: 1, enabled: 0,
                settings: {width: -5, height: NaN, frameRate: Infinity,
                           deviceId: 'abcdef', groupId: 'xyz'},
                delivered: 12.6},
        element: {paused: 0, readyState: 9, videoWidth: 'w',
                  videoHeight: 2, play: 'SecurityError: details', drawn: 3},
        preview: 'many',
    }));
    // the device's ids and the user agent never leave
    let text = JSON.stringify(r);
    assert.ok(!/abcdef|xyz|Mozilla|SozvonApp/.test(text), text);
    assert.strictEqual(r.canvas, 'none');
    assert.strictEqual(r.track, 'live');
    assert.strictEqual(r.muted, true);
    assert.strictEqual(r.enabled, false);
    assert.strictEqual(r.width, null);
    assert.strictEqual(r.height, null);
    assert.strictEqual(r.fps, null);
    assert.strictEqual(r.delivered, 13);
    assert.strictEqual(r.preview, null);
    // canvas fell back to none, so the element is not reported
    assert.strictEqual(r.play, null);

    let e = d.report(base({
        element: {paused: 0, readyState: 9, videoWidth: 'w',
                  videoHeight: 2, play: 'SecurityError: details', drawn: 3},
    }));
    assert.strictEqual(e.paused, false);
    assert.strictEqual(e.ready, 4);
    assert.strictEqual(e.elementWidth, null);
    assert.strictEqual(e.play, 'error');
    for(let [k, v] of Object.entries(e)) {
        let ok = v === null || typeof v === 'boolean' ||
            typeof v === 'number' ||
            (typeof v === 'string' && /^[A-Za-z]+$/.test(v));
        assert.ok(ok, k + ' = ' + JSON.stringify(v));
    }
});
