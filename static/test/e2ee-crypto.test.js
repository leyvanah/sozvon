// Tests for the end-to-end encryption core.  (Sozvon)
//
// Run with:  node --test static/test/
//
// e2ee-crypto.js is deliberately free of the DOM and of WebRTC so that it can
// be exercised here, with Node's WebCrypto standing in for the browser's.  The
// properties below are the ones the design rests on -- if any of them stops
// holding, the call is either black (nothing decodes) or, worse, believed to be
// private when it is not.  Neither shows up as an error in a browser.
//
// Not covered here: the transform plumbing in e2ee-worker.js and the
// signalling in e2ee.js.  The handshake including the signalling relay has a
// browser harness at static/e2ee-test.html, and the encrypted media path needs
// two real browsers against a running server.

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const crypto = require('../e2ee-crypto.js');

/** A full two-party key agreement, as e2ee.js performs it. */
async function handshake() {
    const a = await crypto.generateKeyPair();
    const b = await crypto.generateKeyPair();
    const aPub = await crypto.exportPublic(a.publicKey);
    const bPub = await crypto.exportPublic(b.publicKey);
    const aSecret = await crypto.agree(
        a.privateKey, await crypto.importPublic(bPub),
    );
    const bSecret = await crypto.agree(
        b.privateKey, await crypto.importPublic(aPub),
    );
    return {a, b, aPub, bPub, aSecret, bSecret};
}

test('both peers reach the same shared secret', async () => {
    const h = await handshake();
    assert.ok(crypto.bytesEqual(h.aSecret, h.bSecret),
              'ECDH did not converge');
    assert.ok(h.aSecret.length >= 32, 'shared secret is suspiciously short');
});

test('both peers display the same emoji SAS', async () => {
    const h = await handshake();
    const sasA = await crypto.deriveSAS(h.aSecret, h.aPub, h.bPub);
    const sasB = await crypto.deriveSAS(h.bSecret, h.aPub, h.bPub);
    assert.deepStrictEqual(sasA, sasB);
    assert.strictEqual(sasA.length, crypto.SAS_LENGTH);
    for(const e of sasA)
        assert.ok(crypto.EMOJI.includes(e), `${e} is not from the alphabet`);
});

// The whole security argument: a server that relays its own public key to each
// side sees plaintext, but the two humans see different emoji and stop.
test('a man in the middle produces different SAS on the two legs', async () => {
    const alice = await crypto.generateKeyPair();
    const bob = await crypto.generateKeyPair();
    const mallory = await crypto.generateKeyPair();

    const alicePub = await crypto.exportPublic(alice.publicKey);
    const bobPub = await crypto.exportPublic(bob.publicKey);
    const malloryPub = await crypto.exportPublic(mallory.publicKey);

    // Alice believes she is talking to Mallory's key; Bob likewise.
    const aliceLeg = await crypto.agree(
        alice.privateKey, await crypto.importPublic(malloryPub),
    );
    const bobLeg = await crypto.agree(
        bob.privateKey, await crypto.importPublic(malloryPub),
    );

    const sasAlice = await crypto.deriveSAS(aliceLeg, alicePub, malloryPub);
    const sasBob = await crypto.deriveSAS(bobLeg, malloryPub, bobPub);
    assert.notDeepStrictEqual(
        sasAlice, sasBob,
        'the two legs of a MITM showed the same emoji — the SAS would not ' +
        'reveal the attack',
    );
});

// The SAS is bound to the transcript, roles included, so the two peers must
// agree on who initiated.  A disagreement must surface as a mismatch rather
// than pass silently.
test('the SAS is bound to the order of the two public keys', async () => {
    const h = await handshake();
    const forward = await crypto.deriveSAS(h.aSecret, h.aPub, h.bPub);
    const reversed = await crypto.deriveSAS(h.aSecret, h.bPub, h.aPub);
    assert.notDeepStrictEqual(forward, reversed);
});

test('the emoji alphabet is a power of two', () => {
    // deriveSAS indexes with (byte & 0x3f) and calls that unbiased, which is
    // only true for exactly 64 symbols.
    assert.strictEqual(crypto.EMOJI.length, 64);
    assert.strictEqual(new Set(crypto.EMOJI).size, 64,
                       'duplicate emoji reduce the SAS entropy');
});

