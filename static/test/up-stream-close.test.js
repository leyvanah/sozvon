// What the server says about an up stream the client has already let go.
// (Sozvon)
//
// Run with:  node --test static/test/
//
// A stream is published with an offer, and the server answers it.  When the
// client closes or replaces the stream before that answer arrives -- a second
// change of microphone in quick succession, a camera turned off at once --
// the answer still comes, and so may a renegotiation request or an abort.
// protocol.js threw "unknown up stream" for each of them: an uncaught error
// in the page on every quick change of devices, and a failure of every
// browser test that watches for page errors.  Such messages are about a
// stream this client closed and are of no consequence; a message about an
// id the client never published is still an error.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const staticDir = path.join(__dirname, '..');

const quiet = {log() {}, info() {}, warn() {}, error() {}, debug() {}};

class FakePeerConnection {
    constructor() {
        this.closed = false;
        this.remote = null;
        this.iceConnectionState = 'new';
    }
    close() { this.closed = true; }
    async setRemoteDescription(d) {
        if(this.closed)
            throw new Error('InvalidStateError: closed');
        this.remote = d;
    }
    get remoteDescription() { return this.remote; }
    getSenders() { return []; }
    getTransceivers() { return []; }
    restartIce() {}
}

/** protocol.js, connected to a fake server, with one user: us. */
function connected() {
    const sockets = [];
    class FakeWebSocket {
        constructor() {
            this.readyState = 0;
            this.sent = [];
            sockets.push(this);
        }
        send(s) { this.sent.push(JSON.parse(s)); }
        close() { this.readyState = 3; }
    }
    const ctx = vm.createContext({
        console: quiet,
        WebSocket: FakeWebSocket,
        RTCPeerConnection: FakePeerConnection,
        setTimeout: () => 0, clearTimeout() {},
        setInterval: () => 0, clearInterval() {},
        crypto: globalThis.crypto,
    });
    ctx.self = ctx;
    for(const file of ['signalling-resume.js', 'protocol.js'])
        vm.runInContext(
            fs.readFileSync(path.join(staticDir, file), 'utf8'), ctx,
        );
    const sc = new ctx.ServerConnection();
    sc.connect('wss://example.invalid/ws');
    const ws = sockets[0];
    ws.readyState = 1;
    ws.onopen({});
    ws.onmessage({data: JSON.stringify({type: 'handshake', version: ['2']})});
    sc.users[sc.id] = {username: 'me', permissions: [], data: {},
                       streams: {}};
    return sc;
}

/** An up stream whose offer has gone to the server. */
function published(sc, localId) {
    const c = sc.newUpStream(localId);
    c.localDescriptionSent = true;
    return c;
}

test('an answer for a stream closed meanwhile is let go', async () => {
    const sc = connected();
    const c = published(sc);
    c.close();
    await assert.doesNotReject(sc.gotAnswer(c.id, 'v=0'));
});

test('an answer for a stream replaced meanwhile is let go', async () => {
    const sc = connected();
    const first = published(sc, 'camera');
    const second = published(sc, 'camera');
    assert.notStrictEqual(first.id, second.id);
    await assert.doesNotReject(sc.gotAnswer(first.id, 'v=0'));
    // and it went nowhere near the stream that replaced it
    assert.strictEqual(sc.up[second.id].pc.remoteDescription, null);
    await sc.gotAnswer(second.id, 'v=0');
    assert.strictEqual(sc.up[second.id].pc.remoteDescription.sdp, 'v=0');
});

test('a renegotiation or an abort for a closed stream is let go', () => {
    const sc = connected();
    const c = published(sc);
    c.close();
    assert.doesNotThrow(() => sc.gotRenegotiate(c.id));
    assert.doesNotThrow(() => sc.gotAbort(c.id));
});

test('a message about a stream never published is still an error', async () => {
    const sc = connected();
    await assert.rejects(sc.gotAnswer('never-published', 'v=0'),
                         /unknown up stream/);
    assert.throws(() => sc.gotRenegotiate('never-published'),
                  /unknown up stream/);
    assert.throws(() => sc.gotAbort('never-published'),
                  /unknown up stream/);
});
