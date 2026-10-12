// UDP given up on one network is tried again on another.  (Sozvon,
// leyvanah/sozvon-tasks#61)
//
// On 2026-10-12 a participant under a VPN lost too many UDP packets, and the
// client rightly moved the call to the relay over TCP/TLS.  The decision was
// remembered for six hours, for the browser rather than the network: after
// the VPN was turned off the call stayed on the TCP relay for an hour, on a
// network where UDP worked.  Now the server tags the network a client comes
// from (a salted hash of its address prefix), and the decision is kept for
// that network only.
//
// Needs a server that allows direct paths, offers a relay over TCP, and
// believes X-Forwarded-For from localhost:
//
//   sozvon -turn <lan-ip>:1194 -trusted-proxy 127.0.0.1 ...
//
// and is skipped otherwise.  Alice talks to the server through a proxy that
// says which address she comes from; changing it, and dropping her
// websocket, is her moving to another network.  Her media goes straight to
// the server, as before.

import {test, expect} from '@playwright/test';
import net from 'node:net';
import {chooseDevices} from './lib.js';

const ROOM = process.env.SOZVON_ROOM || 'smoke';
const UPSTREAM = Number(process.env.SOZVON_PORT ||
    new URL(process.env.SOZVON_URL || 'http://localhost:8443').port || 8443);
const PROXY_PORT = 18521;
const VPN = '198.51.100.7';
const HOME = '203.0.113.7';

/**
 * A TCP proxy to the server that adds X-Forwarded-For to every request it
 * carries.  drop() closes every open connection.
 */
function proxy() {
    let from = VPN;
    const pairs = new Set();
    const server = net.createServer(client => {
        const up = net.connect(UPSTREAM, 'localhost');
        const pair = {client, up};
        pairs.add(pair);
        client.on('data', d => {
            const s = d.toString('latin1').replace(/ HTTP\/1\.1\r\n/g,
                ` HTTP/1.1\r\nX-Forwarded-For: ${from}\r\n`);
            up.write(Buffer.from(s, 'latin1'));
        });
        up.on('data', d => client.write(d));
        const end = () => {
            pairs.delete(pair);
            client.destroy(); up.destroy();
        };
        for (const s of [client, up]) {
            s.on('close', end);
            s.on('error', end);
        }
    });
    return {
        listen: () => new Promise(r => server.listen(PROXY_PORT, 'localhost', r)),
        close: () => new Promise(r => {
            for (const p of pairs) { p.client.destroy(); p.up.destroy(); }
            server.close(r);
        }),
        set(address) { from = address; },
        drop() {
            for (const p of [...pairs]) { p.client.destroy(); p.up.destroy(); }
        },
    };
}

test.afterEach(async ({browser}) => {
    for (const c of browser.contexts())
        await c.close();
});

