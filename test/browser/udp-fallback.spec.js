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
        const orig = RTCPeerConnection.prototype.getStats;
        RTCPeerConnection.prototype.getStats = async function(...args) {
            const report = await orig.apply(this, args);
            if (args.length || !window.__loss)
                return report;
            this.__lost = this.__lost || {};
            const out = new Map();
            for (const [k, r] of report) {
                if (r.type === 'inbound-rtp') {
                    // add lost packets in proportion to those received
                    const e = this.__lost[k] ||
                        (this.__lost[k] = {base: r.packetsReceived, extra: 0});
                    e.extra = Math.round((r.packetsReceived - e.base) *
                                         window.__loss / (1 - window.__loss));
                    out.set(k, {...r, packetsLost: (r.packetsLost || 0) + e.extra});
                } else if (r.type === 'remote-inbound-rtp') {
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
