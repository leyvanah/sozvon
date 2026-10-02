// Tests for resuming a session over a new websocket.  (Sozvon)
//
// Run with:  node --test static/test/
//
// protocol.js is written for a browser, so it is evaluated in a vm context
// with a fake WebSocket and a fake clock.  The server's half is tested in
// rtpconn/resume_test.go; what is pinned down here is the client's: when it
// gives up on a socket, what it says when it comes back, that nothing it
// sent is lost or sent twice, and that it still ends the session when it
// should -- leaving, a kick, a refusal -- rather than trying forever.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const R = require('../signalling-resume.js');

const staticDir = path.join(__dirname, '..');
const quiet = {log() {}, info() {}, warn() {}, error() {}};

test('SentLog keeps the tail and refuses gaps', () => {
    const l = new R.SentLog();
    assert.deepStrictEqual(l.after(0), []);
    l.push('a'); l.push('b'); l.push('c');
    assert.deepStrictEqual(l.after(1), ['b', 'c']);
    assert.deepStrictEqual(l.after(3), []);
    assert.strictEqual(l.after(4), null, 'more than was sent');
    assert.strictEqual(l.after(-1), null);
    assert.strictEqual(l.after(1.5), null);
    for(let i = 0; i < R.MAX_MESSAGES; i++)
        l.push('x');
    assert.strictEqual(l.after(2), null, 'no longer kept');
    assert.strictEqual(l.after(3).length, R.MAX_MESSAGES);
});

test('SentLog is bounded in bytes too', () => {
    const l = new R.SentLog();
    l.push('x'.repeat(R.MAX_BYTES));
    l.push('y');
    assert.deepStrictEqual(l.after(1), ['y']);
    assert.strictEqual(l.after(0), null);
});

test('counted leaves out the handshake and the resume messages', () => {
    for(const t of ['handshake', 'sozvon-session', 'sozvon-resumed'])
        assert.strictEqual(R.counted(t), false, t);
    for(const t of ['join', 'ping', 'pong', 'chat', 'ice', 'offer'])
        assert.strictEqual(R.counted(t), true, t);
});

test('onClose resumes only a lost socket of a resumable session', () => {
    assert.strictEqual(R.onClose(1006, true, false), 'resume');
    assert.strictEqual(R.onClose(1011, true, false), 'resume');
    assert.strictEqual(R.onClose(1006, false, false), 'end', 'not resumable');
    assert.strictEqual(R.onClose(1006, true, true), 'end', 'we are leaving');
    assert.strictEqual(R.onClose(1000, true, false), 'end', 'server closed');
    assert.strictEqual(R.onClose(R.CLOSE_NO_RESUME, true, false), 'end');
});

test('onTick pings, then gives up on a silent socket', () => {
    assert.strictEqual(R.onTick(0), 'ok');
    assert.strictEqual(R.onTick(R.PING_AFTER), 'ping');
    assert.strictEqual(R.onTick(R.STALL_AFTER + 1), 'resume');
    // well within the server's patience (two minutes with live media)
    assert.ok(R.GIVE_UP_AFTER < 120000);
});

/** A clock and timers that only move when told to. */
class Clock {
    constructor() {
        this.now = 1000000;
        this.timers = [];
        this.nextId = 1;
    }
    add(f, ms, every) {
        const t = {id: this.nextId++, at: this.now + ms, f, every};
        this.timers.push(t);
        return t.id;
    }
    clear(id) {
        this.timers = this.timers.filter(t => t.id !== id);
    }
    advance(ms) {
        const end = this.now + ms;
        for(;;) {
            const due = this.timers.filter(t => t.at <= end)
                .sort((a, b) => a.at - b.at)[0];
            if(!due)
                break;
            this.now = due.at;
            if(due.every)
                due.at += due.every;
            else
                this.clear(due.id);
            due.f();
        }
        this.now = end;
    }
}

/**
 * Evaluate protocol.js with a fake WebSocket and clock.
 *
 * @returns {{ctx: any, clock: Clock, sockets: Array<any>}}
 */
