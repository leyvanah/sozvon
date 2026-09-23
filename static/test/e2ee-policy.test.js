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

// The failure has to be remembered.  The tracks published while the encryptor
// was failing are still going out without one, so a handshake that completes
// afterwards must not put the padlock back over them.
test('an encryptor that failed once is not forgotten when a peer arrives', () => {
    const ctx = loadController();
    const e = new ctx.SozvonE2EE({id: 'aaa', userMessage() {}});
    e.require = false;

    // alone in the room, publishing: the encryptor cannot be attached
    assert.strictEqual(e.attachSender(refusingSender(), 'video'), false);
    assert.strictEqual(e.state, 'unencrypted');

    e.addUser('zzz');
    assert.strictEqual(
        e.state, 'unencrypted',
        'a handshake was started although media is already going out ' +
        'without an encryptor',
    );
    assert.strictEqual(e.sas, null);
});

test('an encryptor that failed once keeps a group that requires it blocked', () => {
    const ctx = loadController();
    const e = new ctx.SozvonE2EE({id: 'aaa', userMessage() {}});
    e.require = true;

    assert.strictEqual(e.attachSender(refusingSender(), 'video'), false);
    assert.strictEqual(e.state, 'blocked');

    e.addUser('zzz');
    assert.strictEqual(
        e.state, 'blocked',
        'a peer arriving reopened publication for a browser whose ' +
        'encryptor does not attach',
    );
});

