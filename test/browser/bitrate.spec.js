// Adaptive video bitrate (leyvanah/sozvon-tasks#29).
//
// Lag cannot be produced on demand on one laptop, so bob's statistics are
// doctored: getStats() adds window.__lag seconds to every audio sample's
// jitter-buffer delay.  Everything else is real -- bob's controller, the user
// message through the server, alice's registry and setParameters() on her
// actual video sender -- and the test reads the result off alice's sender.

import {test, expect} from '@playwright/test';
import {chooseDevices} from './lib.js';

// Contexts made with browser.newContext() outlive a failed or skipped test,
// and every spec joins the same room: a leftover participant turns the next
// test's one remote tile into three.  Close them whatever happened.
test.afterEach(async ({browser}) => {
    for (const c of browser.contexts())
        await c.close();
});

const ROOM = process.env.SOZVON_ROOM || 'smoke';
const UNLIMITED = 1000000000;

async function join(context, name) {
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    page.errors = errors;
    page.logs = [];
    page.on('console', m => {
        if(m.text().startsWith('bitrate:'))
            { page.logs.push(m.text()); if(process.env.BITRATE_TRACE) console.log(name, m.text()); }
    });
    await page.addInitScript(() => {
        window.__lag = 0;
        const orig = RTCPeerConnection.prototype.getStats;
        RTCPeerConnection.prototype.getStats = async function(...args) {
            const report = await orig.apply(this, args);
            if(args.length)
                return report;
            this.__extra = this.__extra || {};
            const out = new Map();
            for(const [k, r] of report) {
                if(r.type === 'inbound-rtp' && r.kind === 'audio') {
                    // Accumulate, so the per-interval average moves by
                    // exactly __lag while it is set.
                    const n = r.jitterBufferEmittedCount || 0;
                    const e = this.__extra[k] ||
                        (this.__extra[k] = {extra: 0, n});
                    e.extra += (n - e.n) * window.__lag;
                    e.n = n;
                    out.set(k, {...r, jitterBufferDelay:
                        (r.jitterBufferDelay || 0) + e.extra});
                } else {
                    out.set(k, r);
                }
            }
            return out;
        };
    });
    await page.goto(`/group/${ROOM}/`);
    await page.waitForSelector('#username', {state: 'visible'});
    await page.fill('#username', name);
    if (await page.locator('#password').isVisible())
        await page.fill('#password', 'x');
    await chooseDevices(page);
    await page.click('#connectbutton');
    await expect.poll(async () => await page.locator('#peers video').count(),
                      {timeout: 30_000}).toBeGreaterThan(0);
    return page;
}

/** maxBitrate on alice's camera sender, as the browser holds it. */
async function sendCap(page) {
    return await page.evaluate(() => {
        for(const id in serverConnection.up) {
            const c = serverConnection.up[id];
            for(const s of c.pc.getSenders()) {
                if(s.track && s.track.kind === 'video') {
                    const e = s.getParameters().encodings;
                    return e && e[0] ? e[0].maxBitrate : null;
                }
            }
        }
        return null;
    });
}

test('lag at the receiver caps the sender, recovery lifts the cap', async ({browser}) => {
    test.setTimeout(360_000);
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    for (const c of [ctxA, ctxB])
        await c.grantPermissions(['camera', 'microphone']);

    const A = await join(ctxA, 'alice');
    const B = await join(ctxB, 'bob');
    await expect.poll(async () => await B.locator('#peers video').count(),
                      {timeout: 30_000}).toBe(2);

    // A new stream starts capped: bob asks for the start cap as soon as
    // video arrives, and alice applies it although it reaches her before
    // her own first poll of the stream.
    const START = await A.evaluate(() => SozvonBitrate.START_CAP);
    expect(START, 'bitrate-control.js exports START_CAP').toBeGreaterThan(0);
    await expect.poll(() => sendCap(A), {timeout: 15_000}).toBe(START);

    // The controller acts on real lag too, so the scenario needs a receiver
    // that plays audio on time before any lag is injected.  Measured over
    // successive 3 s windows: on a loaded machine the jitter buffer runs long
    // for a while after the call starts and then settles, and a single early
    // sample used to read that as "this machine lags" -- or, before any audio
    // had played at all, as null -- and skip.  Audio that never plays is a
    // failure, not a reason to skip; lag that never settles is the one honest
    // skip left, and it names the figure.
    const audioDelay = () => B.evaluate(async () => {
        const read = async () => {
            let d = 0, n = 0;
            for (const id in serverConnection.down) {
                const r = await serverConnection.down[id].pc.getStats();
                for (const x of r.values())
                    if (x.type === 'inbound-rtp' && x.kind === 'audio') {
                        d += x.jitterBufferDelay; n += x.jitterBufferEmittedCount;
                    }
            }
            return {d, n};
        };
        const a = await read();
        await new Promise(r => setTimeout(r, 3000));
        const b = await read();
        return b.n > a.n ? (b.d - a.d) / (b.n - a.n) : null;
    });
    let baseline = null;
    const settle = Date.now() + 45_000;
    do {
        baseline = await audioDelay();
        console.log('baseline audio delay', baseline);
    } while ((baseline === null || baseline > 0.12) && Date.now() < settle);
    expect(baseline, 'bob never played any of alice\'s audio').not.toBeNull();
    test.skip(baseline > 0.12,
              `receiver still lags ${baseline.toFixed(3)} s after 45 s ` +
              'with no lag injected; the machine is too busy for this test');

    // Healthy: nothing is tightened below the start cap.  Real lag while the
    // call was settling may have tightened it for a while; a healthy
    // receiver lets it back up, and that recovery is part of what is tested.
    await expect.poll(() => sendCap(A), {timeout: 60_000})
        .toBeGreaterThanOrEqual(START);
    const before = await sendCap(A);

    // Bob's audio starts lagging half a second.
    await B.evaluate(() => { window.__lag = 0.5; });
    await expect.poll(() => sendCap(A), {timeout: 20_000})
        .toBeLessThan(before);
    const capped = await sendCap(A);
    console.log('capped at', capped);
    expect(capped).toBeGreaterThanOrEqual(150000);

    // Lag gone: the cap starts rising.  Lifting it entirely takes a minute
    // or more and is covered by static/test/bitrate-control.test.js; set
    // SOZVON_FULL_BITRATE=1 to watch it happen here too.
    await B.evaluate(() => { window.__lag = 0; });
    await expect.poll(() => sendCap(A), {timeout: 30_000})
        .toBeGreaterThan(capped);
    if(process.env.SOZVON_FULL_BITRATE)
        await expect.poll(() => sendCap(A),
                          {timeout: 240_000, intervals: [2000]})
            .toBe(UNLIMITED);

    console.log('bob:', B.logs.join('\n  '));
    console.log('alice:', A.logs.join('\n  '));
    expect(A.errors).toEqual([]);
    expect(B.errors).toEqual([]);
    await ctxA.close();
    await ctxB.close();
});
