// Copyright (c) 2026 by imaprocessus.

// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
// THE SOFTWARE.

// away.js -- a call on a phone put in the background.  (Sozvon)
//
// What a phone does to a call it can no longer see, measured on 2026-10-23
// (Android 16, Chrome 155), the same for the home button and for the screen
// going off:
//
//   - within a second the system closes the camera and silences the
//     microphone.  The page is not told: its tracks stay "live" and not
//     muted, only the page itself is "hidden";
//   - a minute or so later the browser loses the network, and about two
//     minutes after hiding the server ends the session;
//   - back in front, the camera opens again, and a session that had ended
//     is joined afresh.
//
// Nobody else in the call learnt any of this: they kept the last picture,
// heard silence, and saw the person as present until the session timed out.
// So the page says so itself, in the per-user data the raised hand uses
// (galene.js publishAwayState()), and a rejoin that the background caused is
// explained when the person comes back.
//
// A desktop browser does not stop the camera when its window is minimised or
// another tab is chosen, and someone who looks at another window keeps
// talking; there "hidden" says nothing about the call, so only a phone or a
// tablet marks itself.

(function(global) {
    'use strict';

    // A drop noticed this soon after coming back to the page happened while
    // it was hidden: the socket of a hidden page is not seen to close, it is
    // found dead when the page wakes up.
    const RETURN_GRACE = 15000;

    /**
     * Whether hiding the page stops the camera and the microphone, which is
     * what a phone or a tablet does and a computer does not.  A laptop with
     * a touch screen has touch points but a fine pointer.
     *
     * @param {{touchPoints: number, coarse: boolean}} env
     * @returns {boolean}
     */
    function pausesWhenHidden(env) {
        return !!env && env.touchPoints > 0 && !!env.coarse;
    }

    /**
     * Remembers when the page was hidden, so that a rejoin can tell whether
     * the background is what interrupted the call.
     *
     * @constructor
     */
    function Tracker() {
        /** @type {number|null} */
        this.hiddenAt = null;
        /** @type {number|null} */
        this.shownAt = null;
        /** @type {boolean} */
        this.outageAway = false;
        /** @type {boolean} */
        this.inOutage = false;
    }

    /** @param {number} now */
    Tracker.prototype.hidden = function(now) {
        this.hiddenAt = now;
        if(this.inOutage)
            this.outageAway = true;
    };

    /** @param {number} now */
    Tracker.prototype.shown = function(now) {
        this.hiddenAt = null;
        this.shownAt = now;
    };

    /**
     * The connection was lost, and a reconnect begins.
     *
     * @param {number} now
     */
    Tracker.prototype.lost = function(now) {
        if(this.inOutage)
            return;
        this.inOutage = true;
        this.outageAway = this.hiddenAt !== null ||
            (this.shownAt !== null && now - this.shownAt < RETURN_GRACE);
    };

    /**
     * The call is back after a reconnect.
     *
     * @returns {boolean} whether the page being in the background is what
     *     interrupted it
     */
    Tracker.prototype.back = function() {
        let away = this.inOutage && this.outageAway;
        this.inOutage = false;
        this.outageAway = false;
        return away;
    };

    const api = {RETURN_GRACE, pausesWhenHidden, Tracker};

    global.SozvonAway = api;
    if(typeof module !== 'undefined' && module.exports)
        module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
