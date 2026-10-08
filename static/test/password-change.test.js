// Tests for an operator changing their own password.  (Sozvon)
//
// Run with:  node --test 'static/test/*.test.js'
//
// The form itself needs a browser; what can go wrong quietly is around the
// call: a Russian password that btoa() cannot encode, a group or user name
// that breaks the URL, a password bcrypt would truncate or refuse, and a
// reply read the wrong way round.

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const p = require('../password-change.js');

test('the form is checked before anything is sent', () => {
    assert.strictEqual(p.check('', 'newpassword', 'newpassword'), 'empty');
    assert.strictEqual(p.check('old', '', ''), 'empty');
    assert.strictEqual(p.check('old', 'newpassword', 'newpasswort'), 'mismatch');
    assert.strictEqual(p.check('old', 'short', 'short'), 'short');
    assert.strictEqual(p.check('samesame', 'samesame', 'samesame'), 'same');
    assert.strictEqual(p.check('old', 'newpassword', 'newpassword'), null);
});

test('length is counted in characters, the limit in bytes', () => {
    // eight Cyrillic letters are sixteen bytes, and long enough
    assert.strictEqual(p.check('old', 'пароль12', 'пароль12'), null);
    // seven characters are too short whatever their bytes
    assert.strictEqual(p.check('old', 'пароль1', 'пароль1'), 'short');
    // 37 Cyrillic letters are 74 bytes: past what bcrypt takes
    let long = 'ж'.repeat(37);
    assert.strictEqual(p.check('old', long, long), 'long');
    let fits = 'ж'.repeat(36);
    assert.strictEqual(p.check('old', fits, fits), null);
});

test('the Basic credentials are UTF-8, as the server reads them', () => {
    let h = p.basicAuth('николай', 'пароль:с двоеточием');
    assert.match(h, /^Basic /);
    let decoded = Buffer.from(h.slice(6), 'base64').toString('utf8');
    assert.strictEqual(decoded, 'николай:пароль:с двоеточием');
});

test('the URL survives any group or user name', () => {
    assert.strictEqual(p.passwordURL('reception', 'nick'),
        '/galene-api/v0/.groups/reception/.users/nick/.password');
    assert.strictEqual(p.passwordURL('hub/child room', 'a b/c'),
        '/galene-api/v0/.groups/hub/child%20room/.users/a%20b%2Fc/.password');
});

test('replies are read the right way round', () => {
    assert.strictEqual(p.outcome(204), 'ok');
    assert.strictEqual(p.outcome(401), 'wrong');
    assert.strictEqual(p.outcome(429), 'banned');
    assert.strictEqual(p.outcome(500), 'error');
    assert.strictEqual(p.outcome(404), 'error');
});

test('the change sends the new password, authenticated by the old', async () => {
    let seen;
    let result = await p.change(async (url, init) => {
        seen = {url, init};
        return {status: 204};
    }, 'reception', 'nick', 'старый пароль', 'новый пароль');
    assert.strictEqual(result, 'ok');
    assert.strictEqual(seen.url,
        '/galene-api/v0/.groups/reception/.users/nick/.password');
    assert.strictEqual(seen.init.method, 'POST');
    assert.strictEqual(seen.init.body, 'новый пароль');
    assert.strictEqual(seen.init.credentials, 'omit');
    assert.strictEqual(seen.init.headers.Authorization,
        p.basicAuth('nick', 'старый пароль'));
});
