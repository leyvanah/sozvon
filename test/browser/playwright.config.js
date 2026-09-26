// Browser tests: two real clients in one Chromium.  See README.md here.
//
// The fake-device flags are the whole point of this file: they give Chromium a
// synthetic camera (rolling colour bars) and microphone (a beep), so two
// clients can hold a real call on one laptop with no webcam, and the media path
// is exercised for real rather than mocked.

import {defineConfig} from '@playwright/test';

export default defineConfig({
    testDir: '.',
    // manual/ holds drivers for checks a person watches on a real device;
    // they wait for marker files and test nothing on their own.
    testIgnore: process.env.STEP_DIR ? [] : ['manual/**'],
    // One test at a time: every test joins the same room on the same stand, so
    // parallel runs would see each other's participants.
    workers: 1,
    fullyParallel: false,
    // A call needs time to negotiate; the default 30 s is tight once two
    // clients, a handshake and a keyframe are involved.
    timeout: 180_000,
    expect: {timeout: 20_000},
    reporter: [['list']],
    use: {
        baseURL: process.env.SOZVON_URL || 'http://localhost:8443',
        // The stand is http://localhost, which is a secure context, so no
        // certificate handling is needed.  Kept anyway for the HTTPS stand.
        ignoreHTTPSErrors: true,
        video: 'off',
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
        launchOptions: {
            args: [
                '--use-fake-device-for-media-stream',
                '--use-fake-ui-for-media-stream',
                '--autoplay-policy=no-user-gesture-required',
            ],
        },
    },
});
