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

// framing.js -- the shape of the picture, at both ends of a call.  (Sozvon)
//
// The server forwards what the sender encoded, once, to everybody; with
// end-to-end encryption it cannot even see it.  So framing is split in two:
//
//   - the sender decides what leaves the device: the camera picture, turned
//     upright, cut to the format the user picked (16:9, 4:3, 1:1, 9:16).
//     What is cut here no receiver can get back, so it is the user's choice;
//   - each receiver decides how that picture fills its own tile: edge to edge
//     when that costs only a margin, the whole frame otherwise.  Nothing is
//     lost, and every receiver can decide differently.
//
// Both cut around a point of interest.  Until there is a face detector it is
// a fixed guess -- the middle of the frame across, a little above the middle
// down -- which is where a face sits in a webcam picture: the cut takes more
// from the chest than from the forehead.
//
// Pure functions only, so the arithmetic is tested in node; galene.js and
// filter.js do the drawing.

(function(global) {
    'use strict';

    /**
     * The formats the sender can cut to, by setting value.  'camera' (or
     * anything not listed) means: as the camera gives it.
     *
     * @type {Record<string, number>}
     */
    const ASPECTS = {
        '16:9': 16 / 9,
        '4:3': 4 / 3,
        '1:1': 1,
        '9:16': 9 / 16,
    };

    /**
     * Where the face is assumed to be, as fractions of the upright frame.
     */
    const FOCUS = {x: 0.5, y: 0.42};

    /**
     * A receiver fills its tile only while at least this much of the
     * picture's width survives a cut at the sides...
     */
    const MIN_VISIBLE_WIDTH = 0.6;

    /**
     * ...and this much of its height a cut at the top and bottom.  Tighter,
     * because the face is nearer the top than the sides: 0.75 is exactly what
     * a 4:3 picture keeps on a 16:9 screen, and with the cut weighted towards
     * the chest that leaves the forehead in.
     */
    const MIN_VISIBLE_HEIGHT = 0.75;

    /**
     * @param {string} name
     * @returns {number|null}
     */
    function aspectOf(name) {
        return Object.prototype.hasOwnProperty.call(ASPECTS, name) ?
            ASPECTS[name] : null;
    }

    /**
     * @param {number} v
     * @param {number} lo
     * @param {number} hi
     */
    function clamp(v, lo, hi) {
        return Math.min(hi, Math.max(lo, v));
    }

    /**
     * Video encoders want even sizes; never below two.
     *
     * @param {number} v
     */
    function even(v) {
        return Math.max(2, Math.floor(v / 2) * 2);
    }

    /**
     * The largest rectangle of the given shape inside a w x h frame, placed
     * so that the point of interest is as near its middle as the frame
     * allows.
     *
     * @param {number} w
     * @param {number} h
     * @param {number|null} aspect - width / height, or null for no cut
     * @param {{x: number, y: number}} [focus]
     * @returns {{x: number, y: number, w: number, h: number}}
     */
    function crop(w, h, aspect, focus) {
        if(!aspect || !(w > 0) || !(h > 0))
            return {x: 0, y: 0, w: w, h: h};
        let cw = w, ch = w / aspect;
        if(ch > h) {
            ch = h;
            cw = h * aspect;
        }
        // A cut that would shave off less than a pixel or two is no cut.
        cw = Math.abs(cw - w) < 2 ? w : even(cw);
        ch = Math.abs(ch - h) < 2 ? h : even(ch);
        let f = focus || FOCUS;
        let x = Math.round(clamp(f.x * w - cw / 2, 0, w - cw));
        let y = Math.round(clamp(f.y * h - ch / 2, 0, h - ch));
        return {x: x, y: y, w: cw, h: ch};
    }

    /**
     * What the sender draws: the camera picture of vw x vh turned by rot
     * degrees (0, 90, 180, 270), then cut to aspect.
     *
     * The cut is worked out on the upright picture -- that is where "a
     * little above the middle" means anything -- and returned in its
     * coordinates.
     *
     * @param {number} vw
     * @param {number} vh
     * @param {number} rot
     * @param {number|null} aspect
     * @returns {{rot: number, uw: number, uh: number,
     *            crop: {x: number, y: number, w: number, h: number}}}
     */
    function geometry(vw, vh, rot, aspect) {
        rot = ((Math.round(rot / 90) * 90) % 360 + 360) % 360;
        let swap = rot === 90 || rot === 270;
        let uw = swap ? vh : vw;
        let uh = swap ? vw : vh;
        return {rot: rot, uw: uw, uh: uh, crop: crop(uw, uh, aspect)};
    }

    /**
     * How a receiver shows a picture of vw x vh in a box of bw x bh.
     *
     * 'fill' covers the box and cuts what overflows; 'fit' shows the whole
     * picture with bars.  position is the CSS object-position that puts the
     * cut where it hurts least: centred across, weighted towards the chest
     * down.
     *
     * @param {number} bw
     * @param {number} bh
     * @param {number} vw
     * @param {number} vh
     * @param {{enabled?: boolean, screen?: boolean}} [opts]
     *     enabled: auto-framing is on (off means always 'fit');
     *     screen: a shared screen, which is never cut
     * @returns {{fit: 'fill'|'fit', position: string}}
     */
    function tile(bw, bh, vw, vh, opts) {
        let o = opts || {};
        let whole = {fit: /** @type {'fit'} */('fit'), position: '50% 50%'};
        if(o.enabled === false || o.screen)
            return whole;
        if(!(bw > 0) || !(bh > 0) || !(vw > 0) || !(vh > 0))
            return whole;
        let boxAR = bw / bh, videoAR = vw / vh;
        if(Math.abs(boxAR - videoAR) / videoAR < 0.01)
            return whole;   // same shape: nothing to decide
        if(boxAR < videoAR) {
            // a narrower box: the cut falls at the sides
            if(boxAR / videoAR < MIN_VISIBLE_WIDTH)
                return whole;
            return {fit: 'fill', position: pct(FOCUS.x) + ' 50%'};
        }
        // a wider box: the cut falls at the top and bottom
        let keep = videoAR / boxAR;
        if(keep < MIN_VISIBLE_HEIGHT)
            return whole;
        // object-position y is the share of the overflow left above the
        // visible part; put the focus in the middle of what is seen
        let above = clamp((FOCUS.y - keep / 2) / (1 - keep), 0, 1);
        return {fit: 'fill', position: '50% ' + pct(above)};
    }

    /** @param {number} f */
    function pct(f) {
        return (Math.round(f * 1000) / 10) + '%';
    }

    const api = {
        ASPECTS, FOCUS, MIN_VISIBLE_WIDTH, MIN_VISIBLE_HEIGHT,
        aspectOf, crop, geometry, tile,
    };

    global.SozvonFraming = api;
    if(typeof module !== 'undefined' && module.exports)
        module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
