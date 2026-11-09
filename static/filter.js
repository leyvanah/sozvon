// Copyright (c) 2020-2026 by Juliusz Chroboczek.

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

'use strict';

/**
 * @typedef {Object} filterDefinition
 * @property {string} [description]
 * @property {(this: filterDefinition) => Promise<boolean>} [predicate]
 * @property {(this: Filter) => Promise<void>} [init]
 * @property {(this: Filter) => Promise<void>} [cleanup]
 * @property {(this: Filter, src: HTMLVideoElement, ctx: CanvasRenderingContext2D) => Promise<boolean>} draw
 */

/**
 * @param {MediaStream} stream
 * @param {filterDefinition} definition
 * @constructor
 */
function Filter(stream, definition) {
    /** @ts-ignore */
    if(!HTMLCanvasElement.prototype.captureStream) {
        throw new Error('Filters are not supported on this platform');
    }

    /** @type {MediaStream} */
    this.inputStream = stream;
    /** @type {filterDefinition} */
    this.definition = definition;
    /** @type {number} */
    this.frameRate = 30;
    /** @type {HTMLVideoElement} */
    this.video = document.createElement('video');
    /** @type {HTMLCanvasElement} */
    this.canvas = document.createElement('canvas');
    /** @type {CanvasRenderingContext2D} */
    this.context = this.canvas.getContext('2d');
    /** @type {MediaStream} */
    this.outputStream = null;
    /**
     * Whether the filter is running: set by start(), cleared by stop().
     * (Sozvon: upstream keeps its timer here; the clock is now this.ticker
     * or this.interval.)
     *
     * @type {boolean}
     */
    this.running = false;
    /**
     * The clock draw() is called by: a worker (filter-tick.js), or where
     * there cannot be one, a timer of this page.  (Sozvon)
     *
     * @type {Worker|null}
     */
    this.ticker = null;
    /** Whether the worker could not be started, so the page's timer runs. */
    /** @type {boolean} */
    this.noWorker = false;
    /** @type {ReturnType<typeof setInterval>|null} */
    this.interval = null;
    /** The interval the clock runs at, in milliseconds. */
    /** @type {number} */
    this.tickMs = 0;
    /** @type {number} */
    this.count = 0;
    /** @type {boolean} */
    this.fixedFramerate = false;
    /** @type {Record<string,any>} */
    this.userdata = {}
    /** @type {MediaStream} */
    this.captureStream = this.canvas.captureStream(0);
    /** @type {boolean} */
    this.busy = false;
    // For the camera check (camera-diag.js): what the hidden element's
    // play() came to, and how many frames reached the canvas. (Sozvon)
    /** @type {string} */
    this.playState = 'pending';
    /** @type {number} */
    this.drawn = 0;
    // The camera frame last drawn, and the frames the element has presented
    // when the browser counts them only through requestVideoFrameCallback.
    // See newFrame(). (Sozvon)
    /** @type {number} */
    this.lastFrame = -1;
    /** @type {number|null} */
    this.callbackFrames = null;
    // The rate the camera really gives frames at, measured while the page
    // is visible: what a hidden page draws at (tickInterval).  Where and
    // when the measurement started.  (Sozvon)
    /** @type {number|null} */
    this.cameraRate = null;
    /** @type {number|null} */
    this.sampleAt = null;
    /** @type {number} */
    this.sampleFrames = 0;
}

Filter.prototype.start = async function() {
    /** @ts-ignore */
    if(!this.captureStream.getTracks()[0].requestFrame) {
        console.warn('captureFrame not supported, using fixed framerate');
        /** @ts-ignore */
        this.captureStream = this.canvas.captureStream(this.frameRate);
        this.fixedFramerate = true;
    }

    this.outputStream = new MediaStream();
    this.outputStream.addTrack(this.captureStream.getTracks()[0]);
    this.inputStream.getTracks().forEach(t => {
        t.onended = e => this.stop();
        if(t.kind !== 'video')
            this.outputStream.addTrack(t);
    });
    this.video.srcObject = this.inputStream;
    this.video.muted = true;
    // A refused play() leaves the canvas without frames and says so nowhere
    // else; keep its outcome for the camera check. (Sozvon)
    let played = this.video.play();
    if(played && played.then)
        played.then(() => {
            this.playState = 'ok';
        }, e => {
            this.playState = (e && e.name) || 'error';
            console.warn('Filter: play() failed', e);
        });
    else
        this.playState = 'ok';
    if(this.definition.init)
        await this.definition.init.call(this);
    this.running = true;
    this.tick(this.tickInterval());
    /** @type {any} */
    let video = this.video;
    if(video.requestVideoFrameCallback) {
        let counted = () => {
            this.callbackFrames = (this.callbackFrames || 0) + 1;
            if(this.running)
                video.requestVideoFrameCallback(counted);
        };
        video.requestVideoFrameCallback(counted);
    }
}

