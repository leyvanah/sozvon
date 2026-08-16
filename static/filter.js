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
    /** @type {number} */
    this.timer = null;
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
    this.video.play();
    if(this.definition.init)
        await this.definition.init.call(this);
    this.timer = setInterval(() => this.draw(), 1000 / this.frameRate);
}

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
        if(frameRate && frameRate !== this.frameRate) {
            clearInterval(this.timer);
            this.frameRate = frameRate;
            this.timer = setInterval(() => this.draw(), 1000 / this.frameRate);
        }
    }

    if(this.busy) {
        // drop frame
        return;
    }

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
    if(!this.timer)
        return;
    this.captureStream.getTracks()[0].stop();
    clearInterval(this.timer);
    this.timer = null;
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
// frame into a canvas with an explicit rotation and send the canvas, so the
// encoded frames are upright too; because draw() runs every frame the output
// follows the device as it is turned.
//
// The rotation is rot = (base + angle): `angle` is the live device
// orientation, and `base` (the "Video orientation" setting) is a fixed offset
// that corrects devices whose camera sensor is mounted oddly (some tablets).
// On-device tests showed the orientation stays *constant* for base + angle, so
// the sign of `angle` is right and `base` alone picks the upright result.  When
// auto-rotate is off, only `base` applies (a plain manual rotation).
//
// Deliberately not added to `filters` (it is applied automatically, not
// user-chosen).  We draw at the source's intrinsic size (no destination size)
// so the aspect ratio is preserved and the image is never stretched. (Sozvon)
/** @type {filterDefinition} */
let mobileOrientationFilter = {
    description: 'Upright (mobile orientation)',
    draw: async function(src, ctx) {
        if(!(ctx instanceof CanvasRenderingContext2D))
            throw new Error('bad context type');
        let vw = src.videoWidth, vh = src.videoHeight;
        if(!vw || !vh)
            return true;

        let settings = getSettings();
        let base = parseInt(settings.videoRotation, 10) || 0;
        let auto = settings.autoRotate !== false;
        let angle = (auto && screen && screen.orientation &&
                     typeof screen.orientation.angle === 'number') ?
            screen.orientation.angle : 0;
        let rot = (base + angle) % 360;

        let swap = (rot === 90 || rot === 270);
        let cw = swap ? vh : vw;
        let ch = swap ? vw : vh;
        if(ctx.canvas.width !== cw || ctx.canvas.height !== ch) {
            ctx.canvas.width = cw;
            ctx.canvas.height = ch;
        }
        ctx.save();
        ctx.translate(cw / 2, ch / 2);
        ctx.rotate(rot * Math.PI / 180);
        ctx.drawImage(src, -vw / 2, -vh / 2);
        ctx.restore();
        return true;
    },
};

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
