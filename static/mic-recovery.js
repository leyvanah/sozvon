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

// mic-recovery.js -- bring a microphone that dropped out back into the call.
// (Sozvon)
//
// A microphone can end on its own in the middle of a call: a Bluetooth
// headset re-pairs, a USB device is re-plugged, the audio driver resets.  It
// used to take the whole camera stream down with it, so the other side lost
// the picture as well as the sound, and nothing came back until the user
// pressed the microphone button.  galene.js now keeps the stream up and asks
// this module to reopen the device; the new track is swapped in with
// RTCRtpSender.replaceTrack(), which needs no renegotiation.
//
// Only the retry policy lives here, so that it can be tested without a
// browser.

(function(global) {
    'use strict';

    // Pauses before each attempt, in milliseconds.  A device that went away
    // for a moment is usually back within a couple of seconds; one that is
    // still missing after ten is not coming back on its own.
    const DELAYS = [300, 1000, 2000, 3000, 4000];

    /**
     * @param {number} ms
     * @returns {Promise<void>}
     */
    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Tries to reopen a lost track.
     *
     * Resolves to the new track, or to null if every attempt failed, if the
     * browser refused permission (asking again cannot help), or if the track
     * stopped being wanted in the meantime -- the stream was closed or
     * replaced, the user turned the microphone off.  A track opened after it
     * stopped being wanted is stopped here, so that the device is not left
     * open with nobody holding it.
     *
     * @param {Object} o
     * @param {function(): Promise<MediaStreamTrack>} o.open
     *     Opens a fresh track; may throw.
     * @param {function(): boolean} o.wanted
     * @param {number[]} [o.delays]
     * @param {function(number): Promise<void>} [o.sleep]
     * @returns {Promise<MediaStreamTrack|null>}
     */
    async function reopen(o) {
        let delays = o.delays || DELAYS;
        let wait = o.sleep || sleep;
        for(let i = 0; i < delays.length; i++) {
            await wait(delays[i]);
            if(!o.wanted())
                return null;
            let track;
            try {
                track = await o.open();
            } catch(e) {
                if(e && e.name === 'NotAllowedError')
                    return null;
                continue;
            }
            if(!track)
                continue;
            if(!o.wanted()) {
                track.stop();
                return null;
            }
            return track;
        }
        return null;
    }

    const api = {DELAYS, reopen};

    global.SozvonMicRecovery = api;
    if(typeof module !== 'undefined' && module.exports)
        module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
