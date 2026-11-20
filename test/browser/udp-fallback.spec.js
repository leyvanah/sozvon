// A relay over UDP that stops working hands the call over to TCP/TLS, and the
// call goes on.  (Sozvon)
//
// Needs a server that offers a TURN relay over UDP and over TCP and forces
// relaying, e.g. the built-in one on loopback:
//
//   sozvon -relay-only -turn 127.0.0.1:1194 ...
//
// and is skipped otherwise.  A real network that throttles UDP cannot be
// staged here, so the damage is injected where the client reads it: getStats
// starts reporting heavy loss on inbound streams.  From there on everything
// is real -- the watcher's judgement, the configuration change, the ICE
// restarts over the relay that is left, and the media that has to keep
// flowing.

import {test, expect} from '@playwright/test';
import net from 'node:net';

test.afterEach(async ({browser}) => {
    for (const c of browser.contexts())
        await c.close();
});

const ROOM = process.env.SOZVON_ROOM || 'smoke';

async function join(context, name) {
    const page = await context.newPage();
    page.errors = [];
    page.on('pageerror', e => page.errors.push(String(e)));
    await page.addInitScript(() => {
        try { localStorage.setItem('sozvon-lang', 'ru'); } catch(e) {}
        window.__loss = 0;
        window.__stalledAudio = null;
        window.__stalledAudioSamples = 0;
        window.__missingAudio = false;
        const orig = RTCPeerConnection.prototype.getStats;
        RTCPeerConnection.prototype.getStats = async function(...args) {
            const report = await orig.apply(this, args);
            if (args.length || (!window.__loss && !window.__stalledAudio &&
                                !window.__missingAudio))
                return report;
            this.__lost = this.__lost || {};
            const out = new Map();
            for (const [k, r] of report) {
                if (window.__missingAudio && r.type === 'inbound-rtp' &&
                    (r.kind || r.mediaType) === 'audio')
                    continue;
                if (r.type === 'inbound-rtp' && (r.kind || r.mediaType) === 'audio' &&
                    window.__stalledAudio) {
                    const counts = window.__stalledAudio;
                    window.__stalledAudioSamples++;
                    if (!counts.has(k))
                        counts.set(k, r.packetsReceived);
                    out.set(k, {...r, packetsReceived: counts.get(k)});
                } else if (r.type === 'inbound-rtp' && window.__loss) {
                    // add lost packets in proportion to those received
                    const e = this.__lost[k] ||
                        (this.__lost[k] = {base: r.packetsReceived, extra: 0});
                    e.extra = Math.round((r.packetsReceived - e.base) *
                                         window.__loss / (1 - window.__loss));
                    out.set(k, {...r, packetsLost: (r.packetsLost || 0) + e.extra});
                } else if (r.type === 'remote-inbound-rtp' && window.__loss) {
                    // what the other end reports about what we send
                    out.set(k, {...r, fractionLost: window.__loss});
                } else {
                    out.set(k, r);
                }
            }
            return out;
        };
    });
    await page.goto(`/group/${ROOM}/`);
    await page.fill('#username', name);
    if (await page.locator('#password').isVisible())
        await page.fill('#password', 'x');
    for (const id of ['#precheck-cam', '#precheck-mic']) {
        await page.click(id);
        await expect(page.locator(id)).toHaveAttribute(
            'aria-pressed', 'true', {timeout: 45_000});
    }
    await page.click('#connectbutton');
    await expect.poll(async () => await page.locator('#peers video').count(),
                      {timeout: 30_000}).toBeGreaterThan(0);
    return page;
}

// The client-side path of every connection, e.g. ['relay/udp', ...].
const paths = page => page.evaluate(() => {
    const all = [...Object.values(serverConnection.up),
                 ...Object.values(serverConnection.down)];
    return all.map(c => c.userdata.turnPath || null).sort();
});

const conns = page => page.evaluate(() => ({
    up: Object.keys(serverConnection.up).sort(),
    down: Object.keys(serverConnection.down).sort(),
}));

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

