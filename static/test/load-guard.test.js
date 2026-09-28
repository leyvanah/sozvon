// Tests for the page-load guard.  (Sozvon)
//
// Run with:  node --test static/test/
//
// load-guard.js decides when the loading spinner may give way to the page.
// It replaced a ten-second timer that uncovered the page whatever state it
// was in, which on 2026-09-28 showed a client a page without galene.css: every
// hidden notice at once, "this browser does not support video calls" among
// them.  The DOM plumbing needs a browser; the judgement is here.

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const g = require('../load-guard.js');

/** A state with sensible defaults: page still loading, nothing wrong yet. */
function state(extra) {
    return Object.assign({loaded: false, ready: false, failed: 0,
                          elapsed: 0, reloads: 0}, extra);
}

test('a page that loaded and works is shown', () => {
    assert.strictEqual(g.decide(state({loaded: true, ready: true})), 'show');
});

test('the incident: loaded but galene.css never applied is not shown', () => {
    // 'load' fires even when a stylesheet failed; that alone is no licence.
    assert.strictEqual(g.decide(state({loaded: true, ready: false})),
                       'reload');
    assert.strictEqual(g.decide(state({loaded: true, ready: false,
                                       reloads: g.MAX_AUTO_RELOADS})),
                       'fail');
});

test('the old ten-second timer no longer uncovers a broken page', () => {
    for(const elapsed of [g.SLOW_AFTER, g.OFFER_RELOAD_AFTER, 120000]) {
        const a = g.decide(state({ready: false, elapsed}));
        assert.notStrictEqual(a, 'show', `at ${elapsed} ms`);
    }
});

test('a slow page says so, then offers a reload, and keeps waiting', () => {
    assert.strictEqual(g.decide(state({elapsed: 1000})), 'wait');
    assert.strictEqual(g.decide(state({elapsed: g.SLOW_AFTER})), 'slow');
    assert.strictEqual(g.decide(state({elapsed: g.OFFER_RELOAD_AFTER})),
                       'slow-offer');
});

test('essentials in place: a straggling font does not hold the page', () => {
    // Before SLOW_AFTER it waits for 'load' as the old code did, so the
    // page does not flash in before its icons on a normal connection.
    assert.strictEqual(g.decide(state({ready: true, elapsed: 2000})), 'wait');
    assert.strictEqual(g.decide(state({ready: true,
                                       elapsed: g.SLOW_AFTER})), 'show');
});

test('a failed stylesheet or script reloads, a bounded number of times', () => {
    for(let r = 0; r < g.MAX_AUTO_RELOADS; r++)
        assert.strictEqual(g.decide(state({failed: 1, reloads: r})),
                           'reload');
    assert.strictEqual(g.decide(state({failed: 1,
                                       reloads: g.MAX_AUTO_RELOADS})),
                       'fail');
});

test('out of retries, a page that works is shown despite a lost file', () => {
    // A file gone for good (a theme asset, the icon font) must not lock
    // everyone out; only a page that does not work is withheld.
    assert.strictEqual(g.decide(state({loaded: true, ready: true, failed: 1,
                                       reloads: g.MAX_AUTO_RELOADS})),
                       'show');
});
