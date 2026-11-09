// The picture format and auto-framing, in a real call.  (Sozvon)
//
// framing.js does the arithmetic and static/test/framing.test.js checks it;
// what only a browser can show is that it reaches the far end.  Alice picks a
// format in the settings and Bob must receive a picture of that shape --
// cut by Alice's canvas before encoding, since the server forwards what it
// is sent.  A change between two cuts must take effect without publishing
// again (the canvas reads the format every frame); going back to the
// camera's own format drops the canvas on a desktop.  On Bob's side, a
// picture fills his stage when that costs a margin, is shown whole when it
// would cost the face, and is never cut with auto-framing off.  And Alice's
// own thumbnail takes the shape of what she sends.
//
// The fake camera is 640x480 (4:3), and Chromium here is a desktop -- no touch,
// no facingMode, wider than the 1024px mobile layout -- so without a format
// there is no canvas at all.

import {test, expect} from '@playwright/test';

const ROOM = process.env.SOZVON_ROOM || 'smoke';

test.afterEach(async ({browser}) => {
    for (const c of browser.contexts())
        await c.close();
});

async function join(browser, name, viewport) {
    const context = await browser.newContext({viewport});
    const page = await context.newPage();
    page.errors = [];
    page.on('pageerror', e => page.errors.push(String(e)));
    await page.goto(`/group/${ROOM}/`);
    await page.fill('#username', name);
    if (await page.locator('#password').isVisible())
        await page.fill('#password', 'x');
    await page.click('#precheck-cam');
    await expect(page.locator('#precheck-cam'))
        .toHaveAttribute('aria-pressed', 'true', {timeout: 45_000});
    await page.click('#connectbutton');
    await expect.poll(() => page.locator('#peers video').count(),
                      {timeout: 30_000}).toBeGreaterThan(0);
    return page;
}

/** Picks a value in a settings control the way the drawer would. */
function setControl(page, id, value) {
    return page.evaluate(([id, value]) => {
        const e = document.getElementById(id);
        if (e.type === 'checkbox')
            e.checked = value;
        else
            e.value = value;
        e.dispatchEvent(new Event('change'));
    }, [id, value]);
}

/** Alice's camera up stream: its id and the size of what it sends. */
const upCamera = page => page.evaluate(() => {
    const c = Object.values(serverConnection.up)
        .find(c => c.label === 'camera');
    if (!c)
        return null;
    const f = c.userdata.filter;
    return {
        id: c.id,
        canvas: !!f,
        width: f ? f.canvas.width : 0,
        height: f ? f.canvas.height : 0,
    };
});

/** The picture Bob receives from the one remote tile, and how it is shown. */
const remote = page => page.evaluate(() => {
    const tile = document.querySelector('#peers .peer-remote');
    const v = tile && tile.querySelector('video.media');
    if (!v)
        return null;
    return {
        width: v.videoWidth,
        height: v.videoHeight,
        fill: tile.classList.contains('framing-fill'),
        fit: getComputedStyle(v).objectFit,
        position: v.style.objectPosition,
    };
});

const shape = r => r && r.height ? Math.round(r.width / r.height * 100) / 100 : 0;