/**
 * How often to look for a new camera frame: twice per frame.  (Sozvon)
 *
 * A tick that finds nothing new draws nothing (newFrame), so it costs
 * little; a clock at the camera's own rate drifts against it, two frames
 * land between two ticks, and one of them is never drawn -- 16 frames out
 * of 20 in Chromium, measured on 2026-11-09.
 *
 * @returns {number} milliseconds
 */
Filter.prototype.tickInterval = function() {
    if(this.drawsBlind())
        return 1000 / this.blindRate();
    return 1000 / (2 * this.frameRate);
};

/**
 * The rate a hidden page draws at: the camera's, as measured while the page
 * was visible, since a camera often gives fewer frames than the rate it
 * reports -- twenty a second where it says thirty, and every third frame
 * drawn blind would be a copy of the one before.  The reported rate where
 * nothing was measured.  (Sozvon)
 *
 * @returns {number} frames per second
 */
Filter.prototype.blindRate = function() {
    let r = this.cameraRate;
    if(r === null || !(r >= 1) || r > this.frameRate)
        return this.frameRate;
    return Math.round(r);
};

/**
 * Whether to draw on every tick without asking whether the camera gave a new
 * frame.  (Sozvon)
 *
 * In a page in the background the counters newFrame() reads cannot be
 * trusted: requestVideoFrameCallback runs with the page's rendering, and a
 * hidden page is not rendered -- in Firefox 159 it fell to a frame a second
 * while the camera went on at fifteen (2026-11-09).  A computer keeps its
 * camera running in the background (away.js), so there every tick is drawn,
 * at the camera's rate rather than twice it, which would only send each
 * frame twice.  A phone stops its camera in the background, and keeps the
 * check, or it would send its last picture over and over as if live.
 *
 * @returns {boolean}
 */
Filter.prototype.drawsBlind = function() {
    if(typeof document === 'undefined' ||
       document.visibilityState !== 'hidden')
        return false;
    return !(typeof pausesWhenHidden === 'function' && pausesWhenHidden());
};

/**
 * Run draw() every ms milliseconds, or stop with 0.  (Sozvon)
 *
 * The ticks come from a worker (filter-tick.js) rather than from a timer of
 * this page: a page in the background has its timers held to one a second,
 * and a canvas drawn by one sent one frame a second whenever another window
 * covered the call (measured in Firefox 159, 2026-11-09).  Before the
 * picture format was added only phones drew through a canvas, and a phone
 * stops the camera in the background anyway; a computer does not, and goes
 * on sending whatever the canvas gives it.  Where a worker cannot be made,
 * or its script does not load, a timer of the page does, as before: a clock
 * held back in the background, rather than none and a canvas that never
 * draws.
 *
 * @param {number} ms
 */
Filter.prototype.tick = function(ms) {
    this.tickMs = ms;
    if(this.interval !== null) {
        clearInterval(this.interval);
        this.interval = null;
    }
    if(!this.ticker && !this.noWorker && ms > 0 &&
       typeof Worker !== 'undefined') {
        try {
            let w = new Worker('/filter-tick.js');
            w.onmessage = () => this.draw();
            w.onerror = e => {
                if(e && e.preventDefault)
                    e.preventDefault();
                console.warn('Filter: the worker clock failed', e);
                w.terminate();
                if(this.ticker !== w)
                    return;
                this.ticker = null;
                this.noWorker = true;
                if(this.running)
                    this.tick(this.tickMs);
            };
            this.ticker = w;
        } catch(e) {
            console.warn('Filter: no worker clock', e);
            this.ticker = null;
            this.noWorker = true;
        }
    }
    if(this.ticker)
        this.ticker.postMessage(ms);
    else if(ms > 0)
        this.interval = setInterval(() => this.draw(), ms);
};