const downstream = page => page.evaluate(() => {
    const [stream] = Object.values(serverConnection.down);
    const trial = stream?.userdata.audioRelay;
    return {
        trial: trial ? (trial.timer === null ? 'receiving' : 'trying') : null,
        path: stream?.userdata.turnPath,
        policy: stream?.pc.getConfiguration().iceTransportPolicy,
        rolledBack: !!stream?.userdata.audioRelayRetry,
    };
});

const audioPackets = page => page.evaluate(async () => {
    const [stream] = Object.values(serverConnection.down);
    if(!stream?.pc)
        return 0;
    const stats = await stream.pc.getStats();
    return [...stats.values()].filter(r => r.type === 'inbound-rtp' &&
        (r.kind || r.mediaType) === 'audio')
        .reduce((sum, r) => sum + r.packetsReceived, 0);
});

test('a broken UDP relay falls back to TCP and the call goes on',
     async ({browser}) => {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    for (const c of [ctxA, ctxB])
        await c.grantPermissions(['camera', 'microphone']);

    const A = await join(ctxA, 'alice');
    const B = await join(ctxB, 'bob');
    await expect.poll(async () => await B.locator('#peers video').count(),
                      {timeout: 30_000}).toBe(2);

    const offered = await A.evaluate(() =>
        SozvonTurnFallback.hasUdpRelay(serverConnection.rtcConfiguration) &&
        serverConnection.rtcConfiguration.iceTransportPolicy === 'relay');
    test.skip(!offered, 'the server offers no TURN relay over UDP, or ' +
              'does not force relaying: run it with -relay-only -turn');

    // Everyone starts with UDP to the relay in use.  Not necessarily on every
    // connection: on a down connection the server's ICE agent nominates the
    // first pair that works, which is sometimes the one over TCP.
    // Wait for both to settle; if ICE put B on TCP everywhere, there is
    // nothing to fall back from, and the run says so instead of failing.
    for (const p of [A, B])
        await expect.poll(async () => (await paths(p)).every(x => x),
                          {timeout: 20_000}).toBe(true);
    test.skip(!(await paths(B)).includes('relay/udp'),
              'ICE chose the relay over TCP for every connection of B');
    const before = await conns(B);

    // B's network starts throttling UDP.
    await B.evaluate(() => { window.__loss = 0.3; });

    // B gives UDP up, restarts over TCP, and keeps its connections.
    await expect.poll(() => paths(B), {timeout: 40_000})
        .toEqual(['relay/tcp', 'relay/tcp']);
    await B.evaluate(() => { window.__loss = 0; });
    expect(await conns(B)).toEqual(before);
    await growing(B);
    await growing(A);
    expect(await B.evaluate(() => udpRelayGivenUp())).toBe(true);
    // A was not affected: it did not give UDP up.
    expect(await A.evaluate(() => udpRelayGivenUp())).toBe(false);

    // The decision is remembered: B's next call starts on TCP.
    await B.close();
    const B2 = await join(ctxB, 'bob2');
    await expect.poll(() => paths(B2), {timeout: 20_000})
        .toEqual(['relay/tcp', 'relay/tcp']);
    await growing(B2);

    expect(A.errors).toEqual([]);
    expect(B2.errors).toEqual([]);
});

