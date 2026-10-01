// A guest's name never reaches the server, and a made-up name is never
// shown.  (Sozvon)
//
// Two guests join a room with end-to-end encryption.  The server must only
// ever see pseudonyms -- checked from the other side, which gets everyone's
// username from the server -- while each guest sees the other's real name
// on the tile, in the list and on chat, once the handshake is done.  At no
// point may a pseudonym appear anywhere on either page.

import {test, expect} from '@playwright/test';

test.afterEach(async ({browser}) => {
    for (const c of browser.contexts())
        await c.close();
});

const ROOM = process.env.SOZVON_E2EE_ROOM || 'e2ee-strict';
const PSEUDONYM = /~[a-z2-9]{10}/;

async function open(context, path) {
    const page = await context.newPage();
    page.errors = [];
    page.on('pageerror', e => page.errors.push(String(e)));
    await page.addInitScript(() => {
        try { localStorage.setItem('sozvon-lang', 'ru'); } catch(e) {}
        // Watch the page for a pseudonym, from the first paint on.
        window.__pseudonymSeen = null;
        setInterval(() => {
            const text = document.body ? document.body.innerText : '';
            const m = /~[a-z2-9]{10}/.exec(text);
            if (m && !window.__pseudonymSeen)
                window.__pseudonymSeen = m[0];
        }, 100);
    });
    await page.goto(path);
    return page;
}

async function join(context, name) {
    const page = await open(context, `/group/${ROOM}/`);
    await page.fill('#username', name);
    for (const id of ['#precheck-cam', '#precheck-mic']) {
        await page.click(id);
        await expect(page.locator(id)).toHaveAttribute(
            'aria-pressed', 'true', {timeout: 45_000});
    }
    await page.click('#connectbutton');
    await expect.poll(async () => await page.locator('#peers video').count(),
                      {timeout: 30_000}).toBeGreaterThan(0);
    return page;
}

// What the server told this page about everyone else.
const serverNames = page => page.evaluate(() =>
    Object.entries(serverConnection.users)
        .filter(([id]) => id !== serverConnection.id)
        .map(([, u]) => u.username));

test('guests see each other\'s names; the server sees pseudonyms only',
     async ({browser}) => {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    for (const c of [ctxA, ctxB])
        await c.grantPermissions(['camera', 'microphone']);

    const A = await join(ctxA, 'Анна Петрова');
    const B = await join(ctxB, 'Борис');

    // The server knows them by pseudonyms only.
    for (const [page, other] of [[A, 'Борис'], [B, 'Анна Петрова']]) {
        await expect.poll(() => serverNames(page), {timeout: 20_000})
            .toHaveLength(1);
        const [seen] = await serverNames(page);
        expect(seen).toMatch(PSEUDONYM);
        expect(seen).not.toContain(other);
    }
    expect(await A.evaluate(() => serverConnection.username)).toMatch(PSEUDONYM);

    // Once encrypted, each sees the other's real name.
    await expect(B.locator('#users')).toContainText('Анна Петрова',
                                                     {timeout: 30_000});
    await expect(A.locator('#users')).toContainText('Борис');
    await expect(B.locator('.peer-remote .label').first())
        .toHaveText('Анна Петрова');
    await expect(A.locator('.peer-remote .label').first()).toHaveText('Борис');
    // and their own, typed, name in the header
    await expect(A.locator('#userspan')).toHaveText('Анна Петрова');

    // Chat carries the real name too.
    await A.fill('#input', 'привет');
    await A.press('#input', 'Enter');
    await expect(B.locator('#box .message-user').last())
        .toHaveText('Анна Петрова', {timeout: 10_000});

    for (const p of [A, B]) {
        expect(await p.evaluate(() => window.__pseudonymSeen)).toBeNull();
        expect(p.errors).toEqual([]);
    }
});

test('a name after # in a link fills in the guest\'s name and leaves the address',
     async ({browser}) => {
    const ctx = await browser.newContext();
    const page = await open(ctx, `/group/${ROOM}/#name=` +
                            encodeURIComponent('Вера Н.'));
    await expect(page.locator('#username')).toHaveValue('Вера Н.');
    expect(await page.evaluate(() => location.hash)).toBe('');
    expect(page.errors).toEqual([]);
});

test('an operator link carries the client\'s name after #, never to the server',
     async ({browser}) => {
    const HUB = process.env.SOZVON_HUB_ROOM || 'operator-e2ee';
    const ctx = await browser.newContext();
    const page = await open(ctx, `/group/${HUB}/`);
    test.skip(!(await page.evaluate(() => !!groupStatus.operatorRoom &&
                                           !!groupStatus.e2ee)),
              `no E2EE operator room "${HUB}" on this server`);
    await page.fill('#username', 'op');
    await page.fill('#password', 'op');
    await page.click('#connectbutton');
    await expect(page.locator('#operator-room')).toBeVisible({timeout: 20_000});

    await page.click('#operator-advanced-toggle');
    await page.fill('#operator-label', 'Анна П.');
    await page.fill('#operator-clientname', 'Анна Петрова');
    await page.click('.operator-create-btn');

    const row = page.locator('.operator-link').first();
    await expect(row.locator('.operator-link-label')).toHaveText('Анна П.',
                                                                 {timeout: 20_000});
    const url = await row.locator('.operator-url-input').inputValue();
    const [base, hash] = url.split('#');
    expect(new URLSearchParams(hash || '').get('name')).toBe('Анна Петрова');
    expect(base.toLowerCase()).not.toMatch(/anna|petrov/);

    // What the server keeps: no username, a room name that says nothing.
    // (the operator's own session tokens rightly carry the operator's name)
    const token = new URL(base).searchParams.get('token');
    const stored = await page.evaluate(tok => operatorRoom.tokens
        .filter(t => t.token === tok)
        .map(t => ({username: t.username || null, group: t.group})), token);
    expect(stored).toHaveLength(1);
    expect(stored[0].username).toBeNull();
    expect(stored[0].group.toLowerCase()).not.toMatch(/anna|petrov/);

    // The client opens it: the name is filled in.
    const guest = await open(await browser.newContext(), url);
    await expect(guest.locator('#username')).toHaveValue('Анна Петрова',
                                                         {timeout: 20_000});

    for (const p of [page, guest]) {
        expect(await p.evaluate(() => window.__pseudonymSeen)).toBeNull();
        expect(p.errors).toEqual([]);
    }
});
