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

// bitrate-control.js -- receiver-driven video bitrate caps.
//
// The SFU already caps a sender by what its receivers report: packet loss and
// the receivers' REMB estimates (rtpconn/rtpconn.go).  Neither signal survives
// a TURN relay over TCP, which is the only relay this deployment can use: TCP
// retransmits, so nothing is ever lost, and delay arrives in bursts that the
// delay-based estimator does not read as congestion.  A sender then pushes
// 4-6 Mbit/s into a path that cannot carry it smoothly, and the person at the
// other end hears audio falling behind the picture.
//
// So the judgement moves to what the receiver actually experiences -- the
// audio jitter buffer growing, video freezing, audio being concealed -- and a
// receiver whose playback suffers asks the sender, over a user message, to cap
// its video.  Caps drop fast and rise slowly, and are lifted altogether once
// the link has been healthy long enough: full quality when the path allows it.
//
// Like connection-quality.js this has no DOM or WebRTC dependency, so the
// control logic is tested under Node.

(function(global) {
    'use strict';

    // Receiver-side thresholds, per polling interval.  Healthy audio plays
    // out of a 20-80 ms buffer; sustained growth past a couple of hundred
    // milliseconds is the lag people notice.
    const CONGESTED = {
        audioDelay: 0.25,       // seconds of jitter buffer
        videoDelay: 0.4,
        concealed: 0.05,        // fraction of audio samples concealed
        freeze: 0.3,            // seconds of video freeze in the interval
    };
    const HEALTHY = {
        audioDelay: 0.12,
        videoDelay: 0.2,
        concealed: 0.01,
        freeze: 0,
    };

    const MIN_CAP = 150000;         // never ask for less than this
    // A request above this is not a cap anyone could mean (and above
    // 2^32 it is not a valid maxBitrate at all).
    const MAX_CAP = 100000000;
    const RELEASE_AT = 3000000;     // a cap this high is lifted entirely
    const DECREASE = 0.6;           // new cap = DECREASE x what arrived
    const INCREASE = 1.3;
    // When far less arrives than the cap allows, the cap is not what limits
    // the sender, so it can open faster.
    const INCREASE_UNUSED = 2;
    const UNUSED_BELOW = 0.7;
    const BAD_TO_DECREASE = 2;      // consecutive bad intervals
    const GOOD_TO_INCREASE = 8;     // consecutive good intervals
    const MIN_DECREASE_GAP = 6000;  // ms between two decreases
    const MIN_INCREASE_GAP = 15000; // ms after any change before increasing
    // The first seconds of a stream are not evidence: the audio jitter
    // buffer settles after connecting, and on a busy machine it reads
    // 0.7 s before it does.  Nothing is decreased this early.
    const WARMUP = 10000;
    const REFRESH = 10000;          // receiver resends a standing cap
    const TTL = 35000;              // sender forgets an unrefreshed cap

    const MESSAGE_KIND = 'sozvon-bitrate';

    /**
     * Bring a cap into range: null (no cap) unless it is a finite number in
     * (0, MAX_CAP], and never below MIN_CAP.  A cap arrives from another
     * client, so nothing about its type or value is taken on trust.
     *
     * @param {any} cap
     * @returns {number|null}
     */
    function sanitizeCap(cap) {
        if(typeof cap !== 'number' || !Number.isFinite(cap) || !(cap > 0))
            return null;
        if(cap > MAX_CAP)
            return null;
        return Math.max(MIN_CAP, Math.round(cap));
    }

    /**
     * Reduce a getStats() report of a receiving connection to cumulative
     * counters.
     *
     * @param {Iterable<any>} report
     * @param {number} now - milliseconds
     */
    function snapshot(report, now) {
        let s = {
            time: now,
            audio: false, video: false,
            aDelay: 0, aEmitted: 0, aConcealed: 0, aSamples: 0,
            vDelay: 0, vEmitted: 0, vFreeze: 0, vBytes: 0,
        };
        for(let r of report) {
            if(r.type !== 'inbound-rtp')
                continue;
            let kind = r.kind || r.mediaType;
            if(kind === 'audio') {
                s.audio = true;
                s.aDelay += r.jitterBufferDelay || 0;
                s.aEmitted += r.jitterBufferEmittedCount || 0;
                s.aConcealed += Math.max(0, (r.concealedSamples || 0) -
                                         (r.silentConcealedSamples || 0));
                s.aSamples += r.totalSamplesReceived || 0;
            } else if(kind === 'video') {
                s.video = true;
                s.vDelay += r.jitterBufferDelay || 0;
                s.vEmitted += r.jitterBufferEmittedCount || 0;
                s.vFreeze += r.totalFreezesDuration || 0;
                s.vBytes += r.bytesReceived || 0;
            }
        }
        return s;
    }

    /**
     * What one interval looked like to the person watching.
     *
     * @param {ReturnType<typeof snapshot>|null} prev
     * @param {ReturnType<typeof snapshot>} cur
     * @returns {{state: string, videoBps: number, audioDelay: number,
     *            videoDelay: number, concealed: number, freeze: number}}
     *     state is 'bad', 'good', 'hold' (in between) or 'unknown'.
     */
    function assess(prev, cur) {
        let r = {state: 'unknown', videoBps: 0, audioDelay: 0,
                 videoDelay: 0, concealed: 0, freeze: 0};
        if(!prev || cur.time <= prev.time)
            return r;
        let dt = (cur.time - prev.time) / 1000;

        let judged = false;
        let de = cur.aEmitted - prev.aEmitted;
        if(de > 0) {
            r.audioDelay = (cur.aDelay - prev.aDelay) / de;
            judged = true;
        }
        let ds = cur.aSamples - prev.aSamples;
        if(ds > 0)
            r.concealed = Math.max(0, cur.aConcealed - prev.aConcealed) / ds;
        let dv = cur.vEmitted - prev.vEmitted;
        if(dv > 0) {
            r.videoDelay = (cur.vDelay - prev.vDelay) / dv;
            judged = true;
        }
        if(cur.video) {
            r.freeze = Math.max(0, cur.vFreeze - prev.vFreeze);
            r.videoBps = Math.max(0, cur.vBytes - prev.vBytes) * 8 / dt;
        }
        if(!judged)
            return r;

        if(r.audioDelay > CONGESTED.audioDelay ||
           r.videoDelay > CONGESTED.videoDelay ||
           r.concealed > CONGESTED.concealed ||
           r.freeze > CONGESTED.freeze)
            r.state = 'bad';
        else if(r.audioDelay <= HEALTHY.audioDelay &&
                r.videoDelay <= HEALTHY.videoDelay &&
                r.concealed <= HEALTHY.concealed &&
                r.freeze <= HEALTHY.freeze)
            r.state = 'good';
        else
            r.state = 'hold';
        return r;
    }

    /**
     * Receiver-side controller for one incoming stream: decides what cap to
     * ask its sender for.  cap === null means "no cap, full quality".
     *
     * @constructor
     */
    function Controller() {
        /** @type {number|null} */
        this.cap = null;
        this.prev = null;
        this.bad = 0;
        this.good = 0;
        this.changedAt = -Infinity;
        this.sentAt = -Infinity;
        /** @type {number|null} */
        this.startedAt = null;
        /** @type {number[]} */
        this.rates = [];
    }

    /**
     * Feed one poll.
     *
     * @param {ReturnType<typeof snapshot>} snap
     * @returns {{cap: number|null, changed: boolean, send: boolean,
     *            sample: ReturnType<typeof assess>}}
     *     send is true when the cap should be (re)sent to the sender now.
     */
    Controller.prototype.update = function(snap) {
        let now = snap.time;
        let sample = assess(this.prev, snap);
        this.prev = snap;
        let old = this.cap;
        if(this.startedAt === null && sample.state !== 'unknown')
            this.startedAt = now;
        let warming = this.startedAt === null ||
            now - this.startedAt < WARMUP;

        // No video coming in at all -- the sender stopped it, or we stopped
        // asking for it: a cap we asked for is not ours to hold any more.
        if(!snap.video) {
            this.rates = [];
            this.bad = 0;
            this.good = 0;
            this.cap = null;
            let changed = old !== null;
            if(changed) {
                this.changedAt = now;
                this.sentAt = now;
            }
            return {cap: null, changed, send: changed, sample};
        }

        // Zero counts too: a rate from before the video stopped arriving
        // must not pass for what arrives now.
        if(sample.state !== 'unknown' && Number.isFinite(sample.videoBps)) {
            this.rates.push(sample.videoBps);
            if(this.rates.length > 3)
                this.rates.shift();
        }

        if(sample.state === 'bad' && warming) {
            this.bad = 0;
            this.good = 0;
        } else if(sample.state === 'bad') {
            this.bad++;
            this.good = 0;
        } else if(sample.state === 'good') {
            this.good++;
            this.bad = 0;
        } else if(sample.state === 'hold') {
            this.bad = 0;
            this.good = 0;
        }

        // Nothing to shrink if no video is arriving.
        let arriving = this.rates.length ?
            Math.max(...this.rates) : 0;

        if(this.bad >= BAD_TO_DECREASE && arriving > 0 &&
           now - this.changedAt >= MIN_DECREASE_GAP) {
            let base = this.cap === null ? arriving :
                Math.min(this.cap, arriving);
            let cap = sanitizeCap(base * DECREASE);
            if(cap !== null && (this.cap === null || cap < this.cap)) {
                this.cap = cap;
                this.changedAt = now;
            }
            this.bad = 0;
        } else if(this.cap !== null && this.good >= GOOD_TO_INCREASE &&
                  now - this.changedAt >= MIN_INCREASE_GAP) {
            let factor = arriving > 0 && arriving < this.cap * UNUSED_BELOW ?
                INCREASE_UNUSED : INCREASE;
            let cap = sanitizeCap(this.cap * factor);
            this.cap = cap === null || cap >= RELEASE_AT ? null : cap;
            this.changedAt = now;
            this.good = 0;
        }

        let changed = this.cap !== old;
        let send = changed ||
            (this.cap !== null && now - this.sentAt >= REFRESH);
        if(send)
            this.sentAt = now;
        return {cap: this.cap, changed, send, sample};
    };

    /**
     * Sender-side registry of the caps receivers have asked for, per stream.
     *
     * @constructor
     */
    function Caps() {
        /** @type {Map<string, Map<string, {cap: number, at: number}>>} */
        this.streams = new Map();
    }

    /**
     * Record a request.  Returns true if the effective cap of the stream
     * may have changed.
     *
     * @param {string} stream
     * @param {string} from
     * @param {any} cap - anything that is not a valid cap lifts the request
     * @param {number} now
     * @returns {boolean}
     */
    Caps.prototype.set = function(stream, from, cap, now) {
        let before = this.get(stream, now);
        let m = this.streams.get(stream);
        cap = sanitizeCap(cap);
        if(cap === null) {
            if(m) {
                m.delete(from);
                if(m.size === 0)
                    this.streams.delete(stream);
            }
        } else {
            if(!m) {
                m = new Map();
                this.streams.set(stream, m);
            }
            m.set(from, {cap, at: now});
        }
        return this.get(stream, now) !== before;
    };

    /**
     * The tightest fresh cap for a stream, or null.
     *
     * @param {string} stream
     * @param {number} now
     * @returns {number|null}
     */
    Caps.prototype.get = function(stream, now) {
        let m = this.streams.get(stream);
        if(!m)
            return null;
        let min = null;
        for(let [from, e] of m) {
            if(now - e.at > TTL) {
                m.delete(from);
                continue;
            }
            if(min === null || e.cap < min)
                min = e.cap;
        }
        if(m.size === 0)
            this.streams.delete(stream);
        return min;
    };

    /**
     * Drop every request from one receiver (it left).
     *
     * @param {string} from
     * @returns {string[]} streams whose requests were dropped
     */
    Caps.prototype.forget = function(from) {
        let touched = [];
        for(let [stream, m] of this.streams) {
            if(m.delete(from))
                touched.push(stream);
            if(m.size === 0)
                this.streams.delete(stream);
        }
        return touched;
    };

    /**
     * Combine the user's own setting (null = unlimited) with a cap.
     *
     * @param {number|null} setting
     * @param {number|null} cap
     * @returns {number|null}
     */
    function combine(setting, cap) {
        if(cap === null)
            return setting;
        if(setting === null || setting <= 0)
            return cap;
        return Math.min(setting, cap);
    }

    const api = {
        CONGESTED, HEALTHY, MIN_CAP, MAX_CAP, RELEASE_AT, DECREASE, INCREASE,
        INCREASE_UNUSED, UNUSED_BELOW,
        BAD_TO_DECREASE, GOOD_TO_INCREASE, MIN_DECREASE_GAP, WARMUP,
        MIN_INCREASE_GAP, REFRESH, TTL, MESSAGE_KIND,
        sanitizeCap, snapshot, assess, Controller, Caps, combine,
    };

    global.SozvonBitrate = api;
    if(typeof module !== 'undefined' && module.exports)
        module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
