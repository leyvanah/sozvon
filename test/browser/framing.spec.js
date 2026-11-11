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
    const before = (await upCamera(alice)).id;
    await setControl(alice, 'sendaspectselect', '16:9');
    // The camera is opened again, asked for 1280x960.  (What it gives here is
    // 640x480 still: both clients share Chromium's one fake camera, and
    // Bob's has it open at that size.  The second test, where Alice's opens
    // it first, sees the 960 lines.)
    await expect.poll(() => upCamera(alice).then(u => u && u.id)).not.toBe(before);
    expect(await alice.evaluate(() => {
        const c = Object.values(serverConnection.up)
            .find(c => c.label === 'camera');
        const t = c.userdata.filter.inputStream.getVideoTracks()[0];
        const k = t.getConstraints();
        return [k.width && (k.width.ideal || k.width), k.height && (k.height.ideal || k.height)];
    })).toEqual([1280, 960]);
    await expect.poll(() => upCamera(alice).then(u => u && u.width / u.height))
        .toBeCloseTo(16 / 9, 1);
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

    // From one cut to another: the same up stream, nothing republished,
    // and the camera stays open.
    await setControl(alice, 'sendaspectselect', '9:16');
    await expect.poll(() => remote(bob).then(shape)).toBe(0.56);
    expect((await upCamera(alice)).id).toBe(wide.id);
    await expect.poll(() => upCamera(alice).then(u => u.width / u.height))
        .toBeCloseTo(9 / 16, 1);

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

    // Bob watches on an upright phone: Alice's picture goes out as 9:16,
    // with all 960 lines of the camera she opened at 1280x960 for fitting
    // -- 640x480 left 270x480.
    const bob = await join(browser, 'bob', {width: 390, height: 844});
    await expect.poll(() => remote(bob).then(shape)).toBe(0.56);
    await expect.poll(() => upCamera(alice).then(u => [u.width, u.height]))
        .toEqual([540, 960]);
    expect(await adaptNote(alice)).toEqual(
        {shown: true, active: true, format: '9:16', locked: true});

    // Bob turns his phone: 16:9, a quarter of the height cut, no more.
    await bob.setViewportSize({width: 844, height: 390});
    await expect.poll(() => remote(bob).then(shape)).toBe(1.78);
    expect((await adaptNote(alice)).format).toBe('16:9');

    // A third person: one picture cannot fit two screens, so Alice's own
    // choice -- the camera's format -- applies again: no canvas.
    const carol = await join(browser, 'carol', {width: 1200, height: 1000});
    await expect.poll(() => upCamera(alice).then(u => u && u.canvas)).toBe(false);
    await expect.poll(() => remote(bob).then(shape)).toBe(1.33);
    expect(await adaptNote(alice)).toMatchObject({active: false, locked: false});
    // and still one camera from Alice: turning simulcast on replaces her
    // stream at the same moment, and two replacements published two
    await expect.poll(() => alice.evaluate(() => Object.values(serverConnection.up)
        .filter(c => c.label === 'camera').length)).toBe(1);
    await expect.poll(() => bob.locator('#peers .peer-remote').count()).toBe(2);

    // Carol leaves: one-to-one again, fitted again.
    await carol.context().close();
    await expect.poll(() => upCamera(alice).then(u => u && u.canvas)).toBe(true);
    await expect.poll(() => remote(bob).then(shape)).toBe(1.78);

    // Switched off: the camera's format.
    await setControl(alice, 'adaptpeerbox', false);
    await expect.poll(() => remote(bob).then(shape)).toBe(1.33);
    expect(await adaptNote(alice)).toMatchObject({shown: false, locked: false});

    expect(alice.errors).toEqual([]);
    expect(bob.errors).toEqual([]);
});

/** The shape Alice was last told Bob shows her picture in. */
const reportedToAlice = page => page.evaluate(() => {
    let latest = null;
    for (const v of peerViews.values())
        if (!latest || v.at > latest.at)
            latest = v;
    return latest && latest.aspect;
});

