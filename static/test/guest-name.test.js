// Tests for keeping guests' names away from the server.  (Sozvon)
//
// Run with:  node --test static/test/
//
// What must hold: a pseudonym is never mistaken for a name and never shown;
// a name only counts when both its label and its encrypted marker say so;
// and a name in a link stays in the part the browser never sends.

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const g = require('../guest-name.js');

test('pseudonyms are recognisable and random', () => {
    let seen = new Set();
    for(let i = 0; i < 200; i++) {
        let p = g.makePseudonym();
        assert.ok(g.isPseudonym(p), p);
        seen.add(p);
    }
    assert.strictEqual(seen.size, 200);
    for(let name of ['Анна', 'anna', '~anna', '~abcdefghij1', '', null,
                     '~ABCDEFGHJK', '~abcdefghi'])
        assert.ok(!g.isPseudonym(name), String(name));
});

test('a pseudonym is a valid Galene username', () => {
    // group.validUsername: no backslash, path.Clean must leave it alone
    let p = g.makePseudonym();
    assert.ok(!p.includes('\\') && !p.includes('/') && !p.includes('..'));
});

test('names are cleaned before they are shown', () => {
    assert.strictEqual(g.clean('  Анна   Петрова '), 'Анна Петрова');
    assert.strictEqual(g.clean('An\u202ena\u0000'), 'Anna');
    assert.strictEqual(g.clean('x'.repeat(200)).length, g.MAX);
    assert.strictEqual(g.clean(42), '');
});

test('a name counts only when label and marker agree', () => {
    let packed = g.pack('Анна');
    assert.deepStrictEqual(g.classify('name', packed),
                           {type: 'name', name: 'Анна'});
    assert.deepStrictEqual(g.classify('', packed), {type: 'drop'},
                           'a name relabelled as chat must not show as chat');
    assert.deepStrictEqual(g.classify('me', packed), {type: 'drop'});
    assert.deepStrictEqual(g.classify('name', 'hello'), {type: 'drop'},
                           'chat relabelled as a name must not become a name');
    assert.deepStrictEqual(g.classify('name', g.pack('   ')), {type: 'drop'});
    assert.deepStrictEqual(g.classify('', 'hello'), {type: 'chat'});
    assert.deepStrictEqual(g.classify('me', 'waves'), {type: 'chat'});
});

test('the book shows names, never pseudonyms', () => {
    let b = new g.Book();
    let p = g.makePseudonym();
    assert.strictEqual(b.shown('u1', p), '', 'nothing until the name arrives');
    assert.ok(b.set('u1', 'Анна'));
    assert.ok(!b.set('u1', 'Анна'), 'unchanged');
    assert.strictEqual(b.shown('u1', p), 'Анна');
    assert.strictEqual(b.shown('u2', p), '', 'names are per user');
    assert.strictEqual(b.shown('u3', 'nick'), 'nick',
                       'a real username is shown as it is');
    assert.strictEqual(b.shown('u3', undefined), '');
    b.delete('u1');
    assert.strictEqual(b.shown('u1', p), '');
});

test('a name in a link goes after #, and is read back from there', () => {
    let url = g.withNameInHash(
        'https://meet.example/group/room/?token=abc', 'Анна Петрова');
    assert.ok(url.startsWith('https://meet.example/group/room/?token=abc#'));
    assert.ok(!url.split('#')[0].includes('%D0'),
              'the name must not be in the part sent to the server');
    assert.strictEqual(g.nameFromHash('#' + url.split('#')[1]), 'Анна Петрова');
    assert.strictEqual(g.withNameInHash('https://x/', ''), 'https://x/');
    assert.strictEqual(g.nameFromHash(''), '');
    assert.strictEqual(g.nameFromHash('#other=1'), '');
});
