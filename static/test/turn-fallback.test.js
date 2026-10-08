// Tests for giving up a TURN relay over UDP that does not work.  (Sozvon)
//
// Run with:  node --test static/test/
//
// The rule the owner set: if UDP does not work, the call must go exactly as
// it does today, over TLS.  So what matters is that the fallback fires when
// the UDP path is broken, never fires for a path that is not UDP, and that
// the configuration it leaves behind still has the TLS relay in it.

'use strict';

const test = require('node:test');
const assert = require('node:assert');

const f = require('../turn-fallback.js');

const UDP = 'turn:relay.example:3479?transport=udp';
const TLS = 'turns:relay.example:5349?transport=tcp';

function conf() {
    return {
        iceServers: [{urls: [UDP, TLS], username: 'u', credential: 'c'}],
        iceTransportPolicy: 'relay',
    };
}

test('recognises TURN over UDP, and only that', () => {
    assert.ok(f.isUdpRelay(UDP));
    assert.ok(f.isUdpRelay('turn:relay.example:3478'),
              'turn: with no transport is UDP');
    assert.ok(!f.isUdpRelay(TLS));
    assert.ok(!f.isUdpRelay('turn:relay.example:3478?transport=tcp'));
    assert.ok(!f.isUdpRelay('stun:stun.example:3478'));
    assert.ok(!f.isUdpRelay(undefined));
});

test('dropping UDP keeps the TLS relay and everything else', () => {
    let c = conf();
    let out = f.withoutUdp(c);
    assert.deepStrictEqual(out.iceServers,
                           [{urls: [TLS], username: 'u', credential: 'c'}]);
    assert.strictEqual(out.iceTransportPolicy, 'relay');
    assert.deepStrictEqual(c.iceServers[0].urls, [UDP, TLS],
                           'the original must not be modified');
    assert.ok(f.hasUdpRelay(c));
    assert.ok(!f.hasUdpRelay(out));
});

test('a server left with no URL is dropped', () => {
    let out = f.withoutUdp({iceServers: [
        {urls: UDP, username: 'a', credential: 'b'},
        {urls: TLS, username: 'a', credential: 'b'},
    ]});
    assert.deepStrictEqual(out.iceServers.map(s => s.urls), [[TLS]]);
});

test('today\'s configuration, TLS only, is left alone', () => {
    let tlsOnly = {iceServers: [{urls: [TLS]}]};
    assert.ok(!f.hasUdpRelay(tlsOnly));
    assert.deepStrictEqual(f.withoutUdp(tlsOnly).iceServers,
                           [{urls: [TLS]}]);
});

test('UDP is only given up when a relay over TCP or TLS is left', () => {
    assert.ok(f.canDropUdp(conf()), 'UDP and TLS relays: TLS is left');
    assert.ok(f.canDropUdp({iceServers: [
        {urls: ['turn:relay.example:3478', 'turn:relay.example:3478?transport=tcp']},
    ]}), 'TURN over plain TCP counts');
    // A server with direct paths and no relay at all, and one whose only
    // relay is over UDP: giving UDP up would leave nothing to connect to.
    assert.ok(!f.canDropUdp({}));
    assert.ok(!f.canDropUdp({iceServers: []}));
    assert.ok(!f.canDropUdp({iceServers: [{urls: [UDP]}]}));
    assert.ok(!f.canDropUdp({iceServers: [{urls: ['stun:stun.example:3478']}]}),
              'a STUN server is not a relay');
});

function report(localType, relayProtocol, viaTransport) {
    let r = [
        {id: 'L', type: 'local-candidate', candidateType: localType,
         relayProtocol: relayProtocol},
        {id: 'R', type: 'remote-candidate', candidateType: 'relay'},
        {id: 'P', type: 'candidate-pair', localCandidateId: 'L',
         remoteCandidateId: 'R', selected: !viaTransport},
    ];
    if(viaTransport)
        r.push({id: 'T', type: 'transport', selectedCandidatePairId: 'P'});
    return r;
}

