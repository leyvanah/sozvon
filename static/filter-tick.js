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

// filter-tick.js -- the clock a camera canvas is drawn by.  (Sozvon)
//
// A page in the background has its timers held to one a second, and a
// canvas drawn from a timer sends one frame a second: measured on 2026-11-09
// in Firefox 159 on Windows, the moment another window covered the call.
// A worker's timers are not held back that way, so the canvas (filter.js)
// takes its ticks from here.  Post an interval in milliseconds to start or
// change the clock, zero to stop it; every tick is an empty message.

'use strict';

/** @type {ReturnType<typeof setInterval>|null} */
let timer = null;

onmessage = function(e) {
    if(timer !== null) {
        clearInterval(timer);
        timer = null;
    }
    let ms = e.data;
    if(typeof ms === 'number' && ms > 0)
        timer = setInterval(() => postMessage(0), ms);
};
