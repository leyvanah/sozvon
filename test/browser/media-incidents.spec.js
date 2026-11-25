import fs from 'node:fs';
import {test, expect} from '@playwright/test';
import {chooseDevices} from './lib.js';

const ROOM = process.env.SOZVON_ROOM || 'smoke';
const SERVER_LOG = process.env.SOZVON_SERVER_LOG;

test.afterEach(async ({browser}) => {
    for (const context of browser.contexts())
        await context.close();
});

async function join(context, name, reports) {
    const page = await context.newPage();
    page.on('websocket', socket => {
        socket.on('framesent', ({payload}) => {
            const message = JSON.parse(payload.toString());
            if (message.type === 'sozvon-quality' && message.kind === 'media-incident')
                reports.push(message);
        });
    });
    await page.goto(`/group/${ROOM}/`);
    await page.fill('#username', name);
    if (await page.locator('#password').isVisible())
        await page.fill('#password', 'x');
    await chooseDevices(page, {mic: false});
    await page.click('#connectbutton');
    await page.waitForFunction(() => document.querySelector('.peer-self video')?.videoWidth > 0);
    return page;
}

test('reports a gray tile with flowing video and a later playback stall', async ({browser}) => {
    test.skip(!SERVER_LOG, 'needs the server log: run through run.sh');
    const mark = fs.statSync(SERVER_LOG).size;
    const senderReports = [];
    const receiverReports = [];
    await join(await browser.newContext(), 'alice', senderReports);
    const receiver = await join(await browser.newContext(), 'bob', receiverReports);
    const video = receiver.locator('.peer-remote video');
    await receiver.waitForFunction(() => {
        const stream = Object.values(serverConnection.down).find(c => c.label === 'camera');
        return stream?.userdata.mediaIncident?.tracker.ready;
    });
    expect(senderReports).toEqual([]);
    expect(receiverReports).toEqual([]);

    // Only the receiver's ICE event changes. The synthetic video keeps playing.
    await receiver.evaluate(() => {
        const stream = Object.values(serverConnection.down).find(c => c.label === 'camera');
        Object.defineProperty(stream.pc, 'iceConnectionState', {
            value: 'disconnected', configurable: true,
        });
        stream.pc.dispatchEvent(new Event('iceconnectionstatechange'));
    });
    await expect(video).toHaveClass(/\bmedia-failed\b/);
    await video.evaluate(el => new Promise(resolve => el.requestVideoFrameCallback(() =>
        el.requestVideoFrameCallback(() => resolve()))));
    await receiver.evaluate(() => {
        const stream = Object.values(serverConnection.down).find(c => c.label === 'camera');
        delete stream.pc.iceConnectionState;
        stream.pc.dispatchEvent(new Event('iceconnectionstatechange'));
    });
    await expect(video).not.toHaveClass(/\bmedia-failed\b/);
    await expect.poll(() => receiverReports.map(m => m.value.event)).toEqual(['gray-on', 'gray-off']);
    expect(receiverReports[1].value.presented).toBeGreaterThan(0);

    // Pausing the receiver's element leaves the sender and its transport live.
    await video.evaluate(el => el.pause());
    const report = event => receiverReports.find(m => m.value.event === event)?.value;
    await expect.poll(() => report('stalled')?.presented).toBe(0);
    expect(report('stalled').packets).toBeGreaterThan(0);
    expect(report('stalled').ice).toMatch(/^(connected|completed)$/);
    await video.evaluate(el => el.play());
    await expect.poll(() => report('resumed')?.presented).toBeGreaterThan(0);
    expect(senderReports).toEqual([]);

    const allowedFields = new Set(['event', 'ice', 'path', 'hidden', 'age', 'ms',
        'packets', 'lost', 'source', 'encoded', 'received', 'decoded', 'presented']);
    for (const message of receiverReports) {
        expect(Object.keys(message).sort()).toEqual(['id', 'kind', 'type', 'value']);
        expect(Object.keys(message.value).filter(key => !allowedFields.has(key))).toEqual([]);
    }
    const log = () => fs.readFileSync(SERVER_LOG).subarray(mark).toString('utf8');
    await expect.poll(log).toMatch(/c=[0-9a-f]{6} down=[0-9a-f]{6} media incident gray-on ice=disconnected/);
    await expect.poll(log).toMatch(/media incident gray-off[^\n]*presented=[1-9]\d*/);
    await expect.poll(log).toMatch(/media incident stalled[^\n]*presented=0/);
    await expect.poll(log).toMatch(/media incident resumed[^\n]*presented=[1-9]\d*/);
});