test('reads the path in use, Chrome and Firefox style', () => {
    assert.deepStrictEqual(f.selectedPath(report('relay', 'udp', true)),
                           {type: 'relay', relay: 'udp'});
    assert.deepStrictEqual(f.selectedPath(report('relay', 'tls', false)),
                           {type: 'relay', relay: 'tls'});
    assert.deepStrictEqual(f.selectedPath(report('host', undefined, true)),
                           {type: 'host', relay: null});
    assert.strictEqual(f.selectedPath([]), null);
});

const onUdp = {type: 'relay', relay: 'udp'};
const onTls = {type: 'relay', relay: 'tls'};

test('ICE failing on a UDP relay gives UDP up at once', () => {
    let w = new f.Watcher();
    assert.strictEqual(w.update('a', {ice: 'connected', path: onUdp}, 0), null);
    assert.match(w.update('a', {ice: 'failed', path: null}, 2000),
                 /failed/);
});

test('a failure on a TLS relay is not UDP\'s fault', () => {
    let w = new f.Watcher();
    w.update('a', {ice: 'connected', path: onTls}, 0);
    assert.strictEqual(w.update('a', {ice: 'failed', path: null}, 2000), null);
});

test('a failure before anything connected is not UDP\'s fault', () => {
    // UDP blocked outright never gets chosen: ICE settles on TLS by itself
    let w = new f.Watcher();
    assert.strictEqual(w.update('a', {ice: 'checking', path: null}, 0), null);
    assert.strictEqual(w.update('a', {ice: 'failed', path: null}, 30000), null);
});

test('a brief disconnection is tolerated, a long one is not', () => {
    let w = new f.Watcher();
    w.update('a', {ice: 'connected', path: onUdp}, 0);
    assert.strictEqual(w.update('a', {ice: 'disconnected', path: null}, 1000), null);
    assert.strictEqual(w.update('a', {ice: 'disconnected', path: null}, 4000), null);
    assert.strictEqual(w.update('a', {ice: 'connected', path: onUdp}, 5000), null,
                       'recovered by itself');
    w.update('a', {ice: 'disconnected', path: null}, 10000);
    assert.match(w.update('a', {ice: 'disconnected', path: null},
                          10000 + f.DISCONNECTED_FOR),
                 /disconnected/);
});

test('sustained heavy loss on a UDP relay gives UDP up; a spike does not', () => {
    let w = new f.Watcher();
    let t = 0;
    w.update('a', {ice: 'connected', path: onUdp, loss: 0}, t);
    for(let i = 0; i < f.LOSS_POLLS - 1; i++)
        assert.strictEqual(
            w.update('a', {ice: 'connected', path: onUdp, loss: 0.3}, t += 2000),
            null);
    assert.strictEqual(
        w.update('a', {ice: 'connected', path: onUdp, loss: 0.01}, t += 2000),
        null, 'one good poll resets the count');
    let r = null;
    for(let i = 0; i < f.LOSS_POLLS; i++)
        r = w.update('a', {ice: 'connected', path: onUdp, loss: 0.3}, t += 2000);
    assert.strictEqual(r, 'loss');
});

test('heavy loss over TLS is not a reason to drop UDP', () => {
    let w = new f.Watcher();
    let r = null;
    for(let i = 0; i < 2 * f.LOSS_POLLS; i++)
        r = w.update('a', {ice: 'connected', path: onTls, loss: 0.5}, i * 2000);
    assert.strictEqual(r, null);
});

test('streams are watched separately', () => {
    let w = new f.Watcher();
    w.update('a', {ice: 'connected', path: onTls}, 0);
    w.update('b', {ice: 'connected', path: onUdp}, 0);
    assert.strictEqual(w.update('a', {ice: 'failed', path: null}, 1), null);
    assert.match(w.update('b', {ice: 'failed', path: null}, 1), /failed/);
    w.forget('b');
    assert.strictEqual(w.update('b', {ice: 'failed', path: null}, 2), null,
                       'a forgotten stream starts from scratch');
});

