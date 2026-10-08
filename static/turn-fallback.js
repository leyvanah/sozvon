// Copyright (c) 2026 by imaprocessus.

// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
// THE SOFTWARE.

// turn-fallback.js -- give up on a TURN relay over UDP that does not work,
// and carry on over TCP/TLS.  (Sozvon)
//
// A relay reached over UDP is much better for a call than one reached over
// TLS: a lost packet is just lost, instead of holding up everything behind
// it.  But some networks -- Russian mobile carriers in particular -- may drop
// or throttle UDP, and they may do it only once real volume starts, after
// ICE has already chosen the UDP path.  The browser then stays on a path
// that no longer carries media, and a plain ICE restart picks the same path
// again.
//
// So the client watches the path each connection actually uses.  If a
// connection that goes over UDP -- through a relay, or straight to the server
// when the server allows direct paths -- fails, stays disconnected, or loses
// a large share of its packets for a while, UDP is given up for this browser:
// it is dropped from the ICE configuration, the policy becomes relay-only, so
// what is left is the relay over TCP/TLS, every connection is restarted over
// it, and the decision is remembered for a few hours so that the next call on
// the same network starts on the path that works.  With no UDP offered at
// all -- relay-only and no UDP relay -- none of this does anything, and nor
// does it with no relay over TCP/TLS to fall back to.
//
// This file holds the decisions; galene.js does the restarting.

