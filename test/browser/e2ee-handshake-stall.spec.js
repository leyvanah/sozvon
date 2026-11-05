// An E2EE handshake across a signalling stall.
//
// Signalling resume keeps a participant in the call through a stall of up to
// two minutes and delivers what was held once it ends.  The handshake that
// authenticates end-to-end encryption runs over that same signalling, and
// gives up after HANDSHAKE_TIMEOUT (30 s) in e2ee.js.  So: Alice is in an
// encrypted room behind a TCP proxy, her signalling freezes, Bob joins.  His
// handshake with her cannot get through until the stall ends.  Once it does,
// the two must end up in an encrypted call, as they would have before the
// timeout existed -- not both stuck in "failed" until somebody rejoins.

import {test, expect} from '@playwright/test';
import net from 'node:net';

const ROOM = 'e2ee-strict';
const UPSTREAM = Number(process.env.SOZVON_PORT ||
    new URL(process.env.SOZVON_URL || 'http://localhost:8443').port || 8443);
const PROXY_PORT = 18502;
const STALL = Number(process.env.STALL_MS || 40_000);

/** A TCP proxy to the server that can freeze, as in signalling-resume.spec.js. */
function proxy(port = PROXY_PORT) {
    let frozen = false;
    const pairs = new Set();
    const held = [];
    function link(client) {
        const up = net.connect(UPSTREAM, 'localhost');
        const pair = {client, up};
        pairs.add(pair);
        const fwd = (from, to) => from.on('data', d => {
            if (frozen) {
                (from._held ||= []).push(d);
                return;
            }
            to.write(d);
        });
        fwd(client, up);
        fwd(up, client);
        const end = () => { pairs.delete(pair); client.destroy(); up.destroy(); };
        client.on('close', end); up.on('close', end);
        client.on('error', end); up.on('error', end);
    }
    const server = net.createServer(c => frozen ? held.push(c) : link(c));
    return {
        listen: () => new Promise(r => server.listen(port, 'localhost', r)),
        close: () => new Promise(r => {
            for (const p of pairs) { p.client.destroy(); p.up.destroy(); }
            for (const c of held) c.destroy();
            server.close(r);
        }),
        freeze() { frozen = true; },
        thaw() {
            frozen = false;
            for (const p of pairs)
                for (const [from, to] of [[p.client, p.up], [p.up, p.client]]) {
                    for (const d of from._held || []) to.write(d);
                    from._held = [];
                }
            for (const c of held.splice(0))
                if (!c.destroyed) link(c);
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
    await page.waitForFunction(() => typeof serverConnection !== 'undefined' &&
        serverConnection && serverConnection.group && serverConnection.e2ee, null,
        {timeout: 30_000});
    return page;
}

async function emptyRoom(request) {
    await expect.poll(async () => {
        const groups = await (await request.get('/public-groups.json')).json();
        const g = groups.find(g => g.name === ROOM);
        return g ? g.clientCount : 0;
    }, {timeout: 150_000, intervals: [2000],
        message: `room "${ROOM}" never emptied`}).toBe(0);
}

const e2ee = P => P.evaluate(() => {
    const e = serverConnection && serverConnection.e2ee;
    return e ? `${e.state}${e.detail ? '/' + e.detail : ''}` : 'none';
});

test('an encrypted call is set up again across a signalling stall', async ({browser}) => {
    test.setTimeout(STALL + 180_000);
    const ctx = await browser.newContext({
        baseURL: `http://localhost:${UPSTREAM}`});
    await emptyRoom(ctx.request);
    await ctx.close();

    const p = proxy();
    await p.listen();
    try {
        // An encrypted call, alice behind the proxy.  Her media flows on
        // its own path, so the server keeps her through a stall.
        const A = await join(browser, 'alice', PROXY_PORT);
        expect(await A.evaluate(() => !!serverConnection.resumeSecret),
            'the server made alice resumable').toBe(true);
        let B = await join(browser, 'bob', UPSTREAM);
        await expect.poll(async () => [await e2ee(A), await e2ee(B)],
            {timeout: 30_000}).toEqual(['established', 'established']);
        const alice = await A.evaluate(() => serverConnection.id);

        // Her signalling stalls, and bob comes back as a new session --
        // a reload, or a reconnect on his side.  His handshake with her
        // cannot get through until the stall ends.
        p.freeze();
        const t0 = Date.now();
        await B.context().close();
        B = await join(browser, 'bob', UPSTREAM);
        const trace = [];
        const sample = async () => trace.push(
            `${Math.round((Date.now() - t0) / 1000)}s ` +
            `alice=${await e2ee(A)} bob=${await e2ee(B)} ` +
            `bob sees alice=${await B.evaluate(
                id => !!serverConnection.users[id], alice)}`);
        while (Date.now() - t0 < STALL) {
            await sample();
            await new Promise(r => setTimeout(r, 5000));
        }
        p.thaw();
        try {
            await expect.poll(async () => [await e2ee(A), await e2ee(B)],
                {timeout: 60_000, intervals: [2000]})
                .toEqual(['established', 'established']);
        } finally {
            await sample();
            console.log(trace.join('\n'));
        }
        // the same session it was before: she was never dropped
        expect(await A.evaluate(() => serverConnection.id)).toBe(alice);
        // the same emoji on both sides: one session, not two
        const sas = P => P.evaluate(() => JSON.stringify(serverConnection.e2ee.sas));
        expect(await sas(A)).toBe(await sas(B));
        expect(A.log.filter(l => /pageerror/.test(l))).toEqual([]);
        expect(B.log.filter(l => /pageerror/.test(l))).toEqual([]);
    } finally {
        await p.close();
    }
});
