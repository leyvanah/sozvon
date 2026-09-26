// Call quality indicator (leyvanah/sozvon-tasks#28).
//
// A real network cannot be degraded on demand from here, so the statistics
// are: RTCPeerConnection.prototype.getStats is wrapped in bob's page to add
// lost packets to every inbound stream.  Everything downstream of getStats --
// the classifier, the hysteresis, the tile indicator and its caption, the
// language -- runs for real.  Since 2026-09-23 there are no quality toasts;
// the test checks that none come back.

import {test, expect} from '@playwright/test';
import {chooseDevices} from './lib.js';

// Contexts made with browser.newContext() outlive a failed or skipped test,
// and every spec joins the same room: a leftover participant turns the next
// test's one remote tile into three.  Close them whatever happened.
test.afterEach(async ({browser}) => {
    for (const c of browser.contexts())
        await c.close();
});

const ROOM = process.env.SOZVON_ROOM || 'smoke';

async function join(context, name) {
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    page.errors = errors;
    // Russian interface, so the test also proves the strings are translated.
    await page.addInitScript(() => {
        try { localStorage.setItem('sozvon-lang', 'ru'); } catch(e) {}
        // Degradation switch: window.__loss = fraction of packets to report
        // lost on top of what really arrived.
        window.__loss = 0;
        const orig = RTCPeerConnection.prototype.getStats;
        RTCPeerConnection.prototype.getStats = async function(...args) {
            const report = await orig.apply(this, args);
            if(!window.__loss || args.length)
                return report;
            const out = new Map();
            for(const [k, r] of report) {
                if(r.type === 'inbound-rtp') {
                    this.__lost = this.__lost || {};
                    const extra = Math.round(r.packetsReceived *
                        window.__loss / (1 - window.__loss));
                    this.__lost[k] = Math.max(this.__lost[k] || 0, extra);
                    out.set(k, {...r, packetsLost:
                        (r.packetsLost || 0) + this.__lost[k]});
                } else {
                    out.set(k, r);
                }
            }
            return out;
        };
    });
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

test('degraded link shows the indicator with a translated caption, no toasts', async ({browser}) => {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    for (const c of [ctxA, ctxB])
        await c.grantPermissions(['camera', 'microphone']);

    const A = await join(ctxA, 'Лена');
    const B = await join(ctxB, 'bob');
    await expect.poll(async () => await B.locator('#peers video').count(),
                      {timeout: 30_000}).toBe(2);

    // Count every quality toast from here on, including ones that come and
    // go between two checks.
    for (const p of [A, B])
        await p.evaluate(() => {
            window.__qtoasts = 0;
            new MutationObserver(ms => {
                for (const m of ms)
                    for (const n of m.addedNodes)
                        if (n instanceof Element &&
                            n.classList.contains('toastify') &&
                            /связь/i.test(n.textContent))
                            window.__qtoasts++;
            }).observe(document.body, {childList: true, subtree: true});
        });

    // Healthy call: no indicator is visible.  Waited for rather than sampled
    // at a fixed moment: on a busy machine the start of a call really is
    // degraded for a while (the indicator is right to say so), and a sample
    // taken then failed the push for a reason that had nothing to do with
    // the change being pushed.  A call that never settles still fails.
    await expect(B.locator('.conn-quality:visible')).toHaveCount(0, {timeout: 45_000});

    // Degrade what bob receives.  Cumulative loss grows with every packet,
    // so the per-interval loss equals __loss.
    await B.evaluate(() => { window.__loss = 0.2; });

    const remote = B.locator('.peer-remote .conn-quality');
    await expect(remote).toBeVisible({timeout: 15_000});
    await expect(remote).toHaveAttribute('data-level', 'bad');
    await expect(remote.locator('.conn-quality-text'))
        .toHaveText('Плохая связь');
    await expect(remote).toHaveAttribute('title', /^Лена: связь плохая/);
    await B.screenshot({path: 'test-results/quality-bad.png'});

    // Recover: the indicator goes away.
    await B.evaluate(() => { window.__loss = 0; });
    await expect(remote).toBeHidden({timeout: 30_000});
    await B.waitForTimeout(3000);
    // Nobody got a toast about the link at any point.
    for (const p of [A, B])
        expect(await p.evaluate(() => window.__qtoasts)).toBe(0);

    expect(A.errors).toEqual([]);
    expect(B.errors).toEqual([]);
    await ctxA.close();
    await ctxB.close();
});
