// A signalling stall in the middle of a call: the reproduction of the
// 2026-09-21 production drop, where the websocket path went silent for about a
// minute while the media (on its own path, through the relay) kept flowing.
//
// Between the browser and the server sits a TCP proxy that can freeze: it
// keeps every connection open but stops moving bytes, and holds new
// connections without forwarding them -- a dead path, not a closed one, which
// is what makes the browser wait for timeouts instead of seeing an error.

import {test, expect} from '@playwright/test';
import {chooseDevices} from './lib.js';
import net from 'node:net';

const ROOM = process.env.SOZVON_ROOM || 'smoke';
// The proxy forwards to the server under test.  SOZVON_URL is what the
// pre-push hook and playwright.config.js use to name it; taking only
// SOZVON_PORT here once pointed the proxy at 8443 while the hook's server ran
// on 18443, and both tests failed for want of a server.
const UPSTREAM = Number(process.env.SOZVON_PORT ||
    new URL(process.env.SOZVON_URL || 'http://localhost:8443').port || 8443);
const PROXY_PORT = 18500;
const FREEZE_MS = Number(process.env.FREEZE_MS || 75_000);

function freezeProxy(port = PROXY_PORT) {
    let frozen = false;
    const pairs = new Set();
    const held = [];
    function link(client) {
        const up = net.connect(UPSTREAM, 'localhost');
        const pair = {client, up, dead: false};
        pairs.add(pair);
        const fwd = (from, to) => from.on('data', d => {
            if (pair.dead) return;
            if (frozen) {
                (from._held ||= []).push(d);
                return;
            }
            to.write(d);
        });
        fwd(client, up);
        fwd(up, client);
        // A close is a packet like any other: on a dead path it does not
        // arrive either, until the path comes back.
        const end = () => {
            if (pair.dead) return;
            if (frozen) { deferred.push(end); return; }
            pairs.delete(pair); client.destroy(); up.destroy();
        };
        client.on('close', end); up.on('close', end);
        client.on('error', end); up.on('error', end);
    }
    const deferred = [];
    const server = net.createServer(client => {
        if (frozen) held.push(client);
        else link(client);
    });
    return {
        listen: () => new Promise(r => server.listen(port, 'localhost', r)),
        close: () => new Promise(r => {
            for (const p of pairs) { p.client.destroy(); p.up.destroy(); }
            server.close(r);
        }),
        freeze() { frozen = true; },
        // The connections open now go dead for good (nothing moves, not even
        // a close) while new ones get through: the server keeps the old
        // session until its own timeout.
        blackhole() { for (const p of pairs) p.dead = true; },
        thaw() {
            frozen = false;
            // What was stuck in flight arrives late, as TCP retransmission
            // would deliver it once the path recovers.
            for (const p of pairs) {
                for (const [from, to] of [[p.client, p.up], [p.up, p.client]]) {
                    for (const d of from._held || []) to.write(d);
                    from._held = [];
                }
            }
            for (const f of deferred.splice(0)) f();
            for (const c of held.splice(0)) link(c);
        },
    };
}

test.afterEach(async ({browser}) => {
    for (const c of browser.contexts())
        await c.close();
});

async function join(context, name, room = ROOM, port = PROXY_PORT) {
    const page = await context.newPage();
    page.log = [];
    page.on('console', m => page.log.push(`${Date.now()} ${m.type()} ${m.text()}`));
    page.on('pageerror', e => page.log.push(`${Date.now()} pageerror ${e}`));
    await page.goto(`http://localhost:${port}/group/${room}/`);
    await page.waitForSelector('#username', {state: 'visible'});
    await page.fill('#username', name);
    if (await page.locator('#password').isVisible())
        await page.fill('#password', 'x');
    await chooseDevices(page);
    await page.click('#connectbutton');
    await expect.poll(async () => await page.locator('#peers video').count(),
        {timeout: 30_000}).toBeGreaterThan(0);
    return page;
}

/** What the user sees and what the client is actually doing. */
async function state(page) {
    return await page.evaluate(() => {
        const vis = id => {
            const e = document.getElementById(id);
            return !!e && !e.classList.contains('invisible') &&
                getComputedStyle(e).display !== 'none';
        };
        const sc = typeof serverConnection === "undefined" ? null : serverConnection;
        const up = sc ? Object.values(sc.up) : [];
        return {
            socket: !!(sc && sc.socket),
            inGroup: !!(sc && sc.group),
            perms: sc ? sc.permissions.join(',') : null,
            up: up.map(c => `${c.label}:${c.stream ? c.stream.getTracks().map(t => t.kind + '/' + t.readyState).join('+') : '-'}`),
            down: sc ? Object.keys(sc.down).length : 0,
            tiles: document.querySelectorAll('#peers video').length,
            presentbutton: vis('presentbutton'),
            unpresentbutton: vis('unpresentbutton'),
            banner: vis('reconnect-banner'),
            login: vis('login-container'),
            toasts: Array.from(document.querySelectorAll('.toastify, .toast'))
                .map(t => t.textContent.trim()).filter(Boolean),
        };
    });
}

