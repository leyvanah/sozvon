// Picking a microphone opens that microphone.  (Sozvon)
//
// On a call on 2026-11-06 a guest picked another microphone several times
// and never got it: each time the stream was republished with the default
// one, and the picker went back to it.  A device id given to getUserMedia as
// a plain value is only a preference, and Chrome opens the default
// microphone over it.  Chromium's fake devices show the same: three
// microphones, and asking for the second one gives the first.
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

const OTHER_MIC = 'Fake Audio Input 1';
const DEFAULT_MIC = 'Fake Default Audio Input';

async function open(context, room, name) {
    const page = await context.newPage();
    page.errors = [];
    page.on('pageerror', e => page.errors.push(String(e)));
    await page.goto(`/group/${room}/`);
    await page.fill('#username', name);
    if (await page.locator('#password').isVisible())
        await page.fill('#password', 'x');
    for (const id of ['#precheck-cam', '#precheck-mic']) {
        await page.click(id);
        await expect(page.locator(id)).toHaveAttribute('aria-pressed', 'true', {timeout: 45_000});
    }
    return page;
}

async function connect(page) {
    await page.click('#connectbutton');
    await expect.poll(async () => await page.locator('#peers video').count(),
                      {timeout: 30_000}).toBeGreaterThan(0);
}

/** The value of the option of a picker whose label is the given one. */
const optionFor = (page, select, label) => page.evaluate(([s, l]) => {
    const o = [...document.getElementById(s).options]
        .find(o => o.textContent.trim() === l);
    return o ? o.value : null;
}, [select, label]);

const pick = (page, select, value) => page.evaluate(([s, v]) => {
    const el = document.getElementById(s);
    el.value = v;
    el.dispatchEvent(new Event('change'));
}, [select, value]);

/** Alice's outgoing camera stream: its id, microphone and camera track. */
const upCamera = page => page.evaluate(() => {
    const c = Object.values(serverConnection.up)
        .find(c => c.label === 'camera');
    if (!c || !c.stream)
        return null;
    const f = c.userdata.filter;
    const raw = f && f.inputStream ? f.inputStream : c.stream;
    const a = c.stream.getAudioTracks().find(t => t.readyState === 'live');
    const v = raw.getVideoTracks()[0];
    return {
        id: c.id,
        mic: a ? a.label : null,
        camera: v ? v.id : null,
        live: v ? v.readyState === 'live' : false,
    };
});

/** Frames Bob has decoded from Alice. */
const framesSeen = page => page.evaluate(() => {
    const v = document.querySelector('#peers .peer-remote video.media');
    return v && v.getVideoPlaybackQuality ?
        v.getVideoPlaybackQuality().totalVideoFrames : 0;
});

for (const room of ROOMS) {
    test(`picking another microphone in a call opens it and keeps the camera (${room})`, async ({browser}) => {
        const ctxA = await browser.newContext();
        const ctxB = await browser.newContext();
        for (const c of [ctxA, ctxB])
            await c.grantPermissions(['camera', 'microphone']);
        const A = await open(ctxA, room, 'alice');
        await connect(A);
        const B = await open(ctxB, room, 'bob');
        await connect(B);
        await expect.poll(() => framesSeen(B), {timeout: 30_000}).toBeGreaterThan(0);
        if (room === process.env.SOZVON_E2EE_ROOM)
            for (const p of [A, B])
                await expect.poll(() => p.evaluate(() =>
                    serverConnection.e2ee && serverConnection.e2ee.state),
                    {timeout: 20_000}).toBe('established');

        const before = await upCamera(A);
        expect(before.mic).toBe(DEFAULT_MIC);
        const other = await optionFor(A, 'audioselect', OTHER_MIC);
        expect(other, 'the picker lists the second microphone').toBeTruthy();

        await pick(A, 'audioselect', other);

        await expect.poll(async () => (await upCamera(A)).mic,
            {timeout: 20_000, message: 'the stream went on with another microphone'})
            .toBe(OTHER_MIC);
        expect(await A.evaluate(() => document.getElementById('audioselect').value),
            'the picker stays on the chosen microphone').toBe(other);
        expect(await A.evaluate(() => getSettings().audio)).toBe(other);
        // the camera is the one that was running (keep-camera.spec.js)
        const after = await upCamera(A);
        expect(after.camera).toBe(before.camera);
        expect(after.live).toBe(true);
        const f0 = await framesSeen(B);
        await expect.poll(() => framesSeen(B), {timeout: 20_000}).toBeGreaterThan(f0);

        expect(A.errors).toEqual([]);
        expect(B.errors).toEqual([]);
    });
}

test('a microphone picked in the device check is the one the call opens', async ({browser}) => {
    const ctx = await browser.newContext();
    await ctx.grantPermissions(['camera', 'microphone']);
    const A = await open(ctx, process.env.SOZVON_ROOM || 'smoke', 'alice');
    const other = await optionFor(A, 'precheck-audioselect', OTHER_MIC);
    expect(other, 'the device check lists the second microphone').toBeTruthy();

    await pick(A, 'precheck-audioselect', other);
    // reopened with it, and the picker did not go back to the default one
    await A.waitForTimeout(2000);
    expect(await A.evaluate(() =>
        document.getElementById('precheck-audioselect').value)).toBe(other);

    await connect(A);
    await expect.poll(async () => {
        const u = await upCamera(A);
        return u && u.mic;
    }, {timeout: 20_000}).toBe(OTHER_MIC);
    expect(A.errors).toEqual([]);
});

test('a chosen microphone that is gone gives the default one, and says so', async ({browser}) => {
    const ctx = await browser.newContext();
    await ctx.grantPermissions(['camera', 'microphone']);
    const A = await open(ctx, process.env.SOZVON_ROOM || 'smoke', 'alice');
    await connect(A);
    // Replaced at once, before the server has answered the first stream:
    // that answer arrives for a stream that is gone and must be let go
    // (up-stream-close.test.js), not thrown into the page.
    const before = await upCamera(A);
    expect(before.mic).toBe(DEFAULT_MIC);

    // A microphone remembered from another day, unplugged since.
    await A.evaluate(() => {
        updateSettings({audio: 'a-microphone-that-is-not-here'});
        replaceCameraStream();
    });

    await expect.poll(async () => {
        const u = await upCamera(A);
        return u && u.id !== before.id && u.mic;
    }, {timeout: 20_000}).toBe(DEFAULT_MIC);
    const said = await A.evaluate(() => Sozvon.i18n.t('toast.deviceFallback'));
    await expect.poll(() => A.evaluate(() => document.body.innerText),
        {timeout: 5_000}).toContain(said);
    expect(A.errors).toEqual([]);
});