// The peer is told over the signalling channel, which throws on a socket that
// is not open.  The state change is what stops the media, so it has to happen
// whether or not that message got out.
test('a failure that cannot be announced still changes the state', () => {
    const ctx = loadController();
    const e = new ctx.SozvonE2EE({
        id: 'aaa',
        userMessage() {
            throw new Error('Connection is not open');
        },
    });
    e.require = true;
    e.users.add('zzz');
    e.peer = 'zzz';
    e.state = 'established';

    assert.strictEqual(e.attachSender(refusingSender(), 'audio'), false);
    assert.strictEqual(e.state, 'blocked');
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

// ---- the media policy in galene.js ----------------------------------------

/**
 * Lift a top-level function out of a client script, for the same reason
 * handleInput() is lifted below: the file around it wants a browser.
 *
 * @param {string} file
 * @param {string} name
 * @returns {string}
 */
function liftFunction(file, name) {
    const src = fs.readFileSync(path.join(staticDir, file), 'utf8');
    let start = src.indexOf('function ' + name + '(');
    assert.notStrictEqual(
        start, -1,
        `${file} no longer declares ${name}() — this test locates it by ` +
        'that text and needs updating',
    );
    if(src.slice(start - 6, start) === 'async ')
        start -= 6;
    const end = src.indexOf('\n}\n', start);
    assert.ok(end > start, `${name}() in ${file} does not end at column 0`);
    return src.slice(start, end + 3);
}

/**
 * Lift a function the code under test may not have yet, with what it did
 * before instead.  Without this a test of new behaviour fails on the old code
 * for want of a function rather than for doing the old thing, which says far
 * less: the point of running these against the commit before the fix is to
 * watch the old behaviour happen.
 *
 * @param {any} ctx
 * @param {string} file
 * @param {string} name
 * @param {string} before - the source of a stand-in, as the old code behaved
 */
function liftFunctionOr(ctx, file, name, before) {
    let source;
    try {
        source = liftFunction(file, name);
    } catch {
        source = before;
    }
    vm.runInContext(source, ctx);
}

/** @param {string|null} state - the controller state, or null for no connection */
function mayPublish(state) {
    const ctx = vm.createContext({
        serverConnection: state === null ? null : {e2ee: {state: state}},
    });
    vm.runInContext(liftFunction('galene.js', 'mayPublishLocalMedia'), ctx);
    return ctx.mayPublishLocalMedia();
}

// This mapping is the whole media guarantee: the controller decides, and this
// is where the decision stops a camera.  A test that only asserted controller
// state would not notice the condition being inverted here.
test('local media is not published while the controller refuses', () => {
    assert.strictEqual(
        mayPublish('blocked'), false,
        'media would be published although the call cannot be encrypted',
    );
    for(const state of ['idle', 'handshaking', 'established',
                        'unencrypted', 'failed'])
        assert.strictEqual(mayPublish(state), true, state);
    // before there is a connection at all there is nothing to refuse
    assert.strictEqual(mayPublish(null), true);
});

/** @param {string} state */
function runMediaPolicy(state) {
    const closed = [];
    const visibility = {};
    const ctx = vm.createContext({
        serverConnection: {e2ee: {state: state}},
        setVisibility: (id, visible) => visibility[id] = visible,
        closeUpMedia: label => closed.push(label),
        setButtonsVisibility: () => {},
    });
    vm.runInContext(liftFunction('galene.js', 'enforceE2EEMediaPolicy'), ctx);
    ctx.enforceE2EEMediaPolicy();
    return {closed: closed, visibility: visibility};
}

test('a blocked call has its local media closed and says so on screen', () => {
    const r = runMediaPolicy('blocked');
    assert.deepStrictEqual(
        r.closed, ['camera', 'screenshare'],
        'local media kept publishing after the call was blocked',
    );
    assert.strictEqual(r.visibility['e2ee-block-overlay'], true);
});

test('a call that is merely unencrypted keeps publishing', () => {
    const r = runMediaPolicy('unencrypted');
    assert.deepStrictEqual(r.closed, []);
    assert.strictEqual(r.visibility['e2ee-block-overlay'], false);
});

// The policy above closes a stream from inside setUpStream, whose callers go
// on to build a tile for it.  setMedia has to notice; there is no DOM here, so
// the test is that it does not reach for one.
test('no tile is built for a stream that has already been closed', async () => {
    const ctx = vm.createContext({
        document: {
            getElementById() {
                throw new Error('setMedia went to the DOM for a closed stream');
            },
        },
    });
    vm.runInContext(liftFunction('galene.js', 'setMedia'), ctx);
    await ctx.setMedia({sc: null, localId: 'closed-while-setting-up'});
});

// ---- how a chat message is drawn ------------------------------------------

// Enough of a document for addToChatbox to build its message in, and no more.
// What the tests below ask of it is what the reader would see: the classes it
// hung on the message, and the words in it.
class FakeElement {}

function fakeDocument() {
    const make = (tag) => {
        const el = Object.assign(new FakeElement(), {
            tag: tag,
            children: [],
            classes: new Set(),
            dataset: {},
            style: {},
            textContent: '',
            title: '',
            classList: {
                add: (...names) => names.forEach(n => el.classes.add(n)),
                remove: (...names) => names.forEach(n => el.classes.delete(n)),
                contains: (name) => el.classes.has(name),
                toggle: (name, on) => on ? el.classes.add(name)
                                         : el.classes.delete(name),
            },
            appendChild: (child) => {
                el.children.push(child);
                return child;
            },
            addEventListener: () => {},
            /** Every class anywhere in this subtree. */
            allClasses() {
                const out = new Set(el.classes);
                for(const c of el.children)
                    if(c.allClasses) for(const name of c.allClasses()) out.add(name);
                return out;
            },
            /** Everything the reader would see, as one string. */
            text() {
                return el.textContent +
                    el.children.map(c => c.text ? c.text() : '').join(' ');
            },
        });
        return el;
    };
    const box = make('div');
    box.scrollHeight = 0;
    box.clientHeight = 100;
    return {
        box: box,
        createElement: make,
        getElementById: (id) => id === 'box' ? box : make('div'),
    };
}

/**
 * Draw one message with galene.js's own addToChatbox, and hand back what it
 * put in the box.
 *
 * @param {object} o
 * @param {string|null} o.peerId
 * @param {boolean} [o.unencrypted]
 * @param {string} [o.kind]
 * @returns {{classes: Set<string>, text: string}}
 */
function drawMessage(o) {
    const doc = fakeDocument();
    const ctx = vm.createContext({
        console: quiet,
        document: doc,
        HTMLElement: FakeElement,
        Sozvon: {i18n: {t: (key) => `<${key}>`}},
        serverConnection: {id: 'mine', users: {}, permissions: []},
        lastMessage: {},
        panelVisible: () => true,
        refreshPanelAlert: () => {},
        formatTime: () => '12:00',
        formatText: () => doc.createElement('span'),
        displayCaption: () => {},
        chatMessageMenu: () => {},
    });
    vm.runInContext(liftFunction('galene.js', 'addToChatbox'), ctx);
    ctx.addToChatbox(
        null, o.peerId, '', 'somebody', new Date(), false, false,
        o.kind || '', doc.createElement('span'), o.unencrypted,
    );
    const row = doc.box.children[0];
    assert.ok(row, 'nothing was added to the chat box');
    return {classes: row.allClasses(), text: row.text()};
}

test('a message the server could read says so, in words', () => {
    const marked = drawMessage({peerId: 'them', unencrypted: true});
    assert.ok(
        marked.text.includes('<chat.unencrypted>'),
        'a message the server relayed in clear said nothing about it',
    );
    assert.ok(marked.classes.has('message-unencrypted'));

    const plain = drawMessage({peerId: 'them', unencrypted: false});
    assert.ok(!plain.text.includes('<chat.unencrypted>'));
    assert.ok(!plain.classes.has('message-unencrypted'));
});

// The mark has to survive a run of messages from one person, where only the
// first draws a header.
test('the mark is on every message, not only the first of a run', () => {
    for(const kind of ['', 'me']) {
        const marked = drawMessage({peerId: 'them', unencrypted: true, kind: kind});
        assert.ok(
            marked.text.includes('<chat.unencrypted>'),
            `a "${kind || 'plain'}" message lost the mark`,
        );
    }
});

test('an encrypted message is not drawn as a system notice', () => {
    const fromPeer = drawMessage({peerId: 'them'});
    assert.ok(
        !fromPeer.classes.has('message-system'),
        'an encrypted message was drawn as machine chatter',
    );
    const mine = drawMessage({peerId: 'mine'});
    assert.ok(mine.classes.has('message-sender'), 'own message lost its styling');
});

// ---- who the client says a message came from ------------------------------

/**
 * Run galene.js's gotUserMessage() for one 'e2eechat' message and hand back
 * the arguments it passed on to addToChatbox.
 *
 * @returns {Promise<any[]>}
 */
async function relayEncryptedChat(sender) {
    const drawn = [];
    const ctx = vm.createContext({
        console: quiet,
        e2eeActive: () => true,
        addToChatbox: (...args) => drawn.push(args),
        serverConnection: {
            id: 'mine',
            users: {[sender]: {username: 'them'}},
            e2ee: {
                decryptChat: async () => ({kind: '', text: 'hello'}),
            },
        },
    });
    vm.runInContext(liftFunction('galene.js', 'gotUserMessage'), ctx);
    ctx.gotUserMessage(sender, '', 'them', new Date(), false, 'e2eechat',
                       null, {iv: 'x', ct: 'y'});
    await new Promise(resolve => setImmediate(resolve));
    assert.strictEqual(drawn.length, 1, 'the message was not drawn');
    return drawn[0];
}

test('a decrypted message carries its sender where every message carries it', async () => {
    const args = await relayEncryptedChat('them');
    // addToChatbox(id, peerId, dest, nick, time, privileged, history, kind, message)
    assert.strictEqual(
        args[1], 'them',
        'the sender was not in the peerId slot, so the message is drawn as a ' +
        'system notice and raises no unread mark',
    );
    // There is no server-side message id for something the server never had.
    assert.ok(!args[0], 'an encrypted message was given a server message id');
});

test('the echo of an encrypted message you sent carries you', async () => {
    const drawn = [];
    const r = await runHandleInput({
        mode: 'sends', require: true, text: 'text for the other person',
        onChatbox: (...args) => drawn.push(args),
    });
    assert.deepStrictEqual(r.sent, [], 'an encrypted message went to the server');
    assert.strictEqual(drawn.length, 1, 'the message was not echoed locally');
    assert.strictEqual(
        drawn[0][1], 'aaa',
        'your own encrypted message was drawn as a system notice',
    );
});

// The policy closes local media the moment it refuses the call, which can be
// before the stream ever had a tile.  Removing a tile that was never built is
// not an error here, and an exception on a path the app takes by design is
// noise that later hides the real ones.
test('closing a stream that never had a tile is not an error', () => {
    let refreshed = false;
    const ctx = vm.createContext({
        console: quiet,
        document: {
            getElementById: (id) => id === 'peers' ? {removeChild() {}} : null,
        },
        setButtonsVisibility: () => refreshed = true,
        resizePeers: () => {},
        hideVideo: () => {},
    });
    vm.runInContext(liftFunction('galene.js', 'delMedia'), ctx);
    ctx.delMedia('a-stream-closed-before-it-was-shown');
    assert.ok(refreshed, 'the buttons were not told that publishing had stopped');
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
 * @param {'unusable'|'refuses'|'fails'|'sends'} o.mode - how the encrypted
 *     path ends: the channel is not usable at all, sendChat() reports it did
 *     not send, sendChat() rejects, or it goes out encrypted
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
        addToChatbox: (...args) => {
            if(o.onChatbox) o.onChatbox(...args);
        },
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
                    return o.mode === 'sends';
                },
            },
        },
    });
    // handleInput asks mayChatInClear() whether an ordinary chat message may
    // be sent at all; that decision is galene.js's own, so it is lifted too
    // rather than stubbed.
    liftFunctionOr(ctx, 'galene.js', 'mayChatInClear',
                   'function mayChatInClear() { return true; }');
    vm.runInContext(src.slice(start, end), ctx);
    ctx.handleInput();
    // the two fallbacks that go through sendChat() are asynchronous
    await new Promise(resolve => setImmediate(resolve));
    return {sent: sent, errors: errors, input: input};
}

