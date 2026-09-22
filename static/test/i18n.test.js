// Tests for the localisation table.  (Sozvon)
//
// Run with:  node --test static/test/
//
// Two failures are worth catching mechanically, because neither one is visible
// while you are working in the language you happen to be using:
//
//   * A key used in the markup or in galene.js that no table defines.  lookup()
//     returns the key itself, so the interface renders "toast.somethingBroke".
//   * A key defined in English but not in Russian.  lookup() falls back to the
//     English table, so a Russian user silently gets an English sentence in the
//     middle of a Russian page -- nothing errors, nothing logs.
//
// The second is the reason this file reads the tables directly rather than
// going through t(): the runtime API cannot distinguish "translated" from
// "fell back to English".

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const staticDir = path.join(__dirname, '..');

/**
 * Extract the `translations` object literal from i18n.js and evaluate it.
 *
 * The tables are private to the module's IIFE, so they cannot be reached
 * through the public API.  Rather than restructure the client for the benefit
 * of a test, the literal is located and evaluated on its own.  The scan tracks
 * strings and comments, so apostrophes inside translated text ("We can't find
 * the page") and braces inside placeholders do not confuse the brace counting.
 *
 * @returns {Object<string, Object<string, string>>}
 */
function readTranslations() {
    const src = fs.readFileSync(path.join(staticDir, 'i18n.js'), 'utf8');
    const anchor = 'const translations = {';
    const start = src.indexOf(anchor);
    assert.notStrictEqual(
        start, -1,
        'i18n.js no longer declares `const translations = {` — this test ' +
        'locates the tables by that text and needs updating',
    );

    let i = start + anchor.length - 1; // at the opening brace
    let depth = 0;
    let quote = null;      // the quote character we are inside, if any
    let comment = null;    // 'line' or 'block'
    for(; i < src.length; i++) {
        const c = src[i];
        const next = src[i + 1];
        if(comment === 'line') {
            if(c === '\n') comment = null;
            continue;
        }
        if(comment === 'block') {
            if(c === '*' && next === '/') { comment = null; i++; }
            continue;
        }
        if(quote) {
            if(c === '\\') i++;
            else if(c === quote) quote = null;
            continue;
        }
        if(c === '/' && next === '/') { comment = 'line'; i++; continue; }
        if(c === '/' && next === '*') { comment = 'block'; i++; continue; }
        if(c === '\'' || c === '"' || c === '`') { quote = c; continue; }
        if(c === '{') depth++;
        else if(c === '}') {
            depth--;
            if(depth === 0) break;
        }
    }
    assert.strictEqual(depth, 0, 'unbalanced braces in the translations table');

    const literal = src.slice(start + anchor.length - 1, i + 1);
    return vm.runInNewContext('(' + literal + ')');
}

/** Every key referenced by a data-i18n* attribute in the shipped HTML. */
function keysUsedInMarkup() {
    const used = new Map(); // key -> file it came from
    for(const file of fs.readdirSync(staticDir)) {
        if(!file.endsWith('.html'))
            continue;
        const html = fs.readFileSync(path.join(staticDir, file), 'utf8');
        const re = /data-i18n(?:-html|-title|-placeholder|-value|-aria)?="([^"]+)"/g;
        let m;
        while((m = re.exec(html)) !== null)
            used.set(m[1], file);
    }
    return used;
}

/**
 * Every key passed to i18n.t() as a string literal.  Calls that compute their
 * key at runtime (i18n.t(kind), i18n.t('errors.' + code)) cannot be checked
 * this way and are not attempted.
 */
function keysUsedInScripts() {
    const used = new Map();
    for(const file of fs.readdirSync(staticDir)) {
        if(!file.endsWith('.js'))
            continue;
        const js = fs.readFileSync(path.join(staticDir, file), 'utf8');
        // The literal must be the whole argument: i18n.t('knock.' + kind)
        // builds its key at runtime and 'knock.' is not one.
        const re = /i18n\.t\(\s*'([^']+)'\s*[,)]|i18n\.t\(\s*"([^"]+)"\s*[,)]/g;
        let m;
        while((m = re.exec(js)) !== null)
            used.set(m[1] || m[2], file);
    }
    return used;
}

test('the tables look like tables', () => {
    const translations = readTranslations();
    assert.deepStrictEqual(
        Object.keys(translations).sort(), ['en', 'ru'],
        'expected exactly the en and ru tables',
    );
    assert.ok(Object.keys(translations.en).length > 100,
              'suspiciously few English strings — did the scan cut short?');
});