/**
 * Whether the camera has given the element a frame that has not been drawn
 * yet.  (Sozvon)
 *
 * The canvas used to be drawn on every tick whether or not there was
 * anything new to draw, so when the camera stopped -- which is what a phone
 * does the moment the call goes into the background -- the last picture
 * went on being sent at thirty frames a second.  Everyone else saw a still
 * face that looked live, and the receiver's freeze counter, which is how
 * the call notices a stuck picture, stayed at zero.
 *
 * The count comes from getVideoPlaybackQuality() where the browser keeps it
 * (Chromium, Safari); Firefox reports zero there for a camera, so it falls
 * back to frames seen by requestVideoFrameCallback.  A browser that offers
 * neither is drawn on every tick, as before.
 *
 * @returns {boolean}
 */
Filter.prototype.newFrame = function() {
    if(this.drawsBlind()) {
        this.sampleAt = null;
        return true;
    }
    let n = null;
    if(this.video.getVideoPlaybackQuality) {
        let t = this.video.getVideoPlaybackQuality().totalVideoFrames;
        if(t > 0)
            n = t;
    }
    if(n === null)
        n = this.callbackFrames;
    if(n === null)
        return true;
    this.measure(n);
    if(n === this.lastFrame)
        return false;
    this.lastFrame = n;
    return true;
};

/**
 * Measure the camera's rate from its frame count, over two seconds at a
 * time, for blindRate().  (Sozvon)
 *
 * @param {number} n - frames the element has been given so far
 */
Filter.prototype.measure = function(n) {
    let now = Date.now();
    if(this.sampleAt === null || n < this.sampleFrames) {
        this.sampleAt = now;
        this.sampleFrames = n;
    } else if(now - this.sampleAt >= 2000) {
        this.cameraRate = (n - this.sampleFrames) * 1000 / (now - this.sampleAt);
        this.sampleAt = now;
        this.sampleFrames = n;
    }
};

Filter.prototype.draw = async function() {
    if(this.video.videoWidth === 0 && this.video.videoHeight === 0) {
        // video not started yet
        return;
    }

    // check framerate every 30 frames
    if((this.count % 30) === 0) {
        let frameRate = 0;
        this.inputStream.getTracks().forEach(t => {
            if(t.kind === 'video') {
                let r = t.getSettings().frameRate;
                if(r)
                    frameRate = r;
            }
        });
        if(frameRate && frameRate !== this.frameRate)
            this.frameRate = frameRate;
    }
    // the camera's rate, or the page went into or out of the background
    if(this.running && this.tickInterval() !== this.tickMs)
        this.tick(this.tickInterval());

    if(this.busy) {
        // drop frame
        return;
    }

    if(!this.newFrame())
        return;

    try {
        this.busy = true;
        let ok = false;
        try {
            ok = await this.definition.draw.call(
                this, this.video, this.context,
            );
        } catch(e) {
            console.error(e);
        }
        if(ok)
            this.drawn++;
        if(ok && !this.fixedFramerate) {
            /** @ts-ignore */
            this.captureStream.getTracks()[0].requestFrame();
        }
        this.count++;
    } finally {
        this.busy = false;
    }
};

Filter.prototype.stop = async function() {
    if(!this.running)
        return;
    this.captureStream.getTracks()[0].stop();
    this.tick(0);
    if(this.ticker) {
        this.ticker.terminate();
        this.ticker = null;
    }
    this.running = false;
    if(this.definition.cleanup)
        await this.definition.cleanup.call(this);
};

/**
 * Removes any filter set on c.
 *
 * @param {Stream} c
 */
async function removeFilter(c) {
    let old = c.userdata.filter;
    if(!old)
        return;

    if(!(old instanceof Filter))
        throw new Error('userdata.filter is not a filter');

    c.setStream(old.inputStream);
    await old.stop();
    c.userdata.filter = null;
}

