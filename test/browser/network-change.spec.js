// A network change under the TCP relay: media comes back without a reload.
// (Sozvon, leyvanah/sozvon-tasks#60)
//
// The reproduction of a production call on 2026-10-12.  A participant talked
// through the relay over TCP/TLS, and turned a VPN off.  The socket to the
// relay belonged to the VPN's interface and went with it: nothing was closed,
// packets simply stopped.  Signalling came back by itself two seconds later,
// over a new websocket, but the media did not -- ICE sat in "disconnected",
// and was restarted only once Chrome declared it "failed", 20 seconds later
// for one connection and never (within 22 s) for the other.  The participant
// reloaded the page.
//
// Needs a server that forces relaying and has a TURN relay over TCP, e.g. the
// built-in one on the machine's own address:
//
//   sozvon -relay-only -turn <lan-ip>:1194 ...
//
// and is skipped otherwise.  Alice reaches both the server and the relay
// through TCP proxies, and only over TCP, as the participant did; Bob goes
// direct.  The "network change" kills Alice's websocket outright and makes
// her relay connections go silent for good, while new connections pass --
// the new network.  Her media must flow both ways again within seconds,
// in the same session.

import {test, expect} from '@playwright/test';
import net from 'node:net';
import {chooseDevices} from './lib.js';

const ROOM = process.env.SOZVON_ROOM || 'smoke';
const UPSTREAM = Number(process.env.SOZVON_PORT ||
    new URL(process.env.SOZVON_URL || 'http://localhost:8443').port || 8443);
const SIGNAL_PORT = 18511;
const RELAY_PORT = 18512;
// What the call is allowed to take to come back.  Before the fix it took
// Chrome's own "failed" verdict plus a restart: 20-30 s.
const RECOVERY = 12_000;

/**
 * A TCP proxy.  drop() closes every open connection; blackhole() makes them
 * silent for good without closing them.  New connections pass either way.
 * freeze() holds everything -- bytes, closes and new connections -- and
 * thaw() lets it all through, as a path that stalls and recovers does.
 */
function proxy(listenHost, listenPort, host, port) {
    const pairs = new Set();
    let frozen = false;
    const held = [];        // connections made while frozen
    const deferred = [];    // closes and bytes held while frozen
    function link(client) {
        const up = net.connect(port, host);
        const pair = {client, up, dead: false};
        pairs.add(pair);
        const fwd = (from, to) => from.on('data', d => {
            if (pair.dead) return;
            if (frozen) { deferred.push(() => to.write(d)); return; }
            to.write(d);
        });
        fwd(client, up);
        fwd(up, client);
        const end = () => {
            if (frozen && !pair.dead) { deferred.push(end); return; }
            pairs.delete(pair);
            if (pair.dead) return;
            client.destroy(); up.destroy();
        };
        for (const s of [client, up]) {
            s.on('close', end);
            s.on('error', end);
        }
    }
    const server = net.createServer(client => {
        if (frozen) held.push(client);
        else link(client);
    });
    return {
        listen: () => new Promise((r, j) => {
            server.once('error', j);
            server.listen(listenPort, listenHost, r);
        }),
        close: () => new Promise(r => {
            for (const p of pairs) { p.client.destroy(); p.up.destroy(); }
            server.close(r);
        }),
        count: () => pairs.size,
        drop() {
            for (const p of [...pairs]) { p.client.destroy(); p.up.destroy(); }
        },
        blackhole() {
            for (const p of pairs) p.dead = true;
        },
        freeze() { frozen = true; },
        thaw() {
            frozen = false;
            for (const f of deferred.splice(0)) f();
            for (const c of held.splice(0))
                if (!c.destroyed) link(c);
        },
    };
}

test.afterEach(async ({browser}) => {
    for (const c of browser.contexts())
        await c.close();
});

