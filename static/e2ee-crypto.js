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

// e2ee-crypto.js -- pure cryptographic core for Sozvon end-to-end encryption.
//
// This module has NO dependency on the DOM or WebRTC, so it can be loaded
// by the main page, imported into the media worker with importScripts(), and
// require()d under Node for headless testing.
//
// The design follows ZRTP / Signal: peers run an ephemeral ECDH key agreement
// over the (untrusted) signalling channel and authenticate it by comparing a
// Short Authentication String rendered as emoji.  The shared secret never
// travels over the wire; the server cannot derive it and therefore cannot
// read or forge media.  An active man-in-the-middle (e.g. a malicious server)
// produces a *different* SAS on the two legs, which the humans detect when the
// emoji do not match.

'use strict';

(function(global) {
    const subtle = global.crypto.subtle;
    const te = new TextEncoder();
    const td = new TextDecoder();

    // ---- small byte helpers -------------------------------------------------

    /**
     * @param {...Uint8Array} arrs
     * @returns {Uint8Array}
     */
    function concat(...arrs) {
        let len = 0;
        for(const a of arrs)
            len += a.length;
        let out = new Uint8Array(len);
        let o = 0;
        for(const a of arrs) {
            out.set(a, o);
            o += a.length;
        }
        return out;
    }

    /** @param {Uint8Array} a @param {Uint8Array} b */
    function bytesEqual(a, b) {
        if(a.length !== b.length)
            return false;
        // Constant-time-ish; the inputs here are not secret but it costs nothing.
        let d = 0;
        for(let i = 0; i < a.length; i++)
            d |= a[i] ^ b[i];
        return d === 0;
    }

    function b64(buf) {
        let u = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
        let s = '';
        for(let i = 0; i < u.length; i++)
            s += String.fromCharCode(u[i]);
        return btoa(s);
    }

    function unb64(str) {
        let s = atob(str);
        let u = new Uint8Array(s.length);
        for(let i = 0; i < s.length; i++)
            u[i] = s.charCodeAt(i);
        return u;
    }

    // 48-bit big-endian counter (good for ~2.8e14 frames per sender, never
    // exhausted in practice).
    function writeUint48(buf, off, n) {
        buf[off]     = Math.floor(n / 0x10000000000) & 0xff;
        buf[off + 1] = Math.floor(n / 0x100000000) & 0xff;
        buf[off + 2] = (n >>> 24) & 0xff;
        buf[off + 3] = (n >>> 16) & 0xff;
        buf[off + 4] = (n >>> 8) & 0xff;
        buf[off + 5] = n & 0xff;
    }

    function readUint48(buf, off) {
        return (buf[off] * 0x10000000000) +
            (buf[off + 1] * 0x100000000) +
            (buf[off + 2] * 0x1000000) +
            (buf[off + 3] * 0x10000) +
            (buf[off + 4] * 0x100) +
            buf[off + 5];
    }

    // ---- key agreement ------------------------------------------------------

    const ECDH_PARAMS = {name: 'ECDH', namedCurve: 'P-256'};

    /** Generate an ephemeral ECDH key pair.  The private key is non-extractable. */
    async function generateKeyPair() {
        return await subtle.generateKey(ECDH_PARAMS, false, ['deriveBits']);
    }

    /** Export a public key to the 65-byte uncompressed point. */
    async function exportPublic(key) {
        return new Uint8Array(await subtle.exportKey('raw', key));
    }

    /** Import a peer's 65-byte public key. */
    async function importPublic(raw) {
        return await subtle.importKey('raw', raw, ECDH_PARAMS, false, []);
    }

    /** Raw ECDH shared secret (32 bytes) from our private and their public key. */
    async function agree(privateKey, peerPublicKey) {
        let bits = await subtle.deriveBits(
            {name: 'ECDH', public: peerPublicKey}, privateKey, 256,
        );
        return new Uint8Array(bits);
    }

    async function sha256(u8) {
        return new Uint8Array(await subtle.digest('SHA-256', u8));
    }

    /** A public key's commitment: SHA-256 of its raw bytes. */
    async function commit(rawPublic) {
        return await sha256(rawPublic);
    }

    /**
     * HKDF-SHA256.
     * @param {Uint8Array} ikm - input keying material (the ECDH secret)
     * @param {Uint8Array} salt
     * @param {string} info
     * @param {number} lengthBytes
     * @returns {Promise<Uint8Array>}
     */
    async function hkdf(ikm, salt, info, lengthBytes) {
        let base = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
        let bits = await subtle.deriveBits(
            {name: 'HKDF', hash: 'SHA-256', salt: salt, info: te.encode(info)},
            base, lengthBytes * 8,
        );
        return new Uint8Array(bits);
    }

    // The SAS / media keys are bound to the exact pair of public keys that were
    // exchanged (in initiator-then-responder order).  A man-in-the-middle that
    // substitutes its own keys therefore yields a different transcript, hence a
    // different SAS and incompatible media keys on the two legs.
    function transcriptSalt(initiatorPub, responderPub) {
        return concat(te.encode('sozvon-e2ee-v1'), initiatorPub, responderPub);
    }

    // ---- Short Authentication String (emoji) --------------------------------

    // 64 visually distinct, single-codepoint emoji.  6 bits per symbol.
    const EMOJI = [
        '\u{1F600}', '\u{1F60E}', '\u{1F916}', '\u{1F47D}', // 😀 😎 🤖 👽
        '\u{1F436}', '\u{1F431}', '\u{1F98A}', '\u{1F43C}', // 🐶 🐱 🦊 🐼
        '\u{1F428}', '\u{1F42F}', '\u{1F981}', '\u{1F438}', // 🐨 🐯 🦁 🐸
        '\u{1F435}', '\u{1F414}', '\u{1F427}', '\u{1F989}', // 🐵 🐔 🐧 🦉
        '\u{1F98B}', '\u{1F41D}', '\u{1F422}', '\u{1F419}', // 🦋 🐝 🐢 🐙
        '\u{1F433}', '\u{1F42C}', '\u{1F41F}', '\u{1F335}', // 🐳 🐬 🐟 🌵
        '\u{1F332}', '\u{1F338}', '\u{1F341}', '\u{1F344}', // 🌲 🌸 🍁 🍄
        '\u{1F347}', '\u{1F349}', '\u{1F34B}', '\u{1F34C}', // 🍇 🍉 🍋 🍌
        '\u{1F34E}', '\u{1F353}', '\u{1F352}', '\u{1F951}', // 🍎 🍓 🍒 🥑
        '\u{1F33D}', '\u{1F955}', '\u{1F354}', '\u{1F355}', // 🌽 🥕 🍔 🍕
        '\u{1F366}', '\u{1F369}', '\u{1F36A}', '\u{1F382}', // 🍦 🍩 🍪 🎂
        '\u{2615}',  '\u{1F377}', '\u{26BD}',  '\u{1F3C0}', // ☕ 🍷 ⚽ 🏀
        '\u{1F3B2}', '\u{1F3B8}', '\u{1F3BA}', '\u{1F3A8}', // 🎲 🎸 🎺 🎨
        '\u{1F697}', '\u{1F680}', '\u{26F5}',  '\u{23F0}',  // 🚗 🚀 ⛵ ⏰
        '\u{1F319}', '\u{2B50}',  '\u{1F525}', '\u{1F308}', // 🌙 ⭐ 🔥 🌈
        '\u{26A1}',  '\u{1F388}', '\u{1F381}', '\u{1F511}', // ⚡ 🎈 🎁 🔑
    ];

    const SAS_LENGTH = 5; // 5 emoji = 30 bits

    /**
     * Derive the emoji SAS that both peers display for out-of-band comparison.
     * @returns {Promise<string[]>}
     */
    async function deriveSAS(secret, initiatorPub, responderPub) {
        let bytes = await hkdf(
            secret, transcriptSalt(initiatorPub, responderPub),
            'sas', SAS_LENGTH,
        );
        let out = [];
        for(let i = 0; i < SAS_LENGTH; i++)
            // 256 is a multiple of 64, so (byte & 63) is unbiased.
            out.push(EMOJI[bytes[i] & 0x3f]);
        return out;
    }

    // ---- per-sender media key -----------------------------------------------

    /**
     * Derive the AES-256-GCM key a given sender uses.  Each sender gets a
     * distinct key (info bound to its id) so that a plain monotonic frame
     * counter never reuses an (key, IV) pair across senders.
     * @returns {Promise<CryptoKey>}
     */
    async function deriveMediaKey(secret, initiatorPub, responderPub, senderId) {
        let raw = await hkdf(
            secret, transcriptSalt(initiatorPub, responderPub),
            'media|' + senderId, 32,
        );
        return await subtle.importKey(
            'raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt'],
        );
    }

    // ---- chat encryption ----------------------------------------------------

    /**
     * Derive the AES-256-GCM key used to encrypt text chat in a two-party
     * end-to-end encrypted call.  Bound to the same transcript as the media
     * keys and the SAS, so it inherits their man-in-the-middle protection.
     * @returns {Promise<CryptoKey>}
     */
    async function deriveChatKey(secret, initiatorPub, responderPub) {
        let raw = await hkdf(
            secret, transcriptSalt(initiatorPub, responderPub), 'chat', 32,
        );
        return await subtle.importKey(
            'raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt'],
        );
    }

    /**
     * Encrypt a chat message.  Chat has no monotonic counter, so we use a
     * fresh random 96-bit IV per message (safe for AES-GCM at chat volumes).
     * @param {CryptoKey} key
     * @param {string} text
     * @returns {Promise<{iv: string, ct: string}>} base64 IV and ciphertext
     */
    async function encryptChat(key, text) {
        let iv = global.crypto.getRandomValues(new Uint8Array(12));
        let ct = new Uint8Array(await subtle.encrypt(
            {name: 'AES-GCM', iv: iv}, key, te.encode(text),
        ));
        return {iv: b64(iv), ct: b64(ct)};
    }

    /**
     * Decrypt a chat message produced by encryptChat.  Throws on tampering.
     * @param {CryptoKey} key
     * @param {string} ivB64
     * @param {string} ctB64
     * @returns {Promise<string>}
     */
    async function decryptChat(key, ivB64, ctB64) {
        let pt = await subtle.decrypt(
            {name: 'AES-GCM', iv: unb64(ivB64)}, key, unb64(ctB64),
        );
        return td.decode(pt);
    }

    // ---- frame encryption ---------------------------------------------------

    const TAG_BYTES = 16;       // AES-GCM authentication tag
    // Per-transform random IV salt.  6 bytes (48-bit): together with the 6-byte
    // counter below it fills the whole 12-byte AES-GCM IV (no wasted bytes), and
    // makes an accidental (key, IV) reuse across stream replacements negligible.
    // (A 4-byte/32-bit salt left a small birthday-bound risk over a long call.)
    const SALT_BYTES = 6;
    const TRAILER_BYTES = SALT_BYTES + 6 + 1; // salt + 6-byte counter + key id
    const OVERHEAD = TAG_BYTES + TRAILER_BYTES;

    // Number of leading bytes of the encoded frame left in clear so the SFU can
    // still parse the codec header (keyframe bit, dimensions).  Mirrors what
    // codecs.go reads.  We force VP8 video + Opus audio in E2EE mode.
    function clearPrefixLength(isVideo, isKeyFrame) {
        if(!isVideo)
            return 0;            // Opus: Galène never parses the audio payload
        return isKeyFrame ? 10 : 1; // VP8: dimensions live in bytes 6..9
    }

    function ivFromSaltCounter(salt, counter) {
        let iv = new Uint8Array(12);
        iv.set(salt, 0);            // bytes 0..5
        writeUint48(iv, 6, counter); // bytes 6..11
        return iv;
    }

    /**
     * Encrypt one encoded media frame.
     *
     * Layout of the result:
     *   [ clear codec prefix | AES-GCM(rest)+tag | salt(6) | counter(6) | keyId(1) ]
     * The IV is salt|counter: the salt is random per transform, so a counter
     * that restarts at 0 (e.g. when Galène replaces an up stream) can never
     * reuse an (key, IV) pair.  The clear prefix is authenticated as additional
     * data, so a middlebox cannot flip the keyframe bit undetected.
     *
     * @param {Uint8Array} plain
     * @param {boolean} isVideo
     * @param {boolean} isKeyFrame
     * @param {CryptoKey} key
     * @param {Uint8Array} salt - 6 random bytes, fixed for the life of a transform
     * @param {number} counter - monotonic within a transform
     * @param {number} keyId
     * @returns {Promise<Uint8Array>}
     */
    async function encryptFrame(plain, isVideo, isKeyFrame, key, salt, counter, keyId) {
        let prefixLen = Math.min(clearPrefixLength(isVideo, isKeyFrame), plain.length);
        let header = plain.subarray(0, prefixLen);
        let body = plain.subarray(prefixLen);
        let iv = ivFromSaltCounter(salt, counter);
        let ct = new Uint8Array(await subtle.encrypt(
            {name: 'AES-GCM', iv: iv, additionalData: header}, key, body,
        ));
        let trailer = new Uint8Array(TRAILER_BYTES);
        trailer.set(salt, 0);
        writeUint48(trailer, SALT_BYTES, counter);
        trailer[SALT_BYTES + 6] = keyId & 0xff;
        return concat(header, ct, trailer);
    }

    /**
     * Decrypt a frame produced by encryptFrame.  Throws if authentication
     * fails (wrong key, tampering, or a SAS mismatch attack).
     *
     * @param {Uint8Array} data
     * @param {boolean} isVideo
     * @param {boolean} isKeyFrame
     * @param {(keyId: number) => (CryptoKey|undefined)} keyResolver
     * @returns {Promise<Uint8Array>}
     */
    async function decryptFrame(data, isVideo, isKeyFrame, keyResolver) {
        if(data.length < OVERHEAD)
            throw new Error('frame too short to be encrypted');
        let salt = data.subarray(data.length - TRAILER_BYTES, data.length - 7);
        let counter = readUint48(data, data.length - 7);
        let keyId = data[data.length - 1];
        let key = keyResolver(keyId);
        if(!key)
            throw new Error('no key for keyId ' + keyId);

        let cipherEnd = data.length - TRAILER_BYTES;
        let prefixLen = Math.min(
            clearPrefixLength(isVideo, isKeyFrame), cipherEnd - TAG_BYTES,
        );
        if(prefixLen < 0)
            throw new Error('malformed encrypted frame');
        let header = data.subarray(0, prefixLen);
        let ct = data.subarray(prefixLen, cipherEnd);
        let iv = ivFromSaltCounter(salt, counter);
        let body = new Uint8Array(await subtle.decrypt(
            {name: 'AES-GCM', iv: iv, additionalData: header}, key, ct,
        ));
        return concat(header, body);
    }

    const api = {
        // bytes
        concat, bytesEqual, b64, unb64,
        // key agreement
        generateKeyPair, exportPublic, importPublic, agree, sha256, commit, hkdf,
        // authentication
        deriveSAS, EMOJI, SAS_LENGTH,
        // media keys + frames
        deriveMediaKey, encryptFrame, decryptFrame,
        // chat
        deriveChatKey, encryptChat, decryptChat,
        clearPrefixLength, OVERHEAD, TAG_BYTES, TRAILER_BYTES, SALT_BYTES,
    };

    global.SozvonE2EECrypto = api;
    if(typeof module !== 'undefined' && module.exports)
        module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
