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
// A new stream starts capped rather than free.  Left alone the sender climbs
// to 2-3 Mbit/s within seconds, and over the TCP relay the lag that builds
// there takes a minute of decreases to drain -- the first minute of every
// call, audio behind and breaking up (2026-09-23).  Starting at START_CAP and
// opening while playback stays healthy costs a well-connected call about a
// minute of slightly softer picture instead.
//
// Not all delay is ours to cure.  A path that delivers in bursts -- the TCP
// relay, a VPN, a mobile network -- keeps the jitter buffer deep whatever the
// sender does, and judged against fixed thresholds such a path looks
// congested for good: on 2026-10-09 and twice on 2026-10-12 a call was cut
// to the 150 kbit/s floor within a minute and stayed there to the end, an
// hour in one case, with the audio buffer at 260-330 ms whether the sender
// sent 600 kbit/s or 150 (tasks#62).  So the controller remembers what delay
// it saw at lower caps: if the buffer was that deep even at a much lower
// cap, or at the floor, that much is the path's, and the thresholds are
// measured from it.  Delay the sender adds on top still counts as before,
// and with no such evidence -- a stream that has never been cut -- the
// fixed thresholds apply alone.
//
// A camera is not lifted all the way.  Uncapped, a sender's browser pushed
// a camera to 7-10 Mbit/s on 2026-10-13, and within a minute or three the
// receiver lost 15-44% of the audio in an interval, or heard it 300 ms late;
// the cap came down, rose, was lifted again -- 26 times in an hour, 14 audible
// breaks (tasks#65).  A camera's picture stops getting better long before
// that: by default it captures about 640x480, which looks its best at 1-1.5
// Mbit/s.  So a camera stream rises to a ceiling set by the largest picture
// it has shown and stays there: CAMERA_CEILING.  A shared screen or a video
// file is still lifted as before.
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

    // On top of the path's own delay (see above): what the sender may add
    // before the interval counts as congested, and what it may add and the
    // interval still count as healthy.  The fixed thresholds above stay the
    // floor of both.
    const EXCESS_CONGESTED = {audioDelay: 0.15, videoDelay: 0.2};
    const EXCESS_HEALTHY = {audioDelay: 0.05, videoDelay: 0.08};
    // A delay seen at a cap this much lower than the current one (or at the
    // floor) is the path's: sending less did not cure it.
    const PROVEN_BELOW = 0.7;
    // How long such evidence is kept, and how long the delay it showed is
    // trusted once no new evidence comes (uncapped, nothing is lower) and
    // the delay stops being explained by it.  Long enough to climb back
    // from the floor step by step, which takes a couple of minutes.
    const PATH_MEMORY = 300000;
    // A lower delay seen for this many intervals in a row shows the path
    // got better, and the path's delay follows it down.
    const PATH_LOWER_AFTER = 3;
    // Nor is a delay measured in the first seconds after a change: the
    // buffer still holds what the old cap left in it.
    const SETTLE = 4000;

    const MIN_CAP = 150000;         // never ask for less than this
    // A request above this is not a cap anyone could mean (and above
    // 2^32 it is not a valid maxBitrate at all).
    const MAX_CAP = 100000000;
    const RELEASE_AT = 3000000;     // a cap this high is lifted entirely
    // ... except on a camera, which rises to a ceiling instead, by the
    // largest picture seen: [lines up to, ceiling].  About twice what each
    // picture needs to look its best.  Lines are the short side of the
    // picture, so a phone held upright (480x640) counts as the 640x480 it
    // is, not as 720p: by its height it was given 4 Mbit/s, more than a
    // mobile uplink carries, and the cap kept climbing into it and breaking
    // the audio every few minutes (2026-10-14).
    const CAMERA_CEILING = [
        [540, 2500000],             // 640x480, the default capture
        [800, 4000000],             // 720p
        [Infinity, 6000000],        // 1080p and above (the blackboard mode)
    ];
    const START_CAP = 1000000;      // what a new stream is first asked for
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
            // Not used to decide anything yet: reported with each cap
            // asked for, to tell a congested network (packets arrive
            // unevenly) from a receiver too busy to play on time (they
            // arrive evenly, decoding is slow).  tasks#32.
            aJitter: 0, vProcessing: 0, vDecoded: 0,
            // the picture as it arrives: largest frame, current estimate
            vWidth: 0, vHeight: 0,
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
                // the arrival jitter is a current estimate, not a counter
                s.aJitter = Math.max(s.aJitter, r.jitter || 0);
            } else if(kind === 'video') {
                s.video = true;
                s.vDelay += r.jitterBufferDelay || 0;
                s.vEmitted += r.jitterBufferEmittedCount || 0;
                s.vFreeze += r.totalFreezesDuration || 0;
                s.vBytes += r.bytesReceived || 0;
                s.vProcessing += r.totalProcessingDelay || 0;
                s.vDecoded += r.framesDecoded || 0;
                if((r.frameHeight || 0) > s.vHeight) {
                    s.vHeight = r.frameHeight;
                    s.vWidth = r.frameWidth || 0;
                }
            }
        }
        return s;
    }

    /**
     * What one interval looked like to the person watching.
     *
     * @param {ReturnType<typeof snapshot>|null} prev
     * @param {ReturnType<typeof snapshot>} cur
     * @param {{audioDelay: number, videoDelay: number}|null} [path] - the
     *     delay that is the path's, not the sender's; none if unknown
     * @returns {{state: string, videoBps: number, audioDelay: number,
     *            videoDelay: number, concealed: number, freeze: number,
     *            jitter: number, processing: number,
     *            width: number, height: number, fps: number,
     *            path: {audioDelay: number, videoDelay: number}|null}}
     *     state is 'bad', 'good', 'hold' (in between) or 'unknown';
     *     path is what it was judged against.
     */
    function assess(prev, cur, path) {
        let r = {state: 'unknown', videoBps: 0, audioDelay: 0,
                 videoDelay: 0, concealed: 0, freeze: 0,
                 jitter: 0, processing: 0, width: 0, height: 0, fps: 0,
                 path: path || null};
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
        r.jitter = cur.aJitter || 0;
        let dd = (cur.vDecoded || 0) - (prev.vDecoded || 0);
        if(dd > 0)
            r.processing = Math.max(0, (cur.vProcessing || 0) -
                                    (prev.vProcessing || 0)) / dd;
        if(cur.video) {
            r.width = cur.vWidth || 0;
            r.height = cur.vHeight || 0;
            r.fps = Math.max(0, dd) / dt;
            r.freeze = Math.max(0, cur.vFreeze - prev.vFreeze);
            r.videoBps = Math.max(0, cur.vBytes - prev.vBytes) * 8 / dt;
        }
        if(!judged)
            return r;

        let congested = CONGESTED, healthy = HEALTHY;
        if(path) {
            congested = {...CONGESTED,
                audioDelay: Math.max(CONGESTED.audioDelay,
                                     path.audioDelay + EXCESS_CONGESTED.audioDelay),
                videoDelay: Math.max(CONGESTED.videoDelay,
                                     path.videoDelay + EXCESS_CONGESTED.videoDelay),
            };
            healthy = {...HEALTHY,
                audioDelay: Math.max(HEALTHY.audioDelay,
                                     path.audioDelay + EXCESS_HEALTHY.audioDelay),
                videoDelay: Math.max(HEALTHY.videoDelay,
                                     path.videoDelay + EXCESS_HEALTHY.videoDelay),
            };
        }

        if(r.audioDelay > congested.audioDelay ||
           r.videoDelay > congested.videoDelay ||
           r.concealed > congested.concealed ||
           r.freeze > congested.freeze)
            r.state = 'bad';
        else if(r.audioDelay <= healthy.audioDelay &&
                r.videoDelay <= healthy.videoDelay &&
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
     * @param {number|null} [startCap] - asked for as soon as video arrives,
     *     then opened while playback is healthy; none if omitted.
     * @param {string} [label] - the stream's label; 'camera' rises to a
     *     ceiling instead of being lifted
     */
    function Controller(startCap, label) {
        /** @type {number|null} */
        this.startCap = sanitizeCap(startCap);
        this.camera = label === 'camera';
        /** The largest picture seen on the stream, by its short side. */
        this.maxLines = 0;
        /** Whether video has arrived since the start or since it stopped. */
        this.started = false;
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
        /**
         * Delays seen while capped, as evidence of the path's own delay.
         * @type {Array<{time: number, cap: number, audioDelay: number, videoDelay: number}>}
         */
        this.seen = [];
        /**
         * The path's delay as last established, and until when it holds.
         * @type {{audioDelay: number, videoDelay: number}|null}
         */
        this.path = null;
        this.pathUntil = -Infinity;
        /** @type {Array<{audioDelay: number, videoDelay: number}>} */
        this.recent = [];
    }

    /**
     * How far the cap may rise: for a camera, the ceiling for the largest
     * picture it has shown; null for anything else, which is lifted.
     *
     * @returns {number|null}
     */
    Controller.prototype.ceiling = function() {
        if(!this.camera)
            return null;
        for(let [lines, ceiling] of CAMERA_CEILING)
            if(this.maxLines <= lines)
                return ceiling;
        return null;
    };

    /**
     * The evidence of the path's delay at the current cap: the least delay
     * seen at a cap well below it, or at the floor.  null if there is none.
     *
     * @param {number} now
     * @returns {{audioDelay: number, videoDelay: number}|null}
     */
    Controller.prototype.pathEvidence = function(now) {
        while(this.seen.length && now - this.seen[0].time > PATH_MEMORY)
            this.seen.shift();
        let current = this.cap === null ? Infinity : this.cap;
        let path = null;
        for(let e of this.seen) {
            if(e.cap > MIN_CAP && e.cap > current * PROVEN_BELOW)
                continue;
            if(!path) {
                path = {audioDelay: e.audioDelay, videoDelay: e.videoDelay};
            } else {
                path.audioDelay = Math.min(path.audioDelay, e.audioDelay);
                path.videoDelay = Math.min(path.videoDelay, e.videoDelay);
            }
        }
        return path;
    };

    /**
     * The delay that is the path's, not the sender's: fresh evidence if
     * there is any, else what was last established, while it holds.
     *
     * @param {number} now
     * @returns {{audioDelay: number, videoDelay: number}|null}
     */
    Controller.prototype.pathDelay = function(now) {
        let evidence = this.pathEvidence(now);
        if(evidence) {
            this.path = evidence;
            this.pathUntil = Math.max(this.pathUntil, now + PATH_MEMORY);
        } else if(this.path && now >= this.pathUntil) {
            this.path = null;
        }
        return this.path;
    };

    /**
     * After an interval was judged against the path's delay: while the
     * delay sits within it the path still explains it, so it holds on; and
     * a path seen to be better than established is lowered.
     *
     * @param {{state: string, audioDelay: number, videoDelay: number}} sample
     * @param {number} now
     */
    Controller.prototype.confirmPath = function(sample, now) {
        this.recent.push({audioDelay: sample.audioDelay,
                          videoDelay: sample.videoDelay});
        if(this.recent.length > PATH_LOWER_AFTER)
            this.recent.shift();
        if(!this.path)
            return;
        if(sample.state !== 'bad')
            this.pathUntil = Math.max(this.pathUntil, now + PATH_MEMORY);
        if(this.recent.length >= PATH_LOWER_AFTER) {
            let a = Math.max(...this.recent.map(r => r.audioDelay));
            let v = Math.max(...this.recent.map(r => r.videoDelay));
            this.path = {audioDelay: Math.min(this.path.audioDelay, a),
                         videoDelay: Math.min(this.path.videoDelay, v)};
        }
    };

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
        let path = this.pathDelay(now);
        let sample = assess(this.prev, snap, path);
        let lines = sample.width > 0 ?
            Math.min(sample.width, sample.height) : sample.height;
        if(lines > this.maxLines)
            this.maxLines = lines;
        this.prev = snap;
        let old = this.cap;
        if(this.startedAt === null && sample.state !== 'unknown')
            this.startedAt = now;
        let warming = this.startedAt === null ||
            now - this.startedAt < WARMUP;
        // Evidence for pathDelay: what this cap left in the buffer.  Not
        // while warming up, when the buffer has not settled.
        if(!warming && sample.state !== 'unknown') {
            if(this.cap !== null && now - this.changedAt >= SETTLE)
                this.seen.push({time: now, cap: this.cap,
                                audioDelay: sample.audioDelay,
                                videoDelay: sample.videoDelay});
            this.confirmPath(sample, now);
        }

        // No video coming in at all -- the sender stopped it, or we stopped
        // asking for it: a cap we asked for is not ours to hold any more.
        if(!snap.video) {
            this.started = false;
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

        // Video resuming after a pause restarts high just like a new stream.
        if(!this.started) {
            this.started = true;
            if(this.startCap !== null && this.cap === null) {
                this.cap = this.startCap;
                this.changedAt = now;
            }
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
            let ceiling = this.ceiling();
            if(ceiling !== null) {
                // a camera stays at its ceiling once there
                if(this.cap < ceiling) {
                    this.cap = Math.min(cap === null ? ceiling : cap, ceiling);
                    this.changedAt = now;
                }
            } else {
                this.cap = cap === null || cap >= RELEASE_AT ? null : cap;
                this.changedAt = now;
            }
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
        CAMERA_CEILING, CONGESTED, HEALTHY, EXCESS_CONGESTED, EXCESS_HEALTHY, PROVEN_BELOW,
        PATH_MEMORY, PATH_LOWER_AFTER, SETTLE, MIN_CAP, MAX_CAP, RELEASE_AT, START_CAP,
        DECREASE, INCREASE,
        INCREASE_UNUSED, UNUSED_BELOW,
        BAD_TO_DECREASE, GOOD_TO_INCREASE, MIN_DECREASE_GAP, WARMUP,
        MIN_INCREASE_GAP, REFRESH, TTL, MESSAGE_KIND,
        sanitizeCap, snapshot, assess, Controller, Caps, combine,
    };

    global.SozvonBitrate = api;
    if(typeof module !== 'undefined' && module.exports)
        module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
