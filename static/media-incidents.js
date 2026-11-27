// Copyright (c) 2026 by imaprocessus.
// SPDX-License-Identifier: MIT

// Record camera and video-tile faults using counters, without reading frames.
(function(global) {
    'use strict';

    const COUNTERS = ['packets', 'lost', 'source', 'encoded', 'received',
                      'decoded', 'presented'];
    const ICE = ['new', 'checking', 'connected', 'completed', 'disconnected',
                 'failed', 'closed'];
    const PATHS = ['udp', 'tcp', 'tls'];
    const MAX_MS = 120000;
    // Allow an unusually late quality poll, but not a sample spanning sleep
    // or a long interval without applicable browser stats.
    const MAX_INTERVAL = 8000;
    const MIN_STALL = 1500;
    const MIN_FREEZE = 250;

    function add(snapshot, key, value) {
        if(Number.isSafeInteger(value) && (value >= 0 || key === 'lost'))
            snapshot[key] = (snapshot[key] ?? 0) + value;
    }

    // Build a new object from an allowlist. No RTCStats objects, identifiers,
    // candidate details, or media leave this function.
    function snapshot(report, up, presented) {
        let counters = {sources: 0, streams: 0};
        add(counters, 'presented', presented);
        for(let row of report) {
            if((row.kind || row.mediaType) !== 'video')
                continue;
            if(up && row.type === 'media-source') {
                counters.sources++;
                add(counters, 'source', row.frames);
            } else if(up && row.type === 'outbound-rtp') {
                counters.streams++;
                add(counters, 'packets', row.packetsSent);
                add(counters, 'encoded', row.framesEncoded);
            } else if(!up && row.type === 'inbound-rtp') {
                counters.streams++;
                add(counters, 'packets', row.packetsReceived);
                add(counters, 'lost', row.packetsLost);
                add(counters, 'received', row.framesReceived);
                add(counters, 'decoded', row.framesDecoded);
                add(counters, 'freezes', row.freezeCount);
                if(Number.isFinite(row.totalFreezesDuration) && row.totalFreezesDuration >= 0) {
                    counters.freezeMs = (counters.freezeMs ?? 0) +
                        Math.round(row.totalFreezesDuration * 1000);
                }
            }
        }
        return counters;
    }

    function delta(previous, current, key) {
        if(key === 'source' && previous.sources !== current.sources)
            return undefined;
        if(key !== 'source' && key !== 'presented' &&
           previous.streams !== current.streams)
            return undefined;
        let value = current[key] - previous[key];
        if(!Number.isSafeInteger(value) || (key !== 'lost' && value < 0))
            return undefined;
        return value;
    }

    function packet(event, options, evidence, ms) {
        let value = {
            event: event,
            ice: ICE.includes(options.ice) ? options.ice : 'new',
            path: PATHS.includes(options.path) ? options.path : 'unknown',
            hidden: options.hidden === true,
        };
        if(Number.isFinite(ms) && ms >= 0)
            value.ms = Math.min(MAX_MS, Math.round(ms));
        for(let name of COUNTERS) {
            let count = evidence[name];
            if(Number.isSafeInteger(count)) {
                let max = name === 'packets' || name === 'lost' ? 1e7 : MAX_MS;
                let minimum = name === 'lost' ? -max : 0;
                if(count >= minimum && count <= max)
                    value[name] = count;
            }
        }
        return value;
    }

    class Tracker {
        constructor() {
            this.ready = false;
            this.last = null;
            this.stall = null;
            this.interrupted = null;
        }

        // Read at the ICE transition, even between the stats polls. On
        // recovery include how many frames were presented during the interruption.
        iceInterrupted(interrupted, options, now) {
            if(interrupted) {
                if(!options.active || !this.ready || this.interrupted)
                    return null;
                this.interrupted = {at: now, presented: options.presented};
                return packet('ice-down', options, {});
            }
            if(!this.interrupted)
                return null;
            let previous = this.interrupted;
            this.interrupted = null;
            let presented = Number.isSafeInteger(options.presented) &&
                Number.isSafeInteger(previous.presented) ?
                options.presented - previous.presented : undefined;
            return packet('ice-up', options, {
                presented: presented,
            }, now - previous.at);
        }

        sample(report, options, now) {
            if(!options.active || options.hidden) {
                this.last = null;
                this.stall = null;
                return [];
            }
            let current = snapshot(report, options.up, options.presented);
            let previous = this.last;
            // A later poll may already have provided a newer baseline.
            if(previous && now <= previous.at)
                return [];
            this.last = {at: now, counters: current};
            if(!previous || now - previous.at > MAX_INTERVAL) {
                this.stall = null;
                return [];
            }
            let evidence = {};
            for(let key of COUNTERS)
                evidence[key] = delta(previous.counters, current, key);
            let progress = evidence.presented ?? evidence.decoded ??
                evidence.received ?? evidence.encoded ?? evidence.source;
            let result = [];
            if(progress > 0) {
                // An outgoing preview can already show video during the
                // initial ICE checks. Start tracking once the path is up.
                if(options.ice === 'connected' || options.ice === 'completed')
                    this.ready = true;
                if(this.stall !== null) {
                    result.push(packet('resumed', options, evidence, now - this.stall));
                    this.stall = null;
                }
            } else if(progress === 0 && this.ready && this.stall === null &&
                      now - previous.at >= MIN_STALL) {
                this.stall = previous.at;
                result.push(packet('stalled', options, evidence, now - this.stall));
            }
            let freeze = delta(previous.counters, current, 'freezeMs');
            let freezes = delta(previous.counters, current, 'freezes');
            if(freeze >= MIN_FREEZE || (freeze === undefined && freezes > 0))
                result.push(packet('freeze', options, evidence, freeze));
            return result;
        }
    }

    let api = {Tracker};
    global.SozvonMediaIncidents = api;
    if(typeof module !== 'undefined')
        module.exports = api;
})(typeof window === 'undefined' ? globalThis : window);