test('the commitment binds a public key', async () => {
    const a = await crypto.generateKeyPair();
    const b = await crypto.generateKeyPair();
    const aPub = await crypto.exportPublic(a.publicKey);
    const bPub = await crypto.exportPublic(b.publicKey);

    const c1 = await crypto.commit(aPub);
    const c2 = await crypto.commit(aPub);
    const other = await crypto.commit(bPub);
    assert.strictEqual(c1.length, 32, 'not a SHA-256 digest');
    assert.ok(crypto.bytesEqual(c1, c2),
              'the commitment is not deterministic');
    assert.ok(!crypto.bytesEqual(c1, other),
              'two different keys committed to the same value');
});

// ---- media frames ---------------------------------------------------------

/** Fills a frame with recognisable, non-repeating bytes. */
function frame(n) {
    const u = new Uint8Array(n);
    for(let i = 0; i < n; i++)
        u[i] = (i * 7 + 3) & 0xff;
    return u;
}

const salt = new Uint8Array([1, 2, 3, 4, 5, 6]);

async function mediaKey(senderId = 'alice') {
    const h = await handshake();
    return await crypto.deriveMediaKey(h.aSecret, h.aPub, h.bPub, senderId);
}

test('the clear prefix is the length the SFU parses', () => {
    // These numbers mirror what codecs.go reads off a frame.  Shrinking one
    // hides the VP8 dimensions from the server; growing it leaks payload.
    // They are pinned here because nothing else connects the two files.
    assert.strictEqual(crypto.clearPrefixLength(false, false), 0,
                       'Opus payloads are never parsed, so none is needed');
    assert.strictEqual(crypto.clearPrefixLength(false, true), 0);
    assert.strictEqual(crypto.clearPrefixLength(true, false), 1,
                       'VP8 delta frames need their first byte');
    assert.strictEqual(crypto.clearPrefixLength(true, true), 10,
                       'VP8 keyframes carry dimensions in bytes 6..9');
});

const frameCases = [
    {name: 'audio', isVideo: false, isKeyFrame: false},
    {name: 'a video delta frame', isVideo: true, isKeyFrame: false},
    {name: 'a video keyframe', isVideo: true, isKeyFrame: true},
];

for(const c of frameCases) {
    test(`${c.name} survives a round trip`, async () => {
        const key = await mediaKey();
        const plain = frame(64);
        const enc = await crypto.encryptFrame(
            plain, c.isVideo, c.isKeyFrame, key, salt, 1, 0,
        );
        assert.strictEqual(
            enc.length, plain.length + crypto.OVERHEAD,
            'unexpected expansion',
        );
        const dec = await crypto.decryptFrame(
            enc, c.isVideo, c.isKeyFrame, () => key,
        );
        assert.deepStrictEqual([...dec], [...plain]);
    });

    test(`${c.name} keeps its codec prefix in clear`, async () => {
        // The SFU parses these bytes; encrypting them would break forwarding.
        const key = await mediaKey();
        const plain = frame(64);
        const enc = await crypto.encryptFrame(
            plain, c.isVideo, c.isKeyFrame, key, salt, 1, 0,
        );
        const n = crypto.clearPrefixLength(c.isVideo, c.isKeyFrame);
        assert.deepStrictEqual(
            [...enc.subarray(0, n)], [...plain.subarray(0, n)],
        );
        // ...and nothing beyond it is left in clear.
        if(plain.length > n) {
            assert.notDeepStrictEqual(
                [...enc.subarray(n, n + 16)],
                [...plain.subarray(n, n + 16)],
                'the payload was not encrypted',
            );
        }
    });
}

test('the clear codec prefix is authenticated', async () => {
    // A middlebox that flips the keyframe bit must be detected, or it could
    // steer the decoder while the payload stays authentic.
    const key = await mediaKey();
    const plain = frame(64);
    const enc = await crypto.encryptFrame(plain, true, true, key, salt, 1, 0);
    enc[3] ^= 0x01;
    await assert.rejects(
        crypto.decryptFrame(enc, true, true, () => key),
        'a tampered codec header decrypted anyway',
    );
});

test('a tampered payload is rejected', async () => {
    const key = await mediaKey();
    const plain = frame(64);
    const enc = await crypto.encryptFrame(plain, false, false, key, salt, 1, 0);
    enc[20] ^= 0x80;
    await assert.rejects(crypto.decryptFrame(enc, false, false, () => key));
});

