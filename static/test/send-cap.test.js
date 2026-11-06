// A send cap counts as applied only once the browser has taken it.  (Sozvon)
//
// Run with:  node --test static/test/
//
// applySendCap remembers the cap it last applied to an up stream, so that a
// poll with nothing new does not touch the sender.  It used to remember the
// cap before setParameters had run; when Chrome refused that call (an
// InvalidStateError, seen on CI), every later poll found the cap already
// "applied" and left the stream without one for the rest of the call.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const staticDir = path.join(__dirname, '..');

/** The source of a top-level function of a static file, as in e2ee-policy. */
function liftFunction(file, name) {
    const src = fs.readFileSync(path.join(staticDir, file), 'utf8');
    let start = src.indexOf('function ' + name + '(');
    assert.notStrictEqual(start, -1, `${file} no longer declares ${name}()`);
    if(src.slice(start - 6, start) === 'async ')
        start -= 6;
    const end = src.indexOf('\n}\n', start);
    assert.ok(end > start, `${name}() in ${file} does not end at column 0`);
    return src.slice(start, end + 3);
}

/**
 * applySendCap with everything it calls replaced: the cap it computes is
 * whatever `cap` holds, and setSendParameters fails as often as `refusals`
 * says before it succeeds.
 */
function harness() {
    const ctx = vm.createContext({
        console: {info() {}, warn() {}},
        cap: 300000,
        refusals: 0,
        applied: [],
        reported: [],
        doSimulcast: () => false,
        getMaxVideoThroughput: () => 700000,
        reportQuality: (kind, id, value) => ctx.reported.push(value.cap),
    });
    ctx.autoThroughput = () => ctx.cap;
    ctx.setSendParameters = async (c, t) => {
        if(ctx.refusals > 0) {
            ctx.refusals--;
            throw new Error("InvalidStateError: Failed to set parameters since getParameters() has never been called on this sender");
        }
        ctx.applied.push(t);
    };
    vm.runInContext(liftFunction('galene.js', 'applySendCap'), ctx);
    return ctx;
}

const stream = () => ({id: 'up1', pc: {}, userdata: {}});

test('a cap the browser refused is tried again on the next poll', async () => {
    const ctx = harness();
    const c = stream();
    ctx.refusals = 1;
    await assert.rejects(ctx.applySendCap(c));
    assert.deepStrictEqual(ctx.applied, []);
    await ctx.applySendCap(c);
    assert.deepStrictEqual(ctx.applied, [300000],
        'the refused cap was taken as applied and never set');
});

test('a cap that was applied is not set again', async () => {
    const ctx = harness();
    const c = stream();
    await ctx.applySendCap(c);
    await ctx.applySendCap(c);
    assert.deepStrictEqual(ctx.applied, [300000]);
    ctx.cap = 500000;
    await ctx.applySendCap(c);
    assert.deepStrictEqual(ctx.applied, [300000, 500000]);
});

test('only a cap that was applied is reported to the server', async () => {
    const ctx = harness();
    const c = stream();
    ctx.refusals = 1;
    await assert.rejects(ctx.applySendCap(c));
    assert.deepStrictEqual(ctx.reported, [],
        'the server log says the stream is capped when it is not');
    await ctx.applySendCap(c);
    assert.deepStrictEqual(ctx.reported, [300000]);
});