async function join(browser, name, port, relay) {
    const context = await browser.newContext();
    await context.grantPermissions(['camera', 'microphone']);
    const page = await context.newPage();
    page.log = [];
    page.on('console', m => page.log.push(`${Date.now()} ${m.type()} ${m.text()}`));
    page.on('pageerror', e => page.log.push(`${Date.now()} pageerror ${e}`));
    if (relay) {
        // Only the relay over TCP, and through the proxy.
        await page.addInitScript(({port}) => {
            const rewrite = conf => {
                if (!conf || !conf.iceServers)
                    return conf;
                const servers = [];
                for (const s of conf.iceServers) {
                    const urls = (Array.isArray(s.urls) ? s.urls : [s.urls])
                        .filter(u => /^turn:/i.test(u) && /transport=tcp/i.test(u))
                        .map(u => u.replace(/:(\d+)\?/, `:${port}?`));
                    if (urls.length)
                        servers.push({...s, urls});
                }
                return {...conf, iceServers: servers};
            };
            const Orig = window.RTCPeerConnection;
            window.RTCPeerConnection = function(conf, ...rest) {
                return new Orig(rewrite(conf), ...rest);
            };
            window.RTCPeerConnection.prototype = Orig.prototype;
            const set = Orig.prototype.setConfiguration;
            Orig.prototype.setConfiguration = function(conf) {
                return set.call(this, rewrite(conf));
            };
        }, {port: relay});
    }
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

/** Video bytes received over every down connection. */
const received = page => page.evaluate(async () => {
    let n = 0;
    for (const id in serverConnection.down) {
        const pc = serverConnection.down[id].pc;
        if (!pc) continue;
        const stats = await pc.getStats();
        stats.forEach(s => {
            if (s.type === 'inbound-rtp' && s.kind === 'video')
                n += s.bytesReceived || 0;
        });
    }
    return n;
});

/** Resolves once video arrives at a page again, with when it did. */
async function flowing(page, timeout) {
    const before = await received(page);
    await expect.poll(() => received(page), {timeout, intervals: [500]})
        .toBeGreaterThan(before + 20000);
    return Date.now();
}

const states = page => page.evaluate(() => [
    ...Object.values(serverConnection.up),
    ...Object.values(serverConnection.down),
].map(c => `${c.up ? 'up' : 'down'}:${c.pc ? c.pc.iceConnectionState : '-'}`));

test('network change: media comes back without a reload', async ({browser}) => {
    test.setTimeout(180_000);

    // Bob goes first, direct, and his configuration says where the relay is.
    const B = await join(browser, 'bob', UPSTREAM, null);
    const conf = await B.evaluate(() => serverConnection.rtcConfiguration);
    test.skip(!conf || conf.iceTransportPolicy !== 'relay',
              'the server does not force relaying: run it with -relay-only');
    const tcp = (conf.iceServers || [])
        .flatMap(s => Array.isArray(s.urls) ? s.urls : [s.urls])
        .find(u => /^turn:/i.test(u) && /transport=tcp/i.test(u));
    test.skip(!tcp, 'the server offers no TURN relay over TCP: run it with ' +
              '-relay-only -turn <lan-ip>:1194');
    const m = /^turn:([^:?]+):(\d+)/i.exec(tcp);
    const relayHost = m[1], relayPort = Number(m[2]);

    const signal = proxy('localhost', SIGNAL_PORT, 'localhost', UPSTREAM);
    const relay = proxy(relayHost, RELAY_PORT, relayHost, relayPort);
    await signal.listen();
    await relay.listen();
    try {
        const A = await join(browser, 'alice', SIGNAL_PORT, RELAY_PORT);
        for (const p of [A, B])
            await expect.poll(async () => await p.locator('#peers video').count(),
                {timeout: 30_000}).toBe(2);
        await flowing(A, 30_000);
        await flowing(B, 30_000);
        expect(relay.count(), 'alice reaches the relay through the proxy')
            .toBeGreaterThan(0);
        const id = await A.evaluate(() => serverConnection.id);

        // The network changes.
        const t0 = Date.now();
        relay.blackhole();
        signal.drop();

        const [ta, tb] = await Promise.all([
            flowing(A, 60_000), flowing(B, 60_000)]);
        const took = Math.max(ta, tb) - t0;
        console.log(`media back after ${took} ms; alice: ` +
                    (await states(A)).join(' '));
        expect(await A.evaluate(() => serverConnection.id),
               'the same session, no reload').toBe(id);
        expect(took, 'media back within seconds, not after ' +
               'Chrome gives the path up').toBeLessThan(RECOVERY);
    } catch (e) {
        for (const p of browser.contexts().flatMap(c => c.pages()))
            if (p.log) console.log(p.log.slice(-40).join('\n'));
        throw e;
    } finally {
        await signal.close();
        await relay.close();
    }
});

// The call of 2026-10-13 (sozvon-tasks#66).  A participant's signalling went
// quiet; twenty seconds later the media went too; the client got through to
// resume eight seconds after that -- and the server had dropped the session
// one second after the media went, counting its 25 s from the last message.
// The participant came back as a new session, and the other side saw them
// leave and join again.  The wait now counts from when the media went.
test('network change: a session whose media outlives its signalling waits ' +
     'for the client',
     async ({browser}) => {
    test.setTimeout(240_000);
    const B = await join(browser, 'bob', UPSTREAM, null);
    const conf = await B.evaluate(() => serverConnection.rtcConfiguration);
    test.skip(!conf || conf.iceTransportPolicy !== 'relay',
              'the server does not force relaying: run it with -relay-only');
    const tcp = (conf.iceServers || [])
        .flatMap(s => Array.isArray(s.urls) ? s.urls : [s.urls])
        .find(u => /^turn:/i.test(u) && /transport=tcp/i.test(u));
    test.skip(!tcp, 'the server offers no TURN relay over TCP: run it with ' +
              '-relay-only -turn <lan-ip>:1194');
    const m = /^turn:([^:?]+):(\d+)/i.exec(tcp);

    const signal = proxy('localhost', SIGNAL_PORT, 'localhost', UPSTREAM);
    const relay = proxy(m[1], RELAY_PORT, m[1], Number(m[2]));
    await signal.listen();
    await relay.listen();
    try {
        const A = await join(browser, 'alice', SIGNAL_PORT, RELAY_PORT);
        for (const p of [A, B])
            await expect.poll(async () => await p.locator('#peers video').count(),
                {timeout: 30_000}).toBe(2);
        await flowing(A, 30_000);
        await flowing(B, 30_000);
        const id = await A.evaluate(() => serverConnection.id);
        // Bob notes every user that comes and goes.
        await B.evaluate(() => {
            window.__seen = [];
            const prev = serverConnection.onuser;
            serverConnection.onuser = function(uid, kind) {
                window.__seen.push(kind + ':' + uid);
                if (prev) prev.call(this, uid, kind);
            };
        });

        // The signalling stalls; fifteen seconds on, the media goes too.
        signal.freeze();
        await new Promise(r => setTimeout(r, 15_000));
        relay.blackhole();
        // Old server: dropped at about 25-30 s.  The path recovers at 38 s.
        await new Promise(r => setTimeout(r, 23_000));
        signal.thaw();

        await expect.poll(() => A.evaluate(() =>
            !!(serverConnection && serverConnection.group &&
               !serverConnection.resuming)), {timeout: 30_000}).toBe(true);
        expect(await A.evaluate(() => serverConnection.id),
               'the same session, resumed rather than joined again').toBe(id);
        const seen = await B.evaluate(() => window.__seen);
        expect(seen.filter(e => e === 'delete:' + id),
               'bob never saw alice leave').toEqual([]);
        await flowing(A, 30_000);
        await flowing(B, 30_000);
    } catch (e) {
        for (const p of browser.contexts().flatMap(c => c.pages()))
            if (p.log) console.log(p.log.slice(-40).join('\n'));
        throw e;
    } finally {
        await signal.close();
        await relay.close();
    }
});
