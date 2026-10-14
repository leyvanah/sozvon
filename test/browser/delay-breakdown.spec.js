// The browser reports what each playout delay is made of, and the client
// reads it.  (Sozvon)
//
// On 2026-10-14 a call held its audio 300 ms behind on a clean network --
// 15-30 ms of arrival jitter, no loss -- and cutting the video to the floor
// did not shorten it.  Where the 300 ms came from the log could not say.
// The jitter buffer's target and minimum delay split it: the minimum is
// what the arrival jitter needs, target minus minimum what audio/video
// synchronisation adds, delay minus target a backlog not yet played out.
//
// They are only worth logging if the browser fills them in.  A field it
// does not report reads as null, and a log full of nulls would look like
// evidence while being none -- so this checks, in a real Chromium, with and
// without end-to-end encryption, that every figure arrives and is sane.  It
// prints them too: a local baseline to set a real call against.

import {test, expect} from '@playwright/test';
import {chooseDevices} from './lib.js';

test.afterEach(async ({browser}) => {
    for (const c of browser.contexts())
        await c.close();
});

async function join(context, room, name) {
    const page = await context.newPage();
    page.errors = [];
    page.on('pageerror', e => page.errors.push(String(e)));
    // every quality report the client sends, as the server would get it
    await page.addInitScript(() => {
        window.qualityReports = [];
    });
    await page.goto(`/group/${room}/`);
    await page.waitForSelector('#username', {state: 'visible'});
    await page.fill('#username', name);
    if (await page.locator('#password').isVisible())
        await page.fill('#password', 'x');
    await chooseDevices(page);
    await page.click('#connectbutton');
    await page.waitForFunction(() => typeof serverConnection !== 'undefined' &&
                               !!serverConnection && !!serverConnection.socket);
    await page.evaluate(() => {
        const send = serverConnection.send.bind(serverConnection);
        serverConnection.send = m => {
            if (m && m.type === 'sozvon-quality')
                window.qualityReports.push(m);
            return send(m);
        };
    });
    await expect.poll(async () => await page.locator('#peers video').count(),
                      {timeout: 30_000}).toBeGreaterThan(0);
    return page;
}

/**
 * One interval of Bob's camera stream from Alice, judged by the same code
 * the controller uses, on the browser's own statistics.
 */
const interval = (B, seconds) => B.evaluate(async seconds => {
    const S = window.SozvonBitrate;
    let c = null;
    for (const id in serverConnection.down)
        if (serverConnection.down[id].label === 'camera')
            c = serverConnection.down[id];
    if (!c)
        return null;
    const first = S.snapshot((await c.pc.getStats()).values(), Date.now());
    await new Promise(r => setTimeout(r, seconds * 1000));
    const last = S.snapshot((await c.pc.getStats()).values(), Date.now());
    const r = S.assess(first, last);
    const ms = v => v === null ? null : Math.round(v * 1000);
    return {
        audioDelay: ms(r.audioDelay), audioTarget: ms(r.audioTarget),
        audioMinimum: ms(r.audioMinimum),
        videoDelay: ms(r.videoDelay), videoTarget: ms(r.videoTarget),
        videoMinimum: ms(r.videoMinimum),
        jitter: ms(r.jitter), processing: ms(r.processing),
        decode: Math.round(r.decode * 10000) / 10,
        fps: Math.round(r.fps),
    };
}, seconds);

for (const room of ['smoke', 'e2ee-strict']) {
    test(`every part of the playout delay is reported (${room})`,
         async ({browser}) => {
        const A = await join(await browser.newContext(), room, 'alice');
        const B = await join(await browser.newContext(), room, 'bob');
        if (room === 'e2ee-strict')
            for (const p of [A, B])
                await expect.poll(() => p.evaluate(() =>
                    serverConnection.e2ee && serverConnection.e2ee.state),
                    {timeout: 30_000}).toBe('established');

        // past the controller's warm-up, with the buffers settled
        await B.waitForTimeout(15_000);
        const r = await interval(B, 10);
        console.log(`${room}: ${JSON.stringify(r)}`);

        expect(r, 'Bob receives a camera').not.toBeNull();
        expect(r.fps, 'frames are decoded').toBeGreaterThan(0);
        for (const k of ['audioTarget', 'audioMinimum',
                         'videoTarget', 'videoMinimum'])
            expect(r[k], `${k} is reported`).not.toBeNull();
        // the minimum ignores synchronisation, the target does not
        expect(r.audioMinimum).toBeLessThanOrEqual(r.audioTarget + 1);
        expect(r.videoMinimum).toBeLessThanOrEqual(r.videoTarget + 1);
        // decoding alone is part of the time from first packet to decoded
        expect(r.decode).toBeGreaterThan(0);
        expect(r.decode).toBeLessThanOrEqual(r.processing);

        // and the client hands them to the server with a cap it asks for
        const asked = await B.evaluate(() => window.qualityReports
            .filter(m => m.kind === 'ask').map(m => Object.keys(m.value)));
        expect(asked.length, 'the start cap was asked for').toBeGreaterThan(0);
        for (const k of ['audioTarget', 'audioMinimum', 'videoTarget',
                         'videoMinimum', 'decode'])
            expect(asked[0]).toContain(k);

        expect(A.errors).toEqual([]);
        expect(B.errors).toEqual([]);
    });
}