test('the chosen format reaches the far end, and each tile frames it', async ({browser}) => {
    const alice = await join(browser, 'alice', {width: 1200, height: 1000});
    const bob = await join(browser, 'bob', {width: 1200, height: 1000});

    // Nothing chosen: the camera's own 4:3, sent with no canvas.
    await expect.poll(() => remote(bob).then(shape)).toBe(1.33);
    expect((await upCamera(alice)).canvas).toBe(false);

    // 16:9 is a cut: a canvas now, and Bob receives 16:9.
    await setControl(alice, 'sendaspectselect', '16:9');
    await expect.poll(() => upCamera(alice).then(u => u && [u.width, u.height]))
        .toEqual([640, 360]);
    const wide = await upCamera(alice);
    await expect.poll(() => remote(bob).then(shape)).toBe(1.78);

    // Bob's stage is a little taller than wide-screen: a 16:9 picture fills
    // it, cut at the sides only.
    await expect.poll(() => remote(bob).then(r => r.fill)).toBe(true);
    let r = await remote(bob);
    expect(r.fit).toBe('cover');
    expect(r.position).toMatch(/^50% /);

    // With auto-framing off it is shown whole.
    await setControl(bob, 'autoframingbox', false);
    await expect.poll(() => remote(bob).then(r => r.fill)).toBe(false);
    r = await remote(bob);
    expect(r.fit).toBe('contain');
    expect(r.position).toBe('');
    await setControl(bob, 'autoframingbox', true);

    // From one cut to another: the same up stream, nothing republished.
    await setControl(alice, 'sendaspectselect', '9:16');
    await expect.poll(() => remote(bob).then(shape)).toBe(0.56);
    expect((await upCamera(alice)).id).toBe(wide.id);
    expect(await upCamera(alice).then(u => [u.width, u.height]))
        .toEqual([270, 480]);

    // A portrait picture on a landscape stage would lose the face to a fill:
    // shown whole.
    await expect.poll(() => remote(bob).then(r => r.fill)).toBe(false);

    // Alice's own thumbnail has the shape of what she sends.
    await expect.poll(() => alice.evaluate(() => {
        const t = document.querySelector('#peers .peer-self');
        return t && t.classList.contains('thumb-portrait') &&
            Math.round(t.offsetWidth / t.offsetHeight * 100) / 100;
    })).toBe(0.56);

    await setControl(alice, 'sendaspectselect', '1:1');
    await expect.poll(() => remote(bob).then(shape)).toBe(1);

    // Back to the camera's own format: the canvas goes, the picture is 4:3.
    await setControl(alice, 'sendaspectselect', 'camera');
    await expect.poll(() => upCamera(alice).then(u => u && u.canvas)).toBe(false);
    await expect.poll(() => remote(bob).then(shape)).toBe(1.33);

    expect(alice.errors).toEqual([]);
    expect(bob.errors).toEqual([]);
});

/** What Alice's settings say adapting is doing. */
const adaptNote = page => page.evaluate(() => ({
    shown: !document.getElementById('adapt-status').classList.contains('invisible'),
    active: !document.getElementById('adapt-active').classList.contains('invisible'),
    format: document.getElementById('adapt-format').textContent,
    locked: document.getElementById('sendaspectselect').disabled,
}));

test('fitted to the other person\'s screen, one-to-one only', async ({browser}) => {
    const alice = await join(browser, 'alice', {width: 1200, height: 1000});
    await setControl(alice, 'adaptpeerbox', true);
    // alone: nothing to fit, and the note says when it will work
    expect(await adaptNote(alice)).toMatchObject({shown: true, active: false});

    // Bob watches on an upright phone: Alice's 4:3 goes out as 9:16.
    const bob = await join(browser, 'bob', {width: 390, height: 844});
    await expect.poll(() => remote(bob).then(shape)).toBe(0.56);
    expect(await adaptNote(alice)).toEqual(
        {shown: true, active: true, format: '9:16', locked: true});

    // Bob turns his phone: 16:9, a quarter of the height cut, no more.
    await bob.setViewportSize({width: 844, height: 390});
    await expect.poll(() => remote(bob).then(shape)).toBe(1.78);
    expect((await adaptNote(alice)).format).toBe('16:9');

    // A third person: one picture cannot fit two screens, so Alice's own
    // choice -- the camera's format -- applies again.
    const carol = await join(browser, 'carol', {width: 1200, height: 1000});
    await expect.poll(() => remote(bob).then(shape)).toBe(1.33);
    expect(await adaptNote(alice)).toMatchObject({active: false, locked: false});
    // and still one camera from Alice: turning simulcast on replaces her
    // stream at the same moment, and two replacements published two
    await expect.poll(() => alice.evaluate(() => Object.values(serverConnection.up)
        .filter(c => c.label === 'camera').length)).toBe(1);
    await expect.poll(() => bob.locator('#peers .peer-remote').count()).toBe(2);

    // Carol leaves: one-to-one again, fitted again.
    await carol.context().close();
    await expect.poll(() => remote(bob).then(shape)).toBe(1.78);

    // Switched off: the camera's format.
    await setControl(alice, 'adaptpeerbox', false);
    await expect.poll(() => remote(bob).then(shape)).toBe(1.33);
    expect(await adaptNote(alice)).toMatchObject({shown: false, locked: false});

    expect(alice.errors).toEqual([]);
    expect(bob.errors).toEqual([]);
});
