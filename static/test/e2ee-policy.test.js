// Tests for when the client encrypts and when it refuses.  (Sozvon)
//
// Run with:  node --test static/test/
//
// e2ee-crypto.test.js covers the cryptography; this file covers the decision
// of whether to use it.  Both halves of that decision fail quietly when they
// are wrong: a call that carries on unencrypted looks exactly like one that
// does not, and a controller that reports an established session nobody is on
// the other end of shows the same padlock as a real one.  Nothing here needs a
// browser, so the failures that only two machines and a server would reveal
// are the ones worth pinning down mechanically.
//
// e2ee.js is written for a browser: it has no exports and expects `self`, a
// Worker and RTCRtpScriptTransform.  It is therefore evaluated in a vm context
// with those stubbed, against Node's WebCrypto -- the key agreement below is
// real.  The chat fallback lives in galene.js, which cannot be loaded at all
// outside a browser, so handleInput() is lifted out of the source the way
// i18n.test.js lifts the translation tables.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {webcrypto} = require('node:crypto');

const staticDir = path.join(__dirname, '..');

const quiet = {log() {}, warn() {}, error() {}};

/** A worker that remembers what the controller posted to it. */
class FakeWorker {
    constructor() {
        this.messages = [];
    }
    postMessage(m) {
        this.messages.push(m);
    }
}

/**
 * Evaluate e2ee-crypto.js and e2ee.js in a context of their own, so that a
 * test may replace a crypto primitive without affecting any other test.
 *
 * @returns {any} the context, carrying SozvonE2EECrypto and SozvonE2EE
 */
function loadController() {
    const ctx = vm.createContext({
        crypto: webcrypto, TextEncoder, TextDecoder, Uint8Array,
        btoa, atob, console: quiet,
        Worker: FakeWorker,
        RTCRtpScriptTransform: class {
            constructor(worker, options) {
                this.options = options;
            }
        },
    });
    ctx.self = ctx;
    for(const file of ['e2ee-crypto.js', 'e2ee.js'])
        vm.runInContext(
            fs.readFileSync(path.join(staticDir, file), 'utf8'), ctx,
        );
    return ctx;
}

/**
 * A controller standing where onMessage() leaves it just before finalize():
 * one peer, both public keys in hand, nothing derived yet.
 *
 * @param {any} ctx
 * @returns {Promise<any>}
 */
async function readyToFinalize(ctx) {
    const C = ctx.SozvonE2EECrypto;
    const e = new ctx.SozvonE2EE({id: 'aaa', userMessage() {}});
    e.users.add('zzz');
    e.peer = 'zzz';
    e.role = 'initiator';
    e.state = 'handshaking';
    e.keyPair = await C.generateKeyPair();
    e.myPub = await C.exportPublic(e.keyPair.publicKey);
    e.peerPub = await C.exportPublic((await C.generateKeyPair()).publicKey);
    return e;
}

/**
 * Hold a derivation open, so that the peer can leave while finalize() is
 * still running -- the position a slow device puts it in anyway.
 *
 * @param {any} C - the crypto module of one context
 * @param {string} name - the primitive to pause in
 * @param {number} [nth] - which call to pause in (1 = the first)
 * @returns {{reached: Promise<void>, release: () => void}}
 */
function pauseIn(C, name, nth = 1) {
    let arrive, release;
    const reached = new Promise(r => arrive = r);
    const gate = new Promise(r => release = r);
    const original = C[name];
    let calls = 0;
    C[name] = async (...args) => {
        const out = await original(...args);
        if(++calls === nth) {
            arrive();
            await gate;
        }
        return out;
    };
    return {reached: reached, release: () => release()};
}

// The scenario Codex reproduced against real WebCrypto: the peer leaves
// during the chain of awaits, and the run that is already in flight finishes
// afterwards.  Everything it would write belongs to a session that is over.
test('a completion that outlives its session writes nothing back', async () => {
    const ctx = loadController();
    const e = await readyToFinalize(ctx);
    const paused = pauseIn(ctx.SozvonE2EECrypto, 'deriveSAS');

    const pending = e.finalize();
    await paused.reached;
    e.delUser('zzz');
    assert.strictEqual(e.state, 'idle', 'the peer leaving did not reset');
    paused.release();
    await pending;

    assert.strictEqual(
        e.state, 'idle',
        'a session with no peer was reported as end-to-end encrypted',
    );
    assert.strictEqual(e.peer, null);
    assert.strictEqual(e.sas, null, 'an authentication string outlived its session');
    assert.strictEqual(e.chatKey, null, 'a chat key outlived its session');
});

// The same run, stopped earlier: the media keys must not reach the worker
// either, or frames would be sealed for a peer that has left.
test('a completion that outlives its session gives the worker no keys', async () => {
    const ctx = loadController();
    const e = await readyToFinalize(ctx);
    const paused = pauseIn(ctx.SozvonE2EECrypto, 'deriveMediaKey');

    const pending = e.finalize();
    await paused.reached;
    e.delUser('zzz');
    paused.release();
    // A run left to carry on may also fail outright, now that the material it
    // was working from has been cleared; either way, nothing of a session
    // that is over may reach the worker.
    await pending.catch(() => {});

    const keys = (e.worker ? e.worker.messages : [])
          .filter(m => m.type === 'key');
    assert.deepStrictEqual(
        keys, [], 'keys for a finished session were handed to the worker',
    );
});

