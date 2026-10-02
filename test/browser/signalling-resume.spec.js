// Signalling resume (leyvanah/sozvon-tasks#56).  Local only, like the rest of
// this directory -- see README.md.
//
// The reproduction of the 2026-10-02 production drop: a participant's
// websocket went silent for 45 s while their media kept flowing, and the
// server removed them from the call.  Alice talks to the server through a TCP
// proxy that can freeze; Bob talks to it directly, so he sees what the server
// does with Alice.  Her media goes straight to the server, past the proxy.
//
// 1. Freezing Alice's signalling for 60 s -- past both the server's old 45 s
//    and the client's old 50 s -- must not take her out of the call: Bob never
//    loses her, nothing is renegotiated, and the chat sent either way during
//    the freeze arrives once it thaws.
// 2. A participant who is really gone -- her page closed while her path is
//    dead, so the server hears nothing at all -- must vanish for Bob within
//    40 s (it was 45 to 55), not linger as a phantom.
// 3. One who leaves normally vanishes at once, as before.

import {test, expect} from '@playwright/test';
import net from 'node:net';

const ROOM = process.env.SOZVON_ROOM || 'smoke';
const UPSTREAM = Number(process.env.SOZVON_PORT ||
    new URL(process.env.SOZVON_URL || 'http://localhost:8443').port || 8443);
const PROXY_PORT = 18501;

/**
 * A TCP proxy to the server.  freeze() stops moving bytes on every
 * connection and holds new ones; thaw() delivers what was held, as TCP
 * would once the path recovers.  blackhole() kills the open connections
 * for good -- not even a close gets through -- while new ones pass.
 */
function proxy(port = PROXY_PORT) {
    let frozen = false;
    const pairs = new Set();
    const held = [];
    const deferred = [];
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
        const end = () => {
            if (pair.dead) return;
            if (frozen) { deferred.push(end); return; }
            pairs.delete(pair); client.destroy(); up.destroy();
        };
        client.on('close', end); up.on('close', end);
        client.on('error', end); up.on('error', end);
    }
    const server = net.createServer(client => {
        if (frozen) held.push(client);
        else link(client);
    });
    return {
        listen: () => new Promise(r => server.listen(port, 'localhost', r)),
        close: () => new Promise(r => {
            for (const p of pairs) { p.client.destroy(); p.up.destroy(); }
            for (const c of held) c.destroy();
            server.close(r);
        }),
        freeze() { frozen = true; },
        blackhole() { for (const p of pairs) p.dead = true; },
        thaw() {
            frozen = false;
            for (const p of pairs) {
                for (const [from, to] of [[p.client, p.up], [p.up, p.client]]) {
                    for (const d of from._held || []) to.write(d);
                    from._held = [];
                }
            }
            for (const f of deferred.splice(0)) f();
            for (const c of held.splice(0)) {
                if (!c.destroyed) link(c);
            }
        },
    };
}

test.afterEach(async ({browser}) => {
    for (const c of browser.contexts())
        await c.close();
});

async function join(browser, name, port) {
    const context = await browser.newContext();
    await context.grantPermissions(['camera', 'microphone']);
    const page = await context.newPage();
    page.log = [];
    page.on('console', m => page.log.push(`${Date.now()} ${m.type()} ${m.text()}`));
    page.on('pageerror', e => page.log.push(`${Date.now()} pageerror ${e}`));
    await page.goto(`http://localhost:${port}/group/${ROOM}/`);
    await page.waitForSelector('#username', {state: 'visible'});
    await page.fill('#username', name);
    if (await page.locator('#password').isVisible())
        await page.fill('#password', 'x');
    await page.click('#precheck-cam');
    await page.click('#precheck-mic');
    await page.waitForFunction(() => {
        const v = document.getElementById('precheck-video');
        return v && v.videoWidth > 0;
    }, null, {timeout: 20_000});
    await page.click('#connectbutton');
    await expect.poll(async () => await page.locator('#peers video').count(),
        {timeout: 30_000}).toBeGreaterThan(0);
    return page;
}

/** Alice through the proxy, Bob direct, each seeing the other. */
async function call(browser) {
    const A = await join(browser, 'alice', PROXY_PORT);
    const B = await join(browser, 'bob', UPSTREAM);
    for (const p of [A, B])
        await expect.poll(async () => await p.locator('#peers video').count(),
            {timeout: 30_000}).toBe(2);
    const alice = await A.evaluate(() => serverConnection.id);
    expect(await A.evaluate(() => !!serverConnection.resumeSecret),
        'the server made alice resumable').toBe(true);
    return {A, B, alice};
}