test('every English string has a Russian one', () => {
    const translations = readTranslations();
    const missing = Object.keys(translations.en)
          .filter(k => !(k in translations.ru));
    assert.deepStrictEqual(
        missing, [],
        'these keys fall back to English on a Russian page:\n  ' +
        missing.join('\n  '),
    );
});

test('no Russian string is left over from a deleted English one', () => {
    const translations = readTranslations();
    const orphans = Object.keys(translations.ru)
          .filter(k => !(k in translations.en));
    assert.deepStrictEqual(
        orphans, [],
        'these Russian keys have no English counterpart, so nothing can ' +
        'reach them:\n  ' + orphans.join('\n  '),
    );
});

test('no translation is left as a copy of the English text', () => {
    const translations = readTranslations();
    // A handful of strings are legitimately identical in both languages:
    // proper nouns, symbols, and the language names in the switcher.
    const identical = Object.keys(translations.en).filter(
        k => translations.ru[k] === translations.en[k] &&
             translations.en[k].length > 12,
    );
    assert.deepStrictEqual(
        identical, [],
        'these Russian strings are verbatim English, which usually means a ' +
        'key was copied and not translated:\n  ' + identical.join('\n  '),
    );
});

test('every key used in the markup is defined', () => {
    const translations = readTranslations();
    const problems = [];
    for(const [key, file] of keysUsedInMarkup()) {
        if(!(key in translations.en))
            problems.push(`${key} (${file})`);
    }
    assert.deepStrictEqual(
        problems, [],
        'these render as the raw key:\n  ' + problems.join('\n  '),
    );
});

test('every key used in the client scripts is defined', () => {
    const translations = readTranslations();
    const problems = [];
    for(const [key, file] of keysUsedInScripts()) {
        if(!(key in translations.en))
            problems.push(`${key} (${file})`);
    }
    assert.deepStrictEqual(
        problems, [],
        'these render as the raw key:\n  ' + problems.join('\n  '),
    );
});

test('placeholders survive translation', () => {
    const translations = readTranslations();
    // t() substitutes {name}-style placeholders.  One dropped in translation
    // means the sentence loses the number or name it was built around.
    const problems = [];
    for(const key of Object.keys(translations.en)) {
        if(!(key in translations.ru))
            continue;
        const of = s => (s.match(/\{[a-zA-Z0-9_]+\}/g) || []).sort();
        const en = of(translations.en[key]);
        const ru = of(translations.ru[key]);
        if(JSON.stringify(en) !== JSON.stringify(ru))
            problems.push(`${key}: en ${en} vs ru ${ru}`);
    }
    assert.deepStrictEqual(
        problems, [],
        'placeholders differ between languages:\n  ' + problems.join('\n  '),
    );
});

// A join refused for want of a seat carries a code, and galene.js turns the
// code into a sentence through fullRoomMessages.  Those keys are computed, so
// the literal-key scan above does not see them, and the codes are defined in
// Go, where no JavaScript check would notice one being added or renamed.  A
// code the table lacks falls back to the server's English message: exactly
// the refusal this table was made to replace.  (Sozvon)
test('every full-room code the server sends has a translated message', () => {
    const go = fs.readFileSync(
        path.join(staticDir, '..', 'group', 'group.go'), 'utf8');
    const codes = [...go.matchAll(/&FullError\{\s*Code:\s*"([^"]+)"/g)]
        .map(m => m[1]);
    assert.ok(codes.length >= 3,
        `found ${codes.length} FullError codes in group/group.go; ` +
        'expected at least three — this test locates them by ' +
        '`&FullError{ Code: "..."` and needs updating');

    const js = fs.readFileSync(path.join(staticDir, 'galene.js'), 'utf8');
    const m = js.match(/const fullRoomMessages = (\{[^}]*\});/);
    assert.ok(m, 'galene.js no longer declares `const fullRoomMessages = {`');
    const table = vm.runInNewContext('(' + m[1] + ')');

    const translations = readTranslations();
    for(const code of codes) {
        const key = table[code];
        assert.ok(key, `server code ${code} has no entry in fullRoomMessages`);
        for(const lang of ['en', 'ru'])
            assert.ok(translations[lang][key],
                `${key} (for ${code}) is missing from the ${lang} table`);
    }
    assert.deepStrictEqual(Object.keys(table).sort(), codes.sort(),
        'fullRoomMessages has an entry for a code the server never sends');
});