async function join(context, name, port) {
    const page = await context.newPage();
    page.errors = [];
    page.on('pageerror', e => page.errors.push(String(e)));
    // Loss injected where the client reads it, as in udp-fallback.spec.js:
    // a real network that throttles UDP cannot be staged here.
    await page.addInitScript(() => {
        window.__loss = 0;
        const orig = RTCPeerConnection.prototype.getStats;
        RTCPeerConnection.prototype.getStats = async function(...args) {
            const report = await orig.apply(this, args);
            if (args.length || !window.__loss)
                return report;
            this.__lost = this.__lost || {};
            const out = new Map();
            for (const [k, r] of report) {
                if (r.type === 'inbound-rtp') {
                    const e = this.__lost[k] ||
                        (this.__lost[k] = {base: r.packetsReceived, extra: 0});
                    e.extra = Math.round((r.packetsReceived - e.base) *
                                         window.__loss / (1 - window.__loss));
                    out.set(k, {...r, packetsLost: (r.packetsLost || 0) + e.extra});
                } else if (r.type === 'remote-inbound-rtp') {
                    out.set(k, {...r, fractionLost: window.__loss});
                } else {
                    out.set(k, r);
                }
            }
            return out;
        };
    });
    await page.goto(`http://localhost:${port}/group/${ROOM}/`);
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

const paths = page => page.evaluate(() => {
    const all = [...Object.values(serverConnection.up),
                 ...Object.values(serverConnection.down)];
    return all.map(c => c.userdata.turnPath || null).sort();
});

const isDirectUdp = p => /^(host|srflx|prflx)\/udp$/.test(p);

const received = page => page.evaluate(async () => {
    let n = 0;
    for (const id in serverConnection.down) {
        const stats = await serverConnection.down[id].pc.getStats();
        stats.forEach(s => {
            if (s.type === 'inbound-rtp' && s.kind === 'video')
                n += s.bytesReceived || 0;
        });
    }
    return n;
});

async function growing(page) {
    const before = await received(page);
    await expect.poll(() => received(page), {timeout: 20_000})
        .toBeGreaterThan(before + 20000);
}

test('UDP given up on one network is tried again on another',
     async ({browser}) => {
    const p = proxy();
    await p.listen();
    try {
        const ctxA = await browser.newContext();
        const ctxB = await browser.newContext();
        for (const c of [ctxA, ctxB])
            await c.grantPermissions(['camera', 'microphone']);

        const A = await join(ctxA, 'alice', PROXY_PORT);
        const B = await join(ctxB, 'bob', UPSTREAM);
        await expect.poll(async () => await A.locator('#peers video').count(),
                          {timeout: 30_000}).toBe(2);

        const conf = await A.evaluate(() => ({
            direct: serverConnection.rtcConfiguration.iceTransportPolicy !== 'relay',
            relay: SozvonTurnFallback.canDropUdp(serverConnection.rtcConfiguration),
        }));
        test.skip(!conf.direct || !conf.relay, 'needs direct paths and a ' +
                  'relay over TCP: run the server with -turn <lan-ip>:1194');
        const vpn = await A.evaluate(() => serverConnection.network);
        const bobs = await B.evaluate(() => serverConnection.network);
        expect(vpn, 'the server tags the network').toMatch(/^[0-9a-f]{16}$/);
        test.skip(vpn === bobs, 'the server does not believe the proxy: ' +
                  'run it with -trusted-proxy 127.0.0.1');

        await expect.poll(async () => (await paths(A)).every(isDirectUdp),
                          {timeout: 20_000}).toBe(true);

        // Under the "VPN", UDP loses too much: Alice gives it up.
        await A.evaluate(() => { window.__loss = 0.3; });
        await expect.poll(() => paths(A), {timeout: 40_000})
            .toEqual(['relay/tcp', 'relay/tcp']);
        await A.evaluate(() => { window.__loss = 0; });
        const stored = await A.evaluate(k => localStorage.getItem(k),
            await A.evaluate(() => SozvonTurnFallback.STORAGE_KEY));
        expect(Object.keys(JSON.parse(stored)), 'remembered for that network')
            .toEqual([vpn]);
        const id = await A.evaluate(() => serverConnection.id);

        // The VPN goes off: another address, and the websocket with it.
        p.set(HOME);
        p.drop();
        await expect.poll(() => A.evaluate(() => serverConnection.network),
                          {timeout: 30_000}).not.toBe(vpn);
        await expect.poll(async () => (await paths(A)).every(isDirectUdp),
                          {timeout: 40_000}).toBe(true);
        expect(await A.evaluate(() => serverConnection.id),
               'the same session').toBe(id);
        await growing(A);
        await growing(B);

        // Back under the VPN, a new call starts on the relay at once ...
        await A.close();
        p.set(VPN);
        const A2 = await join(ctxA, 'alice2', PROXY_PORT);
        expect(await A2.evaluate(() => serverConnection.network)).toBe(vpn);
        await expect.poll(() => paths(A2), {timeout: 20_000})
            .toEqual(['relay/tcp', 'relay/tcp']);
        await growing(A2);
        // ... and at home, on UDP.
        await A2.close();
        p.set(HOME);
        const A3 = await join(ctxA, 'alice3', PROXY_PORT);
        await expect.poll(async () => (await paths(A3)).every(isDirectUdp),
                          {timeout: 20_000}).toBe(true);
        await growing(A3);

        for (const page of [B, A3])
            expect(page.errors).toEqual([]);
    } finally {
        await p.close();
    }
});