/** What Bob knows of Alice. */
async function bobSees(B, alice) {
    return await B.evaluate(id => {
        const sc = serverConnection;
        return {
            present: !!(sc && sc.users[id]),
            down: sc ? Object.values(sc.down)
                .filter(c => c.source === id).map(c => c.id) : [],
        };
    }, alice);
}

async function aliceState(A) {
    return await A.evaluate(() => {
        const sc = serverConnection;
        const banner = document.getElementById('reconnect-banner');
        return {
            id: sc && sc.id,
            inGroup: !!(sc && sc.group),
            resuming: !!(sc && sc.resuming),
            up: sc ? Object.keys(sc.up) : [],
            banner: !!banner && !banner.classList.contains('invisible') &&
                getComputedStyle(banner).display !== 'none',
        };
    });
}

test('a signalling stall with live media drops no one', async ({browser}) => {
    test.setTimeout(240_000);
    const p = proxy();
    await p.listen();
    try {
        const {A, B, alice} = await call(browser);
        const before = await bobSees(B, alice);
        const aBefore = await aliceState(A);
        expect(before.present).toBe(true);
        expect(before.down.length).toBeGreaterThan(0);

        p.freeze();
        const t0 = Date.now();
        await A.evaluate(() => serverConnection.chat('', '', 'from alice, frozen'));
        await B.evaluate(() => serverConnection.chat('', '', 'from bob, meanwhile'));
        const trace = [];
        while (Date.now() - t0 < 60_000) {
            await new Promise(r => setTimeout(r, 3000));
            trace.push([Math.round((Date.now() - t0) / 1000),
                await aliceState(A), await bobSees(B, alice)]);
        }
        p.thaw();
        await expect.poll(async () => (await aliceState(A)).resuming,
            {timeout: 30_000}).toBe(false);
        for (const [t, a, b] of trace)
            console.log(t, JSON.stringify(a), JSON.stringify(b));
        for (const l of A.log)
            if (/resum|Signalling|close|Timeout/i.test(l)) console.log(l);

        expect(trace.some(([, a]) => a.resuming),
            'alice did give up on her socket').toBe(true);
        for (const [t, a, b] of trace) {
            expect(a.inGroup, `alice in the group at ${t}s`).toBe(true);
            expect(a.banner, `no reconnect banner at ${t}s`).toBe(false);
            expect(b.present, `bob still sees alice at ${t}s`).toBe(true);
        }
        expect(A.log.some(l => /Session resumed/.test(l)),
            'alice resumed her session').toBe(true);

        const a = await aliceState(A);
        expect(a.id, 'the same session').toBe(aBefore.id);
        expect(a.up, 'nothing republished').toEqual(aBefore.up);
        expect((await bobSees(B, alice)).down, 'nothing renegotiated')
            .toEqual(before.down);

        // what was said during the freeze arrives, once
        await expect.poll(async () => await B.locator('#box').textContent(),
            {timeout: 10_000}).toContain('from alice, frozen');
        await expect.poll(async () => await A.locator('#box').textContent(),
            {timeout: 10_000}).toContain('from bob, meanwhile');
        const count = async (P, s) => (await P.locator('#box').textContent())
            .split(s).length - 1;
        expect(await count(B, 'from alice, frozen')).toBe(1);
        expect(await count(A, 'from bob, meanwhile')).toBe(1);

        // and the call goes on
        await A.evaluate(() => serverConnection.chat('', '', 'after'));
        await expect.poll(async () => await B.locator('#box').textContent(),
            {timeout: 10_000}).toContain('after');
        expect(A.log.filter(l => /pageerror/.test(l))).toEqual([]);
    } finally {
        await p.close();
    }
});

test('a participant who is really gone does not linger', async ({browser}) => {
    test.setTimeout(120_000);
    const p = proxy();
    await p.listen();
    try {
        const {A, B, alice} = await call(browser);
        // Her path dies, then so does her page: the server hears nothing
        // more, neither a close nor a resume, and her media stops.
        p.blackhole();
        const t0 = Date.now();
        await A.close({runBeforeUnload: false});
        await expect.poll(async () => (await bobSees(B, alice)).present,
            {timeout: 40_000, intervals: [1000]}).toBe(false);
        console.log(`alice gone for bob after ${Math.round((Date.now() - t0) / 1000)}s`);
        await expect.poll(async () => await B.locator('#peers video').count(),
            {timeout: 10_000}).toBe(1);
    } finally {
        await p.close();
    }
});

test('leaving is seen at once', async ({browser}) => {
    const p = proxy();
    await p.listen();
    try {
        const {A, B, alice} = await call(browser);
        const t0 = Date.now();
        await A.close();
        await expect.poll(async () => (await bobSees(B, alice)).present,
            {timeout: 5_000, intervals: [250]}).toBe(false);
        console.log(`alice gone for bob after ${Date.now() - t0}ms`);
    } finally {
        await p.close();
    }
});
