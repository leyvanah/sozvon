// Sozvon: light / dark theme resolution.
//
// Loaded as a *blocking* script in the <head> of every visitor-facing page,
// ahead of the stylesheets, so the theme is decided before the first paint —
// a deferred script would repaint the page in front of the user.  It is kept
// tiny for exactly that reason.
//
// The three preferences are "system" (the default), "light" and "dark".  This
// script resolves them to a single data-theme attribute on <html>, which is
// what common.css keys the light scale off; see the comment at the top of it
// for why the resolution happens here rather than in a media query.
//
// Note the name: static/theme/ is the *deployment* theme hook, a different
// thing entirely — that one restyles an instance, this one switches between
// the two themes the client ships with.
//
// Sozvon is a fork of Galène (MIT); see LICENCE.

(function() {
    'use strict';

    // The project was called Oryn before it was called Sozvon, and its stored
    // keys carried that name: the remembered logins, the operator's session,
    // the language and the theme.  Renaming them without moving the values
    // would silently log people out and reset their preferences, so carry the
    // old ones across once.  This runs before anything reads a key, which is
    // the only reason it lives in this file rather than somewhere tidier.
    //
    // Done by prefix rather than by listing the keys, so a key added to the
    // old client after this was written still survives the move.  It can be
    // deleted once no browser is plausibly still holding the old names.
    function migrateLegacyKeys(store) {
        var moved = [];
        for(var i = 0; i < store.length; i++) {
            var k = store.key(i);
            if(k && (k.indexOf('oryn.') === 0 || k.indexOf('oryn-') === 0))
                moved.push(k);
        }
        for(var j = 0; j < moved.length; j++) {
            var old = moved[j];
            var now = 'sozvon' + old.slice('oryn'.length);
            // A value under the new name wins: this browser has already used
            // the renamed client, and the stale one must not overwrite it.
            if(store.getItem(now) === null)
                store.setItem(now, store.getItem(old));
            store.removeItem(old);
        }
    }

    try {
        migrateLegacyKeys(window.localStorage);
        migrateLegacyKeys(window.sessionStorage);
    } catch(e) {
        // Storage can be absent or refuse to be written to (private mode,
        // quota, a blocked third-party context).  Losing the old preferences
        // is not worth failing the page load for.
    }

    /** @type {string} */
    const STORE_KEY = 'sozvon-theme';
    /** the preferences a stored value is allowed to hold */
    const PREFS = ['system', 'light', 'dark'];

    const listeners = [];
    const media = window.matchMedia ?
        window.matchMedia('(prefers-color-scheme: light)') : null;

    /**
     * @returns {string} one of PREFS
     */
    function stored() {
        try {
            const v = localStorage.getItem(STORE_KEY);
            if(PREFS.includes(v))
                return v;
        } catch(e) { /* localStorage may be unavailable */ }
        return 'system';
    }

    let pref = stored();

    /**
     * The theme actually in force: "system" asks the operating system, and
     * anything short of an explicit request for light stays dark — dark is
     * the default, not merely the fallback.
     * @returns {string} "light" or "dark"
     */
    function resolve() {
        if(pref === 'system')
            return (media && media.matches) ? 'light' : 'dark';
        return pref;
    }

    let resolved = resolve();

    function stamp() {
        const root = document.documentElement;
        const next = resolve();
        if(next === resolved && root.getAttribute('data-theme') === next)
            return;
        resolved = next;

        // Swap with every transition switched off, for two reasons.  The
        // cosmetic one: a whole interface cross-fading over 140ms reads as a
        // glitch rather than as motion.  The load-bearing one: Chromium does
        // not re-resolve a transitioned colour when the custom property it
        // came from changes on an ancestor, so anything in a `transition:
        // color` rule — nav buttons, selects, the drawer's links — stayed
        // painted in the outgoing theme until the next reload.  Reading
        // offsetWidth flushes the change while the suppression is in force.
        root.classList.add('theme-switching');
        root.setAttribute('data-theme', next);
        void root.offsetWidth;
        // A timer rather than requestAnimationFrame: the system can flip
        // between light and dark while this tab is in the background, where
        // animation frames are suspended entirely and the suppression would
        // stay on until the next switch — an app that has quietly lost every
        // transition.  Timers are throttled there, not stopped.
        window.setTimeout(() => root.classList.remove('theme-switching'), 0);

        notify();
    }

    function notify() {
        listeners.forEach(fn => {
            try { fn(resolved); } catch(e) { console.error(e); }
        });
    }

    // Before anything is painted.  <html> exists this early; <body> does not.
    document.documentElement.setAttribute('data-theme', resolved);

    /**
     * @param {string} p - one of PREFS
     */
    function set(p) {
        if(!PREFS.includes(p) || p === pref)
            return;
        const was = resolved;
        pref = p;
        try { localStorage.setItem(STORE_KEY, p); } catch(e) { /* ignore */ }
        stamp();
        // Choosing "dark" while the system was already dark changes nothing on
        // screen, so stamp() stays quiet — but the preference did change, and
        // a listener that acts on it (the host app, which follows the system
        // itself) has to hear about it.
        if(resolved === was)
            notify();
        reflect();
    }

    function reflect() {
        document.querySelectorAll('[data-theme-option]').forEach(b => {
            const on = b.getAttribute('data-theme-option') === pref;
            b.classList.toggle('active', on);
            b.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
    }

    /**
     * Called with the theme in force, "light" or "dark", whenever it changes
     * — and also when only the preference changed, since a listener may care
     * about the difference between "dark" and "system that happens to be
     * dark".  Read .pref for that.
     * @param {function(string): void} fn
     */
    function onChange(fn) {
        listeners.push(fn);
    }

    // Follow the system while, and only while, the preference is "system".
    // addEventListener on a MediaQueryList is unsupported on Safari < 14, so
    // fall back to the deprecated addListener there rather than losing the
    // update entirely.
    if(media) {
        const onMedia = () => {
            if(pref === 'system')
                stamp();
        };
        if(media.addEventListener)
            media.addEventListener('change', onMedia);
        else if(media.addListener)
            media.addListener(onMedia);
    }

    function init() {
        document.querySelectorAll('[data-theme-option]').forEach(b =>
            b.addEventListener('click', e => {
                e.preventDefault();
                set(b.getAttribute('data-theme-option'));
            }));
        reflect();
    }

    window.Sozvon = window.Sozvon || {};
    window.Sozvon.theme = {
        set, onChange,
        get pref() { return pref; },
        get resolved() { return resolved; },
    };

    if(document.readyState === 'loading')
        document.addEventListener('DOMContentLoaded', init);
    else
        init();
})();
