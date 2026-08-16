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

// e2ee.js -- end-to-end encryption controller for the Sozvon web client.
//
// Drives an ephemeral ECDH key agreement with the single other participant
// over the (untrusted) signalling channel, authenticated by an emoji Short
// Authentication String that the two humans compare out loud.  The server
// relays the handshake but never learns the shared secret, so it cannot read
// or forge media; an active man-in-the-middle yields a different SAS on the two
// legs, which the comparison exposes.
//
// MVP scope: exactly two participants, VP8 video + Opus audio.

'use strict';

(function(global) {
    const C = global.SozvonE2EECrypto;

    /**
     * @param {ServerConnection} sc
     * @constructor
     */
    function E2EE(sc) {
        this.sc = sc;
        this.supported = (typeof RTCRtpScriptTransform !== 'undefined') && !!C;
        /** @type {Worker} */
        this.worker = null;
        /** @type {Set<string>} other participants' ids */
        this.users = new Set();

        // Whether the group refuses connections that cannot be encrypted
        // (the operator's "require encryption" option).  Set from galene.js.
        this.require = false;

        this.peer = null;
        this.role = null;            // 'initiator' | 'responder'
        this.startingFor = null;
        this.keyPair = null;
        this.myPub = null;           // Uint8Array
        this.peerPub = null;
        this.peerCommit = null;      // initiator stores the responder's commitment
        this.secret = null;
        this.peerSupports = null;    // null unknown | true | false (peer can encrypt)
        this.chatKey = null;         // AES-GCM key for two-party chat

        // idle|handshaking|established|failed|unencrypted|blocked
        this.state = 'idle';
        this.detail = null;
        /** @type {string[]} */
        this.sas = null;

        /** @type {(this: E2EE, sas: string[]) => void} */
        this.onsas = null;
        /** @type {(this: E2EE, state: string, detail: string) => void} */
        this.onstate = null;
    }

    E2EE.prototype.ensureWorker = function() {
        if(!this.worker) {
            this.worker = new Worker('/e2ee-worker.js');
            this.worker.onmessage = (e) => {
                if(e.data && e.data.type === 'error')
                    console.warn('E2EE worker:', e.data.op, e.data.message);
            };
        }
        return this.worker;
    };

    E2EE.prototype.setState = function(state, detail) {
        this.state = state;
        this.detail = detail || null;
        if(this.onstate)
            this.onstate.call(this, state, this.detail);
    };

    // ---- participant tracking (driven by galene.js user events) -------------

    E2EE.prototype.addUser = function(id) {
        if(id === this.sc.id)
            return;
        this.users.add(id);
        this.recompute();
    };

    E2EE.prototype.delUser = function(id) {
        this.users.delete(id);
        if(id === this.peer)
            this.resetPeer();
        this.recompute();
    };

    E2EE.prototype.recompute = function() {
        if(this.users.size === 0) {
            this.resetPeer();
            this.setState('idle');
            return;
        }
        if(this.users.size >= 2) {
            // Pairwise ECDH only authenticates two parties: a call with three
            // or more cannot be end-to-end encrypted with this scheme.
            this.resetPeer();
            this.downgrade('multipeer');
            return;
        }
        // Exactly one peer.
        let peer = [...this.users][0];
        if(!this.supported) {
            // This browser cannot encrypt at all.  Tell the peer so it does
            // not sit waiting for a handshake, and reflect the situation.
            this.peer = peer;
            this.announceNoCrypto();
            this.downgrade('unsupported');
            return;
        }
        this.startWith(peer);
    };

    // Move to the unencrypted-but-allowed state, or refuse outright when the
    // group requires encryption.  Never leaves secure media flowing in clear.
    E2EE.prototype.downgrade = function(reason) {
        if(this.require) {
            this.setWorkerMode(false);
            this.setState('blocked', reason);
        } else {
            this.setWorkerMode(true);
            this.setState('unencrypted', reason);
        }
    };

    // Tell the worker to forward frames unchanged (cleartext) or to
    // encrypt/decrypt them.  No-op when we cannot encrypt (no worker).
    E2EE.prototype.setWorkerMode = function(cleartext) {
        if(this.supported && this.worker)
            this.worker.postMessage({type: 'mode', cleartext: !!cleartext});
    };

    // Signal to the single peer that we cannot do end-to-end encryption.
    E2EE.prototype.announceNoCrypto = function() {
        this.send({t: 'nocrypto'});
    };

    E2EE.prototype.resetPeer = function() {
        this.peer = null;
        this.role = null;
        this.startingFor = null;
        this.keyPair = null;
        this.myPub = null;
        this.peerPub = null;
        this.peerCommit = null;
        this.secret = null;
        this.sas = null;
        this.peerSupports = null;
        this.chatKey = null;
        if(this.worker) {
            this.worker.postMessage({type: 'clear'});
            // Safe default: drop unkeyed frames rather than leak cleartext.
            this.worker.postMessage({type: 'mode', cleartext: false});
        }
    };

    // ---- handshake ----------------------------------------------------------

    E2EE.prototype.startWith = async function(peer) {
        if(!this.supported)
            return;
        if(this.peer === peer && (this.keyPair || this.startingFor === peer))
            return;
        this.resetPeer();
        this.peer = peer;
        this.startingFor = peer;
        // Deterministic, symmetric role assignment.  The responder commits to
        // its public key first, which stops a man-in-the-middle from choosing
        // its keys to force a matching SAS.
        this.role = (this.sc.id < peer) ? 'initiator' : 'responder';
        this.setState('handshaking');
        this.ensureWorker();
        // Drop unkeyed frames during the handshake; never forward cleartext.
        this.setWorkerMode(false);

        let kp = await C.generateKeyPair();
        if(this.peer !== peer)
            return; // peer changed while generating
        this.keyPair = kp;
        this.myPub = await C.exportPublic(kp.publicKey);
        this.startingFor = null;

        this.send({t: 'hello'});
        if(this.role === 'responder')
            this.send({t: 'commit', commit: C.b64(await C.commit(this.myPub))});
    };

    E2EE.prototype.send = function(payload) {
        if(this.peer)
            this.sc.userMessage('e2ee', this.peer, payload, true);
    };

    /**
     * Handle an incoming 'e2ee' user message.  Called from galene.js.
     * @param {string} from
     * @param {any} payload
     */
    E2EE.prototype.onMessage = async function(from, payload) {
        if(!payload)
            return;
        // Only talk to the single current peer.
        if(this.users.size !== 1 || from !== [...this.users][0])
            return;
        if(!this.supported) {
            // We cannot encrypt: let the peer know and reflect the state.
            this.peer = from;
            this.announceNoCrypto();
            this.downgrade('unsupported');
            return;
        }
        if(payload.t === 'nocrypto') {
            // The peer cannot encrypt; the call cannot be end-to-end encrypted.
            this.peer = from;
            this.peerSupports = false;
            this.downgrade('peer-unsupported');
            return;
        }
        if(this.peer !== from || !this.keyPair)
            await this.startWith(from);
        // Once established, ignore stray/duplicate handshake traffic; a genuine
        // restart arrives as a leave+join (new user id) via del/addUser.
        if(this.state === 'established' || this.state === 'failed')
            return;
        if(!this.myPub)
            return;

        switch(payload.t) {
        case 'hello':
            if(this.role === 'responder')
                this.send({t: 'commit', commit: C.b64(await C.commit(this.myPub))});
            break;
        case 'commit':
            if(this.role === 'initiator') {
                this.peerCommit = C.unb64(payload.commit);
                this.send({t: 'dh', pub: C.b64(this.myPub)});
            }
            break;
        case 'dh': {
            let pub = C.unb64(payload.pub);
            if(this.role === 'responder') {
                this.peerPub = pub;
                this.send({t: 'dh', pub: C.b64(this.myPub)});
                await this.finalize();
            } else {
                if(!this.peerCommit)
                    return;
                let h = await C.commit(pub);
                if(!C.bytesEqual(h, this.peerCommit)) {
                    // Commitment broken: the responder's key was substituted.
                    this.setState('failed', 'commitment');
                    return;
                }
                this.peerPub = pub;
                await this.finalize();
            }
            break;
        }
        }
    };

    E2EE.prototype.finalize = async function() {
        this.secret = await C.agree(
            this.keyPair.privateKey, await C.importPublic(this.peerPub),
        );
        let iPub = this.role === 'initiator' ? this.myPub : this.peerPub;
        let rPub = this.role === 'initiator' ? this.peerPub : this.myPub;

        // One key per (sender, media kind); each gets its own IV space.
        let owners = [this.sc.id, this.peer];
        let kinds = ['audio', 'video'];
        for(let owner of owners) {
            for(let kind of kinds) {
                let streamId = owner + '|' + kind;
                let key = await C.deriveMediaKey(this.secret, iPub, rPub, streamId);
                this.ensureWorker().postMessage(
                    {type: 'key', streamId: streamId, keyId: 0, key: key},
                );
            }
        }

        // Key for two-party text chat, bound to the same transcript.
        this.chatKey = await C.deriveChatKey(this.secret, iPub, rPub);

        // Switch the worker to encrypt/decrypt (it may have been forwarding
        // cleartext while this call was momentarily a >2-party or downgraded).
        this.setWorkerMode(false);

        this.sas = await C.deriveSAS(this.secret, iPub, rPub);
        this.peerSupports = true;
        this.setState('established');
        if(this.onsas)
            this.onsas.call(this, this.sas);
    };

    // ---- transform wiring (called from galene.js / protocol.js) -------------

    E2EE.prototype.attachSender = function(sender, kind) {
        if(!this.supported || !sender)
            return;
        try {
            sender.transform = new RTCRtpScriptTransform(this.ensureWorker(), {
                operation: 'encrypt',
                streamId: this.sc.id + '|' + kind,
                kind: kind,
            });
        } catch(e) {
            console.error('E2EE attachSender:', e);
        }
    };

    E2EE.prototype.attachReceiver = function(receiver, sourceId, kind) {
        if(!this.supported || !receiver)
            return;
        try {
            receiver.transform = new RTCRtpScriptTransform(this.ensureWorker(), {
                operation: 'decrypt',
                streamId: sourceId + '|' + kind,
                kind: kind,
            });
        } catch(e) {
            console.error('E2EE attachReceiver:', e);
        }
    };

    // ---- text chat ----------------------------------------------------------

    /** Whether outgoing chat can be end-to-end encrypted right now. */
    E2EE.prototype.canChat = function() {
        return this.state === 'established' && !!this.chatKey && !!this.peer;
    };

    /**
     * Encrypt and send a chat message to the single peer over the (un-stored)
     * user-message channel.  Returns true if it was sent encrypted, false if
     * the caller should fall back to a normal cleartext chat message.
     * @param {string} kind - '' or 'me'
     * @param {string} text
     * @returns {Promise<boolean>}
     */
    E2EE.prototype.sendChat = async function(kind, text) {
        if(!this.canChat())
            return false;
        let enc = await C.encryptChat(this.chatKey, text);
        this.sc.userMessage('e2eechat', this.peer,
                            {kind: kind || '', iv: enc.iv, ct: enc.ct}, true);
        return true;
    };

    /**
     * Decrypt a received 'e2eechat' user message.
     * @param {any} payload
     * @returns {Promise<{kind: string, text: string}|null>}
     */
    E2EE.prototype.decryptChat = async function(payload) {
        if(!this.chatKey || !payload || !payload.iv || !payload.ct)
            return null;
        let text = await C.decryptChat(this.chatKey, payload.iv, payload.ct);
        return {kind: payload.kind || '', text: text};
    };

    global.SozvonE2EE = E2EE;
})(self);
