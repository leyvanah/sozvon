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

// connection-quality.js -- turns WebRTC statistics into a call quality level.
//
// A call that degrades used to say nothing until ICE failed outright, and then
// only "Cannot receive media ..., still trying" -- in English, with no hint of
// what was wrong or what to do.  This module is the judgement half of the fix:
// it reads a getStats() report, compares it with the previous one, and says
// whether the connection is good, weak, bad or lost.  galene.js does the
// polling and the talking.
//
// Like e2ee-crypto.js it has no dependency on the DOM or on a live
// RTCPeerConnection, so it can be require()d under Node and tested there.
//
// Levels, from best to worst: good, weak, bad, lost.  "lost" comes only from
// the ICE state; the other three come from the numbers.

(function(global) {
    'use strict';

    const LEVELS = ['good', 'weak', 'bad', 'lost'];

    // Thresholds.  Loss is the fraction of packets lost over one polling
    // interval; RTT and jitter are in seconds, as getStats() reports them.
    // Audio stays intelligible to about 3% loss and breaks up past 10%;
    // conversation gets awkward past 300 ms of round trip and falls apart
    // near a second.
    const WEAK = {loss: 0.03, rtt: 0.35, jitter: 0.05};
    const BAD = {loss: 0.10, rtt: 0.8, jitter: 0.15};

    // Too few packets in an interval make the loss ratio noise: two lost out
    // of five is not 40% loss worth announcing.
    const MIN_PACKETS = 20;

    // Hysteresis, in polling intervals: get worse quickly, get better slowly,
    // so a single bad sample does not toast and a recovering link does not
    // flap between "weak" and "good".
    const WORSEN_AFTER = 2;
    const IMPROVE_AFTER = 3;

    /**
     * @param {string} level
     * @returns {number}
     */
    function rank(level) {
        let i = LEVELS.indexOf(level);
        return i < 0 ? 0 : i;
    }

    /**
     * @param {...string} levels
     * @returns {string}
     */
    function worst(...levels) {
        let w = 'good';
        for(let l of levels)
            if(l && rank(l) > rank(w))
                w = l;
        return w;
    }

    /**
     * Reduce a getStats() report to the cumulative counters we need.
     *
     * @param {Iterable<any>} report - RTCStatsReport.values(), or any
     *     iterable of stats dictionaries.
     * @param {number} now - timestamp in milliseconds.
     */
    function snapshot(report, now) {
        let s = {
            time: now,
            // inbound-rtp: what we receive
            received: 0, lost: 0, jitter: 0, inbound: false,
            // remote-inbound-rtp: what the far end says about what we send
            remoteLoss: 0, remoteRtt: 0, outbound: false,
            // selected candidate pair
            rtt: 0,
        };
        for(let r of report) {
            switch(r.type) {
            case 'inbound-rtp':
                s.inbound = true;
                s.received += r.packetsReceived || 0;
                // Duplicates can make packetsLost negative.
                s.lost += Math.max(0, r.packetsLost || 0);
                s.jitter = Math.max(s.jitter, r.jitter || 0);
                break;
            case 'remote-inbound-rtp':
                s.outbound = true;
                s.remoteLoss = Math.max(s.remoteLoss, r.fractionLost || 0);
                s.remoteRtt = Math.max(s.remoteRtt, r.roundTripTime || 0);
                break;
            case 'candidate-pair':
                if(r.nominated && r.state === 'succeeded' &&
                   typeof r.currentRoundTripTime === 'number')
                    s.rtt = Math.max(s.rtt, r.currentRoundTripTime);
                break;
            }
        }
        return s;
    }

    /**
     * Compare two snapshots and name the level the interval between them
     * deserves, or null when there is not enough traffic to judge.
     *
     * @param {ReturnType<typeof snapshot>|null} prev
     * @param {ReturnType<typeof snapshot>} cur
     * @returns {{level: string|null, loss: number, rtt: number, jitter: number}}
     */
    function assess(prev, cur) {
        let rtt = Math.max(cur.rtt, cur.remoteRtt);
        let loss = 0;
        let judged = false;

        if(prev && cur.inbound) {
            let received = cur.received - prev.received;
            let lost = cur.lost - prev.lost;
            if(received >= 0 && lost >= 0 && received + lost >= MIN_PACKETS) {
                loss = lost / (received + lost);
                judged = true;
            }
        }
        if(cur.outbound) {
            loss = Math.max(loss, cur.remoteLoss);
            judged = true;
        }
        if(rtt > 0)
            judged = true;

        let jitter = cur.inbound ? cur.jitter : 0;
        if(!judged)
            return {level: null, loss, rtt, jitter};

        let level = 'good';
        if(loss >= BAD.loss || rtt >= BAD.rtt || jitter >= BAD.jitter)
            level = 'bad';
        else if(loss >= WEAK.loss || rtt >= WEAK.rtt || jitter >= WEAK.jitter)
            level = 'weak';
        return {level, loss, rtt, jitter};
    }

    /**
     * Tracker holds the settled level of one connection and moves it only
     * when the evidence persists.
     *
     * @constructor
     */
    function Tracker() {
        /** @type {string} */
        this.level = 'good';
        /** @type {ReturnType<typeof snapshot>|null} */
        this.prev = null;
        /** @type {string|null} */
        this.pending = null;
        this.count = 0;
    }

    /**
     * Feed one poll.  Returns the settled level and whether it changed.
     *
     * @param {string} iceState - RTCPeerConnection.iceConnectionState.
     * @param {ReturnType<typeof snapshot>|null} snap - null if stats were
     *     unavailable this time.
     * @returns {{level: string, previous: string, changed: boolean}}
     */
    Tracker.prototype.update = function(iceState, snap) {
        let previous = this.level;

        if(iceState === 'failed') {
            // A failed path is announced at once; there is nothing to
            // smooth.  Counters restart after an ICE restart, so forget them.
            this.level = 'lost';
            this.prev = null;
            this.pending = null;
            this.count = 0;
            return {level: this.level, previous,
                    changed: previous !== this.level};
        }

        let raw = null;
        if(iceState === 'disconnected') {
            // Chrome passes through "disconnected" on a brief hiccup and
            // often recovers by itself, so it has to persist like any other
            // bad sample before it counts.
            raw = this.level === 'lost' ? null : 'lost';
            this.prev = null;
        } else if(snap) {
            raw = assess(this.prev, snap).level;
            this.prev = snap;
        }

        if(this.level === 'lost') {
            // Back from lost as soon as ICE is: say "restored" now, and let
            // the numbers settle the level from here.
            if(iceState === 'connected' || iceState === 'completed') {
                this.level = raw && raw !== 'good' ? raw : 'good';
                this.pending = null;
                this.count = 0;
            }
            return {level: this.level, previous,
                    changed: previous !== this.level};
        }

        if(raw === null || raw === this.level) {
            this.pending = null;
            this.count = 0;
            return {level: this.level, previous, changed: false};
        }

        if(raw !== this.pending) {
            this.pending = raw;
            this.count = 0;
        }
        this.count++;
        let needed = rank(raw) > rank(this.level) ?
            WORSEN_AFTER : IMPROVE_AFTER;
        if(this.count >= needed) {
            this.level = raw;
            this.pending = null;
            this.count = 0;
        }
        return {level: this.level, previous,
                changed: previous !== this.level};
    };

    const api = {
        LEVELS, WEAK, BAD, MIN_PACKETS, WORSEN_AFTER, IMPROVE_AFTER,
        rank, worst, snapshot, assess, Tracker,
    };

    global.SozvonConnQuality = api;
    if(typeof module !== 'undefined' && module.exports)
        module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
