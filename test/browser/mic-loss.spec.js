// A microphone that drops out mid-call comes back, and the picture never goes.
// (Sozvon)
//
// It used to close the whole camera stream: the other side lost video along
// with the sound, and nothing returned until the user pressed the microphone
// button.  Now the stream stays up, the microphone is reopened and swapped in
// with replaceTrack -- the same up and down connections throughout, so no
// renegotiation and no new relay allocation.
//
// A real device cannot be unplugged from a test, so the loss is staged the
// way the browser reports it: the track is stopped and 'ended' is fired on
// it.  (track.stop() alone fires nothing, which is exactly how our own
// teardown tells itself apart from a real loss.)

import {test, expect} from '@playwright/test';

test.afterEach(async ({browser}) => {
    for (const c of browser.contexts())
        await c.close();
});

const ROOM = process.env.SOZVON_ROOM || 'smoke';

async function join(context, name) {
    const page = await context.newPage();
    page.errors = [];
    page.on('pageerror', e => page.errors.push(String(e)));
    await page.addInitScript(() => {
        try { localStorage.setItem('sozvon-lang', 'ru'); } catch(e) {}
    });
    await page.goto(`/group/${ROOM}/`);
    await page.fill('#username', name);
    if (await page.locator('#password').isVisible())
        await page.fill('#password', 'x');
    for (const id of ['#precheck-cam', '#precheck-mic']) {
        await page.click(id);
        await expect(page.locator(id)).toHaveAttribute(
            'aria-pressed', 'true', {timeout: 45_000});
    }
    await page.click('#connectbutton');
    await expect.poll(async () => await page.locator('#peers video').count(),
                      {timeout: 30_000}).toBeGreaterThan(0);
    return page;
}

// Ids of this client's up and down connections.
const conns = page => page.evaluate(() => ({
    up: Object.keys(serverConnection.up).sort(),
    down: Object.keys(serverConnection.down).sort(),
}));

// Received so far on the down connections: bytes per kind, and the energy of
// the decoded sound -- bytes alone would also grow for audio the receiver
// cannot decrypt.
const received = page => page.evaluate(async () => {
    let r = {audio: 0, video: 0, energy: 0};
    for (const id in serverConnection.down) {
        const stats = await serverConnection.down[id].pc.getStats();
        stats.forEach(s => {
            if (s.type === 'inbound-rtp' && s.kind in r) {
                r[s.kind] += s.bytesReceived || 0;
                if (s.kind === 'audio')
                    r.energy += s.totalAudioEnergy || 0;
            }
        });
    }
    return r;
});

async function growing(page, kind) {
    const before = (await received(page))[kind];
    const step = kind === 'energy' ? 0 : 2000;
    await expect.poll(async () => (await received(page))[kind],
                      {timeout: 15_000}).toBeGreaterThan(before + step);
}

// The camera stream's state as the sender sees it; null once it is closed.
const camera = page => page.evaluate(() => {
    const c = Object.values(serverConnection.up)
        .find(s => s.label === 'camera');
    if (!c || !c.stream)
        return null;
    const t = c.stream.getAudioTracks()[0];
    const s = c.pc.getSenders().find(s => s.track && s.track.kind === 'audio');
    return {
        audio: c.stream.getAudioTracks().length,
        fresh: !!t && t !== window.lostMic && t.readyState === 'live',
        sent: !!t && !!s && s.track === t,
        video: c.stream.getVideoTracks().some(v => v.readyState === 'live'),
    };
});

// Stop the camera stream's microphone the way a lost device does.
const loseMic = page => page.evaluate(() => {
    const c = Object.values(serverConnection.up)
        .find(s => s.label === 'camera');
    const t = c.stream.getAudioTracks()[0];
    window.lostMic = t;
    t.stop();
    t.dispatchEvent(new Event('ended'));
});

const toast = (page, text) =>
    expect(page.locator('.toastify', {hasText: text}).first())
        .toBeVisible({timeout: 20_000});

test('a lost microphone comes back without touching the picture',
     async ({browser}) => {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    for (const c of [ctxA, ctxB])
        await c.grantPermissions(['camera', 'microphone']);

    const A = await join(ctxA, 'alice');
    const B = await join(ctxB, 'bob');
    await expect.poll(async () => await B.locator('#peers video').count(),
                      {timeout: 30_000}).toBe(2);
    await growing(B, 'audio');
    await growing(B, 'energy');

    const connsA = await conns(A);
    const connsB = await conns(B);

    // 1. The device comes back: a fresh track, same connections.
    await loseMic(A);
    await expect.poll(() => camera(A), {timeout: 20_000})
        .toEqual({audio: 1, fresh: true, sent: true, video: true});
    await toast(A, 'Микрофон снова работает');
    expect(await conns(A)).toEqual(connsA);
    expect(await conns(B)).toEqual(connsB);
    await growing(B, 'audio');
    await growing(B, 'energy');
    await growing(B, 'video');

    // 2. The device is gone for good: video carries on alone.
    await A.evaluate(() => {
        window.realGUM = navigator.mediaDevices.getUserMedia;
        navigator.mediaDevices.getUserMedia = async () => {
            const e = new Error('gone');
            e.name = 'NotFoundError';
            throw e;
        };
    });
    await loseMic(A);
    await expect.poll(() => camera(A), {timeout: 30_000})
        .toEqual({audio: 0, fresh: false, sent: false, video: true});
    await toast(A, 'Микрофон отключился — доступ отозван');
    expect(await conns(A)).toEqual(connsA);
    expect(await conns(B)).toEqual(connsB);
    await growing(B, 'video');

    // 3. The device is back and the microphone button is pressed: the new
    // track goes into the sender left idle, still the same connections
    // (tasks#31).
    const transceivers = () => A.evaluate(() => Object.values(serverConnection.up)
        .find(s => s.label === 'camera').pc.getTransceivers().length);
    const tBefore = await transceivers();
    await A.evaluate(() => {
        navigator.mediaDevices.getUserMedia = window.realGUM;
        document.getElementById('mutebutton').click();
    });
    await expect.poll(() => camera(A), {timeout: 20_000})
        .toEqual({audio: 1, fresh: true, sent: true, video: true});
    expect(await transceivers()).toBe(tBefore);
    expect(await conns(A)).toEqual(connsA);
    expect(await conns(B)).toEqual(connsB);
    await growing(B, 'audio');
    await growing(B, 'energy');
    await growing(B, 'video');

    expect(A.errors).toEqual([]);
    expect(B.errors).toEqual([]);
});
