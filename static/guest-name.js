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

// guest-name.js -- keep a guest's name away from the server.  (Sozvon)
//
// In a room with end-to-end encryption a guest joins under a pseudonym the
// browser makes up, and the name they typed travels to the other side only
// inside the encrypted channel, once the handshake is done.  The server --
// and whoever runs it -- sees the pseudonym and nothing else.
//
// A pseudonym is never shown: until the real name arrives the interface
// shows nothing at all where a name would go.  So the pseudonym has a form a
// person would not type, and everything that displays a name asks this file
// what to show.
//
// The name rides the encrypted chat channel as a message of kind "name".
// That kind label travels outside the ciphertext, so the plaintext carries a
// marker of its own: a message counts as a name only when both agree, and a
// name relabelled as chat, or chat relabelled as a name, is dropped.

(function(global) {
    'use strict';

    const PREFIX = '~';
    const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';
    const LENGTH = 10;
    const PATTERN = /^~[a-z2-9]{10}$/;
    const KIND = 'name';
    const MARK = '\u0001sozvon-name\u0001';
    const MAX = 64;

    /**
     * @param {function(Uint8Array): Uint8Array} [random] - fills an array
     *     with random bytes; crypto.getRandomValues by default
     * @returns {string}
     */
    function makePseudonym(random) {
        let bytes = new Uint8Array(LENGTH);
        (random || (b => global.crypto.getRandomValues(b)))(bytes);
        let s = PREFIX;
        for(let i = 0; i < LENGTH; i++)
            s += ALPHABET[bytes[i] % ALPHABET.length];
        return s;
    }

    /**
     * @param {any} username
     * @returns {boolean}
     */
    function isPseudonym(username) {
        return typeof username === 'string' && PATTERN.test(username);
    }

    /**
     * A name as it may be shown: no control characters, spaces collapsed,
     * bounded length.
     *
     * @param {any} name
     * @returns {string}
     */
    function clean(name) {
        if(typeof name !== 'string')
            return '';
        return name.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, '')
            .replace(/\s+/g, ' ').trim().slice(0, MAX);
    }

    /**
     * The plaintext to encrypt for a name message.
     *
     * @param {string} name
     * @returns {string}
     */
    function pack(name) {
        return MARK + clean(name);
    }

    /**
     * Sort a decrypted chat-channel message.
     *
     * @param {string} kind - the kind label that came with it
     * @param {any} text - the decrypted text
     * @returns {{type: 'name', name: string}|{type: 'chat'}|{type: 'drop'}}
     */
    function classify(kind, text) {
        let marked = typeof text === 'string' && text.startsWith(MARK);
        if(kind === KIND) {
            let name = marked ? clean(text.slice(MARK.length)) : '';
            return name ? {type: 'name', name: name} : {type: 'drop'};
        }
        if(marked)
            return {type: 'drop'};
        return {type: 'chat'};
    }

    /**
     * The names received during this call, by user id.  Kept in memory
     * only.
     *
     * @constructor
     */
    function Book() {
        /** @type {Map<string, string>} */
        this.names = new Map();
    }

    /**
     * @param {string} id
     * @param {string} name
     * @returns {boolean} whether it changed
     */
    Book.prototype.set = function(id, name) {
        name = clean(name);
        if(!name || this.names.get(id) === name)
            return false;
        this.names.set(id, name);
        return true;
    };

    /** @param {string} id */
    Book.prototype.delete = function(id) {
        this.names.delete(id);
    };

    Book.prototype.clear = function() {
        this.names.clear();
    };

    /**
     * What to show for a user: their username, unless it is a pseudonym, in
     * which case the name they sent, or nothing yet.
     *
     * @param {string} id
     * @param {any} username
     * @returns {string}
     */
    Book.prototype.shown = function(id, username) {
        if(isPseudonym(username))
            return this.names.get(id) || '';
        return typeof username === 'string' ? username : '';
    };

    /**
     * The name a link carries after '#', where the browser never sends it
     * to the server.  Returns '' if there is none.
     *
     * @param {string} hash - location.hash
     * @returns {string}
     */
    function nameFromHash(hash) {
        if(typeof hash !== 'string' || hash.length < 2)
            return '';
        let params;
        try {
            params = new URLSearchParams(hash.slice(1));
        } catch(e) {
            return '';
        }
        return clean(params.get('name') || '');
    }

    /**
     * @param {string} url
     * @param {string} name
     * @returns {string} url with the name after '#'
     */
    function withNameInHash(url, name) {
        name = clean(name);
        if(!name)
            return url;
        let base = url.split('#')[0];
        return base + '#' + new URLSearchParams({name: name}).toString();
    }

    const api = {
        KIND, MAX, makePseudonym, isPseudonym, clean, pack, classify, Book,
        nameFromHash, withNameInHash,
    };

    global.SozvonGuestName = api;
    if(typeof module !== 'undefined' && module.exports)
        module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