/**
 * Sets the filter described by c.userdata.filterDefinition on c.
 *
 * @param {Stream} c
 */
async function setFilter(c) {
    await removeFilter(c);

    if(!c.userdata.filterDefinition)
        return;

    let filter = new Filter(c.stream, c.userdata.filterDefinition);
    await filter.start();
    c.setStream(filter.outputStream);
    c.userdata.filter = filter;
}

/**
 * Sends a message to a worker, then waits for a reply.
 *
 * @param {Worker} worker
 * @param {any} message
 * @param {Transferable[]} [transfer]
 */
async function workerSendReceive(worker, message, transfer) {
    if(worker.onmessage)
        throw new Error("worker busy");
    let p = new Promise((resolve, reject) => {
        worker.onmessage = e => {
            if(e && e.data) {
                if(e.data instanceof Error)
                    reject(e.data);
                else
                    resolve(e.data);
            } else {
                resolve(null);
            }
        };
    });
    try {
        worker.postMessage(message, transfer);
        return await p
    } finally {
        worker.onmessage = null;
    }
}

/**
 * @type {Record.<string,filterDefinition>}
 */
let filters = {
    'mirror-h': {
        description: "Horizontal mirror",
        draw: async function(src, ctx) {
            if(!(ctx instanceof CanvasRenderingContext2D))
                throw new Error('bad context type');
            if(ctx.canvas.width !== src.videoWidth ||
               ctx.canvas.height !== src.videoHeight) {
                ctx.canvas.width = src.videoWidth;
                ctx.canvas.height = src.videoHeight;
            }
            ctx.scale(-1, 1);
            ctx.drawImage(src, -src.videoWidth, 0);
            ctx.resetTransform();
            return true;
        },
    },
    'mirror-v': {
        description: "Vertical mirror",
        draw: async function(src, ctx) {
            if(!(ctx instanceof CanvasRenderingContext2D))
                throw new Error('bad context type');
            if(ctx.canvas.width !== src.videoWidth ||
               ctx.canvas.height !== src.videoHeight) {
                ctx.canvas.width = src.videoWidth;
                ctx.canvas.height = src.videoHeight;
            }
            ctx.scale(1, -1);
            ctx.drawImage(src, 0, -src.videoHeight);
            ctx.resetTransform();
            return true;
        },
    },
    'rotate': {
        description: 'Rotate',
        draw: async function(src, ctx) {
            if(!(ctx instanceof CanvasRenderingContext2D))
                throw new Error('bad context type');
            if(ctx.canvas.width !== src.videoWidth ||
               ctx.canvas.height !== src.videoHeight) {
                ctx.canvas.width = src.videoWidth;
                ctx.canvas.height = src.videoHeight;
            }
            ctx.scale(-1, -1);
            ctx.drawImage(src, -src.videoWidth, -src.videoHeight);
            ctx.resetTransform();
            return true;
        },
    },
    // 90° clockwise: the output canvas swaps width/height and the source
    // is drawn after a translate + rotate. (Sozvon)
    'rotate-90': {
        description: 'Rotate 90°',
        draw: async function(src, ctx) {
            if(!(ctx instanceof CanvasRenderingContext2D))
                throw new Error('bad context type');
            if(ctx.canvas.width !== src.videoHeight ||
               ctx.canvas.height !== src.videoWidth) {
                ctx.canvas.width = src.videoHeight;
                ctx.canvas.height = src.videoWidth;
            }
            ctx.save();
            ctx.translate(src.videoHeight, 0);
            ctx.rotate(Math.PI / 2);
            ctx.drawImage(src, 0, 0);
            ctx.restore();
            return true;
        },
    },
    // 270° clockwise (= 90° counter-clockwise). (Sozvon)
    'rotate-270': {
        description: 'Rotate 270°',
        draw: async function(src, ctx) {
            if(!(ctx instanceof CanvasRenderingContext2D))
                throw new Error('bad context type');
            if(ctx.canvas.width !== src.videoHeight ||
               ctx.canvas.height !== src.videoWidth) {
                ctx.canvas.width = src.videoHeight;
                ctx.canvas.height = src.videoWidth;
            }
            ctx.save();
            ctx.translate(0, src.videoWidth);
            ctx.rotate(-Math.PI / 2);
            ctx.drawImage(src, 0, 0);
            ctx.restore();
            return true;
        },
    },
    'background-blur': {
        description: 'Background blur',
        predicate: async function() {
            let r = await fetch('/third-party/tasks-vision/vision_bundle.mjs', {
                method: 'HEAD',
            });
            if(!r.ok) {
                if(r.status !== 404)
                    console.warn(
                        `Fetch vision_bundle.mjs: ${r.status} ${r.statusText}`,
                    );
                return false;
            }
            return true;
        },
        init: async function() {
            if(!(this instanceof Filter))
                throw new Error('Bad type for this');
            if(this.userdata.worker)
                throw new Error("Worker already running (this shouldn't happen)")
            this.userdata.worker = new Worker('/background-blur-worker.js');
            await workerSendReceive(this.userdata.worker, {
                model: '/third-party/tasks-vision/models/selfie_segmenter.tflite',
            });
        },
        cleanup: async function() {
            if(this.userdata.worker.onmessage) {
                this.userdata.worker.onmessage(null);
            }
            this.userdata.worker.terminate();
            this.userdata.worker = null;
        },
        draw: async function(src, ctx) {
            let bitmap = await createImageBitmap(src);
            try {
                let result = await workerSendReceive(this.userdata.worker, {
                    bitmap: bitmap,
                    timestamp: performance.now(),
                }, [bitmap]);

                if(!result)
                    return false;

                let mask = result.mask;
                bitmap = result.bitmap;

                if(ctx.canvas.width !== src.videoWidth ||
                   ctx.canvas.height !== src.videoHeight) {
                    ctx.canvas.width = src.videoWidth;
                    ctx.canvas.height = src.videoHeight;
                }

                // set the alpha mask, background is opaque
                ctx.globalCompositeOperation = 'copy';
                ctx.drawImage(mask, 0, 0);

                // rather than blurring the original image, we first mask
                // the background then blur, this avoids a halo effect
                ctx.globalCompositeOperation = 'source-in';
                ctx.drawImage(result.bitmap, 0, 0);
		if('filter' in ctx) {
                    ctx.globalCompositeOperation = 'copy';
                    ctx.filter = `blur(${src.videoWidth / 48}px)`;
                    ctx.drawImage(ctx.canvas, 0, 0);
                    ctx.filter = 'none';
		} else {
		    // Safari bug 198416, context.filter is not supported.

                    // Work around typescript inferring ctx as none
                    ctx = /**@type{CanvasRenderingContext2D}*/(ctx);

		    let scale = 24;
		    let swidth = src.videoWidth / scale;
		    let sheight = src.videoHeight / scale;
		    if(!('canvas' in this.userdata))
			this.userdata.canvas = document.createElement('canvas');
                    /** @type {HTMLCanvasElement} */
		    let c2 = this.userdata.canvas;
		    if(c2.width !== swidth)
			c2.width = swidth;
		    if(c2.height !== sheight)
			c2.height = sheight;
		    let ctx2 = c2.getContext('2d');
		    // scale down the background
		    ctx2.globalCompositeOperation = 'copy';
		    ctx2.drawImage(ctx.canvas,
				   0, 0, src.videoWidth, src.videoHeight,
				   0, 0, swidth, sheight,
				  );
		    // scale back up, composite atop the original background
		    ctx.globalCompositeOperation = 'source-atop';
		    ctx.drawImage(ctx2.canvas,
				  0, 0,
				  src.videoWidth / scale,
				  src.videoHeight / scale,
				  0, 0, src.videoWidth, src.videoHeight,
				 );
		}

		// now draw the foreground
                ctx.globalCompositeOperation = 'destination-atop';
                ctx.drawImage(result.bitmap, 0, 0);
                ctx.globalCompositeOperation = 'source-over';

                mask.close();
            } finally {
                bitmap.close();
            }
            return true;
        },
    },
};

