// A phone that puts the call in the background says so.  (Sozvon)
//
// Measured on a real phone on 2026-10-23 (away.js): the moment the call goes
// into the background the system stops the camera and silences the
// microphone, and the page is told nothing but that it is hidden.  Its
// orientation canvas went on sending the last picture at thirty frames a
// second, so the others saw a still face that looked live, and no one was
// told anything until the server ended the session two minutes later.
//
// Here alice is a phone (touch, coarse pointer: so her camera goes through
// the orientation canvas), and her camera is a canvas this test can stop,
// as the phone's system does.  Hiding is simulated: Chromium will not hide a
// page on request, and what is under test is what the page does when told.

import {test, expect} from '@playwright/test';
import {chooseDevices} from './lib.js';

const ROOM = process.env.SOZVON_ROOM || 'smoke';

test.afterEach(async ({browser}) => {
    for (const c of browser.contexts())
        await c.close();
});

/** A camera that gives frames only while window.cameraRunning is true. */
function stoppableCamera() {
    window.cameraRunning = true;
    const real = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async constraints => {
        const out = new MediaStream();
        if (constraints && constraints.audio)
            (await real({audio: constraints.audio})).getAudioTracks()
                .forEach(t => out.addTrack(t));
        if (constraints && constraints.video) {
            const canvas = document.createElement('canvas');
            canvas.width = 640;
            canvas.height = 480;
            const ctx = canvas.getContext('2d');
            const stream = canvas.captureStream(0);
            const track = stream.getVideoTracks()[0];
            let n = 0;
            setInterval(() => {
                if (!window.cameraRunning)
                    return;
                ctx.fillStyle = `hsl(${(n++ * 7) % 360}, 60%, 50%)`;
                ctx.fillRect(0, 0, 640, 480);
                ctx.fillStyle = '#fff';
                ctx.font = '64px sans-serif';
                ctx.fillText(String(n), 40, 120);
                track.requestFrame();
            }, 1000 / 30);
            out.addTrack(track);
        }
        return out;
    };
}

/** Pretends the page went into the background, or came back. */
function setHidden(hidden) {
    window.pageHidden = hidden;
    if (!window.visibilityPatched) {
        window.visibilityPatched = true;
        Object.defineProperty(document, 'visibilityState', {
            configurable: true,
            get: () => window.pageHidden ? 'hidden' : 'visible',
        });
        Object.defineProperty(document, 'hidden', {
            configurable: true,
            get: () => !!window.pageHidden,
        });
    }
    document.dispatchEvent(new Event('visibilitychange'));
}

async function join(context, name, {phone = false} = {}) {
    const page = await context.newPage();
    page.errors = [];
    page.on('pageerror', e => page.errors.push(String(e)));
    if (phone)
        await page.addInitScript(stoppableCamera);
    await page.goto(`/group/${ROOM}/`);
    await page.waitForSelector('#username', {state: 'visible'});
    await page.fill('#username', name);
    if (await page.locator('#password').isVisible())
        await page.fill('#password', 'x');
    await chooseDevices(page);
    await page.click('#connectbutton');
    await page.waitForFunction(() => typeof serverConnection !== 'undefined' &&
                               !!serverConnection && !!serverConnection.id &&
                               Object.values(serverConnection.up)
                                   .some(c => c.label === 'camera'));
    return page;
}

/** Frames bob has decoded from alice's camera so far. */
function framesFrom(page, name) {
    return page.evaluate(async name => {
        const c = Object.values(serverConnection.down)
            .find(c => c.username === name && c.label === 'camera');
        if (!c)
            return null;
        let n = null;
        (await c.pc.getStats()).forEach(s => {
            if (s.type === 'inbound-rtp' && s.kind === 'video')
                n = s.framesDecoded;
        });
        return n;
    }, name);
}

/** How many frames arrive from alice in ms milliseconds. */
async function framesIn(page, name, ms) {
    const a = await framesFrom(page, name);
    await page.waitForTimeout(ms);
    return (await framesFrom(page, name)) - a;
}

/** Whether bob shows alice as away: on her tile and in the people list. */
function awayShown(page, name) {
    return page.evaluate(name => {
        const c = Object.values(serverConnection.down)
            .find(c => c.username === name && c.label === 'camera');
        const tile = c && document.getElementById('peer-' + c.localId);
        const row = [...document.querySelectorAll('#users > div')]
            .find(r => r.textContent.includes(name));
        return {
            tile: !!tile && tile.classList.contains('peer-away'),
            note: tile ? (tile.querySelector('.peer-away-note') || {}).textContent || '' : '',
            row: !!row && row.classList.contains('user-away'),
        };
    }, name);
}

