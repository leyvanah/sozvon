// Turning the microphone on mid-call leaves the picture alone.  (Sozvon, tasks#31)
//
// Someone who joined with the microphone off and turned it on in the call
// used to republish the whole camera stream: a new outgoing stream id, a new
// <video> on the other side, a visible jolt, and under E2EE a wait for a
// fresh keyframe.  The microphone is now added to the stream already up.
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

/** Alice's outgoing camera stream: its id and its tracks. */
const upCamera = page => page.evaluate(() => {
    const ups = Object.values(serverConnection.up)
        .filter(c => c.label === 'camera');
    return ups.map(c => ({
        id: c.id,
        audio: c.stream.getAudioTracks().filter(t => t.readyState === 'live').length,
        video: c.stream.getVideoTracks().length,
    }));
});

/** On Bob's side: the remote <video>, tagged so a replacement is visible. */
const remoteVideo = (page, tag) => page.evaluate((tag) => {
    const v = document.querySelector('#peers .peer-remote video.media');
    if (!v)
        return null;
    if (tag)
        v.__tag = tag;
    const s = v.srcObject;
    return {
        tag: v.__tag || null,
        stream: s ? s.id : null,
        audio: s ? s.getAudioTracks().filter(t => t.readyState === 'live').length : 0,
        frames: v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality().totalVideoFrames : null,
    };
}, tag);

/** Bytes of audio Bob has received from everyone, summed over down streams. */
const audioBytesIn = page => page.evaluate(async () => {
    let n = 0;
    for (const id in serverConnection.down) {
        const st = await serverConnection.down[id].pc.getStats();
        st.forEach(r => {
            if (r.type === 'inbound-rtp' && r.kind === 'audio')
                n += r.bytesReceived || 0;
        });
    }
    return n;
});

for (const room of ROOMS) {
    test(`turning the microphone on mid-call keeps the picture (${room})`, async ({browser}) => {
        const ctxA = await browser.newContext();
        const ctxB = await browser.newContext();
        for (const c of [ctxA, ctxB])
            await c.grantPermissions(['camera', 'microphone']);

        const A = await join(ctxA, room, 'alice', false);
        const B = await join(ctxB, room, 'bob', true);

        await expect.poll(async () => (await remoteVideo(B)) &&
                                      (await remoteVideo(B)).frames,
                          {timeout: 30_000}).toBeGreaterThan(0);
        if (room === process.env.SOZVON_E2EE_ROOM)
            for (const p of [A, B])
                await expect.poll(() => p.evaluate(() =>
                    serverConnection.e2ee && serverConnection.e2ee.state),
                    {timeout: 20_000}).toBe('established');
        const before = await upCamera(A);
        expect(before).toHaveLength(1);
        expect(before[0].audio).toBe(0);
        const seen = await remoteVideo(B, 'original');
        expect(seen.audio).toBe(0);

        await A.evaluate(() => document.getElementById('mutebutton').click());

        // Alice sends sound, from the same stream.
        await expect.poll(async () => (await upCamera(A))[0].audio,
                          {timeout: 20_000}).toBe(1);
        const after = await upCamera(A);
        expect(after).toHaveLength(1);
        expect(after[0].id).toBe(before[0].id);

        // Bob hears it, in the element that was already showing her.
        await expect.poll(async () => (await remoteVideo(B)).audio,
                          {timeout: 20_000}).toBe(1);
        const now = await remoteVideo(B);
        expect(now.tag, 'the remote <video> was replaced').toBe('original');
        expect(now.stream).toBe(seen.stream);
        const b0 = await audioBytesIn(B);
        await B.waitForTimeout(2000);
        expect(await audioBytesIn(B)).toBeGreaterThan(b0);
        expect((await remoteVideo(B)).frames).toBeGreaterThan(now.frames);

        // And the microphone button now mutes in place.
        await A.evaluate(() => document.getElementById('mutebutton').click());
        await expect.poll(() => A.evaluate(() => {
            const c = Object.values(serverConnection.up).find(c => c.label === 'camera');
            return c.stream.getAudioTracks()[0].enabled;
        })).toBe(false);
        expect((await upCamera(A))[0].id).toBe(before[0].id);

        expect(A.errors).toEqual([]);
        expect(B.errors).toEqual([]);
    });
}