// Canvas pass-through that fixes mobile/tablet video orientation.  A phone or
// tablet encodes its camera in the sensor's fixed (landscape) orientation, and
// our SFU strips the video-orientation RTP header (see readLoop in
// rtpconn/rtpreader.go), so the far end sees us sideways even though the
// browser rotates the camera correctly for *local* display.  We redraw the
// frame into a canvas -- drawing it is what turns the pixels -- and send the
// canvas, so the encoded frames are upright too; because draw() runs every
// frame the output follows the device as it is turned.
//
// The browser already turns the camera's frames to match the screen: held
// upright a phone's camera gives 480x640, turned on its side 640x480, without
// being reopened -- Chrome and Firefox on Android alike (measured on
// 2026-11-09, in both directions).  What it does not do is turn the pixels it
// encodes, so the canvas is still what makes the far end see it upright.  The
// rotation drawn is only `base`, the "Video orientation" setting, a fixed
// offset for devices whose camera sensor is mounted oddly (some tablets).  It
// used to add the screen's own angle on top, which turned the picture a
// second time: upright, at angle 0, it looked right, and a phone turned on its
// side sent a picture lying on its side until the arrows were pressed.
// "Auto-rotate" decides whether a phone goes through the canvas at all.
//
// The same pass also cuts the upright picture to the format chosen in the
// settings (settings.sendAspect: 16:9, 4:3, 1:1, 3:4, 9:16) or fitted to the
// other person's screen (cameraAspect in galene.js), around the point where
// a face usually is -- see framing.js.  Turning and cutting are one drawImage:
// the canvas is the size of the cut, and the turned picture is drawn shifted
// so that the cut lands on it.  Both are read from the settings on every
// frame, so changing either takes effect at once, without reopening the
// camera.
//
// Deliberately not added to `filters` (it is applied automatically, not
// user-chosen).  The picture is never scaled, only turned and cut, so it is
// never stretched. (Sozvon)
/** @type {filterDefinition} */
let cameraGeometryFilter = {
    description: 'Upright and framed',
    draw: async function(src, ctx) {
        if(!(ctx instanceof CanvasRenderingContext2D))
            throw new Error('bad context type');
        let vw = src.videoWidth, vh = src.videoHeight;
        if(!vw || !vh)
            return true;

        let settings = getSettings();
        let g = SozvonFraming.geometry(vw, vh, cameraRotation(settings),
                                       cameraAspect(settings));
        let c = g.crop;
        if(ctx.canvas.width !== c.w || ctx.canvas.height !== c.h) {
            ctx.canvas.width = c.w;
            ctx.canvas.height = c.h;
        }
        ctx.save();
        ctx.translate(g.uw / 2 - c.x, g.uh / 2 - c.y);
        ctx.rotate(g.rot * Math.PI / 180);
        ctx.drawImage(src, -vw / 2, -vh / 2);
        ctx.restore();
        return true;
    },
};