(function(global) {
    'use strict';

    // How long a connection over a UDP relay may stay "disconnected"
    // before UDP is given up.  Chrome passes through "disconnected" on
    // brief hiccups and recovers by itself within a few seconds.
    const DISCONNECTED_FOR = 6000;
    // Loss that counts as "UDP is being throttled", and for how many
    // consecutive polls (of about 2 s) it must persist.
    const LOSS = 0.15;
    const LOSS_POLLS = 5;
    // How long the decision is remembered.
    const REMEMBER = 6 * 3600 * 1000;
    const STORAGE_KEY = 'sozvon-turn-udp-off';

    /**
     * Whether an ICE server URL is a TURN relay reached over UDP.  A turn:
     * URL with no transport parameter means UDP.
     *
     * @param {string} url
     * @returns {boolean}
     */
    function isUdpRelay(url) {
        if(typeof url !== 'string' || !/^turn:/i.test(url))
            return false;
        let m = /[?&]transport=([a-z]+)/i.exec(url);
        return !m || m[1].toLowerCase() === 'udp';
    }

    /**
     * @param {any} server - an RTCIceServer
     * @returns {string[]}
     */
    function urlsOf(server) {
        if(!server || !server.urls)
            return [];
        return Array.isArray(server.urls) ? server.urls : [server.urls];
    }

    /**
     * Whether a configuration offers a TURN relay over UDP.
     *
     * @param {RTCConfiguration} conf
     * @returns {boolean}
     */
    function hasUdpRelay(conf) {
        let servers = (conf && conf.iceServers) || [];
        return servers.some(s => urlsOf(s).some(isUdpRelay));
    }

    /**
     * Whether a configuration lets a connection go over UDP: a TURN relay
     * over UDP, or direct paths to the server (any policy but relay-only).
     *
     * @param {RTCConfiguration} conf
     * @returns {boolean}
     */
    function offersUdp(conf) {
        return hasUdpRelay(conf) ||
            !!conf && conf.iceTransportPolicy !== 'relay';
    }

    /**
     * A copy of conf without UDP: no TURN over UDP, and relay-only, so that
     * no direct UDP path is tried either.  Servers left with no URL are
     * dropped; everything else is kept as it was.
     *
     * @param {RTCConfiguration} conf
     * @returns {RTCConfiguration}
     */
    function withoutUdp(conf) {
        /** @type {any} */
        let out = {};
        for(let key in conf)
            out[key] = conf[key];
        out.iceTransportPolicy = 'relay';
        out.iceServers = ((conf && conf.iceServers) || []).map(s => {
            let urls = urlsOf(s).filter(u => !isUdpRelay(u));
            if(urls.length === 0)
                return null;
            let copy = Object.assign({}, s);
            copy.urls = urls;
            return copy;
        }).filter(s => s);
        return out;
    }

    /**
     * The candidate pair a connection currently uses, as the local
     * candidate's type and how the browser reaches the other end: for a
     * relay, the protocol to the relay; otherwise the candidate's own.
     *
     * @param {Iterable<any>} stats - the values of an RTCStatsReport
     * @returns {{type: string, relay: string|null}|null}
     */
    function selectedPath(stats) {
        let byId = new Map();
        let selectedId = null;
        let fallbackId = null;
        for(let r of stats) {
            byId.set(r.id, r);
            if(r.type === 'transport' && r.selectedCandidatePairId)
                selectedId = r.selectedCandidatePairId;
            else if(r.type === 'candidate-pair' && r.selected)
                // Firefox marks the pair itself
                fallbackId = r.id;
        }
        let pair = byId.get(selectedId || fallbackId);
        if(!pair)
            return null;
        let local = byId.get(pair.localCandidateId);
        if(!local || !local.candidateType)
            return null;
        let relay = local.candidateType === 'relay' ?
            local.relayProtocol : local.protocol;
        return {type: local.candidateType,
                relay: (relay || '').toLowerCase() || null};
    }

    /**
     * Watches every connection's path and says when UDP should be given up.
     *
     * @constructor
     */
    function Watcher() {
        /** @type {Map<string, {path: any, disconnectedSince: number|null, lossPolls: number}>} */
        this.streams = new Map();
    }

    /**
     * Feed one poll of one connection.  Returns null, or the reason to give
     * up UDP: 'failed', 'disconnected' or 'loss'.
     *
     * @param {string} id
     * @param {Object} o
     * @param {string} o.ice - iceConnectionState
     * @param {{type: string, relay: string|null}|null} o.path
     * @param {number|null} [o.loss] - loss over the last poll, 0..1
     * @param {number} now
     * @returns {string|null}
     */
    Watcher.prototype.update = function(id, o, now) {
        let s = this.streams.get(id);
        if(!s) {
            s = {path: null, disconnectedSince: null, lossPolls: 0};
            this.streams.set(id, s);
        }
        // remember the last path seen while connected: once ICE is down,
        // the stats may no longer say which pair it was
        if(o.path && (o.ice === 'connected' || o.ice === 'completed'))
            s.path = o.path;
        let onUdp = !!s.path && s.path.relay === 'udp';

        if(o.ice === 'disconnected') {
            if(s.disconnectedSince === null)
                s.disconnectedSince = now;
        } else {
            s.disconnectedSince = null;
        }

        if(typeof o.loss === 'number' && o.loss >= LOSS &&
           (o.ice === 'connected' || o.ice === 'completed'))
            s.lossPolls++;
        else
            s.lossPolls = 0;

        if(!onUdp)
            return null;
        if(o.ice === 'failed')
            return 'failed';
        if(s.disconnectedSince !== null &&
           now - s.disconnectedSince >= DISCONNECTED_FOR)
            return 'disconnected';
        if(s.lossPolls >= LOSS_POLLS)
            return 'loss';
        return null;
    };

    /** @param {string} id */
    Watcher.prototype.forget = function(id) {
        this.streams.delete(id);
    };

    /**
     * Whether UDP was given up recently in this browser.  Storage may be
     * missing or throw (private windows); then nothing is remembered.
     *
     * @param {any} storage - localStorage, or something like it
     * @param {number} now
     * @returns {boolean}
     */
    function remembered(storage, now) {
        try {
            let t = parseInt(storage.getItem(STORAGE_KEY), 10);
            return !isNaN(t) && now - t >= 0 && now - t < REMEMBER;
        } catch(e) {
            return false;
        }
    }

    /**
     * @param {any} storage
     * @param {number} now
     */
    function remember(storage, now) {
        try {
            storage.setItem(STORAGE_KEY, String(now));
        } catch(e) {
        }
    }

    /**
     * Whether giving UDP up would leave anything to connect through: a
     * relay over TCP or TLS.  Without one, withoutUdp gives a relay-only
     * configuration with no relay in it -- every connection restarted on it
     * dies, and so does every call started while the decision is
     * remembered.  A lossy path still beats none.
     *
     * @param {RTCConfiguration} conf
     * @returns {boolean}
     */
    function canDropUdp(conf) {
        return withoutUdp(conf).iceServers.some(
            s => urlsOf(s).some(u => /^turns?:/i.test(u)));
    }

    const api = {
        DISCONNECTED_FOR, LOSS, LOSS_POLLS, REMEMBER, STORAGE_KEY,
        isUdpRelay, hasUdpRelay, offersUdp, withoutUdp, canDropUdp,
        selectedPath, Watcher, remembered, remember,
    };

    global.SozvonTurnFallback = api;
    if(typeof module !== 'undefined' && module.exports)
        module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
