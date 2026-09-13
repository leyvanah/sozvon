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

// e2ee-worker.js -- hosts the RTCRtpScriptTransform that encrypts/decrypts
// encoded media frames off the main thread.  The actual cryptography lives in
// e2ee-crypto.js, which we share with the main page.

'use strict';

importScripts('/e2ee-crypto.js');

const C = self.SozvonE2EECrypto;

// Media keys, posted from the main thread once the SAS handshake completes.
//   keys: Map<streamId, Map<keyId, CryptoKey>>
// streamId is "<userId>|<kind>", so every (sender, media kind) has a distinct
// key and an independent IV space.
const keys = new Map();

// The key id new outgoing frames are sealed with (bumped on rekey).
let sendKeyId = 0;

// When true, transforms pass frames through unchanged (cleartext).  The main
// thread sets this when the call cannot be end-to-end encrypted but is allowed
// to continue anyway (three or more participants, or a peer that cannot
// encrypt, with the group's "require encryption" option off).  It is never set
// while a two-party call is established, so secure media is never sent in clear.
let cleartextMode = false;

function getKey(streamId, keyId) {
    let m = keys.get(streamId);
    return m && m.get(keyId);
}

function putKey(streamId, keyId, key) {
    let m = keys.get(streamId);
    if(!m) {
        m = new Map();
        keys.set(streamId, m);
    }
    m.set(keyId, key);
}

// Live video encrypt transformers.  drop-until-keyed below discards the
// encoder's initial keyframe while the SAS handshake is still running, and
// nothing else would ever ask for another one -- the peer then decodes delta
// frames against a reference it never received, which is the grey-video bug.
// Holding the transformers lets us ask for a fresh keyframe the moment a key
// exists. (Sozvon)
const videoEncoders = new Set();

// A completing handshake posts one 'key' per stream; coalesce that burst into
// a single request per encoder.
let keyFrameTimer = null;

function scheduleKeyFrames() {
    if(keyFrameTimer !== null)
        return;
    keyFrameTimer = setTimeout(() => {
        keyFrameTimer = null;
        for(let t of videoEncoders) {
            try {
                let p = t.generateKeyFrame();
                if(p && p.catch)
                    p.catch(() => {});
            } catch(err) {
                // Not implemented, or no encoder attached yet: the peer's PLI
                // remains as a fallback.
            }
        }
    }, 0);
}

self.onmessage = (e) => {
    let d = e.data || {};
    switch(d.type) {
    case 'key':
        // d.key is a structured-cloned CryptoKey (stays non-extractable).
        putKey(d.streamId, d.keyId, d.key);
        // What we dropped while unkeyed may have been the encoder's only
        // keyframe; ask for another now that we can seal it.
        scheduleKeyFrames();
        break;
    case 'sendKeyId':
        sendKeyId = d.keyId | 0;
        scheduleKeyFrames();
        break;
    case 'clear':
        keys.clear();
        break;
    case 'mode':
        cleartextMode = !!d.cleartext;
        // The same race in reverse: frames dropped before the cleartext
        // fallback was allowed leave the peer without a reference frame.
        scheduleKeyFrames();
        break;
    }
};

function makeEncryptor(streamId, isVideo) {
    // Random per-transform salt: a counter that restarts at 0 (e.g. when an up
    // stream is replaced) can therefore never reuse an (key, IV) pair.
    let salt = self.crypto.getRandomValues(new Uint8Array(C.SALT_BYTES));
    let counter = 0;
    return async (frame, controller) => {
        if(cleartextMode) {
            // Unencrypted fallback (3+ participants or a peer that cannot
            // encrypt, with "require encryption" off): forward as-is.
            controller.enqueue(frame);
            return;
        }
        let key = getKey(streamId, sendKeyId);
        if(!key)
            return; // drop-until-keyed: never emit plaintext before a key exists
        let isKey = isVideo && frame.type === 'key';
        try {
            let out = await C.encryptFrame(
                new Uint8Array(frame.data), isVideo, isKey, key,
                salt, counter++, sendKeyId,
            );
            frame.data = out.buffer;
            controller.enqueue(frame);
        } catch(err) {
            // Drop rather than leak; surface once for diagnosis.
            reportOnce('encrypt', err);
        }
    };
}

// An undecryptable stream fails once per frame; throttle so that never turns
// into a keyframe-request storm.
const KEYFRAME_REQUEST_MS = 1000;

function makeDecryptor(streamId, isVideo, transformer) {
    let resolver = (keyId) => getKey(streamId, keyId);
    let lastRequest = 0;
    return async (frame, controller) => {
        if(cleartextMode) {
            controller.enqueue(frame);
            return;
        }
        let isKey = isVideo && frame.type === 'key';
        try {
            let out = await C.decryptFrame(
                new Uint8Array(frame.data), isVideo, isKey, resolver,
            );
            frame.data = out.buffer;
            controller.enqueue(frame);
        } catch(err) {
            // Undecryptable: wrong key, not-yet-keyed, or a SAS-mismatch attack.
            // Drop the frame (black video) instead of feeding garbage to the
            // decoder.
            if(isVideo && transformer) {
                let now = Date.now();
                if(now - lastRequest >= KEYFRAME_REQUEST_MS) {
                    lastRequest = now;
                    try {
                        let p = transformer.sendKeyFrameRequest();
                        if(p && p.catch)
                            p.catch(() => {});
                    } catch(err2) {
                        // Best effort only: galene's PLI routing has been
                        // flaky for simulcast RIDs, so the sender-side
                        // generateKeyFrame() is the load-bearing fix.
                    }
                }
            }
            reportOnce('decrypt', err);
        }
    };
}

let reported = {};
function reportOnce(op, err) {
    if(reported[op])
        return;
    reported[op] = true;
    self.postMessage({type: 'error', op: op, message: '' + (err && err.message || err)});
}

// RTCRtpScriptTransform entry point.  Fires once per sender/receiver the main
// thread attaches a transform to.
self.onrtctransform = (event) => {
    let t = event.transformer;
    let opts = t.options || {};
    let isVideo = opts.kind === 'video';
    let encrypt = opts.operation === 'encrypt';
    let fn = encrypt ?
        makeEncryptor(opts.streamId, isVideo) :
        makeDecryptor(opts.streamId, isVideo, t);
    if(encrypt && isVideo)
        videoEncoders.add(t);
    t.readable
        .pipeThrough(new TransformStream({transform: fn}))
        .pipeTo(t.writable)
        .catch((err) => reportOnce(opts.operation || 'pipe', err))
        .finally(() => videoEncoders.delete(t));
};
