// A silent microphone is marked on a tile that has a picture.  (Sozvon)
//
// Muting keeps the stream published and only disables the track, so the
// mark has to come from the user data the muting client publishes; this
// checks that it appears and goes away on the other side, and that someone
// who joined with no microphone at all is marked from the start.

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

async function join(context, name, mic) {
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
    await chooseDevices(page, {mic});
    await page.click('#connectbutton');
    await expect.poll(async () => await page.locator('#peers video').count(),
                      {timeout: 30_000}).toBeGreaterThan(0);
    return page;
}

// The dock hides itself; the handler is what is under test, not the pointer.
const toggleMic = page =>
    page.evaluate(() => document.getElementById('mutebutton').click());

test('a muted or absent microphone is marked on the picture', async ({browser}) => {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    for (const c of [ctxA, ctxB])
        await c.grantPermissions(['camera', 'microphone']);

    const A = await join(ctxA, 'alice', true);
    const B = await join(ctxB, 'bob', true);
    const mark = B.locator('.peer-remote .label .label-mic');
    await expect.poll(async () => await B.locator('#peers video').count(),
                      {timeout: 30_000}).toBe(2);

    await B.waitForTimeout(2000);
    await expect(mark).toHaveCount(0);

    await toggleMic(A);
    await expect(mark).toHaveCount(1, {timeout: 10_000});
    await expect(mark).toHaveAttribute('title', 'Микрофон выключен');
    await B.screenshot({path: 'test-results/tile-mic.png'});

    await toggleMic(A);
    await expect(mark).toHaveCount(0, {timeout: 10_000});

    // Rejoin without a microphone: marked from the start.
    await A.close();
    const A2 = await join(ctxA, 'alice2', false);
    await expect(B.locator('.peer-remote .label', {hasText: 'alice2'})
                 .locator('.label-mic')).toHaveCount(1, {timeout: 20_000});

    expect(B.errors).toEqual([]);
    expect(A2.errors).toEqual([]);
    await ctxA.close();
    await ctxB.close();
});