test('a phone in the background is shown as away, and its canvas stops', async ({browser}) => {
    const alice = await join(await browser.newContext({
        isMobile: true, hasTouch: true, viewport: {width: 412, height: 860},
    }), 'alice', {phone: true});
    const bob = await join(await browser.newContext(), 'bob');

    // alice is a phone, and her camera goes through the orientation canvas
    expect(await alice.evaluate(() => pausesWhenHidden())).toBe(true);
    expect(await alice.evaluate(() => !!Object.values(serverConnection.up)
        .find(c => c.label === 'camera').userdata.filter)).toBe(true);

    await expect.poll(() => framesIn(bob, 'alice', 1000), {timeout: 30_000})
        .toBeGreaterThan(5);
    expect(await awayShown(bob, 'alice')).toEqual({tile: false, note: '', row: false});

    // into the background: the system stops her camera
    await alice.evaluate(() => {
        window.cameraRunning = false;
    });
    await alice.evaluate(setHidden, true);

    await expect.poll(() => awayShown(bob, 'alice'))
        .toMatchObject({tile: true, row: true});
    expect((await awayShown(bob, 'alice')).note).toMatch(/\S/);
    // No frames come through any more.  Before, the canvas went on sending
    // the last picture at thirty a second.
    await expect.poll(() => framesIn(bob, 'alice', 2000), {timeout: 10_000})
        .toBe(0);
    // The paths are not judged while hidden: the phone takes the network
    // away from a page in the background, and on the real phone that made
    // the call give up UDP for six hours.
    const watched = () => alice.evaluate(() =>
        turnWatcher ? turnWatcher.streams.size : 0);
    await alice.waitForTimeout(3000);
    expect(await watched()).toBe(0);

    // back in front: the camera runs again
    await alice.evaluate(() => {
        window.cameraRunning = true;
    });
    await alice.evaluate(setHidden, false);
    await expect.poll(() => awayShown(bob, 'alice'))
        .toEqual({tile: false, note: '', row: false});
    await expect.poll(() => framesIn(bob, 'alice', 1000)).toBeGreaterThan(5);
    // and judged again once it is back
    await expect.poll(watched).toBeGreaterThan(0);

    // a computer does not mark itself: its camera keeps running when hidden
    expect(await bob.evaluate(() => pausesWhenHidden())).toBe(false);
    await bob.evaluate(setHidden, true);
    await alice.waitForTimeout(2000);
    expect(await awayShown(alice, 'bob')).toEqual({tile: false, note: '', row: false});

    expect(alice.errors).toEqual([]);
    expect(bob.errors).toEqual([]);
});

test('a call that dropped in the background says so when it is back', async ({browser}) => {
    const alice = await join(await browser.newContext({
        isMobile: true, hasTouch: true, viewport: {width: 412, height: 860},
    }), 'alice', {phone: true});
    const bob = await join(await browser.newContext(), 'bob');
    await expect.poll(() => framesIn(bob, 'alice', 1000), {timeout: 30_000})
        .toBeGreaterThan(5);
    const before = await alice.evaluate(() => serverConnection.id);

    await alice.evaluate(setHidden, true);
    // What the background did on the phone: the session could not be
    // resumed and is joined afresh.  Dropping the resume secret leaves the
    // client nothing to resume with.
    await alice.evaluate(() => {
        serverConnection.resumeSecret = null;
        serverConnection.socket.close();
    });
    await alice.waitForFunction(before => typeof serverConnection !== 'undefined' &&
                                !!serverConnection && !!serverConnection.id &&
                                serverConnection.id !== before &&
                                !!serverConnection.socket, before,
                                {timeout: 60_000});
    await expect(alice.locator('.toastify', {
        hasText: await alice.evaluate(() => Sozvon.i18n.t('toast.reconnectedAfterAway')),
    })).toBeVisible();

    // Still in the background after the rejoin, and the others are told
    // again.  Asked of the new session: the old one lingers on the server
    // until it times out.
    const after = await alice.evaluate(() => serverConnection.id);
    // The rejoin says {"muted": null} and then {"away": true}, one after
    // the other: the server once delivered them the wrong way round.
    const awayOf = id => bob.evaluate(id => {
        const u = serverConnection.users[id];
        return u ? !!(u.data && u.data.away) : null;
    }, id);
    await expect.poll(() => awayOf(after)).toBe(true);

    await alice.evaluate(setHidden, false);
    await expect.poll(() => awayOf(after)).toBe(false);
    // and that was the session it came back in: it was not ended under it
    expect(await alice.evaluate(() => serverConnection.id)).toBe(after);
    expect(alice.errors).toEqual([]);
});
