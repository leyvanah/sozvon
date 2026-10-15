// A change to the sound alone never reopens the camera.  (Sozvon)
//
// Turning the microphone on is meant to add it to the stream already up
// (mic-in-place.spec.js).  When that cannot be done the stream is published
// again -- and that used to close the camera and open it anew: a gap in the
// picture at best, and on 2026-10-14 a guest whose camera came back white and
// stayed white.  The same reopening happened on every change of microphone
// or of the audio settings.  Now the running camera track is carried over to
// the new stream.
//
// Run in the plain room and, with SOZVON_E2EE_ROOM set, in an encrypted one.

import {test, expect} from '@playwright/test';

test.afterEach(async ({browser}) => {
    for (const c of browser.contexts())
        await c.close();
});

const ROOMS = [process.env.SOZVON_ROOM || 'smoke'];
if (process.env.SOZVON_E2EE_ROOM)
    ROOMS.push(process.env.SOZVON_E2EE_ROOM);

async function join(context, room, name, mic) {
    const page = await context.newPage();
    page.errors = [];
    page.on('pageerror', e => page.errors.push(String(e)));
    await page.goto(`/group/${room}/`);
    await page.fill('#username', name);
    if (await page.locator('#password').isVisible())
        await page.fill('#password', 'x');
    await page.click('#precheck-cam');
    await expect(page.locator('#precheck-cam')).toHaveAttribute('aria-pressed', 'true', {timeout: 45_000});
    if (mic) {
        await page.click('#precheck-mic');
        await expect(page.locator('#precheck-mic')).toHaveAttribute('aria-pressed', 'true', {timeout: 45_000});
    }
    await page.click('#connectbutton');
    await expect.poll(async () => await page.locator('#peers video').count(),
                      {timeout: 30_000}).toBeGreaterThan(0);
    return page;
}

/** Alice's outgoing camera stream, and the camera track under any filter. */
const upCamera = page => page.evaluate(() => {
    const ups = Object.values(serverConnection.up)
        .filter(c => c.label === 'camera');
    return ups.map(c => {
        const f = c.userdata.filter;
        const raw = f && f.inputStream ? f.inputStream : c.stream;
        const v = raw.getVideoTracks()[0];
        return {
            id: c.id,
            audio: c.stream.getAudioTracks().filter(t => t.readyState === 'live').length,
            camera: v ? v.id : null,
            live: v ? v.readyState === 'live' : false,
        };
    });
});

/** Frames Bob has decoded from Alice, in whatever element shows her now. */
const framesSeen = page => page.evaluate(() => {
    const v = document.querySelector('#peers .peer-remote video.media');
    return v && v.getVideoPlaybackQuality ?
        v.getVideoPlaybackQuality().totalVideoFrames : 0;
});

async function call(browser, room, aliceMic) {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    for (const c of [ctxA, ctxB])
        await c.grantPermissions(['camera', 'microphone']);
    const A = await join(ctxA, room, 'alice', aliceMic);
    const B = await join(ctxB, room, 'bob', true);
    await expect.poll(() => framesSeen(B), {timeout: 30_000}).toBeGreaterThan(0);
    if (room === process.env.SOZVON_E2EE_ROOM)
        for (const p of [A, B])
            await expect.poll(() => p.evaluate(() =>
                serverConnection.e2ee && serverConnection.e2ee.state),
                {timeout: 20_000}).toBe('established');
    return {A, B};
}

/** The picture goes on: Bob decodes new frames of Alice, more than once. */
async function pictureFlows(B) {
    const f0 = await framesSeen(B);
    await expect.poll(() => framesSeen(B), {timeout: 20_000}).toBeGreaterThan(f0);
    const f1 = await framesSeen(B);
    await B.waitForTimeout(2000);
    expect(await framesSeen(B)).toBeGreaterThan(f1);
}

for (const room of ROOMS) {
    test(`a microphone that cannot be added in place keeps the camera (${room})`, async ({browser}) => {
        const {A, B} = await call(browser, room, false);
        const before = await upCamera(A);
        expect(before).toHaveLength(1);
        expect(before[0].audio).toBe(0);
        expect(before[0].live).toBe(true);

        // The next audio transceiver fails, as in a browser that will not
        // add a track to a connection already up.
        await A.evaluate(() => {
            const add = RTCPeerConnection.prototype.addTransceiver;
            let fail = true;
            RTCPeerConnection.prototype.addTransceiver = function(t, ...rest) {
                const kind = typeof t === 'string' ? t : t.kind;
                if (fail && kind === 'audio') {
                    fail = false;
                    throw new Error('test: addTransceiver refused');
                }
                return add.call(this, t, ...rest);
            };
        });
        await A.evaluate(() => document.getElementById('mutebutton').click());

        // Republished with the microphone ...
        await expect.poll(async () => {
            const u = await upCamera(A);
            return u.length === 1 && u[0].id !== before[0].id && u[0].audio === 1;
        }, {timeout: 20_000}).toBe(true);
        // ... and the very same camera track, still running.
        const after = await upCamera(A);
        expect(after[0].camera).toBe(before[0].camera);
        expect(after[0].live).toBe(true);
        await pictureFlows(B);

        expect(A.errors).toEqual([]);
        expect(B.errors).toEqual([]);
    });

    test(`changing the audio settings keeps the camera (${room})`, async ({browser}) => {
        const {A, B} = await call(browser, room, true);
        const before = await upCamera(A);
        expect(before).toHaveLength(1);
        expect(before[0].audio).toBe(1);

        // High-quality audio republishes the stream with a new microphone.
        await A.evaluate(() => {
            const box = document.getElementById('hqaudiobox');
            box.checked = !box.checked;
            box.dispatchEvent(new Event('change'));
        });

        await expect.poll(async () => {
            const u = await upCamera(A);
            return u.length === 1 && u[0].id !== before[0].id && u[0].audio === 1;
        }, {timeout: 20_000}).toBe(true);
        const after = await upCamera(A);
        expect(after[0].camera).toBe(before[0].camera);
        expect(after[0].live).toBe(true);
        await pictureFlows(B);

        expect(A.errors).toEqual([]);
        expect(B.errors).toEqual([]);
    });
}