/**
 * Run the /msg command out of galene.js's command table.  It does not go
 * through handleInput's fallback at all: the command is dispatched and
 * returns, so whatever it does about encryption it has to do itself.
 *
 * @param {boolean} require - the group's "require encryption" option
 * @returns {{sent: any[][], error: any}}
 */
function runPrivateMessage(require) {
    const src = fs.readFileSync(path.join(staticDir, 'galene.js'), 'utf8');
    const start = src.indexOf('commands.msg = {');
    const end = src.indexOf('\n};\n', start);
    assert.ok(
        start >= 0 && end > start,
        'galene.js no longer declares `commands.msg = {` — this test locates ' +
        'it by that text and needs updating',
    );

    const sent = [];
    const drawn = [];
    const ctx = vm.createContext({
        console: quiet,
        commands: {},
        Sozvon: {i18n: {t: k => k}},
        e2eeActive: () => true,
        addToChatbox: (...args) => drawn.push(args),
        parseCommand: (r) => {
            const space = r.indexOf(' ');
            return [r.slice(0, space), r.slice(space + 1)];
        },
        findUserId: () => 'zzz',
        serverConnection: {
            id: 'aaa',
            username: 'me',
            users: {zzz: {username: 'them'}},
            chat: (...args) => sent.push(args),
            e2ee: {require: require},
        },
    });
    liftFunctionOr(ctx, 'galene.js', 'mayChatInClear',
                   'function mayChatInClear() { return true; }');
    vm.runInContext(src.slice(start, end + 4), ctx);

    let error = null;
    try {
        ctx.commands.msg.f('msg', 'them hello');
    } catch(e) {
        error = e;
    }
    return {sent: sent, drawn: drawn, error: error};
}

// The command table is a fourth way into serverConnection.chat, and it never
// passes handleInput's fallback: it sends and returns.
test('a private message is not sent in clear when the group requires encryption', () => {
    const r = runPrivateMessage(true);
    assert.deepStrictEqual(
        r.sent, [],
        'a private message went to the server in clear',
    );
    assert.ok(r.error, 'the message was dropped without telling the user');
});

test('a private message is sent where encryption is not required', () => {
    const r = runPrivateMessage(false);
    assert.strictEqual(r.error, null);
    assert.strictEqual(r.sent.length, 1);
    assert.strictEqual(r.sent[0][2], 'hello');
    // and its echo says who sent it, like every other message
    assert.strictEqual(r.drawn.length, 1, 'the message was not echoed locally');
    assert.strictEqual(
        r.drawn[0][1], 'aaa',
        'your own private message was drawn as a system notice',
    );
});

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
