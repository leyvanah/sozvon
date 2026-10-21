// What to tell someone whose browser refused the camera or microphone.  (Sozvon)
//
// A NotAllowedError says only that access was refused, not why, and the fix
// depends on the why:
//
//   * The site is blocked in the browser's settings.  The browser no longer
//     asks; the setting has to be changed by hand.
//   * The request was dismissed, or never shown.  On Android, Chrome refuses
//     to show a permission prompt while another app draws over it (a chat
//     bubble, a picture-in-picture video, a screen filter) and says only
//     "This site can't ask for permission"; cancelling that is a refusal.
//   * The site is allowed, and the operating system refuses the browser
//     itself.
//
// The Permissions API tells these apart without guessing from error text:
// 'denied' is the first, 'granted' the third, anything else (including no
// answer at all, as in Firefox) the second.  The second case ends in the
// site setting too, which works whichever way the guess went: a site that is
// allowed needs no prompt.
//
// This file only chooses the message; galene.js shows it.

(function(global) {
    'use strict';

    /**
     * Where the page runs, as far as the advice differs.
     *
     * @param {Object} env
     * @param {string} env.ua - navigator.userAgent
     * @param {boolean} [env.bridge] - window.SozvonApp exists
     * @param {number} [env.touchPoints] - navigator.maxTouchPoints
     * @returns {{os: string, app: string|null}} os is 'android' | 'ios' |
     *     'windows' | 'mac' | 'other'; app is 'android' or 'desktop' inside
     *     one of our apps, null in a browser
     */
    function detectPlatform(env) {
        let ua = env.ua || '';
        let os = 'other';
        if(/Android/i.test(ua))
            os = 'android';
        // iPadOS asks for desktop pages and calls itself a Mac; touch gives
        // it away.
        else if(/iPhone|iPad|iPod/.test(ua) ||
                (/Macintosh/.test(ua) && (env.touchPoints || 0) > 1))
            os = 'ios';
        else if(/Windows/.test(ua))
            os = 'windows';
        else if(/Macintosh|Mac OS X/.test(ua))
            os = 'mac';

        let app = null;
        // The Android app appends this marker to its WebView's user agent;
        // the desktop app exposes the same bridge without it.
        if(ua.indexOf('SozvonApp') >= 0)
            app = 'android';
        else if(env.bridge)
            app = 'desktop';
        return {os: os, app: app};
    }

    /**
     * One state for the devices a request asked for.
     *
     * @param {Array<string|null>} states - PermissionStatus.state per device,
     *     null where the browser would not say
     * @returns {string|null} 'denied' if any device is blocked, 'granted' if
     *     every one is allowed, otherwise null
     */
    function combineStates(states) {
        if(states.indexOf('denied') >= 0)
            return 'denied';
        if(states.length > 0 && states.every(s => s === 'granted'))
            return 'granted';
        return null;
    }

    /**
     * @typedef {Object} Line
     * @property {string} key - a Sozvon.i18n key
     * @property {Object<string,string>} [params] - keys of further strings,
     *     translated and substituted into this one
     */

    /**
     * @typedef {Object} Advice
     * @property {string} title - a Sozvon.i18n key
     * @property {Line} reason
     * @property {Line[]} steps
     */

    /**
     * Choose the message for a refused camera or microphone.
     *
     * Params hold i18n keys, not text, so that the caller translates them in
     * the same language as the line they go into.
     *
     * @param {Object} o
     * @param {string} o.kind - 'audio' | 'video' | 'both'
     * @param {string|null} o.state - from combineStates
     * @param {{os: string, app: string|null}} o.platform - from detectPlatform
     * @returns {Advice}
     */
    function advice(o) {
        let os = o.platform.os;
        let app = o.platform.app;
        let title = 'mediaHelp.title.' + o.kind;
        let device = 'mediaHelp.device.' + o.kind;
        let section = 'mediaHelp.section.' + o.kind;

        if(app === 'android') {
            // The app asks Android itself: there is no site setting, and
            // asking again shows Android's dialog again until it is refused
            // for good.
            return {
                title: title,
                reason: {key: 'mediaHelp.reason.app'},
                steps: [
                    {key: 'mediaHelp.step.retryAllow'},
                    {key: 'mediaHelp.step.appSettings',
                     params: {section: section}},
                ],
            };
        }

        if(app === 'desktop') {
            // The app allows its own server, so only the system can refuse.
            return {
                title: title,
                reason: {key: 'mediaHelp.reason.systemApp'},
                steps: [systemStep(os, section)],
            };
        }

        let path = 'mediaHelp.path.' +
            (os === 'android' || os === 'ios' ? os : 'desktop');

        if(o.state === 'denied') {
            return {
                title: title,
                reason: {key: 'mediaHelp.reason.blocked'},
                steps: [
                    {key: 'mediaHelp.step.site',
                     params: {device: device, path: path}},
                ],
            };
        }

        if(o.state === 'granted') {
            return {
                title: title,
                reason: {key: 'mediaHelp.reason.system'},
                steps: [systemStep(os, section)],
            };
        }

        let steps = [{key: 'mediaHelp.step.retryAllow'}];
        if(os === 'android')
            steps.push({key: 'mediaHelp.step.overlay'});
        steps.push({key: 'mediaHelp.step.orSite',
                    params: {device: device, path: path}});
        return {
            title: title,
            reason: {key: 'mediaHelp.reason.dismissed'},
            steps: steps,
        };
    }

    /**
     * @param {string} os
     * @param {string} section
     * @returns {Line}
     */
    function systemStep(os, section) {
        return {key: 'mediaHelp.step.system.' + os,
                params: {section: section}};
    }

    const api = {detectPlatform, combineStates, advice};

    global.SozvonMediaHelp = api;
    if(typeof module !== 'undefined' && module.exports)
        module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