test('a broken direct UDP path falls back to the relay over TCP',
     async ({browser}) => {
    // Needs a server that allows direct paths (no -relay-only) and offers a
    // relay over TCP, e.g.:  sozvon -turn <lan-ip>:1194 ...
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    for (const c of [ctxA, ctxB])
        await c.grantPermissions(['camera', 'microphone']);

    const A = await join(ctxA, 'alice');
    const B = await join(ctxB, 'bob');
    await expect.poll(async () => await B.locator('#peers video').count(),
                      {timeout: 30_000}).toBe(2);

    const direct = await A.evaluate(() =>
        serverConnection.rtcConfiguration.iceTransportPolicy !== 'relay');
    test.skip(!direct, 'the server forces relaying: run it without -relay-only');
    const relay = await A.evaluate(() =>
        SozvonTurnFallback.canDropUdp(serverConnection.rtcConfiguration));
    test.skip(!relay, 'the server offers no relay over TCP: run it with ' +
              '-turn <address>:1194 (the next test covers this case)');

    // Everyone starts on a direct UDP path to the server.
    const isDirectUdp = p => /^(host|srflx|prflx)\/udp$/.test(p);
    for (const p of [A, B])
        await expect.poll(async () => (await paths(p)).every(isDirectUdp),
                          {timeout: 20_000}).toBe(true);
    const before = await conns(B);

    await B.evaluate(() => { window.__loss = 0.3; });

    // B gives UDP up altogether and carries on over the relay's TCP.
    await expect.poll(() => paths(B), {timeout: 40_000})
        .toEqual(['relay/tcp', 'relay/tcp']);
    await B.evaluate(() => { window.__loss = 0; });
    expect(await conns(B)).toEqual(before);
    await growing(B);
    await growing(A);
    expect(await B.evaluate(() =>
        serverConnection.down[Object.keys(serverConnection.down)[0]]
            .pc.getConfiguration().iceTransportPolicy)).toBe('relay');
    // A was not affected: it did not give UDP up.
    expect(await A.evaluate(() => udpRelayGivenUp())).toBe(false);

    // The next call from B starts on the relay.
    await B.close();
    const B2 = await join(ctxB, 'bob2');
    await expect.poll(() => paths(B2), {timeout: 20_000})
        .toEqual(['relay/tcp', 'relay/tcp']);
    await growing(B2);

    expect(A.errors).toEqual([]);
    expect(B2.errors).toEqual([]);
});

test('a direct UDP path with stalled audio falls back only while its sender is active',
     async ({browser}) => {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    for (const c of [ctxA, ctxB])
        await c.grantPermissions(['camera', 'microphone']);

    const A = await join(ctxA, 'alice');
    const B = await join(ctxB, 'bob');
    const conf = await A.evaluate(() => serverConnection.rtcConfiguration);
    test.skip(conf.iceTransportPolicy === 'relay' ||
        !await A.evaluate(() => SozvonTurnFallback.canDropUdp(serverConnection.rtcConfiguration)),
        'requires direct paths and a TURN relay over TCP/TLS');
    const relay = await A.evaluate(() => {
        const conf = serverConnection.rtcConfiguration;
        const urls = conf.iceServers.flatMap(s => s.urls);
        return urls.some(u => /^turn:/i.test(u) && /transport=tcp/i.test(u)) ?
            'relay/tcp' : 'relay/tls';
    });
    const onDirectUdp = async page => {
        const route = await paths(page);
        return route.length === 2 && route.every(p => /^(host|srflx|prflx)\/udp$/.test(p));
    };
    await expect.poll(() => onDirectUdp(A)).toBe(true);
    await expect.poll(() => onDirectUdp(B)).toBe(true);
    await expect.poll(() => B.evaluate(async () => {
        const [stream] = Object.values(serverConnection.down);
        return [...(await stream.pc.getStats()).values()].some(r =>
            r.type === 'inbound-rtp' && (r.kind || r.mediaType) === 'audio' &&
            r.packetsReceived > 0);
    })).toBe(true);

    const toggleMic = page =>
        page.evaluate(() => document.getElementById('mutebutton').click());
    const source = await A.evaluate(() => serverConnection.id);
    await toggleMic(A);
    await expect.poll(() => B.evaluate(id => micSilent(id), source)).toBe(true);
    await B.evaluate(() => { window.__stalledAudio = new Map(); });
    await expect.poll(() => B.evaluate(() => window.__stalledAudioSamples))
        .toBeGreaterThanOrEqual(5);
    expect((await downstream(B)).trial).toBeNull();
    expect(await onDirectUdp(B)).toBe(true);

    const session = await B.evaluate(() => serverConnection.id);
    const streams = await conns(B);
    await toggleMic(A);
    await expect.poll(() => downstream(B), {timeout: 20_000})
        .toMatchObject({trial: 'trying', policy: 'relay'});
    await B.evaluate(() => { window.__stalledAudio = null; });
    await expect.poll(() => downstream(B))
        .toMatchObject({trial: 'receiving', path: relay, policy: 'relay'});
    const route = await paths(B);
    expect(route).toContain(relay);
    expect(route.some(p => /^(host|srflx|prflx)\/udp$/.test(p))).toBe(true);
    expect(await conns(B)).toEqual(streams);
    await growing(B);
    expect(await B.evaluate(() => serverConnection.id)).toBe(session);
    expect(A.errors).toEqual([]);
    expect(B.errors).toEqual([]);
});