function memoryStorage() {
    let m = new Map();
    return {
        getItem: k => m.has(k) ? m.get(k) : null,
        setItem: (k, v) => m.set(k, String(v)),
    };
}

test('the decision is remembered for a while, then forgotten', () => {
    let s = memoryStorage();
    assert.ok(!f.remembered(s, 1000));
    f.remember(s, 1000);
    assert.ok(f.remembered(s, 1000 + f.REMEMBER - 1));
    assert.ok(!f.remembered(s, 1000 + f.REMEMBER));
});

test('storage that throws remembers nothing and breaks nothing', () => {
    let broken = {
        getItem() { throw new Error('denied'); },
        setItem() { throw new Error('denied'); },
    };
    f.remember(broken, 0);
    assert.ok(!f.remembered(broken, 0));
});

test('direct paths count as UDP when the server allows them', () => {
    let direct = {iceServers: [{urls: [TLS]}], iceTransportPolicy: 'all'};
    let relayOnly = {iceServers: [{urls: [TLS]}], iceTransportPolicy: 'relay'};
    assert.ok(f.offersUdp(direct), 'direct UDP to the server is possible');
    assert.ok(!f.offersUdp(relayOnly), 'relay-only over TLS offers no UDP');
    assert.ok(f.offersUdp(conf()), 'a UDP relay is UDP');
    assert.ok(f.offersUdp({iceServers: [{urls: [TLS]}]}),
              'no policy means "all"');
});

test('giving up UDP also gives up direct paths: relay-only over TLS', () => {
    let out = f.withoutUdp({iceServers: [{urls: [UDP, TLS]}],
                            iceTransportPolicy: 'all'});
    assert.strictEqual(out.iceTransportPolicy, 'relay');
    assert.deepStrictEqual(out.iceServers, [{urls: [TLS]}]);
    assert.ok(!f.offersUdp(out), 'nothing over UDP is left');
});

test('reads direct paths with their protocol', () => {
    const direct = (type, protocol) => [
        {id: 'L', type: 'local-candidate', candidateType: type,
         protocol: protocol},
        {id: 'P', type: 'candidate-pair', localCandidateId: 'L',
         selected: true},
    ];
    assert.deepStrictEqual(f.selectedPath(direct('srflx', 'udp')),
                           {type: 'srflx', relay: 'udp'});
    assert.deepStrictEqual(f.selectedPath(direct('host', 'tcp')),
                           {type: 'host', relay: 'tcp'});
});

test('a pair learnt through the relay is read as the relay it goes through', () => {
    // Seen in Chrome after falling back to a TURN relay over TCP: the local
    // candidate of the selected pair is "prflx", its protocol "udp" (the
    // relay to the server), its relayProtocol "tcp" (us to the relay).
    const r = [
        {id: 'L', type: 'local-candidate', candidateType: 'prflx',
         protocol: 'udp', relayProtocol: 'tcp'},
        {id: 'P', type: 'candidate-pair', localCandidateId: 'L'},
        {id: 'T', type: 'transport', selectedCandidatePairId: 'P'},
    ];
    assert.deepStrictEqual(f.selectedPath(r), {type: 'relay', relay: 'tcp'});

    // ...so a loss on it is not a reason to give UDP up.
    const w = new f.Watcher();
    let reason = null;
    for(let i = 0; i < f.LOSS_POLLS + 2; i++)
        reason = w.update('s', {ice: 'connected', path: f.selectedPath(r),
                                loss: 0.5}, i * 2000) || reason;
    assert.strictEqual(reason, null);
});

test('a direct UDP path that breaks gives UDP up; a TCP one does not', () => {
    let w = new f.Watcher();
    w.update('a', {ice: 'connected', path: {type: 'srflx', relay: 'udp'}}, 0);
    assert.strictEqual(w.update('a', {ice: 'failed', path: null}, 1), 'failed');
    w.update('b', {ice: 'connected', path: {type: 'host', relay: 'tcp'}}, 0);
    assert.strictEqual(w.update('b', {ice: 'failed', path: null}, 1), null);
});