// A run that is still current must of course go through.
test('a completion that is still current establishes the session', async () => {
    const ctx = loadController();
    const e = await readyToFinalize(ctx);
    await e.finalize();
    assert.strictEqual(e.state, 'established');
    assert.ok(e.sas && e.sas.length > 0);
    assert.ok(e.chatKey);
    assert.strictEqual(
        e.worker.messages.filter(m => m.type === 'key').length, 4,
        'one key per (sender, media kind)',
    );
});

/**
 * Run a whole handshake between two controllers, relaying their user messages
 * to each other the way the server does.
 *
 * @param {any} ctx
 * @param {boolean} [tamper] - substitute the responder's public key in flight,
 *     as a server sitting in the middle of the exchange would
 * @returns {Promise<{a: any, b: any}>}
 */
async function handshake(ctx, tamper) {
    const C = ctx.SozvonE2EECrypto;
    const queue = [];
    const connection = id => ({
        id: id,
        userMessage: (kind, dest, payload) => {
            if(tamper && id === 'zzz' && payload.t === 'dh') {
                const pub = C.unb64(payload.pub);
                pub[1] ^= 1;
                payload = {t: 'dh', pub: C.b64(pub)};
            }
            queue.push({from: id, dest: dest, payload: payload});
        },
    });
    const a = new ctx.SozvonE2EE(connection('aaa'));
    const b = new ctx.SozvonE2EE(connection('zzz'));
    a.users.add('zzz');
    b.users.add('aaa');
    await a.startWith('zzz');
    await b.startWith('aaa');

    const peers = {aaa: a, zzz: b};
    for(let i = 0; queue.length && i < 100; i++) {
        const m = queue.shift();
        await peers[m.dest].onMessage(m.from, m.payload);
    }
    return {a: a, b: b};
}

// The generation check above sits in the middle of the handshake, so the
// handshake itself is worth running here rather than only in a browser: both
// sides must still reach the same emoji, and a substituted key must still be
// caught by the commitment.
test('two controllers relayed through a server agree on one session', async () => {
    const ctx = loadController();
    const {a, b} = await handshake(ctx);
    assert.strictEqual(a.state, 'established');
    assert.strictEqual(b.state, 'established');
    assert.strictEqual(a.sas.join(''), b.sas.join(''));
    assert.strictEqual(
        a.worker.messages.filter(m => m.type === 'key').length, 4,
    );
});

test('a substituted public key is still refused', async () => {
    const ctx = loadController();
    const {a} = await handshake(ctx, true);
    assert.strictEqual(a.state, 'failed');
    assert.strictEqual(a.sas, null);
});

/** A sender whose transform cannot be set, as an unsupporting browser has. */
function refusingSender() {
    const sender = {};
    Object.defineProperty(sender, 'transform', {
        set() {
            throw new Error('transform not supported here');
        },
        get() {
            return undefined;
        },
    });
    return sender;
}

test('a sender the encryptor cannot be attached to blocks a group that requires it', () => {
    const ctx = loadController();
    const e = new ctx.SozvonE2EE({id: 'aaa', userMessage() {}});
    e.require = true;
    e.users.add('zzz');
    e.peer = 'zzz';
    e.state = 'established';

    const sender = refusingSender();
    assert.strictEqual(
        e.attachSender(sender, 'audio'), false,
        'attachSender reported success although no transform was attached',
    );
    assert.strictEqual(sender.transform, undefined);
    assert.strictEqual(
        e.state, 'blocked',
        'media would have been published while the call was still shown ' +
        'as end-to-end encrypted',
    );
});

test('a sender the encryptor cannot be attached to downgrades a group that does not', () => {
    const ctx = loadController();
    const e = new ctx.SozvonE2EE({id: 'aaa', userMessage() {}});
    e.require = false;
    e.users.add('zzz');
    e.peer = 'zzz';
    e.state = 'established';

    assert.strictEqual(e.attachSender(refusingSender(), 'audio'), false);
    assert.strictEqual(
        e.state, 'unencrypted',
        'the call carried on under a padlock it had lost',
    );
});

test('attaching the encryptor to a working sender succeeds', () => {
    const ctx = loadController();
    const e = new ctx.SozvonE2EE({id: 'aaa', userMessage() {}});
    e.require = true;
    e.peer = 'zzz';
    e.state = 'established';

    const sender = {transform: undefined};
    assert.strictEqual(e.attachSender(sender, 'video'), true);
    // field by field: the object was made in the vm context, so it is not
    // deep-strict-equal to one made here
    assert.strictEqual(sender.transform.options.operation, 'encrypt');
    assert.strictEqual(sender.transform.options.streamId, 'aaa|video');
    assert.strictEqual(sender.transform.options.kind, 'video');
    assert.strictEqual(e.state, 'established');
});