test('a direct UDP path is restored when the audio relay does not answer', async ({browser}) => {
    const sockets = new Set();
    const deadRelay = net.createServer(socket => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        socket.on('error', () => {});
    });
    await new Promise(resolve => deadRelay.listen(0, '127.0.0.1', resolve));
    try {
        const ctxA = await browser.newContext();
        const ctxB = await browser.newContext();
        for (const c of [ctxA, ctxB])
            await c.grantPermissions(['camera', 'microphone']);
        const A = await join(ctxA, 'alice');
        const B = await join(ctxB, 'bob');
        const canTest = await B.evaluate(() => {
            const conf = serverConnection.rtcConfiguration;
            return conf.iceTransportPolicy !== 'relay' && SozvonTurnFallback.canDropUdp(conf);
        });
        test.skip(!canTest, 'requires direct paths and a TURN relay over TCP/TLS');
        await expect.poll(() => audioPackets(B)).toBeGreaterThan(10);
        await expect.poll(() => downstream(B)).toMatchObject({
            trial: null, policy: 'all', path: expect.stringMatching(/^(host|srflx|prflx)\/udp$/),
        });
        const session = await B.evaluate(port => {
            const setConfiguration = RTCPeerConnection.prototype.setConfiguration;
            RTCPeerConnection.prototype.setConfiguration = function(conf) {
                if(conf.iceTransportPolicy === 'relay') {
                    conf = {...conf, iceServers: [{
                        urls: [`turn:127.0.0.1:${port}?transport=tcp`],
                        username: 'test', credential: 'test',
                    }]};
                }
                return setConfiguration.call(this, conf);
            };
            window.__missingAudio = true;
            return serverConnection.id;
        }, deadRelay.address().port);
        const streams = await conns(B);
        await expect.poll(() => downstream(B)).toMatchObject({trial: 'trying'});
        await B.evaluate(() => { window.__missingAudio = false; });
        const heard = await audioPackets(A);
        await expect.poll(() => audioPackets(A)).toBeGreaterThan(heard + 50);
        expect((await downstream(B)).trial).toBe('trying');
        expect(await B.evaluate(() => Object.values(serverConnection.up)[0]
            .pc.getConfiguration().iceTransportPolicy)).toBe('all');
        await expect.poll(() => downstream(B), {timeout: 15_000})
            .toMatchObject({trial: null, policy: 'all', rolledBack: true});
        const received = await audioPackets(B);
        await expect.poll(() => audioPackets(B)).toBeGreaterThan(received + 50);
        expect(await conns(B)).toEqual(streams);
        expect(await B.evaluate(() => serverConnection.id)).toBe(session);
        expect([...A.errors, ...B.errors]).toEqual([]);
    } finally {
        for (const socket of sockets)
            socket.destroy();
        await new Promise(resolve => deadRelay.close(resolve));
    }
});