test('a signalling stall mid-call does not leave the call broken', async ({browser}) => {
    const proxy = freezeProxy();
    await proxy.listen();
    try {
        const ctxA = await browser.newContext();
        const ctxB = await browser.newContext();
        for (const c of [ctxA, ctxB])
            await c.grantPermissions(['camera', 'microphone']);
        const A = await join(ctxA, 'alice');
        const B = await join(ctxB, 'bob');
        await expect.poll(async () => await A.locator('#peers video').count(),
            {timeout: 30_000}).toBe(2);
        console.log('before', JSON.stringify(await state(A)));

        const t0 = Date.now();
        proxy.freeze();
        const trace = [];
        const until = t0 + FREEZE_MS;
        while (Date.now() < until) {
            await new Promise(r => setTimeout(r, 5000));
            trace.push([Math.round((Date.now() - t0) / 1000), await state(A)]);
        }
        proxy.thaw();
        const t1 = Date.now();
        for (let i = 0; i < 12; i++) {
            await new Promise(r => setTimeout(r, 5000));
            trace.push(['+' + Math.round((Date.now() - t1) / 1000), await state(A)]);
        }
        for (const [t, s] of trace)
            console.log(t, JSON.stringify(s));
        console.log('--- alice console');
        for (const l of A.log) console.log(l);

        const end = await state(A);
        expect(end.inGroup, 'alice is back in the group').toBe(true);
        expect(end.up.some(u => u.startsWith('camera:') && u.includes('video/live')),
            'alice publishes her camera again without touching anything').toBe(true);
        expect(end.tiles, 'alice sees herself and bob').toBe(2);
        const endB = await state(B);
        expect(endB.tiles, 'bob sees himself and alice').toBe(2);
    } finally {
        await proxy.close();
    }
});

// The same drop, but the client is back before the server has noticed that its
// previous connection is dead.  In a room that requires encryption the server
// admits two participants, and it still counts the dead session: the rejoin is
// refused as a third participant.  That must be retried, not taken as final.
test('a rejoin refused because the dead session still counts is retried', async ({browser}) => {
    test.setTimeout(300_000);
    const room = 'e2ee-strict';
    const proxy = freezeProxy();
    await proxy.listen();
    try {
        const ctxA = await browser.newContext();
        const ctxB = await browser.newContext();
        for (const c of [ctxA, ctxB])
            await c.grantPermissions(['camera', 'microphone']);
        const A = await join(ctxA, 'alice', room);
        // Bob talks to the server directly: only Alice's path goes dead.
        const B = await join(ctxB, 'bob', room, UPSTREAM);
        await expect.poll(async () => await A.locator('#peers video').count(),
            {timeout: 30_000}).toBe(2);

        // Alice's current connections go dead for good -- the server keeps
        // them until its own timeout -- while new ones get through, and Alice
        // is made to notice at once rather than after 50 s.
        proxy.blackhole();
        await A.evaluate(() => {
            serverConnection.lastServerMessage = Date.now() - 60_000;
        });

        const t0 = Date.now();
        const seen = [];
        let s;
        let dropped = false;
        do {
            await new Promise(r => setTimeout(r, 3000));
            s = await state(A);
            seen.push(`${Math.round((Date.now() - t0) / 1000)} ${JSON.stringify(s)}`);
            if (!s.inGroup) dropped = true;
        } while (!(dropped && s.inGroup && s.up.length && s.tiles === 2) &&
                 Date.now() - t0 < 150_000);
        for (const l of seen) console.log(l);
        console.log('--- alice console');
        for (const l of A.log) if (/Timeout|close|fail|Rejoin|two participants/i.test(l)) console.log(l);

        expect(A.log.some(l => /Rejoin refused, will retry:.*two participants/.test(l)),
            'the scenario did hit the refusal').toBe(true);
        expect(s.login, 'alice was not sent back to the login screen').toBe(false);
        expect(s.inGroup, 'alice is back in the group').toBe(true);
        expect(s.up.some(u => u.startsWith('camera:') && u.includes('video/live')),
            'alice publishes her camera again').toBe(true);
        expect(s.tiles, 'alice sees herself and bob').toBe(2);
    } finally {
        await proxy.close();
    }
});
