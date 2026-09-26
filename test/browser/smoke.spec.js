// Two clients, one laptop, no webcam: the first half of P-SMOKE, automated.
//
// What this covers that a person doing it by hand keeps having to redo:
// video actually arriving *in both directions*, which is the fork's most
// frequent failure and the one that looks fine from the sending side.
//
// What it deliberately does not cover: whether anything looks right.  Themes,
// contrast, layout and real camera behaviour stay manual.

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

/**
 * Join a room through the real login screen, with the pre-join device check
 * turned on, and wait until the client is in the call.
 */
async function join(context, name, {room = ROOM, cam = true, mic = true} = {}) {
    const page = await context.newPage();

    // Surface client-side errors: a test that passes while the console is on
    // fire is not telling the truth.
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    page.errors = errors;

    await page.goto(`/group/${room}/`);
    await page.waitForSelector('#username', {state: 'visible'});
    await page.fill('#username', name);
    // The test rooms take any password (wildcard-user).
    if (await page.locator('#password').isVisible())
        await page.fill('#password', 'x');

    // The toggles and the preview prove the devices were actually opened,
    // before we join.
    await chooseDevices(page, {cam, mic});

    await page.click('#connectbutton');
    // In the call, and publishing: our own tile exists.  Waiting on this rather
    // than on the login form disappearing gives a failure that says which of
    // the two went wrong.
    await expect.poll(
        async () => await page.locator('#peers video').count(),
        {message: `${name} never got a tile of their own`, timeout: 30_000},
    ).toBeGreaterThan(0);
    return page;
}

/**
 * Every <video> on the stage, with enough state to tell a live picture from a
 * black one.  totalVideoFrames is what distinguishes "the element exists and
 * is playing nothing" from "frames are being decoded" -- the exact difference
 * the E2EE keyframe bug produces.
 */
async function stageVideos(page, settleMs = 1500) {
    return await page.evaluate(async (ms) => {
        const vids = Array.from(document.querySelectorAll('#peers video'));
        const sample = v => ({
            id: v.id,
            frames: v.getVideoPlaybackQuality ?
                v.getVideoPlaybackQuality().totalVideoFrames : null,
            time: v.currentTime,
        });
        const before = vids.map(sample);
        await new Promise(r => setTimeout(r, ms));
        const after = vids.map(sample);
        return vids.map((v, i) => ({
            id: v.id,
            width: v.videoWidth,
            height: v.videoHeight,
            paused: v.paused,
            framesAdvanced: after[i].frames - before[i].frames,
            timeAdvanced: after[i].time > before[i].time,
        }));
    }, settleMs);
}

/** Fail with a readable message rather than a bare false. */
function expectLivePicture(videos, who) {
    expect(videos.length, `${who}: no video on the stage at all`).toBeGreaterThan(0);
    for (const v of videos) {
        expect(v.width, `${who}: ${v.id} has no picture (videoWidth 0)`).toBeGreaterThan(0);
        expect(v.framesAdvanced,
            `${who}: ${v.id} is frozen -- no frames decoded in the sample window`,
        ).toBeGreaterThan(0);
    }
}

test('two clients see and hear each other, both directions', async ({browser}) => {
    // Separate contexts are separate clients: separate storage, separate
    // permissions, separate identity -- the automated form of "one normal
    // window and one private window".
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    for (const c of [ctxA, ctxB])
        await c.grantPermissions(['camera', 'microphone']);

    const A = await join(ctxA, 'alice');
    const B = await join(ctxB, 'bob');

    // Each side must end up with two tiles: its own and the other's.
    await expect.poll(
        async () => await A.locator('#peers video').count(),
        {message: 'alice never saw two videos', timeout: 30_000},
    ).toBe(2);
    await expect.poll(
        async () => await B.locator('#peers video').count(),
        {message: 'bob never saw two videos', timeout: 30_000},
    ).toBe(2);

    // Exactly two: a third tile means one client published twice, which has
    // shipped before (fixed in d25c229).
    expect(await A.locator('#peers video').count()).toBe(2);

    // The part that matters: frames are decoding on both sides.  One-way video
    // passes every check above and fails this one.
    expectLivePicture(await stageVideos(A), 'alice');
    expectLivePicture(await stageVideos(B), 'bob');

    // Each sees the other in the participant list.
    await expect(A.locator('#users')).toContainText('bob');
    await expect(B.locator('#users')).toContainText('alice');

    // Chat, both ways, including that markup arrives as text and not as HTML.
    await A.fill('#input', 'ping from alice <b>not bold</b>');
    await A.press('#input', 'Enter');
    await expect(B.locator('#box')).toContainText('ping from alice <b>not bold</b>');
    expect(await B.locator('#box b').count(),
        'markup in a chat message was rendered as HTML').toBe(0);

    await B.fill('#input', 'pong from bob');
    await B.press('#input', 'Enter');
    await expect(A.locator('#box')).toContainText('pong from bob');

    expect(A.errors, 'alice hit a client-side error').toEqual([]);
    expect(B.errors, 'bob hit a client-side error').toEqual([]);

    await ctxA.close();
    await ctxB.close();
});
