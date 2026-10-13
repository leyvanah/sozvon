// A camera at its bitrate ceiling delivers the same picture as one with no
// cap at all.  (Sozvon, leyvanah/sozvon-tasks#65)
//
// Lifted entirely, a sender's browser pushed a camera to 7-10 Mbit/s on
// 2026-10-13, and the receiver's audio broke up 14 times in an hour.  Now a
// camera rises to a ceiling set by the picture it shows and stays there.
// The promise that goes with it: the picture does not suffer.  So Bob
// receives Alice's camera at the ceiling and then with no cap, and the two
// must match -- the size she captures, and the frame rate her browser sends.

import {test, expect} from '@playwright/test';
import {chooseDevices} from './lib.js';

test.afterEach(async ({browser}) => {
    for (const c of browser.contexts())
        await c.close();
});

const ROOM = process.env.SOZVON_ROOM || 'smoke';

async function join(context, name) {
    const page = await context.newPage();
    page.errors = [];
    page.on('pageerror', e => page.errors.push(String(e)));
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

/** Bob's controller for Alice's camera: its cap and its ceiling. */
const control = B => B.evaluate(() => {
    for (const id in serverConnection.down) {
        const c = serverConnection.down[id];
        const ctl = c.userdata.bitrate;
        if (c.label === 'camera' && ctl)
            return {cap: ctl.cap, ceiling: ctl.ceiling()};
    }
    return null;
});

/** maxBitrate on Alice's camera sender. */
const sendCap = A => A.evaluate(() => {
    for (const id in serverConnection.up) {
        const c = serverConnection.up[id];
        if (c.label !== 'camera')
            continue;
        for (const s of c.pc.getSenders())
            if (s.track && s.track.kind === 'video') {
                const e = s.getParameters().encodings;
                return e && e[0] ? e[0].maxBitrate ?? null : null;
            }
    }
    return null;
});

/** What Alice captures. */
const captured = A => A.evaluate(() => {
    for (const id in serverConnection.up) {
        const c = serverConnection.up[id];
        if (c.label !== 'camera')
            continue;
        const t = c.stream.getVideoTracks()[0];
        const s = t.getSettings();
        return {width: s.width, height: s.height, fps: s.frameRate};
    }
    return null;
});

/**
 * Over a few seconds: the picture Bob receives (size, decoded frame rate,
 * rate) and the frame rate Alice's browser sends.
 */
async function measure(A, B, seconds = 10) {
    const sent = () => A.evaluate(async () => {
        for (const id in serverConnection.up) {
            const c = serverConnection.up[id];
            if (c.label !== 'camera')
                continue;
            let frames = 0;
            (await c.pc.getStats()).forEach(r => {
                if (r.type === 'outbound-rtp' && r.kind === 'video')
                    frames += r.framesEncoded || 0;
            });
            return frames;
        }
        return 0;
    });
    const got = () => B.evaluate(async () => {
        for (const id in serverConnection.down) {
            const c = serverConnection.down[id];
            if (c.label !== 'camera')
                continue;
            let r = {frames: 0, bytes: 0, width: 0, height: 0};
            (await c.pc.getStats()).forEach(x => {
                if (x.type === 'inbound-rtp' && x.kind === 'video') {
                    r.frames += x.framesDecoded || 0;
                    r.bytes += x.bytesReceived || 0;
                    r.width = Math.max(r.width, x.frameWidth || 0);
                    r.height = Math.max(r.height, x.frameHeight || 0);
                }
            });
            return r;
        }
        return null;
    });
    const s0 = await sent(), g0 = await got(), t0 = Date.now();
    await new Promise(r => setTimeout(r, seconds * 1000));
    const s1 = await sent(), g1 = await got();
    const dt = (Date.now() - t0) / 1000;
    return {
        width: g1.width, height: g1.height,
        fps: (g1.frames - g0.frames) / dt,
        sentFps: (s1 - s0) / dt,
        kbps: Math.round((g1.bytes - g0.bytes) * 8 / dt / 1000),
    };
}

test('a camera at its ceiling delivers the same picture as with no cap',
     async ({browser}) => {
    test.setTimeout(360_000);
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    for (const c of [ctxA, ctxB])
        await c.grantPermissions(['camera', 'microphone']);
    const A = await join(ctxA, 'alice');
    const B = await join(ctxB, 'bob');
    await expect.poll(async () => await B.locator('#peers video').count(),
                      {timeout: 30_000}).toBe(2);

    // Bob's controller raises Alice's camera to its ceiling, and no further.
    await expect.poll(async () => {
        const c = await control(B);
        return c && c.cap !== null && c.cap === c.ceiling;
    }, {timeout: 240_000, intervals: [2000]}).toBe(true);
    const {ceiling} = await control(B);
    await expect.poll(() => sendCap(A), {timeout: 20_000}).toBe(ceiling);
    const cam = await captured(A);
    console.log('captured', cam, 'ceiling', ceiling);

    const atCeiling = await measure(A, B);
    console.log('at the ceiling', atCeiling);

    // Now with no cap at all: Bob lets go and stops judging.
    await B.evaluate(() => {
        for (const id in serverConnection.down) {
            const c = serverConnection.down[id];
            if (c.label === 'camera' && c.userdata.bitrate) {
                c.userdata.bitrate.camera = false;
                c.userdata.bitrate.update = function() {
                    return {cap: null, changed: false, send: false,
                            sample: null};
                };
                releaseBitrateCap(c);
            }
        }
    });
    await expect.poll(() => sendCap(A), {timeout: 20_000})
        .toBeGreaterThan(ceiling);
    // let the sender's own rate climb past the ceiling before measuring
    await new Promise(r => setTimeout(r, 15_000));
    const free = await measure(A, B);
    console.log('with no cap', free);

    // The same picture: the size Alice captures, both ways ...
    for (const m of [atCeiling, free]) {
        expect(m.height, 'full height').toBe(cam.height);
        expect(m.width, 'full width').toBe(cam.width);
    }
    // ... and every frame her browser sends, both ways.
    for (const m of [atCeiling, free])
        expect(m.fps, 'frames received per frame sent')
            .toBeGreaterThan(0.9 * m.sentFps);
    expect(atCeiling.fps, 'as many frames as with no cap')
        .toBeGreaterThan(0.9 * free.fps);
    expect(atCeiling.kbps, 'the ceiling holds').toBeLessThanOrEqual(
        Math.ceil(ceiling / 1000 * 1.15));

    expect(A.errors).toEqual([]);
    expect(B.errors).toEqual([]);
});
