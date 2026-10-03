// A knock at a full room is refused at the door, in the guest's language,
// and the operator learns of it without a sound.  (sozvon-tasks#2)
//
// Needs groups/lobby-full.json on the stand (copy it from
// test/browser/groups): lobby on, max-clients 2, an "op"
// user with password "op", wildcard guests.  The operator takes one seat, the
// first guest the other.

import {test, expect} from '@playwright/test';

test.afterEach(async ({browser}) => {
    for (const c of browser.contexts())
        await c.close();
});

const ROOM = process.env.SOZVON_FULL_ROOM || 'lobby-full';
const FULL = 'В комнате нет свободных мест. Попробуйте зайти позже.';

async function open(browser, name, password) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    page.errors = [];
    page.on('pageerror', e => page.errors.push(String(e)));
    page.logs = [];
    page.on('console', m => page.logs.push(m.type() + ': ' + m.text()));
    await page.addInitScript(() => {
        try { localStorage.setItem('sozvon-lang', 'ru'); } catch(e) {}
        // Count every sound the page plays: the refusal must make none.
        window.__plays = 0;
        const play = HTMLMediaElement.prototype.play;
        HTMLMediaElement.prototype.play = function() {
            if (this instanceof HTMLAudioElement && !this.srcObject)
                window.__plays++;
            return play.apply(this, arguments);
        };
        // Remember every toast ever shown: they fade on their own.
        window.__toasts = [];
        new MutationObserver(ms => {
            for (const m of ms)
                for (const n of m.addedNodes)
                    if (n.nodeType === 1 && n.classList.contains('toastify'))
                        window.__toasts.push(n.textContent);
        }).observe(document, {childList: true, subtree: true});
    });
    const status = await (await page.request.get(`/group/${ROOM}/.status`)).json()
        .catch(() => null);
    test.skip(!status, `no room "${ROOM}" on this server`);
    await page.goto(`/group/${ROOM}/`);
    await page.fill('#username', name);
    // In a lobby room the password field hides behind "log in as operator".
    if (password && !(await page.locator('#password').isVisible()))
        await page.click('#operator-login-link');
    if (await page.locator('#password').isVisible())
        await page.fill('#password', password || 'x');
    await page.click('#connectbutton');
    return page;
}

const inCall = page => page.evaluate(() =>
    typeof serverConnection !== 'undefined' && !!serverConnection &&
    !!serverConnection.group && serverConnection.permissions !== undefined &&
    document.getElementById('login-container').offsetParent === null &&
    document.getElementById('lobby-waiting').offsetParent === null);

async function operator(browser) {
    const op = await open(browser, 'op', 'op');
    await expect.poll(() => inCall(op), {timeout: 20_000}).toBe(true);
    return op;
}

async function admitFirstKnock(op) {
    const toast = op.locator('.knock-toast').first();
    await expect(toast).toBeVisible({timeout: 15_000});
    await toast.locator('.knock-admit').click();
}

test('a knock at a full room is refused at once, in Russian, and quietly',
     async ({browser}) => {
    const op = await operator(browser);

    // First guest: knocks, is admitted, takes the last seat.
    const first = await open(browser, 'Первый');
    await expect(first.locator('#lobby-waiting')).toBeVisible({timeout: 15_000});
    await admitFirstKnock(op);
    await expect.poll(() => inCall(first), {timeout: 20_000}).toBe(true);

    const playsBefore = await op.evaluate(() => window.__plays);
    expect(playsBefore).toBeGreaterThan(0);   // the real knock did ring

    // Second guest: turned away at the door, never reaches the lobby.
    const second = await open(browser, 'Второй');
    await expect(second.locator('body')).toContainText(FULL, {timeout: 15_000});
    await expect(second.locator('#lobby-waiting')).toBeHidden();
    await expect(second.locator('body')).not.toContainText('too many users');

    // The operator is told, without a sound and without buttons.
    await expect(op.locator('body'))
        .toContainText('Второй: вход отклонён — в комнате нет свободных мест',
                       {timeout: 10_000});
    await op.waitForTimeout(1000);
    expect(await op.evaluate(() => window.__plays)).toBe(playsBefore);
    await expect(op.locator('.knock-toast')).toHaveCount(0);
    await expect(op.locator('#users .knock-p')).toHaveCount(0);

    for (const p of [op, first, second])
        expect(p.errors).toEqual([]);
});

test('two admitted for one seat: the second is refused and leaves the lobby',
     async ({browser}) => {
    const op = await operator(browser);

    const a = await open(browser, 'Анна');
    await expect(a.locator('#lobby-waiting')).toBeVisible({timeout: 15_000});
    const b = await open(browser, 'Борис');
    await expect(b.locator('#lobby-waiting')).toBeVisible({timeout: 15_000});

    await expect(op.locator('.knock-toast')).toHaveCount(2, {timeout: 15_000});
    // Admit both from the participants list, one row at a time: a toast that
    // is fading out still takes a click.
    for (const left of [1, 0]) {
        await op.evaluate(() => {
            const b = document.querySelector('#users .knock-p .knock-admit');
            b.click();
        });
        await expect(op.locator('#users .knock-p')).toHaveCount(left,
                                                              {timeout: 10_000});
    }

    // Exactly one gets in; the other is told why and is not left on
    // "you have been admitted".
    await expect.poll(async () =>
        (await inCall(a) ? 1 : 0) + (await inCall(b) ? 1 : 0),
        {timeout: 20_000}).toBe(1);
    const loser = (await inCall(a)) ? b : a;
    await expect.poll(() => loser.evaluate(() => window.__toasts.join('\n')),
                      {timeout: 15_000}).toContain(FULL);
    await expect(loser.locator('#lobby-waiting')).toBeHidden();

    for (const p of [op, a, b])
        expect(p.errors).toEqual([]);
});
