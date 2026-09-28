// Sozvon: the page-load guard.
//
// galene.html hides its content with the `hidden` attribute and shows a
// spinner (#app-loading) until the page has loaded; this script decides when
// to take the spinner away.  It used to be a few lines in galene.js that
// uncovered the page on window 'load' or after ten seconds, whichever came
// first -- and neither of those means the page is usable.  'load' fires just
// the same when a stylesheet or script failed, and on a stalling link ten
// seconds is simply not enough.  On 2026-09-28 a client got exactly that page:
// galene.css never arrived, so every element that only it hides was on screen
// at once -- all four "cannot encrypt" reasons, "this browser does not support
// video calls", "reconnecting" -- over a browser that was perfectly fine.
//
// So the page is uncovered only once it is known to work: galene.css has
// applied, galene.js has run, and no stylesheet or script failed.  Otherwise
// the spinner stays, says after a while that the connection is slow, and a
// page that did fail is reloaded (a couple of times automatically, then on a
// button) instead of being shown half-built.
//
// Loaded as a *blocking* script in the <head>, ahead of the stylesheets, so
// its error listener is in place before any of them can fail.  It runs before
// i18n.js, hence its own two-language strings.  The decision itself is the
// pure function decide(), exported for static/test/.
//
// Sozvon is a fork of Galène (MIT); see LICENCE.

