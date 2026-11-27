'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {Tracker} = require('../media-incidents.js');

const visible = {ice: 'connected', path: 'udp', active: true, hidden: false};

function inbound(fields) {
    return [{type: 'inbound-rtp', kind: 'video', ...fields}];
}

test('an ICE interruption can leave the rendered frames flowing', () => {
    const tracker = new Tracker();
    const disconnected = {...visible, ice: 'disconnected'};
    const checking = {...visible, ice: 'checking', up: true};
    tracker.sample([], {...checking, presented: 1}, 0);
    tracker.sample([], {...checking, presented: 30}, 2000);
    assert.equal(tracker.iceInterrupted(true, {...checking, presented: 31}, 2010), null);
    assert.equal(tracker.iceInterrupted(false, visible, 2100), null);
    tracker.sample([], {...visible, up: true, presented: 94}, 4000);
    assert.deepEqual(tracker.iceInterrupted(true, {...disconnected, presented: 100}, 4500), {
        event: 'ice-down', ice: 'disconnected', path: 'udp', hidden: false,
    });
    assert.equal(tracker.iceInterrupted(true, {...disconnected, presented: 120}, 4750), null);
    assert.deepEqual(tracker.iceInterrupted(false, {...visible, presented: 129}, 5500), {
        event: 'ice-up', ice: 'connected', path: 'udp', hidden: false,
        ms: 1000, presented: 29,
    });
});

test('a browser freeze report captures a stall between otherwise progressing polls', () => {
    const tracker = new Tracker();
    const setup = {packetsReceived: 100, packetsLost: 8, framesReceived: 27,
                   framesDecoded: 26, totalFreezesDuration: 0, freezeCount: 0};
    assert.deepEqual(tracker.sample(inbound(setup), visible, 0), []);
    const recovery = {packetsReceived: 125, packetsLost: 17, framesReceived: 37,
                      framesDecoded: 36, totalFreezesDuration: 0.9, freezeCount: 1};
    assert.deepEqual(tracker.sample(inbound(recovery), visible, 2000), [{
        event: 'freeze', ice: 'connected', path: 'udp', hidden: false, ms: 900,
        packets: 25, lost: 9, received: 10, decoded: 10,
    }]);
});

test('a continuous stall is reported once with its available counters and recovery', () => {
    const tracker = new Tracker();
    const first = {packetsReceived: 10, framesReceived: 4, framesDecoded: 4};
    const next = {packetsReceived: 20, framesReceived: 8, framesDecoded: 8};
    tracker.sample(inbound(first), visible, 0);
    tracker.sample(inbound(next), visible, 2000);
    assert.deepEqual(tracker.sample(inbound({...next, packetsReceived: 30}), visible, 4000), [{
        event: 'stalled', ice: 'connected', path: 'udp', hidden: false, ms: 2000,
        packets: 10, received: 0, decoded: 0,
    }]);
    assert.deepEqual(tracker.sample(inbound({...next, packetsReceived: 40}), visible, 6000), []);
    assert.deepEqual(tracker.sample(inbound({...next, packetsReceived: 50, framesDecoded: 9}),
                                    visible, 8000), [{
        event: 'resumed', ice: 'connected', path: 'udp', hidden: false, ms: 6000,
        packets: 10, received: 0, decoded: 1,
    }]);
});

test('hidden, disabled and reset counters do not create misleading stalls', () => {
    const tracker = new Tracker();
    tracker.sample(inbound({framesDecoded: 20}), visible, 0);
    tracker.sample(inbound({framesDecoded: 60}), visible, 2000);
    assert.deepEqual(tracker.sample(inbound({framesDecoded: 0}), visible, 4000), []);
    assert.deepEqual(tracker.sample(inbound({packetsReceived: 1}), visible, 6000), []);
    assert.deepEqual(tracker.sample(inbound({framesDecoded: 0}), {...visible, hidden: true}, 8000), []);
    assert.deepEqual(tracker.sample(inbound({framesDecoded: 0}), visible, 10000), []);
    assert.deepEqual(tracker.sample(inbound({framesDecoded: 0}), {...visible, active: false}, 12000), []);
    assert.deepEqual(tracker.sample(inbound({framesDecoded: 0}), visible, 14000), []);
});

test('only allowlisted video counters and states are retained for reporting', () => {
    const tracker = new Tracker();
    const opts = {...visible, ice: 'unsupported secret', path: 'sensitive address', username: 'staff'};
    const rows = count => [
        ...inbound({framesDecoded: count, id: 'sensitive stream ID', address: 'sensitive address',
                    totalFreezesDuration: count / 10, deviceId: 'sensitive device'}),
        {type: 'inbound-rtp', kind: 'audio', packetsReceived: count, audioLevel: 0.8},
        {type: 'local-candidate', ip: 'sensitive address', url: 'sensitive URL'},
    ];
    tracker.sample(rows(12), opts, 0);
    assert.deepEqual(tracker.sample(rows(18), opts, 2000), [{
        event: 'freeze', ice: 'new', path: 'unknown', hidden: false, ms: 600, decoded: 6,
    }]);
    assert.deepEqual(tracker.last, {at: 2000, counters: {
        sources: 0, streams: 1, decoded: 18, freezeMs: 1800,
    }});
});