// An empty room is not an idle one: the client publishes into the SFU whether
// or not anybody else has arrived, so a browser that cannot encrypt must be
// refused before it turns a camera on rather than once a peer shows up.
test('a browser that cannot encrypt is refused with nobody else in the room', () => {
    const ctx = loadController();
    const e = new ctx.SozvonE2EE({id: 'alone', userMessage() {}});
    e.supported = false;
    e.require = true;

    e.addUser('zzz');
    assert.strictEqual(e.state, 'blocked');
    e.delUser('zzz');
    assert.strictEqual(
        e.state, 'blocked',
        'the room emptying reopened publication for a browser that cannot ' +
        'encrypt',
    );
});

test('the requirement is applied as soon as the client learns of it', () => {
    const ctx = loadController();
    const e = new ctx.SozvonE2EE({id: 'alone', userMessage() {}});
    e.supported = false;

    // What galene.js does on joining, before any user event arrives.
    e.setRequire(true);
    assert.strictEqual(
        e.state, 'blocked',
        'a browser that cannot encrypt was left free to publish',
    );
});

test('a group that does not require encryption is not blocked by this', () => {
    const ctx = loadController();
    const e = new ctx.SozvonE2EE({id: 'alone', userMessage() {}});
    e.supported = false;

    e.setRequire(false);
    assert.strictEqual(e.state, 'idle');
});

// ---- the chat fallback in galene.js ---------------------------------------

/**
 * Run galene.js's handleInput() against stubs.
 *
 * The function is lifted out of the source because galene.js as a whole wants
 * a document, a WebRTC stack and a server; the text below is the real thing,
 * not a copy of it, so it goes stale the moment the source does.
 *
 * @param {object} o
 * @param {'unusable'|'refuses'|'fails'} o.mode - how the encrypted path ends:
 *     the channel is not usable at all, sendChat() reports it did not send,
 *     or sendChat() rejects
 * @param {boolean} o.require - the group's "require encryption" option
 * @param {string} o.text - what the user typed
 * @returns {Promise<{sent: any[][], errors: any[], input: {value: string}}>}
 */
async function runHandleInput(o) {
    const src = fs.readFileSync(path.join(staticDir, 'galene.js'), 'utf8');
    const start = src.indexOf('function handleInput() {');
    const end = src.indexOf("document.getElementById('inputform').onsubmit");
    assert.ok(
        start >= 0 && end > start,
        'galene.js no longer declares `function handleInput() {` ahead of ' +
        'the input form handler — this test locates it by that text and ' +
        'needs updating',
    );

    const sent = [];
    const errors = [];
    const input = {value: o.text};
    const ctx = vm.createContext({
        console: quiet,
        document: {getElementById: () => input},
        Sozvon: {i18n: {t: k => k}},
        e2eeActive: () => true,
        displayError: e => errors.push(e),
        addToChatbox: () => {},
        serverConnection: {
            socket: {},
            id: 'aaa',
            username: 'me',
            chat: (...args) => sent.push(args),
            e2ee: {
                require: o.require,
                canChat: () => o.mode !== 'unusable',
                sendChat: async () => {
                    if(o.mode === 'fails')
                        throw new Error('injected encryption failure');
                    return false;
                },
            },
        },
    });
    vm.runInContext(src.slice(start, end), ctx);
    ctx.handleInput();
    // the two fallbacks that go through sendChat() are asynchronous
    await new Promise(resolve => setImmediate(resolve));
    return {sent: sent, errors: errors, input: input};
}

const CHAT_MODES = ['unusable', 'refuses', 'fails'];

// serverConnection.chat() is the ordinary chat message: the server reads it
// and keeps it in the room's history.  Where the operator has required
// end-to-end encryption, that is the one thing the message must not become.
test('chat that cannot be encrypted is not sent in clear when the group requires it', async () => {
    for(const mode of CHAT_MODES) {
        const r = await runHandleInput({
            mode: mode, require: true, text: 'text for the other person',
        });
        assert.deepStrictEqual(
            r.sent, [],
            `${mode}: the message was sent to the server in clear`,
        );
        assert.strictEqual(
            r.errors.length, 1,
            `${mode}: the message was dropped without telling the user`,
        );
        assert.strictEqual(
            r.input.value, 'text for the other person',
            `${mode}: the text the user typed was lost`,
        );
    }
});

test('chat falls back to an ordinary message where encryption is not required', async () => {
    for(const mode of CHAT_MODES) {
        const r = await runHandleInput({
            mode: mode, require: false, text: 'text for the other person',
        });
        assert.strictEqual(
            r.sent.length, 1, `${mode}: the message was not sent at all`,
        );
        assert.strictEqual(r.sent[0][2], 'text for the other person');
        assert.strictEqual(r.input.value, '', `${mode}: the box was not cleared`);
    }
});
