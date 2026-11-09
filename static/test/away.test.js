// Tests for a phone call put in the background.  (Sozvon)
//
// Run with:  node --test static/test/
//
// The case behind it (2026-10-23): a guest on a phone left the call in the
// background.  Her camera and microphone had been paused by the system, the
// others saw her last picture and heard nothing, and two minutes later the
// server ended her session; nobody had been told any of it.

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const a = require('../away.js');

test('only a phone or a tablet marks itself', () => {
    assert.strictEqual(a.pausesWhenHidden({touchPoints: 5, coarse: true}), true);
    // a laptop with a touch screen still has a mouse
    assert.strictEqual(a.pausesWhenHidden({touchPoints: 10, coarse: false}), false);
    assert.strictEqual(a.pausesWhenHidden({touchPoints: 0, coarse: false}), false);
    assert.strictEqual(a.pausesWhenHidden({touchPoints: 0, coarse: true}), false);
    assert.strictEqual(a.pausesWhenHidden(null), false);
});

test('a drop while hidden is explained on the way back', () => {
    const t = new a.Tracker();
    t.hidden(0);
    t.lost(70_000);
    t.shown(150_000);
    assert.strictEqual(t.back(), true);
    // and only once
    assert.strictEqual(t.back(), false);
});

test('a dead socket found just after coming back counts too', () => {
    // a hidden page does not see its socket close; it finds it dead on waking
    const t = new a.Tracker();
    t.hidden(0);
    t.shown(150_000);
    t.lost(150_000 + a.RETURN_GRACE - 1);
    assert.strictEqual(t.back(), true);
});

test('hiding during a reconnect counts', () => {
    const t = new a.Tracker();
    t.lost(0);
    t.hidden(1_000);
    t.shown(5_000);
    assert.strictEqual(t.back(), true);
});

test('an ordinary drop in front of the user is not blamed on the background', () => {
    const t = new a.Tracker();
    t.hidden(0);
    t.shown(10_000);
    t.lost(10_000 + a.RETURN_GRACE);
    assert.strictEqual(t.back(), false);

    const fresh = new a.Tracker();
    fresh.lost(0);
    assert.strictEqual(fresh.back(), false);
});

test('one outage is judged by how it began', () => {
    // retries of the same reconnect cycle do not move its start
    const t = new a.Tracker();
    t.lost(0);
    t.hidden(60_000);
    t.shown(61_000);
    t.lost(61_000 + 2 * a.RETURN_GRACE);
    assert.strictEqual(t.back(), true);
    // the next outage starts clean
    t.lost(500_000);
    assert.strictEqual(t.back(), false);
});

// publishAwayState() lives in galene.js, which wants a browser: lift it out
// of the source, as e2ee-policy.test.js does, and run it against a fake
// connection whose copy of our own data comes back only when told to.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function lift(name) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'galene.js'), 'utf8');
    const start = src.indexOf('function ' + name + '(');
    if(start < 0)
        return '';
    const end = src.indexOf('\n}\n', start);
    assert.ok(end > start, `${name}() does not end at column 0`);
    return src.slice(start, end + 3);
}

function phone() {
    const sent = [];
    const echoes = [];
    const me = {data: {}};
    const ctx = vm.createContext({
        console: {warn() {}},
        awayApi: () => a,
        pausesWhenHidden: () => true,
        serverConnection: {
            id: 'me',
            users: {me},
            userAction(kind, dest, value) {
                assert.strictEqual(kind, 'setdata');
                sent.push(value.away);
                echoes.push(value.away);
            },
        },
    });
    vm.runInContext('var awayAnnouncer = null;\n' +
                    lift('getAwayAnnouncer') + lift('publishAwayState'), ctx);
    return {
        ctx, sent,
        // the server's copy of our data arrives
        echo() {
            while(echoes.length)
                me.data.away = echoes.shift() || undefined;
        },
    };
}

test('back in front before our own data came back, the room is told', () => {
    // A page in the background gets the server's copy of its own data only
    // once it is in front again.  Judged by that copy, coming back looked
    // like nothing to say, and the late copy then left the room seeing
    // someone in another app who was in the call -- every other time.
    const p = phone();
    p.ctx.publishAwayState(true);       // to the background
    p.ctx.publishAwayState(false);      // back, before the copy came
    p.echo();
    p.ctx.publishAwayState(true);
    p.ctx.publishAwayState(false);
    p.echo();
    assert.deepStrictEqual(p.sent, [true, null, true, null]);
});

test('each change is said once', () => {
    const p = phone();
    p.ctx.publishAwayState(false);      // joined in front: nothing to say
    p.ctx.publishAwayState(true);
    p.echo();
    p.ctx.publishAwayState(true);       // hidden again, without showing
    p.ctx.publishAwayState(false);
    p.ctx.publishAwayState(false);
    assert.deepStrictEqual(p.sent, [true, null]);
});

test('a new session starts from not in the background', () => {
    // per-user data does not survive a join
    const p = phone();
    p.ctx.publishAwayState(true);
    p.ctx.serverConnection.id = 'again';
    p.ctx.publishAwayState(true);       // rejoined while hidden
    p.ctx.publishAwayState(false);
    assert.deepStrictEqual(p.sent, [true, true, null]);
});
