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

// camera-diag.js -- where a published camera's picture stops.  (Sozvon)
//
// On 2026-10-21 a guest turned her camera on nine times and not one video
// packet left her browser; her own preview stayed empty too, while the same
// camera worked in another service.  The server could say only that nothing
// arrived.  Between the camera and the wire there are several steps, any of
// which can stall without an error:
//
//   camera track -> (on touch devices and with a filter) a hidden <video>
//   playing it -> a canvas redrawn from that element -> the RTP sender's
//   input -> the encoder -> packets on the wire; and, beside them, the
//   preview the person sees.
//
// A few seconds after a camera stream is published, galene.js gathers each
// step's own counters and sends them, as one report, to the connection log
// (rtpconn/connlog.go): the first step whose count is zero is where the
// picture stops.  Only words from fixed lists and numbers go out -- the
// platform as a coarse family, never the user agent.
//
// The pure part is here, so it can be tested in node; galene.js reads the
// browser.

'use strict';

(function(global) {
    // How long after publishing the camera is looked at: a slow phone camera
    // takes a second or two to deliver its first frame, a permission prompt
    // is over by then (the stream is published only once it is answered).
    const CHECK_AFTER = 6000;

    const BROWSERS = ['edge', 'yandex', 'samsung', 'opera', 'firefox',
                      'chrome', 'safari', 'webview', 'other'];
    const CANVAS = ['none', 'orientation', 'filter'];
    // what the hidden element's play() came to (DOMException names)
    const PLAY = ['ok', 'pending', 'NotAllowedError', 'AbortError',
                  'NotSupportedError', 'error'];
    const LIMITS = ['none', 'cpu', 'bandwidth', 'other'];

    /**
     * The browser family, from the user agent.  Order matters: Edge, Opera,
     * Yandex and Samsung all say "Chrome" too, and every Chromium says
     * "Safari".
     *
     * @param {string} ua
     * @returns {string} one of BROWSERS
     */
    function browserFamily(ua) {
        ua = ua || '';
        if(/Edg(e|A|iOS)?\//.test(ua))
            return 'edge';
        if(/YaBrowser\//.test(ua))
            return 'yandex';
        if(/SamsungBrowser\//.test(ua))
            return 'samsung';
        if(/OPR\/|OPT\//.test(ua))
            return 'opera';
        if(/Firefox\/|FxiOS\//.test(ua))
            return 'firefox';
        // an Android WebView marks itself with "wv"
        if(/Android/.test(ua) && /; wv\)/.test(ua))
            return 'webview';
        if(/Chrome\/|CriOS\/|Chromium\//.test(ua))
            return 'chrome';
        if(/Safari\//.test(ua) || /iPhone|iPad|iPod/.test(ua))
            return 'safari';
        return 'other';
    }

    /**
     * A non-negative integer, or null.
     *
     * @param {any} v
     * @returns {number|null}
     */
    function count(v) {
        if(typeof v !== 'number' || !Number.isFinite(v) || v < 0)
            return null;
        return Math.round(v);
    }

    /**
     * @param {any} v
     * @param {string[]} allowed
     * @param {string} fallback
     * @returns {string}
     */
    function oneOf(v, allowed, fallback) {
        return allowed.indexOf(v) >= 0 ? v : fallback;
    }

    /**
     * The sender's side of the chain, from an up connection's getStats():
     * frames the sender got from its track (media-source), frames encoded,
     * packets sent, and what limits the encoder.  Summed over the video
     * encodings, so simulcast counts as one stream.  A counter the browser
     * does not report stays null -- not zero, which would be evidence.
     *
     * @param {Iterable<any>} report - RTCStatsReport.values()
     * @returns {{source: number|null, encoded: number|null,
     *            sent: number|null, limit: string|null}}
     */
    function senderStats(report) {
        let r = {source: null, encoded: null, sent: null, limit: null};
        let add = (k, v) => {
            let n = count(v);
            if(n !== null)
                r[k] = (r[k] || 0) + n;
        };
        for(let s of report) {
            let kind = s.kind || s.mediaType;
            if(kind !== 'video')
                continue;
            if(s.type === 'media-source') {
                add('source', s.frames);
            } else if(s.type === 'outbound-rtp') {
                add('encoded', s.framesEncoded);
                add('sent', s.packetsSent);
                let l = s.qualityLimitationReason;
                // the most telling reason across encodings
                if(typeof l === 'string' && (r.limit === null ||
                                             r.limit === 'none'))
                    r.limit = oneOf(l, LIMITS, 'other');
            }
        }
        return r;
    }

    /**
     * The report for the connection log, from what galene.js read.  Every
     * field is a word from a fixed list, a boolean, a number or null, so
     * the server can check it field by field.
     *
     * @param {Object} p
     * @param {{os: string, app: string|null}} p.platform - detectPlatform
     *     in media-help.js
     * @param {string} p.ua
     * @param {boolean} p.touch
     * @param {string} p.canvas - 'none', 'orientation' or 'filter'
     * @param {{readyState?: string, muted?: boolean, enabled?: boolean,
     *          settings?: {width?: number, height?: number,
     *                      frameRate?: number},
     *          delivered?: number|null}} p.track - the camera's own track
     * @param {{paused: boolean, readyState: number, videoWidth: number,
     *          videoHeight: number, play: string, drawn: number}|null}
     *     p.element - the hidden element and canvas of a filter, or null
     * @param {ReturnType<typeof senderStats>} p.sender
     * @param {number|null} p.preview - frames the preview presented
     * @param {number} p.after - milliseconds since the stream was published
     */
    function report(p) {
        let t = p.track || {};
        let set = t.settings || {};
        let v = {
            after: count(p.after / 1000),
            os: p.platform && p.platform.os || 'other',
            app: p.platform && p.platform.app || null,
            browser: browserFamily(p.ua),
            touch: !!p.touch,
            canvas: oneOf(p.canvas, CANVAS, 'none'),
            track: t.readyState === 'ended' ? 'ended' : 'live',
            muted: !!t.muted,
            enabled: t.enabled === undefined || !!t.enabled,
            width: count(set.width),
            height: count(set.height),
            fps: count(set.frameRate),
            delivered: count(t.delivered),
            paused: null,
            ready: null,
            elementWidth: null,
            elementHeight: null,
            play: null,
            drawn: null,
            source: p.sender ? p.sender.source : null,
            encoded: p.sender ? p.sender.encoded : null,
            sent: p.sender ? p.sender.sent : null,
            limit: p.sender ? p.sender.limit : null,
            preview: count(p.preview),
        };
        let e = p.element;
        if(e && v.canvas !== 'none') {
            v.paused = !!e.paused;
            v.ready = Math.min(4, count(e.readyState) || 0);
            v.elementWidth = count(e.videoWidth);
            v.elementHeight = count(e.videoHeight);
            v.play = oneOf(e.play, PLAY, 'error');
            v.drawn = count(e.drawn);
        }
        return v;
    }

    const api = {
        CHECK_AFTER, BROWSERS, CANVAS, PLAY, LIMITS,
        browserFamily, senderStats, report,
    };

    global.SozvonCameraDiag = api;
    if(typeof module !== 'undefined' && module.exports)
        module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
