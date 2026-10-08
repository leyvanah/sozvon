// Manual driver for device checks: joins as "bob" with a fake camera, then
// turns the camera off and on when marker files appear in $STEP_DIR
// (off, on, done).  Not a test of anything by itself; run only with
// STEP_DIR set, e.g. while a real phone watches the call.

import {test, expect} from '@playwright/test';
import {chooseDevices} from '../lib.js';
import fs from 'node:fs';
import path from 'node:path';

const STEP_DIR = process.env.STEP_DIR;
test.skip(!STEP_DIR, 'manual driver: set STEP_DIR');

const waitFor = async (name) => {
    while (!fs.existsSync(path.join(STEP_DIR, name)))
        await new Promise(r => setTimeout(r, 500));
};
const mark = (name) => fs.writeFileSync(path.join(STEP_DIR, name), '');

test('bob drives the camera for a watching device', async ({browser}) => {
    test.setTimeout(900_000);
    const ctx = await browser.newContext();
    await ctx.grantPermissions(['camera', 'microphone']);
    const page = await ctx.newPage();
    await page.goto(`/group/${process.env.SOZVON_ROOM || 'smoke'}/`);
    await page.fill('#username', 'bob');
    await chooseDevices(page);
    await page.click('#connectbutton');
    await expect.poll(async () => await page.locator('#peers video').count(),
        {timeout: 30_000}).toBeGreaterThan(0);
    mark('bob-in');

    await waitFor('off');
    await page.evaluate(() => document.getElementById('unpresentbutton').click());
    mark('bob-off');

    await waitFor('on');
    await page.evaluate(() => document.getElementById('presentbutton').click());
    mark('bob-on');

    await waitFor('done');
});