function load() {
    const clock = new Clock();
    const sockets = [];
    class FakeWebSocket {
        constructor(url) {
            this.url = url;
            this.readyState = 0;
            this.sent = [];
            this.closedWith = null;
            sockets.push(this);
        }
        get OPEN() { return 1; }
        send(s) {
            if(this.readyState !== 1)
                throw new Error('not open');
            this.sent.push(JSON.parse(s));
        }
        close(code) {
            this.closedWith = code || 1005;
            this.readyState = 2;
        }
        // driven by the test
        open() {
            this.readyState = 1;
            this.onopen && this.onopen({});
        }
        receive(m) {
            this.onmessage && this.onmessage({data: JSON.stringify(m)});
        }
        drop(code) {
            this.readyState = 3;
            this.onclose && this.onclose({code, reason: ''});
        }
    }
    class FakeDate extends Date {
        constructor(...a) {
            if(a.length) super(...a); else super(clock.now);
        }
        static now() { return clock.now; }
    }
    const ctx = vm.createContext({
        console: quiet,
        WebSocket: FakeWebSocket,
        Date: FakeDate,
        setTimeout: (f, ms) => clock.add(f, ms),
        clearTimeout: id => clock.clear(id),
        setInterval: (f, ms) => clock.add(f, ms, ms),
        clearInterval: id => clock.clear(id),
        crypto: globalThis.crypto,
    });
    ctx.self = ctx;
    for(const file of ['signalling-resume.js', 'protocol.js'])
        vm.runInContext(
            fs.readFileSync(path.join(staticDir, file), 'utf8'), ctx,
        );
    return {ctx, clock, sockets};
}

/**
 * A session joined and given its secret: the client has sent one numbered
 * message (join), the server two.
 */
function session(opts = {}) {
    const env = load();
    const sc = new env.ctx.ServerConnection();
    env.events = [];
    sc.onconnected = () => env.events.push('connected');
    sc.onclose = (code) => env.events.push(`close ${code}`);
    sc.connect('wss://example.invalid/ws');
    const ws = env.sockets[0];
    ws.open();
    assert.strictEqual(ws.sent[0].type, 'handshake');
    assert.strictEqual(ws.sent[0].kind, 'sozvon-resumable');
    ws.receive({type: 'handshake', version: ['2']});
    sc.send({type: 'join', kind: 'join', group: 'g'});
    if(opts.secret !== false)
        ws.receive({type: 'sozvon-session', value: 's3cret'});
    ws.receive({type: 'user', kind: 'add', id: 'x', username: 'X'});
    ws.receive({type: 'pong'});
    env.sc = sc;
    env.ws = ws;
    return env;
}

test('a silent socket is pinged, then replaced; nothing is lost', () => {
    const {sc, ws, clock, sockets, events} = session();
    assert.strictEqual(sc.received, 2);

    clock.advance(R.PING_AFTER + 2000);
    assert.ok(ws.sent.some(m => m.type === 'ping'), 'pinged');

    clock.advance(R.STALL_AFTER);
    // every ping went into the dead socket, so all of them are sent again
    const pings = ws.sent.filter(m => m.type === 'ping').length;
    assert.strictEqual(sockets.length, 2, 'a new socket');
    assert.strictEqual(ws.closedWith, 4000);
    const ws2 = sockets[1];
    assert.strictEqual(sc.socket, ws2);

    // what the user does meanwhile is kept, not thrown away nor thrown
    sc.send({type: 'chat', value: 'hello'});
    ws2.open();
    const hello = ws2.sent[0];
    assert.strictEqual(hello.kind, 'sozvon-resume');
    assert.strictEqual(hello.id, sc.id);
    assert.deepStrictEqual({...hello.value},
                           {secret: 's3cret', received: 2});
    assert.strictEqual(ws2.sent.length, 1, 'nothing else before the answer');

    // the server got the join only
    ws2.receive({type: 'handshake', version: ['2']});
    ws2.receive({type: 'sozvon-resumed', value: 1});
    const resent = ws2.sent.slice(1).map(m => m.type);
    assert.deepStrictEqual(resent, [...Array(pings).fill('ping'), 'chat']);
    assert.strictEqual(sc.resuming, null);
    assert.deepStrictEqual(events, ['connected'], 'no new session, no close');

    // and the session goes on over the new socket
    sc.send({type: 'chat', value: 'again'});
    assert.strictEqual(ws2.sent.at(-1).value, 'again');
    ws2.receive({type: 'chat', value: 'replayed'});
    assert.strictEqual(sc.received, 3);
});