test('the grid reports its box, a session left behind is the same person, a filter wins', async ({browser}) => {
    const alice = await join(browser, 'alice', {width: 1200, height: 1000});
    await setControl(alice, 'adaptpeerbox', true);
    const bob = await join(browser, 'bob', {width: 1200, height: 700});
    await expect.poll(() => adaptNote(alice).then(n => n.active)).toBe(true);

    // In the grid Bob's tile takes the shape of the picture, so the box
    // reported is the cell -- its width by the row's height cap -- not the
    // element, which would only confirm what Alice already sends.
    await bob.evaluate(() => toggleView());
    await expect.poll(() => bob.evaluate(() =>
        document.getElementById('peers').classList.contains('speaker'))).toBe(false);
    const cell = () => bob.evaluate(() => {
        const c = Object.values(serverConnection.down)
            .find(c => c.label === 'camera');
        const m = c && document.getElementById('media-' + c.localId);
        if (!m)
            return null;
        const cs = getComputedStyle(m);
        const w = m.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
        const maxH = parseFloat(cs.maxHeight);
        const h = cs.boxSizing === 'border-box' ?
            maxH - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom) : maxH;
        return w / h;
    });
    await expect.poll(async () => {
        const [want, got] = [await cell(), await reportedToAlice(alice)];
        return Number.isFinite(want) && Math.abs(want - got) < 0.01;
    }).toBe(true);

    // Bob opens the call a second time, the way a phone moves from one
    // app's browser to another and leaves the first session behind.  Three
    // sessions, still one other person: Alice goes on fitting.
    const bob2 = await join(browser, 'bob', {width: 390, height: 844});
    await expect.poll(() => alice.evaluate(() =>
        Object.keys(serverConnection.users).length)).toBe(3);
    await expect.poll(() => alice.evaluate(() => peerViews.size)).toBe(2);
    expect(await adaptNote(alice)).toMatchObject({active: true});
    expect((await upCamera(alice)).canvas).toBe(true);
    await bob2.context().close();

    // A filter takes the canvas: the format is greyed with a note, the
    // camera is asked for the plain 640x480 rather than 1280x960 for a cut
    // that cannot happen, and fitting stops.
    await setControl(alice, 'filterselect', 'mirror-h');
    await expect.poll(() => alice.evaluate(() => ({
        note: !document.getElementById('format-filter-note').classList.contains('invisible'),
        format: document.getElementById('sendaspectselect').disabled,
        adapt: document.getElementById('adaptpeerbox').disabled,
        status: !document.getElementById('adapt-status').classList.contains('invisible'),
    }))).toEqual({note: true, format: true, adapt: true, status: false});
    await expect.poll(() => alice.evaluate(() => {
        const c = Object.values(serverConnection.up)
            .find(c => c.label === 'camera');
        const f = c && c.userdata.filter;
        if (!f || f.definition !== filters['mirror-h'])
            return null;
        const k = f.inputStream.getVideoTracks()[0].getConstraints();
        return k.height ? (k.height.ideal || k.height) : 'none';
    })).toBe(480);
    await expect.poll(() => remote(bob).then(shape)).toBe(1.33);

    // Taken off: fitting again, at 1280x960.
    await setControl(alice, 'filterselect', '');
    await expect.poll(() => adaptNote(alice).then(n => n.active)).toBe(true);
    expect(await alice.evaluate(() => {
        const c = Object.values(serverConnection.up)
            .find(c => c.label === 'camera');
        const k = c.userdata.filter.inputStream.getVideoTracks()[0].getConstraints();
        return k.height && (k.height.ideal || k.height);
    })).toBe(960);

    expect(alice.errors).toEqual([]);
    expect(bob.errors).toEqual([]);
});

