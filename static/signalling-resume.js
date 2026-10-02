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

// signalling-resume.js -- keep a call going when its websocket dies.
// (Sozvon)
//
// The websocket that carries the signalling and the media of a call travel
// on different paths, and the first can stall while the second is fine.  It
// used to end the call: after 45 seconds of silence the server dropped the
// participant, media and all.  Now the client opens a new websocket and
// carries on the same session; see rtpconn/resume.go for the server side.
//
// Both sides number the messages they send and keep the last ones.  This
// module holds the client's half of that bookkeeping and its timings;
// protocol.js does the rest.

(function(global) {
    'use strict';

    // Ping the server after this much silence from it.  The server pings
    // a silent client after 10 s, so a healthy socket never goes quiet for
    // much longer than that in either direction.
    const PING_AFTER = 8000;
    // Give up on a socket that has said nothing for this long, and resume.
    const STALL_AFTER = 20000;
    // Wait this long for one resume attempt to be answered.
    const ATTEMPT_TIMEOUT = 8000;
    // Pause between attempts when the network refuses outright.
    const RETRY_DELAY = 2000;
    // The server keeps a session for two minutes at most; past this the
    // client stops trying and starts a fresh one.
    const GIVE_UP_AFTER = 110000;

    // The same bounds as the server's.
    const MAX_MESSAGES = 512;
    const MAX_BYTES = 2 << 20;

    // Close code with which the server refuses to resume.
    const CLOSE_NO_RESUME = 4001;

    /**
     * Whether a message of this type is numbered.  The server counts the
     * same set.
     *
     * @param {string} type
     * @returns {boolean}
     */
    function counted(type) {
        return type !== 'handshake' && type !== 'sozvon-session' &&
            type !== 'sozvon-resumed';
    }

    /**
     * The numbered messages sent, the last ones kept for replay.
     */
    class SentLog {
        constructor() {
            /** @type {Array<string>} */
            this.msgs = [];
            this.bytes = 0;
            /** How many were ever sent. */
            this.count = 0;
        }

        /** @param {string} s */
        push(s) {
            this.msgs.push(s);
            this.bytes += s.length;
            this.count++;
            while(this.msgs.length > MAX_MESSAGES ||
                  (this.msgs.length > 1 && this.bytes > MAX_BYTES))
                this.bytes -= this.msgs.shift().length;
        }

        /**
         * The messages after the first n, or null if some of them are no
         * longer kept, or if n is more than was ever sent.
         *
         * @param {number} n
         * @returns {Array<string>|null}
         */
        after(n) {
            let first = this.count - this.msgs.length + 1;
            if(!Number.isInteger(n) || n + 1 < first || n > this.count)
                return null;
            return this.msgs.slice(n + 1 - first);
        }
    }

    /**
     * What to do with a websocket that closed while a session was open.
     *
     * @param {number} code
     * @param {boolean} resumable - the server gave us a secret
     * @param {boolean} leaving - we closed it ourselves
     * @returns {'end'|'resume'}
     */
    function onClose(code, resumable, leaving) {
        if(leaving || !resumable)
            return 'end';
        // 1000 is a deliberate close by the server (a kick, for instance);
        // 4001 is its refusal to resume.
        if(code === 1000 || code === CLOSE_NO_RESUME)
            return 'end';
        return 'resume';
    }

    /**
     * What the liveness check should do, given how long the server has
     * been silent.
     *
     * @param {number} silent - milliseconds since the last server message
     * @returns {'ok'|'ping'|'resume'}
     */
    function onTick(silent) {
        if(silent > STALL_AFTER)
            return 'resume';
        if(silent >= PING_AFTER)
            return 'ping';
        return 'ok';
    }

    const api = {
        PING_AFTER, STALL_AFTER, ATTEMPT_TIMEOUT, RETRY_DELAY,
        GIVE_UP_AFTER, MAX_MESSAGES, MAX_BYTES, CLOSE_NO_RESUME,
        counted, SentLog, onClose, onTick,
    };

    global.SozvonResume = api;
    if(typeof module !== 'undefined' && module.exports)
        module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
