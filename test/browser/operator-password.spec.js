// An operator changes their own password from the operator panel.  (Sozvon)
//
// Needs, on the stand: groups/operator-password.json from test/browser/groups
// (user "op", password "op-password-1"), and data/config.json with
// "writableGroups": true -- without it the server may not rewrite the group
// file and the panel does not offer the change.  The test puts the password
// back when it is done.

import {test, expect} from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

test.afterEach(async ({browser}) => {
    for (const c of browser.contexts())
        await c.close();
});

const HUB = 'operator-password';
const FIRST = 'op-password-1';
const SECOND = 'новый-пароль-2';
const FILE = path.resolve(import.meta.dirname, '../../groups', `${HUB}.json`);

async function login(browser, password) {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    page.errors = [];
    page.on('pageerror', e => page.errors.push(String(e)));
    await page.addInitScript(() => {
        try { localStorage.setItem('sozvon-lang', 'ru'); } catch(e) {}
    });
    await page.goto(`/group/${HUB}/`);
    test.skip(!(await page.evaluate(() => !!groupStatus.operatorRoom)),
              `no operator room "${HUB}" on this server`);
    await page.fill('#username', 'op');
    await page.fill('#password', password);
    await page.click('#connectbutton');
    return page;
}

async function inPanel(page) {
    await expect(page.locator('#operator-room')).toBeVisible({timeout: 20_000});
}

async function change(page, current, next, again = next) {
    const form = page.locator('#operator-password-form');
    if (!(await form.isVisible()))
        await page.click('#operator-password-toggle');
    await page.fill('#operator-password-current', current);
    await page.fill('#operator-password-new', next);
    await page.fill('#operator-password-again', again);
    await page.click('#operator-password-save');
}

const message = page => page.locator('#operator-password-message');

test('an operator changes their own password from the panel',
     async ({browser}) => {
    const before = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    const page = await login(browser, FIRST);
    await inPanel(page);
    await expect(page.locator('#operator-account')).toBeVisible();
    test.skip(!(await page.evaluate(() => !!groupStatus.canChangePassword)),
              'writableGroups is off on this server');

    // The eye shows what is typed, and hides it again.
    await page.click('#operator-password-toggle');
    const field = page.locator('#operator-password-new');
    const eye = page.locator('[aria-controls="operator-password-new"]');
    await field.fill('видно-ли-это');
    await expect(field).toHaveAttribute('type', 'password');
    await eye.click();
    await expect(field).toHaveAttribute('type', 'text');
    await expect(eye).toHaveAttribute('aria-pressed', 'true');
    await expect(eye).toHaveAttribute('title', 'Скрыть пароль');
    await expect(field).toHaveValue('видно-ли-это');
    await eye.click();
    await expect(field).toHaveAttribute('type', 'password');
    await expect(eye).toHaveAttribute('title', 'Показать пароль');
    // shown again for the real change below, to check it is hidden after
    await eye.click();

    // Checked before anything is sent.
    await change(page, FIRST, 'короткий'.slice(0, 5));
    await expect(message(page)).toHaveText(/не короче 8 символов/);
    await change(page, FIRST, 'новый-пароль-2', 'новый-пароль-3');
    await expect(message(page)).toHaveText('Новые пароли не совпадают.');

    // A wrong current password is refused by the server.
    await change(page, 'not-the-password', SECOND);
    await expect(message(page)).toHaveText('Текущий пароль неверный.');
    await expect(message(page)).toHaveClass(/error/);

    // The real thing.
    await change(page, FIRST, SECOND);
    await expect(message(page)).toHaveText(/Пароль изменён/);
    await expect(page.locator('#operator-password-current')).toHaveValue('');
    // nothing is left on show once it is saved
    for (const id of ['current', 'new', 'again'])
        await expect(page.locator(`#operator-password-${id}`))
            .toHaveAttribute('type', 'password');

    // The group file keeps everything it had, with the password hashed.
    const after = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    for (const key of Object.keys(before))
        if (key !== 'users')
            expect(after[key], `group file keeps "${key}"`).toEqual(before[key]);
    expect(after.users.op.permissions).toBe('op');
    expect(after.users.op.password.type).toBe('bcrypt');
    expect(JSON.stringify(after)).not.toContain(SECOND);

    // The new password logs in, the old one no longer does.
    await inPanel(await login(browser, SECOND));
    const old = await login(browser, FIRST);
    await expect(old.locator('#operator-room')).toBeHidden();
    await expect(old.locator('#connectbutton')).toBeVisible({timeout: 20_000});

    // Put it back, through the form.
    await change(page, SECOND, FIRST);
    await expect(message(page)).toHaveText(/Пароль изменён/);
    expect(page.errors).toEqual([]);
});