test('a truncated frame is rejected rather than misread', async () => {
    const key = await mediaKey();
    await assert.rejects(
        crypto.decryptFrame(
            new Uint8Array(crypto.OVERHEAD - 1), false, false, () => key,
        ),
        /too short/,
    );
});

test('each sender gets a distinct key', async () => {
    // Senders share one frame counter space, so identical keys would reuse an
    // (key, IV) pair across senders and break AES-GCM outright.
    const h = await handshake();
    const alice = await crypto.deriveMediaKey(
        h.aSecret, h.aPub, h.bPub, 'alice',
    );
    const bob = await crypto.deriveMediaKey(h.aSecret, h.aPub, h.bPub, 'bob');

    const plain = frame(32);
    const byAlice = await crypto.encryptFrame(
        plain, false, false, alice, salt, 1, 0,
    );
    const byBob = await crypto.encryptFrame(
        plain, false, false, bob, salt, 1, 0,
    );
    assert.notDeepStrictEqual([...byAlice], [...byBob]);
    await assert.rejects(
        crypto.decryptFrame(byAlice, false, false, () => bob),
        "one sender's key opened another's frame",
    );
});

test('the frame counter survives the trailer at 48 bits', async () => {
    // The counter is written as six bytes; a value that does not fit would
    // wrap and silently reuse an IV.
    const key = await mediaKey();
    const plain = frame(32);
    for(const counter of [0, 1, 65535, 2 ** 32, 2 ** 48 - 1]) {
        const enc = await crypto.encryptFrame(
            plain, false, false, key, salt, counter, 0,
        );
        const dec = await crypto.decryptFrame(
            enc, false, false, () => key,
        );
        assert.deepStrictEqual([...dec], [...plain], `counter ${counter}`);
    }
});

test('the key id reaches the resolver', async () => {
    const key = await mediaKey();
    const enc = await crypto.encryptFrame(
        frame(32), false, false, key, salt, 1, 7,
    );
    let asked = null;
    await crypto.decryptFrame(enc, false, false, id => {
        asked = id;
        return key;
    });
    assert.strictEqual(asked, 7);
});

test('an unknown key id fails loudly', async () => {
    const key = await mediaKey();
    const enc = await crypto.encryptFrame(
        frame(32), false, false, key, salt, 1, 3,
    );
    await assert.rejects(
        crypto.decryptFrame(enc, false, false, () => undefined),
        /no key for keyId 3/,
    );
});

// ---- chat -----------------------------------------------------------------

test('chat survives a round trip', async () => {
    const h = await handshake();
    const key = await crypto.deriveChatKey(h.aSecret, h.aPub, h.bPub);
    const text = 'Привет — hello 👋 <b>not markup</b>';
    const {iv, ct} = await crypto.encryptChat(key, text);
    assert.strictEqual(await crypto.decryptChat(key, iv, ct), text);
});

test('chat uses a fresh IV per message', async () => {
    const h = await handshake();
    const key = await crypto.deriveChatKey(h.aSecret, h.aPub, h.bPub);
    const one = await crypto.encryptChat(key, 'same text');
    const two = await crypto.encryptChat(key, 'same text');
    assert.notStrictEqual(one.iv, two.iv, 'the IV repeated');
    assert.notStrictEqual(one.ct, two.ct);
});

test('chat from another call does not decrypt', async () => {
    const h1 = await handshake();
    const h2 = await handshake();
    const key1 = await crypto.deriveChatKey(h1.aSecret, h1.aPub, h1.bPub);
    const key2 = await crypto.deriveChatKey(h2.aSecret, h2.aPub, h2.bPub);
    const {iv, ct} = await crypto.encryptChat(key1, 'secret');
    await assert.rejects(crypto.decryptChat(key2, iv, ct));
});

test('the chat key is not the media key', async () => {
    const h = await handshake();
    const chat = await crypto.deriveChatKey(h.aSecret, h.aPub, h.bPub);
    const media = await crypto.deriveMediaKey(
        h.aSecret, h.aPub, h.bPub, 'chat',
    );
    const {iv, ct} = await crypto.encryptChat(chat, 'secret');
    await assert.rejects(
        crypto.decryptChat(media, iv, ct),
        'the two derivations collided',
    );
});