test('the old socket is ignored once replaced', () => {
    const {sc, ws, clock, sockets, events} = session();
    clock.advance(R.STALL_AFTER + 5000);
    const before = sc.received;
    ws.receive({type: 'chat', value: 'late'});
    ws.drop(1006);
    assert.strictEqual(sc.received, before);
    assert.strictEqual(sockets.length, 2);
    assert.deepStrictEqual(events, ['connected']);
});

test('a lost socket is resumed at once', () => {
    const {ws, sockets} = session();
    ws.drop(1006);
    assert.strictEqual(sockets.length, 2);
});

test('the server refusing to resume ends the session', () => {
    const {ws, sockets, events} = session();
    ws.drop(1006);
    sockets[1].open();
    sockets[1].drop(R.CLOSE_NO_RESUME);
    assert.deepStrictEqual(events, ['connected', `close ${R.CLOSE_NO_RESUME}`]);
    assert.strictEqual(sockets.length, 2, 'no further attempt');
});

test('a resume that keeps failing gives up in time', () => {
    const {ws, sockets, clock, events} = session();
    ws.drop(1006);
    // the network refuses outright, then stops answering at all
    sockets[1].drop(1006);
    clock.advance(R.RETRY_DELAY);
    assert.strictEqual(sockets.length, 3, 'tried again');
    clock.advance(R.GIVE_UP_AFTER + R.ATTEMPT_TIMEOUT);
    assert.deepStrictEqual(events, ['connected', 'close 1006']);
    const n = sockets.length;
    clock.advance(60000);
    assert.strictEqual(sockets.length, n, 'and stopped');
});

test('more acknowledged than sent ends the session', () => {
    const {ws, sockets, events} = session();
    ws.drop(1006);
    sockets[1].open();
    sockets[1].receive({type: 'handshake', version: ['2']});
    sockets[1].receive({type: 'sozvon-resumed', value: 99});
    assert.deepStrictEqual(events, ['connected', 'close 1006']);
    assert.strictEqual(sockets[1].closedWith, 1000,
                       'a normal close, so the server ends its side too');
});

test('leaving ends the session, it is not resumed', () => {
    const {sc, ws, sockets, events} = session();
    sc.close();
    assert.strictEqual(ws.closedWith, 1000);
    ws.drop(1000);
    assert.deepStrictEqual(events, ['connected', 'close 1000']);
    assert.strictEqual(sockets.length, 1);
});

test('leaving while resuming ends the session', () => {
    const {sc, ws, sockets, events} = session();
    ws.drop(1006);
    sc.close();
    sockets[1].drop(1006);
    assert.deepStrictEqual(events, ['connected', 'close 1006']);
    assert.strictEqual(sockets.length, 2);
});

test('a close from the server (a kick) is not resumed', () => {
    const {ws, sockets, events} = session();
    ws.drop(1000);
    assert.deepStrictEqual(events, ['connected', 'close 1000']);
    assert.strictEqual(sockets.length, 1);
});

test('without a secret the old rules hold', () => {
    const {sc, ws, sockets, clock, events} = session({secret: false});
    assert.strictEqual(sc.resumeSecret, null);
    clock.advance(R.STALL_AFTER + 5000);
    assert.strictEqual(sockets.length, 1, 'no resume');
    clock.advance(50000);
    assert.deepStrictEqual(events, ['connected', 'close 1006']);
    assert.strictEqual(sockets.length, 1);
    assert.throws(() => sc.send({type: 'chat'}), /not open/);
    ws.drop(1006);
});
