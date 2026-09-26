// Shared by the specs.

import {expect} from '@playwright/test';

// Opening a (fake) device is the first thing to starve on a busy machine: at
// 20 s the preview timed out twice in eight runs with every core busy and a
// go test running beside it.  Waiting for a state, so a longer limit only
// costs time when something is really wrong.
const DEVICE_TIMEOUT = 45_000;

/**
 * Turn devices on in the pre-join check and wait until each toggle is really
 * on -- aria-pressed, which the page sets only once the device has opened --
 * and the camera preview shows a picture.
 *
 * Clicking and moving on is not the same thing: the toggle becomes "on" only
 * after getUserMedia returns, and a join clicked before that goes in without
 * the device.  On a busy machine that took a third of tile-mic runs: alice
 * joined with no microphone and the test, rightly, saw her marked silent.
 */
export async function chooseDevices(page, {cam = true, mic = true} = {}) {
    for (const [on, id] of [[cam, '#precheck-cam'], [mic, '#precheck-mic']]) {
        if (!on)
            continue;
        await page.click(id);
        await expect(page.locator(id)).toHaveAttribute('aria-pressed', 'true',
                                                       {timeout: DEVICE_TIMEOUT});
    }
    if (cam)
        await page.waitForFunction(() => {
            const v = document.getElementById('precheck-video');
            return v && v.videoWidth > 0;
        }, null, {timeout: DEVICE_TIMEOUT});
}
