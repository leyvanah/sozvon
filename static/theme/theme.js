// Sozvon deployment theme hook.
//
// Loaded (deferred) on every visitor-facing page: the landing page, the
// login / waiting room, 404, statistics and change-password.  In the stock
// distribution this file is a no-op; a deployment may replace the contents
// of static/theme/ at deploy time to rebrand its instance.
//
// Only the landing page and the login / waiting room load i18n.js, and this
// script is ordered after it there.  On the other three pages window.Sozvon
// is absent, so guard any string override with a check — the branding half
// of the API below works everywhere.
//
// What a theme script can do:
//
//   * Override localised strings — Sozvon.i18n.override() deep-merges the
//     given per-language tables over the built-in ones and re-applies
//     them to the page, e.g.:
//
//         Sozvon.i18n.override({
//             en: {'lobby.title': 'Waiting room', 'login.connect': 'Knock'},
//             ru: {'lobby.title': 'Комната ожидания'},
//         });
//
//     Keys are the same data-i18n keys used throughout the markup and by
//     Sozvon.i18n.t(); missing keys keep their stock text.
//
//   * Adjust branding — swap the .brand-word text, the logo <img> sources
//     or document.title from here.  Run such DOM changes on
//     DOMContentLoaded; this script executes before it fires.
//
// Styling belongs in theme.css next to this file.  Note the same-origin
// CSP: reference any theme assets by relative URL from this directory.