/**
 * The rotation the camera picture needs to be upright: the fixed base from
 * the settings.  Not the screen's angle: the browser has turned the frames
 * by that already (see above). (Sozvon)
 *
 * @param {settings} settings
 * @returns {number}
 */
function cameraRotation(settings) {
    return (parseInt(settings.videoRotation, 10) || 0) % 360;
}

/**
 * The format picked in the settings, as width / height, or null to send the
 * picture as the camera gives it.  Blackboard mode never cuts: it is a
 * document camera, and its edges are the document.  What is actually sent
 * can differ, when the picture is fitted to the other person's screen: see
 * cameraAspect in galene.js. (Sozvon)
 *
 * @param {settings} settings
 * @returns {number|null}
 */
function sendAspect(settings) {
    if(settings.blackboardMode)
        return null;
    return SozvonFraming.aspectOf(settings.sendAspect || '');
}

async function addFilters() {
    for(let name in filters) {
        let f = filters[name];
        if(f.predicate) {
            if(!(await f.predicate.call(f)))
                continue;
        }
        // Sozvon: prefer a localised name, falling back to the English one.
        let key = 'filter.' + name;
        let d = Sozvon.i18n.t(key);
        if(!d || d === key)
            d = f.description || name;
        addSelectOption(getSelectElement('filterselect'), d, name);
    }
}
