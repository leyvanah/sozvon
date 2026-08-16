// The app bar along the top of the window.  See titlebar.html for what it is
// and why it is the window's own page rather than something drawn over the
// page below it.
//
// Everything here goes through window.sozvonBar, which titlebar-preload.js
// exposes: this page never touches the content below, it only asks the main
// process to act on it.
//
// SOZVON is a fork of Galène (MIT); see LICENCE.

(function() {
    'use strict';

    const bar = window.sozvonBar;
    if(!bar)
        return;

    const servers = document.getElementById('servers');
    const reload = document.getElementById('reload');
    const hub = document.getElementById('hub');
    const theme = document.getElementById('theme');

    servers.addEventListener('click', () => bar.showLauncher());
    reload.addEventListener('click', () => bar.reload());
    hub.addEventListener('click', () => bar.openHub());
    theme.addEventListener('click', () => bar.setTheme(dark ? 'light' : 'dark'));

    let dark = true;

    /**
     * @param {{onServer: boolean, dark: boolean}} state
     */
    function reflect(state) {
        dark = !!state.dark;
        document.body.classList.toggle('is-dark', dark);
        theme.title = dark ? 'Светлая тема' : 'Тёмная тема';
        // The three navigation buttons only mean anything while a server is
        // loaded, and on the launcher they go away rather than greying out:
        // there are only two places to be, and a greyed-out row of controls
        // reads as something broken rather than as something not applicable.
        for(const b of [servers, reload, hub])
            b.hidden = !state.onServer;
    }

    bar.onState(reflect);
    bar.getState().then(reflect).catch(() => { /* ignore */ });
})();