(function(global) {
    'use strict';

    // When the spinner starts saying the connection is slow.
    var SLOW_AFTER = 10000;
    // When it also offers a reload while still waiting.
    var OFFER_RELOAD_AFTER = 30000;
    // Automatic reloads after a failed load, per tab, before asking instead.
    var MAX_AUTO_RELOADS = 2;
    var RELOAD_DELAY = 3000;
    var RELOADS_KEY = 'sozvon-load-retries';

    /**
     * What to do with the loading screen now.
     *
     * @param {object} s
     * @param {boolean} s.loaded       window 'load' has fired
     * @param {boolean} s.ready        galene.css applied and galene.js ran
     * @param {number} s.failed        stylesheets/scripts that failed
     * @param {number} s.elapsed       ms since the page started loading
     * @param {number} s.reloads       automatic reloads already done
     * @returns {string} 'wait' | 'slow' | 'slow-offer' | 'show' |
     *                   'reload' | 'fail'
     */
    function decide(s) {
        if(s.failed > 0 || (s.loaded && !s.ready)) {
            if(s.reloads < MAX_AUTO_RELOADS)
                return 'reload';
            // Out of retries.  A page whose essentials work is shown even
            // with, say, the icon font missing -- a file that is gone for
            // good must not lock everyone out.  One that does not work is
            // never shown.
            return s.ready ? 'show' : 'fail';
        }
        // Only the essentials are needed: a font or an image that is still
        // on its way must not hold the page back.
        if(s.ready && (s.loaded || s.elapsed >= SLOW_AFTER))
            return 'show';
        if(s.elapsed >= OFFER_RELOAD_AFTER)
            return 'slow-offer';
        if(s.elapsed >= SLOW_AFTER)
            return 'slow';
        return 'wait';
    }

    var api = {
        decide: decide,
        SLOW_AFTER: SLOW_AFTER,
        OFFER_RELOAD_AFTER: OFFER_RELOAD_AFTER,
        MAX_AUTO_RELOADS: MAX_AUTO_RELOADS,
    };
    global.SozvonLoadGuard = api;
    if(typeof module !== 'undefined' && module.exports)
        module.exports = api;

    if(typeof document === 'undefined')
        return;                 // under node, for the tests

    var strings = {
        ru: {
            slow: 'Связь медленная, страница ещё загружается…',
            retrying: 'Страница загрузилась не полностью, пробуем ещё раз…',
            failed: 'Страница не загрузилась — похоже, связь нестабильна.',
            reload: 'Обновить страницу',
        },
        en: {
            slow: 'The connection is slow, the page is still loading…',
            retrying: 'The page did not load completely, trying again…',
            failed: 'The page did not load — the connection seems unstable.',
            reload: 'Reload the page',
        },
    };

    // Same choice as i18n.js makes, which has not loaded yet.
    function language() {
        try {
            var stored = localStorage.getItem('sozvon-lang');
            if(stored && strings[stored])
                return stored;
        } catch(e) { /* storage may be unavailable */ }
        var nav = (navigator.languages && navigator.languages[0]) ||
            navigator.language || 'en';
        return /^ru\b/i.test(nav) ? 'ru' : 'en';
    }
    var text = strings[language()];

    function getReloads() {
        try {
            return parseInt(sessionStorage.getItem(RELOADS_KEY), 10) || 0;
        } catch(e) {
            // No storage, no counter: never reload automatically, or a
            // failing page would reload forever.
            return MAX_AUTO_RELOADS;
        }
    }

    function setReloads(n) {
        try {
            if(n)
                sessionStorage.setItem(RELOADS_KEY, String(n));
            else
                sessionStorage.removeItem(RELOADS_KEY);
        } catch(e) { /* ignore */ }
    }

    var failed = 0;
    var loaded = false;
    var done = false;
    var shown = null;
    var start = Date.now();
    var timer = null;

    // Resource errors do not bubble, but they do pass through window in the
    // capture phase.  A 504 from the proxy counts as a failure too.
    global.addEventListener('error', function(e) {
        var t = e.target;
        if(t && (t.tagName === 'SCRIPT' ||
                 (t.tagName === 'LINK' && /stylesheet/i.test(t.rel))))
            failed++;
    }, true);

    // galene.css hides .invisible; if that rule is not in force, the page
    // would show every hidden notice at once.
    function cssApplied() {
        if(!document.body)
            return false;
        var probe = document.createElement('div');
        probe.className = 'invisible';
        document.body.appendChild(probe);
        var ok = getComputedStyle(probe).display === 'none';
        probe.remove();
        return ok;
    }

    function ready() {
        return !!global.SozvonAppLoaded && cssApplied();
    }

    function overlay() {
        return document.getElementById('app-loading');
    }

    function note(message, withButton) {
        var o = overlay();
        if(!o)
            return;
        var box = o.querySelector('.app-loading-note');
        if(!box) {
            box = document.createElement('div');
            box.className = 'app-loading-note';
            box.setAttribute('role', 'status');
            o.appendChild(box);
        }
        box.textContent = '';
        var p = document.createElement('p');
        p.textContent = message;
        box.appendChild(p);
        if(withButton) {
            var b = document.createElement('button');
            b.type = 'button';
            b.textContent = text.reload;
            b.addEventListener('click', function() {
                setReloads(0);
                location.reload();
            });
            box.appendChild(b);
        }
    }

    function show() {
        setReloads(0);
        // galene.html sets `hidden` only on the guarded blocks, so clearing
        // every [hidden] here is safe.
        document.querySelectorAll('[hidden]').forEach(function(el) {
            el.removeAttribute('hidden');
        });
        var o = overlay();
        if(o)
            o.remove();
    }

    function step() {
        if(done)
            return;
        var reloads = getReloads();
        var action = decide({
            loaded: loaded,
            ready: ready(),
            failed: failed,
            elapsed: Date.now() - start,
            reloads: reloads,
        });
        switch(action) {
        case 'show':
            done = true;
            show();
            return;
        case 'reload':
            done = true;
            setReloads(reloads + 1);
            note(text.retrying, false);
            setTimeout(function() { location.reload(); }, RELOAD_DELAY);
            return;
        case 'fail':
            done = true;
            // Nothing is loading any more; a spinner would say otherwise.
            var spinner = document.querySelector('#app-loading .app-spinner');
            if(spinner)
                spinner.remove();
            note(text.failed, true);
            return;
        case 'slow':
        case 'slow-offer':
            // Rebuilt only on a change, so a focused button is not replaced
            // under the user's finger every second.
            if(action !== shown)
                note(text.slow, action === 'slow-offer');
            break;
        }
        shown = action;
        clearTimeout(timer);
        timer = setTimeout(step, 1000);
    }

    global.addEventListener('load', function() {
        loaded = true;
        step();
    });
    timer = setTimeout(step, 1000);
})(typeof self !== 'undefined' ? self : globalThis);
