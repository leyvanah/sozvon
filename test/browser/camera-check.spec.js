// A published camera tells the connection log how far its picture got.
// (Sozvon)
//
// On 2026-10-21 a guest's camera opened nine times and not one video packet
// left her browser, her own preview empty too; the log could only say that
// nothing arrived.  camera-diag.js now has the client report, a few seconds
// after publishing, each step from the camera to the wire with its own count.
// Such a report is only evidence if the counts are real, so this checks in a
// real Chromium that a working camera reports every step as non-zero -- plain
// and through the orientation canvas -- and that a canvas whose hidden element
// is refused playback says so; and that the server writes the line.

import fs from 'node:fs';
import {test, expect} from '@playwright/test';
import {chooseDevices} from './lib.js';

const ROOM = process.env.SOZVON_ROOM || 'smoke';
// run.sh starts the server with -log-connections and says where it logs
const SERVER_LOG = process.env.SOZVON_SERVER_LOG;

test.afterEach(async ({browser}) => {
    for (const c of browser.contexts())
        await c.close();
});

async function join(context, name) {
    const page = await context.newPage();
    page.errors = [];
    page.on('pageerror', e => page.errors.push(String(e)));
    await page.addInitScript(() => {
        window.cameraReports = [];
    });
    await page.goto(`/group/${ROOM}/`);
    await page.waitForSelector('#username', {state: 'visible'});
    await page.fill('#username', name);
    if (await page.locator('#password').isVisible())
        await page.fill('#password', 'x');
    await chooseDevices(page);
    await page.click('#connectbutton');
    await page.waitForFunction(() => typeof serverConnection !== 'undefined' &&
                               !!serverConnection && !!serverConnection.socket);
    await page.evaluate(() => {
        const send = serverConnection.send.bind(serverConnection);
        serverConnection.send = m => {
            if (m && m.type === 'sozvon-quality' && m.kind === 'camera')
                window.cameraReports.push(m);
            return send(m);
        };
    });
    await expect.poll(() => cameraId(page), {timeout: 30_000}).not.toBeNull();
    return page;
}

/** The camera up stream now published. */
function cameraId(page) {
    return page.evaluate(() => {
        const c = Object.values(serverConnection.up)
            .find(c => c.label === 'camera');
        return c ? c.id : null;
    });
}

/** Waits for the camera report of up stream id and returns its value. */
async function reportOf(page, id) {
    await page.waitForFunction(id => window.cameraReports.some(m => m.id === id),
                               id, {timeout: 30_000});
    return await page.evaluate(id => window.cameraReports.find(m => m.id === id).value,
                               id);
}

/** Publishes the camera again, as a device or setting change does. */
async function republish(page, before) {
    await page.evaluate(() => replaceCameraStream());
    await expect.poll(() => cameraId(page)).not.toBe(before);
    const id = await cameraId(page);
    expect(id).not.toBeNull();
    return id;
}

/** The server's line for a report, once it is written. */
async function serverLine(after) {
    let line = null;
    await expect.poll(() => {
        const log = fs.readFileSync(SERVER_LOG, 'utf8').split('\n')
            .slice(after);
        line = log.find(l => / camera after \d+s: /.test(l)) || null;
        return line;
    }, {timeout: 10_000}).not.toBeNull();
    return line;
}

const logLength = () => SERVER_LOG ?
    fs.readFileSync(SERVER_LOG, 'utf8').split('\n').length - 1 : 0;

test('a working camera reports every step, and the server logs it', async ({browser}) => {
    test.skip(!SERVER_LOG, 'needs the server log: run through run.sh');
    const page = await join(await browser.newContext(), 'alice');
    const mark = logLength();
    const id = await cameraId(page);
    expect(id).not.toBeNull();

    const r = await reportOf(page, id);
    console.log('plain camera:', JSON.stringify(r));
    expect(r.canvas).toBe('none');
    expect(r.track).toBe('live');
    expect(r.muted).toBe(false);
    expect(r.os).toMatch(/^(windows|mac|other)$/);
    expect(r.browser).toBe('chrome');
    expect(r.after).toBeGreaterThanOrEqual(5);
    expect(r.width).toBeGreaterThan(0);
    // every counter Chromium reports, and each one is past zero
    for (const k of ['source', 'encoded', 'sent', 'preview'])
        expect(r[k], k).toBeGreaterThan(0);
    expect(r.play).toBeNull();
    expect(r.drawn).toBeNull();

    const line = await serverLine(mark);
    console.log('server:', line);
    expect(line).toMatch(/ up=[0-9a-f]{6} camera after \d+s: \w+\/chrome; track live \d+x\d+/);
    expect(line).toMatch(/; no canvas; sender got [1-9]\d* frames, encoded [1-9]\d*, sent [1-9]\d* packets; preview [1-9]\d* frames$/);
    expect(page.errors).toEqual([]);
});

test('through the orientation canvas, the element and its draws count too', async ({browser}) => {
    const page = await join(await browser.newContext(), 'alice');
    const first = await cameraId(page);
    // a manual rotation routes even a desktop camera through the canvas
    await page.evaluate(() => updateSettings({videoRotation: 90}));
    const id = await republish(page, first);

    const r = await reportOf(page, id);
    console.log('orientation canvas:', JSON.stringify(r));
    expect(r.canvas).toBe('orientation');
    expect(r.track).toBe('live');
    expect(r.play).toBe('ok');
    expect(r.paused).toBe(false);
    expect(r.ready).toBeGreaterThanOrEqual(2);
    expect(r.elementWidth).toBeGreaterThan(0);
    for (const k of ['drawn', 'source', 'encoded', 'sent', 'preview'])
        expect(r[k], k).toBeGreaterThan(0);
    expect(page.errors).toEqual([]);
});

test('a canvas whose hidden element is refused playback says so', async ({browser}) => {
    const page = await join(await browser.newContext(), 'alice');
    const first = await cameraId(page);
    // What a browser that will not play an element outside the page would
    // do (an autoplay policy, a power-saving mode): play() is refused and
    // the element stays paused.  Elements in the page play as before.
    await page.evaluate(() => {
        const play = HTMLMediaElement.prototype.play;
        HTMLMediaElement.prototype.play = function() {
            if (this.isConnected)
                return play.call(this);
            return Promise.reject(new DOMException('refused', 'NotAllowedError'));
        };
        updateSettings({videoRotation: 90});
    });
    const id = await republish(page, first);

    const r = await reportOf(page, id);
    console.log('refused element:', JSON.stringify(r));
    expect(r.canvas).toBe('orientation');
    expect(r.track).toBe('live');
    expect(r.play).toBe('NotAllowedError');
    expect(r.paused).toBe(true);
    // Chromium still hands a paused element's latest frame to the canvas,
    // so here the picture gets through all the same; a browser that does
    // not would show drawn 0.  Either way the counters are there to say.
    for (const k of ['drawn', 'source', 'encoded', 'sent', 'preview'])
        expect(typeof r[k], k).toBe('number');
});
