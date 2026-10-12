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

// ice-recovery.js -- bring media back after the network changes.  (Sozvon)
//
// protocol.js restarts ICE only once a connection has "failed", and Chrome
// says so 20-30 seconds after the path went away.  When the path went away
// because the network changed -- a VPN turned off, Wi-Fi swapped for mobile
// data -- nothing comes back by itself in the meantime: a relay reached over
// TCP was reached over a socket of the old network, and that socket is not
// closed, it just goes quiet.  In production (2026-10-12) the signalling came
// back two seconds after such a change, the media did not, and the
// participant reloaded the page.
//
// So a connection is restarted early:
//
//   - right after the signalling resumes over a new websocket, if it is not
//     connected.  A resumed session almost always means the network changed,
//     and for a while afterwards ("suspect") any connection that drops to
//     "disconnected" is restarted at once, since ICE notices the loss a
//     second or two after the websocket does;
//   - otherwise once it has stayed "disconnected" for DISCONNECTED_FOR.
//     That is longer than turn-fallback.js allows a connection over a UDP
//     relay before it gives UDP up (and restarts everything itself), so the
//     two do not fight over the same connection.
//
// A restart from "disconnected" is cheap: Chrome keeps the old pair until a
// new one is chosen, and a path that was only stalled recovers either way.
//
// Only the decisions live here, so that they can be tested without a browser;
// galene.js does the restarting.

(function(global) {
    'use strict';

    // How long a connection may stay "disconnected" before it is restarted
    // when nothing points at a network change.  Chrome passes through the
    // state on brief hiccups and recovers within a few seconds; and
    // turn-fallback.js acts on a UDP relay at 6 s, polled every 2 s.
    const DISCONNECTED_FOR = 8000;
    // How long after a resume a drop to "disconnected" counts as the
    // network having changed.
    const SUSPECT_FOR = 15000;
    // The least time between two restarts of one connection.  A restart
    // goes through "checking", which takes a moment; restarting again
    // before it is done only starts over.
    const MIN_GAP = 5000;

    /**
     * @constructor
     */
    function Recovery() {
        /** @type {Map<string, {disconnectedSince: number|null, restartedAt: number|null}>} */
        this.streams = new Map();
        /** Until when a drop counts as a network change. */
        this.suspectUntil = 0;
    }

    /**
     * The signalling has just resumed over a new websocket.
     *
     * @param {number} now
     */
    Recovery.prototype.resumed = function(now) {
        this.suspectUntil = now + SUSPECT_FOR;
    };

    /**
     * Feed the state of one connection: on every change, on resume, and on
     * a timer while it is disconnected.  Returns why it is to be restarted
     * now -- 'resumed' (the network changed) or 'disconnected' (it stayed
     * down too long) -- or null; the caller restarts it.
     *
     * "failed" is left alone: protocol.js restarts on that already.
     *
     * @param {string} id
     * @param {string} state - iceConnectionState
     * @param {number} now
     * @returns {string|null}
     */
    Recovery.prototype.update = function(id, state, now) {
        let s = this.streams.get(id);
        if(!s) {
            s = {disconnectedSince: null, restartedAt: null};
            this.streams.set(id, s);
        }
        if(state !== 'disconnected') {
            s.disconnectedSince = null;
            if(state === 'connected' || state === 'completed')
                s.restartedAt = null;
        } else if(s.disconnectedSince === null) {
            s.disconnectedSince = now;
        }

        if(s.restartedAt !== null && now - s.restartedAt < MIN_GAP)
            return null;

        let restart = null;
        // Straight after a network change a connection that is down is
        // stale.  "new" and "checking" are a negotiation already under way,
        // and "failed" is protocol.js's.
        if(now < this.suspectUntil && state === 'disconnected')
            restart = 'resumed';
        else if(s.disconnectedSince !== null &&
                now - s.disconnectedSince >= DISCONNECTED_FOR)
            restart = 'disconnected';

        if(restart) {
            s.restartedAt = now;
            s.disconnectedSince = null;
        }
        return restart;
    };

    /**
     * A connection was restarted by someone else (the UDP fallback): it is
     * not to be restarted again before MIN_GAP.
     *
     * @param {string} id
     * @param {number} now
     */
    Recovery.prototype.restarted = function(id, now) {
        let s = this.streams.get(id);
        if(!s) {
            s = {disconnectedSince: null, restartedAt: null};
            this.streams.set(id, s);
        }
        s.restartedAt = now;
        s.disconnectedSince = null;
    };

    /** @param {string} id */
    Recovery.prototype.forget = function(id) {
        this.streams.delete(id);
    };

    const api = {DISCONNECTED_FOR, SUSPECT_FOR, MIN_GAP, Recovery};

    global.SozvonIceRecovery = api;
    if(typeof module !== 'undefined' && module.exports)
        module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