test('the canvas runs on the worker clock, and hidden keeps the camera\'s rate', async ({browser}) => {
    const alice = await join(browser, 'alice', {width: 1200, height: 1000});
    await setControl(alice, 'sendaspectselect', '16:9');
    await expect.poll(() => upCamera(alice).then(u => u && u.canvas)).toBe(true);
    const filter = () => alice.evaluate(() => {
        const c = Object.values(serverConnection.up)
            .find(c => c.label === 'camera');
        const f = c.userdata.filter;
        return {worker: !!f.ticker, noWorker: f.noWorker, drawn: f.drawn,
                rate: f.cameraRate, tickMs: f.tickMs, blind: f.drawsBlind()};
    });
    // filter-tick.js is served and allowed: the worker runs, the page's
    // timer does not
    await expect.poll(() => filter().then(f => f.worker && !f.noWorker)).toBe(true);
    // the camera's real rate is measured while the page is visible
    await expect.poll(() => filter().then(f => f.rate), {timeout: 10_000})
        .toBeGreaterThan(5);

    // Hidden, as another window covering the call makes it.  (Headless
    // Chromium does not hold back a hidden page's timers the way Firefox
    // did on 2026-11-09: what this checks is the drawing, not the browser.)
    await alice.evaluate(() => Object.defineProperty(document, 'visibilityState',
        {configurable: true, get: () => 'hidden'}));
    await expect.poll(() => filter().then(f => f.blind)).toBe(true);
    const a = await filter();
    await alice.waitForTimeout(3000);
    const b = await filter();
    const drawnRate = (b.drawn - a.drawn) / 3;
    const cameraRate = Math.round(a.rate);
    expect(b.tickMs).toBeCloseTo(1000 / cameraRate, 1);
    // every tick drawn, at the camera's rate: not the reported rate's
    // copies, and not one a second
    expect(drawnRate).toBeGreaterThan(cameraRate * 0.7);
    expect(drawnRate).toBeLessThan(cameraRate * 1.2);

    expect(alice.errors).toEqual([]);
});

test('a camera that will not open at 1280x960 opens small and is raised', async ({browser}) => {
    // Firefox on Windows would not open a laptop's camera asked for a 4:3
    // bigger than 640x480 -- "Failed to allocate videosource" -- though the
    // same camera, once open, went to 1280x960 in place (2026-11-11).  This
    // camera does the same, and Alice has fitting on before she joins: the
    // room's camera must still come on, and at 1280x960.
    const context = await browser.newContext({viewport: {width: 1200, height: 1000}});
    await context.addInitScript(() => {
        try {
            if (!sessionStorage.getItem('settings'))
                sessionStorage.setItem('settings', JSON.stringify({adaptToPeer: true}));
        } catch (e) { /* ignore */ }
        const md = navigator.mediaDevices;
        const real = md.getUserMedia.bind(md);
        window.openedAt = [];
        md.getUserMedia = async c => {
            const v = c && c.video;
            const h = v && v.height && (v.height.ideal || v.height.exact || v.height);
            if (v)
                window.openedAt.push(typeof h === 'number' ? h : null);
            if (typeof h === 'number' && h > 480 && h * 16 !== (v.width.ideal || 0) * 9)
                throw new DOMException('Failed to allocate videosource', 'NotReadableError');
            return real(c);
        };
    });
    const alice = await context.newPage();
    alice.errors = [];
    alice.on('pageerror', e => alice.errors.push(String(e)));
    await alice.goto(`/group/${ROOM}/`);
    await alice.fill('#username', 'alice');
    if (await alice.locator('#password').isVisible())
        await alice.fill('#password', 'x');
    await alice.click('#precheck-cam');
    await expect(alice.locator('#precheck-cam'))
        .toHaveAttribute('aria-pressed', 'true', {timeout: 45_000});
    await alice.click('#connectbutton');
    await expect.poll(() => alice.evaluate(() => getSettings().adaptToPeer)).toBe(true);
    await expect.poll(() => upCamera(alice).then(u => !!u), {timeout: 30_000}).toBe(true);
    // opened at 480 lines (the preview, then the room), never asked for 960
    expect(await alice.evaluate(() => window.openedAt)).not.toContain(960);
    expect(await alice.evaluate(() => {
        const c = Object.values(serverConnection.up)
            .find(c => c.label === 'camera');
        const f = c.userdata.filter;
        const t = (f && f.inputStream ? f.inputStream : c.stream).getVideoTracks()[0];
        const k = t.getConstraints();
        return [t.readyState, k.height && (k.height.ideal || k.height)];
    })).toEqual(['live', 960]);

    const bob = await join(browser, 'bob', {width: 1200, height: 1000});
    await expect.poll(() => remote(bob).then(r => r && r.width > 0)).toBe(true);
    expect(await alice.locator('.toast-error, .toastify').allTextContents())
        .not.toContain('Failed to allocate videosource');
    expect(alice.errors).toEqual([]);
    expect(bob.errors).toEqual([]);
});
