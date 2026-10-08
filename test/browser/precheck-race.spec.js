// "Mic, then Join" while the microphone is still opening.  (Sozvon, tasks#51)
//
// The pre-join toggle used to count as on only once getUserMedia and the
// device listing had returned.  Pressing Join inside that window joined
// without sound and said nothing; on a slow phone or at the first permission
// prompt the window is seconds wide.  The open that was still in flight then
// came back to a preview nobody was looking at and kept the microphone.
//
// The window is made wide on purpose here: audio-only getUserMedia calls (the
// pre-join check asks for one kind at a time; the call asks for both) are held
// back for a few seconds, and Join is pressed straight after the toggle.

import {test, expect} from '@playwright/test';

test.afterEach(async ({browser}) => {
    for (const c of browser.contexts())
        await c.close();
});

const ROOM = process.env.SOZVON_ROOM || 'smoke';
const HOLD_MS = 3000;

test('joining while the microphone is still opening keeps the microphone', async ({browser}) => {
    const ctx = await browser.newContext();
    await ctx.grantPermissions(['camera', 'microphone']);
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));

    await page.addInitScript((hold) => {
        const md = navigator.mediaDevices;
        const real = md.getUserMedia.bind(md);
        // Every stream handed out, so the test can tell which ones are
        // still holding a device after the join.
        window.__gumStreams = [];
        md.getUserMedia = async (c) => {
            if (c && c.audio && !c.video)
                await new Promise(r => setTimeout(r, hold));
            const s = await real(c);
            window.__gumStreams.push(s);
            return s;
        };
    }, HOLD_MS);

    await page.goto(`/group/${ROOM}/`);
    await page.waitForSelector('#username', {state: 'visible'});
    await page.fill('#username', 'quick');
    if (await page.locator('#password').isVisible())
        await page.fill('#password', 'x');

    await page.click('#precheck-mic');
    // The open is in flight: the toggle is not on yet.
    expect(await page.getAttribute('#precheck-mic', 'aria-pressed')).toBe('false');
    await page.click('#connectbutton');

    // In the call, publishing a live microphone.
    await expect.poll(() => page.evaluate(() => {
        if (typeof serverConnection === "undefined" || !serverConnection)
            return 0;
        let n = 0;
        for (const id in serverConnection.up) {
            const s = serverConnection.up[id].stream;
            if (s)
                n += s.getAudioTracks()
                      .filter(t => t.readyState === 'live').length;
        }
        return n;
    }), {message: 'joined without the microphone it was asked to bring',
         timeout: 30_000}).toBeGreaterThan(0);

    // Let the held pre-join open come back, then make sure it let go: every
    // live audio track left on the page belongs to the call.
    await page.waitForTimeout(HOLD_MS + 1500);
    const stray = await page.evaluate(() => {
        const up = new Set();
        for (const id in serverConnection.up) {
            const s = serverConnection.up[id].stream;
            if (s)
                s.getTracks().forEach(t => up.add(t.id));
        }
        let n = 0;
        for (const s of window.__gumStreams)
            for (const t of s.getAudioTracks())
                if (t.readyState === 'live' && !up.has(t.id))
                    n++;
        return n;
    });
    expect(stray, 'a pre-join microphone stream outlived the join').toBe(0);
    expect(errors).toEqual([]);
});