test('a direct UDP path given up for loss is tried again, once',
     async ({browser}) => {
    // The same stand as the test above.  Loss that lasts ten seconds may be
    // a bad ten seconds, and the TCP relay turns every later hiccup into a
    // stall (2026-11-11: an hour's call on TCP after one burst, the audio
    // seconds behind the picture).  So UDP comes back a while later; given
    // up for loss a second time, it stays given up.
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    for (const c of [ctxA, ctxB])
        await c.grantPermissions(['camera', 'microphone']);

    const A = await join(ctxA, 'alice');
    const B = await join(ctxB, 'bob');
    await expect.poll(async () => await B.locator('#peers video').count(),
                      {timeout: 30_000}).toBe(2);

    const direct = await A.evaluate(() =>
        serverConnection.rtcConfiguration.iceTransportPolicy !== 'relay');
    test.skip(!direct, 'the server forces relaying: run it without -relay-only');
    const relay = await A.evaluate(() =>
        SozvonTurnFallback.canDropUdp(serverConnection.rtcConfiguration));
    test.skip(!relay, 'the server offers no relay over TCP: run it with ' +
              '-turn <address>:1194');

    const isDirectUdp = p => /^(host|srflx|prflx)\/udp$/.test(p);
    for (const p of [A, B])
        await expect.poll(async () => (await paths(p)).every(isDirectUdp),
                          {timeout: 20_000}).toBe(true);
    const before = await conns(B);

    // minutes in a real call
    const RETRY = 15000;
    await B.evaluate(ms => { SozvonTurnFallback.RETRY_AFTER = ms; }, RETRY);

    // A burst of loss: B goes over to the relay's TCP.
    await B.evaluate(() => { window.__loss = 0.3; });
    await expect.poll(() => B.evaluate(() => udpRelayGivenUp()),
                      {timeout: 40_000, intervals: [200]}).toBe(true);
    const gaveUp = Date.now();
    await expect.poll(() => paths(B), {timeout: 40_000})
        .toEqual(['relay/tcp', 'relay/tcp']);
    await B.evaluate(() => { window.__loss = 0; });

    // ... and comes back to UDP by itself, not before its time, with the
    // same connections, and with nothing remembered against the network.
    await expect.poll(async () => (await paths(B)).every(isDirectUdp),
                      {timeout: 40_000}).toBe(true);
    expect(Date.now() - gaveUp).toBeGreaterThanOrEqual(RETRY - 1000);
    expect(await B.evaluate(() => udpRelayGivenUp())).toBe(false);
    expect(await conns(B)).toEqual(before);
    await growing(B);
    await growing(A);

    // Loss again: TCP again, and this time for good.
    await B.evaluate(() => { window.__loss = 0.3; });
    await expect.poll(() => paths(B), {timeout: 40_000})
        .toEqual(['relay/tcp', 'relay/tcp']);
    await B.evaluate(() => { window.__loss = 0; });
    await B.waitForTimeout(RETRY * 2.5);
    expect(await paths(B)).toEqual(['relay/tcp', 'relay/tcp']);
    expect(await B.evaluate(() => udpRelayGivenUp())).toBe(true);
    expect(await conns(B)).toEqual(before);
    await growing(B);
    await growing(A);

    expect(A.errors).toEqual([]);
    expect(B.errors).toEqual([]);
});

test('with no relay to fall back to, a lossy direct path is kept',
     async ({browser}) => {
    // Needs a server that allows direct paths and offers no relay over TCP,
    // e.g.:  sozvon -turn "" ...  Giving UDP up there used to leave every
    // connection relay-only with no relay: the call died, and so did every
    // call from the same browser for the hours the decision is remembered.
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    for (const c of [ctxA, ctxB])
        await c.grantPermissions(['camera', 'microphone']);

    const A = await join(ctxA, 'alice');
    const B = await join(ctxB, 'bob');
    await expect.poll(async () => await B.locator('#peers video').count(),
                      {timeout: 30_000}).toBe(2);

    const stranded = await A.evaluate(() =>
        serverConnection.rtcConfiguration.iceTransportPolicy !== 'relay' &&
        !SozvonTurnFallback.canDropUdp(serverConnection.rtcConfiguration));
    test.skip(!stranded, 'the server offers a relay over TCP, or forces ' +
              'relaying: run it with -turn ""');

    const isDirectUdp = p => /^(host|srflx|prflx)\/udp$/.test(p);
    await expect.poll(async () => (await paths(B)).every(isDirectUdp),
                      {timeout: 20_000}).toBe(true);
    const before = await conns(B);

    // Long enough for the watcher to have given UDP up several times over.
    await B.evaluate(() => { window.__loss = 0.3; });
    await B.waitForTimeout(25_000);
    await B.evaluate(() => { window.__loss = 0; });

    expect(await B.evaluate(() => udpRelayGivenUp())).toBe(false);
    expect((await paths(B)).every(isDirectUdp)).toBe(true);
    expect(await conns(B)).toEqual(before);
    await growing(B);
    await growing(A);

    expect(A.errors).toEqual([]);
    expect(B.errors).toEqual([]);
});
