// A participant turns the camera off in the middle of a call and back on
// (sozvon-tasks#10).  With the camera off their tile must show who they are --
// the avatar in their list colour and their name -- and not the empty <video>,
// which the Android WebView paints as a big "play" triangle.  With the camera
// back on, the picture must replace the card again.

import {test, expect} from '@playwright/test';
import {chooseDevices} from './lib.js';

const ROOM = process.env.SOZVON_ROOM || 'smoke';
const SHOTS = process.env.SHOTS_DIR || 'test-results';
const SCHEME = process.env.SCHEME || 'light';

test.afterEach(async ({browser}) => {
    for (const c of browser.contexts())
        await c.close();
});

async function join(context, name) {
    const page = await context.newPage();
    page.log = [];
    page.on('pageerror', e => page.log.push(`pageerror ${e}`));
    await page.goto(`/group/${ROOM}/`);
    await page.waitForSelector('#username', {state: 'visible'});
    await page.fill('#username', name);
    if (await page.locator('#password').isVisible())
        await page.fill('#password', 'x');
    await chooseDevices(page);
    await page.click('#connectbutton');
    await expect.poll(async () => await page.locator('#peers video').count(),
        {timeout: 30_000}).toBeGreaterThan(0);
    return page;
}

/** How `viewer` shows the tile of the user called `name`. */
async function tileOf(viewer, name) {
    return await viewer.evaluate((name) => {
        const sc = serverConnection;
        const uid = Object.keys(sc.users).find(id => sc.users[id].username === name);
        const streams = uid === sc.id ? Object.values(sc.up) :
            Object.values(sc.down).filter(c => c.source === uid);
        const tile = streams.map(c => document.getElementById('peer-' + c.localId))
            .find(t => t);
        const row = document.getElementById('user-' + uid);
        const rowAv = row && row.querySelector('.up-avatar');
        const rowColour = rowAv && [...rowAv.classList].find(c => /^av-\d+$/.test(c));
        if (!tile)
            return {tile: false, rowColour};
        const v = tile.querySelector('video');
        const av = tile.querySelector(':scope > .stage-person-avatar');
        const label = tile.querySelector(':scope > .stage-person-name, :scope > .stage-person-label');
        const r = av && av.getBoundingClientRect();
        const t = tile.getBoundingClientRect();
        return {
            tile: true,
            nopicture: tile.classList.contains('peer-nopicture'),
            videoVisibility: v ? getComputedStyle(v).visibility : null,
            videoTracks: v && v.srcObject ? v.srcObject.getVideoTracks().length : 0,
            avatar: av ? av.textContent : null,
            avatarColour: av ? [...av.classList].find(c => /^av-\d+$/.test(c)) || null : null,
            avatarBg: av ? getComputedStyle(av).backgroundColor : null,
            avatarInside: av ? (r.width > 0 && r.left >= t.left && r.right <= t.right &&
                                r.top >= t.top && r.bottom <= t.bottom) : null,
            label: label ? label.textContent : null,
            rowColour,
        };
    }, name);
}

async function click(page, id) {
    await page.evaluate((id) => document.getElementById(id).click(), id);
}

test('camera off mid-call shows the person, camera on shows the picture again', async ({browser}) => {
    test.setTimeout(150_000);
    const ctxA = await browser.newContext({colorScheme: SCHEME});
    const ctxB = await browser.newContext({colorScheme: SCHEME});
    for (const c of [ctxA, ctxB])
        await c.grantPermissions(['camera', 'microphone']);
    const A = await join(ctxA, 'alice');
    const B = await join(ctxB, 'bob');
    await expect.poll(async () => await A.locator('#peers video').count(),
        {timeout: 30_000}).toBe(2);
    await expect.poll(async () => (await tileOf(A, 'bob')).videoTracks,
        {timeout: 20_000}).toBe(1);
    expect((await tileOf(A, 'bob')).nopicture).toBe(false);

    // Bob turns the camera off, keeping the microphone.
    await click(B, 'unpresentbutton');
    await expect.poll(async () => (await tileOf(A, 'bob')).nopicture,
        {timeout: 20_000}).toBe(true);
    const off = await tileOf(A, 'bob');
    console.log('camera off, as alice sees bob:', JSON.stringify(off));
    expect(off.videoVisibility, 'the empty <video> is not painted').toBe('hidden');
    expect(off.avatar, 'the avatar carries the initial').toBe('B');
    expect(off.avatarColour, 'the avatar has the list colour').toBe(off.rowColour);
    expect(off.avatarInside, 'the avatar is drawn inside the tile').toBe(true);
    expect(off.label).toContain('bob');
    await A.screenshot({path: `${SHOTS}/videoless-off-alice-${SCHEME}.png`});
    const self = await tileOf(B, 'bob');
    console.log('camera off, bob sees himself:', JSON.stringify(self));
    await B.screenshot({path: `${SHOTS}/videoless-off-bob-${SCHEME}.png`});

    // And back on.
    await click(B, 'presentbutton');
    await expect.poll(async () => {
        const t = await tileOf(A, 'bob');
        return t.videoTracks === 1 && !t.nopicture;
    }, {timeout: 20_000}).toBe(true);
    const on = await tileOf(A, 'bob');
    console.log('camera on again:', JSON.stringify(on));
    expect(on.videoVisibility).toBe('visible');
    expect(on.avatar, 'no avatar over a picture').toBe(null);
    await A.screenshot({path: `${SHOTS}/videoless-on-alice-${SCHEME}.png`});

    expect(A.log.concat(B.log)).toEqual([]);
});
