// An operator signed in on this device stays signed in: after a browser
// restart, after the laptop has slept through the reconnect cycle, and when
// opening a client's link.  (Sozvon)
//
// Needs an operator room on the stand: groups/operator-e2ee.json from
// test/browser/groups (user "op", password "op").

import {test, expect} from '@playwright/test';

test.afterEach(async ({browser}) => {
    for (const c of browser.contexts())
        await c.close();
});

const HUB = process.env.SOZVON_HUB_ROOM || 'operator-e2ee';
const RECONNECT_LAST = 15;   // RECONNECT_MAX_ATTEMPTS in galene.js

async function open(context, path) {
    const page = await context.newPage();
    page.errors = [];
    page.logs = [];
    page.on('pageerror', e => page.errors.push(String(e)));
    page.on('console', m => page.logs.push(m.type() + ': ' + m.text()));
    await page.addInitScript(() => {
        try { localStorage.setItem('sozvon-lang', 'ru'); } catch(e) {}
    });
    await page.goto(path);
    return page;
}

// Log in at the hub with "remember me"; returns the page, still connected.
async function operatorAtHub(browser) {
    const ctx = await browser.newContext();
    const page = await open(ctx, `/group/${HUB}/`);
    test.skip(!(await page.evaluate(() => !!groupStatus.operatorRoom)),
              `no operator room "${HUB}" on this server`);
    await page.fill('#username', 'op');
    await page.fill('#password', 'op');
    await page.check('#remember');
    await page.click('#connectbutton');
    await expect(page.locator('#operator-room')).toBeVisible({timeout: 20_000});
    await expect.poll(() => page.evaluate(() =>
        localStorage.getItem('sozvon.remember')), {timeout: 10_000})
        .toContain('"includeSubgroups":true');
    return page;
}

// What survives a browser restart: localStorage, not sessionStorage.
async function rememberedOperator(browser) {
    const page = await operatorAtHub(browser);
    const state = await page.context().storageState();
    await page.context().close();
    return state;
}

test('a remembered operator lands in the operator room after a browser restart',
     async ({browser}) => {
    const state = await rememberedOperator(browser);
    const ctx = await browser.newContext({storageState: state});
    const page = await open(ctx, `/group/${HUB}/`);
    await expect(page.locator('#operator-room')).toBeVisible({timeout: 20_000});
    await page.waitForTimeout(5000);
    await expect(page.locator('#operator-room')).toBeVisible();
    await expect(page.locator('#rejoin-container')).toBeHidden();
    expect(page.errors).toEqual([]);
});

// The laptop sleeps: the network goes away, the socket dies, and every
// reconnect attempt fails for longer than the reconnect cycle used to last.
// When the network is back the operator must be back in the operator room on
// their own -- not on a "join as <blank>" card that only a reload gets past,
// which is what production showed after a night's sleep (2026-10-03).
test('an operator room comes back by itself after a long network outage',
     async ({browser}) => {
    const state = await rememberedOperator(browser);
    const ctx = await browser.newContext({storageState: state});
    const page = await open(ctx, `/group/${HUB}/`);
    await expect(page.locator('#operator-room')).toBeVisible({timeout: 20_000});
    // A reload, as in production: now the session token logs us in, and it
    // sends no name of its own.
    await page.reload();
    await expect(page.locator('#operator-room')).toBeVisible({timeout: 20_000});
    expect(await page.evaluate(() => getInputElement('username').value)).toBe('');

    await ctx.setOffline(true);
    await page.evaluate(() => serverConnection.socket.close());
    // Skip the six minutes of backoff: the next failed attempt is the one
    // that used to be the last.
    await page.evaluate(() => { reconnectAttempt = RECONNECT_MAX_ATTEMPTS; });
    // The resume cycle tries for 110 s, then the reconnect cycle takes over.
    await expect.poll(() => page.evaluate(() => reconnectAttempt),
                      {timeout: 200_000, intervals: [5000]})
        .toBeGreaterThan(RECONNECT_LAST + 1);
    expect(await page.evaluate(() => wantConnected && reconnecting)).toBe(true);
    await expect(page.locator('#rejoin-container')).toBeHidden();
    // and had it shown the card, it would have named the operator
    expect(await page.evaluate(() => reconnectName)).toBe('op');

    // The network comes back: in at once, not at the next half-minute tick.
    await ctx.setOffline(false);
    await expect.poll(() => page.evaluate(() =>
        !!serverConnection && !!serverConnection.socket &&
        serverConnection.socket.readyState === 1 && !!serverConnection.group &&
        !reconnecting), {timeout: 10_000}).toBe(true);
    await expect(page.locator('#operator-room')).toBeVisible();
    expect(page.errors).toEqual([]);
});

// An operator remembered on this device opens a client's link: in as the
// operator, never asked for a name.  And if the operator's token is no longer
// good, the link still works as the client's link.
test('a remembered operator opening a client link comes in as the operator',
     async ({browser}) => {
    const hub = await operatorAtHub(browser);
    await hub.click('#operator-advanced-toggle');
    await hub.fill('#operator-clientname', 'Анна Петрова');
    await hub.click('.operator-create-btn');
    const row = hub.locator('.operator-link').first();
    await expect(row.locator('.operator-url-input')).toHaveValue(/token=/,
                                                                 {timeout: 20_000});
    const url = await row.locator('.operator-url-input').inputValue();
    const state = await hub.context().storageState();

    // A cold browser opens the link.
    const ctx = await browser.newContext({storageState: state});
    const page = await open(ctx, url);
    // At most one click, for the browser's autoplay rule; never a name or a
    // password, and never the client's name.
    await expect(page.locator('#connectbutton')).toBeVisible({timeout: 20_000});
    await page.waitForTimeout(1000);
    await expect(page.locator('#password')).toBeHidden();
    expect(await page.evaluate(() => getInputElement('username').value))
        .not.toBe('Анна Петрова');
    await page.click('#connectbutton');
    await expect.poll(() => page.evaluate(() => !!serverConnection &&
        !!serverConnection.group && serverConnection.permissions),
        {timeout: 20_000}).toContain('op');
    expect(await page.evaluate(() => serverConnection.username)).toBe('op');
    expect(page.errors).toEqual([]);

    // The same link with the operator's token revoked: a client's link again.
    await hub.evaluate(() => {
        const all = JSON.parse(localStorage.getItem('sozvon.remember'));
        for (const g in all)
            revokeToken(all[g].token);
    });
    await hub.waitForTimeout(1000);
    const ctx2 = await browser.newContext({storageState: state});
    const guest = await open(ctx2, url);
    await expect.poll(() => guest.evaluate(() => probingState),
                      {timeout: 20_000}).toBe('need-username');
    // offered the client's name, as the link meant
    await expect(guest.locator('#username')).toHaveValue('Анна Петрова');
    expect(guest.errors).toEqual([]);
});
