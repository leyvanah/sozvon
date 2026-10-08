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

// password-change.js -- an operator changes their own password from the
// operator panel.  (Sozvon)
//
// The server side is upstream's: POST the new password to
// /galene-api/v0/.groups/<group>/.users/<user>/.password, authenticated with
// the user's own current password over HTTP Basic.  The server re-hashes it
// and rewrites the group file, which it only does where the configuration
// sets writableGroups -- the status says so as canChangePassword.  Upstream
// offers it as a bare page in a new tab; this module is what the panel's form
// needs around that call, kept apart so that it can be tested without a
// browser.

(function(global) {
    'use strict';

    // Shorter than this is refused before it reaches the server.  An
    // operator's password guards every client's room.
    const MIN_LENGTH = 8;
    // The server stores a bcrypt hash, and bcrypt takes 72 bytes at most --
    // 36 characters of Cyrillic.  Longer is refused here rather than by a
    // bare server error.
    const MAX_BYTES = 72;

    /**
     * Why the form cannot be sent, or null if it can.
     *
     * @param {string} current
     * @param {string} next
     * @param {string} again
     * @returns {null|'empty'|'mismatch'|'short'|'long'|'same'}
     */
    function check(current, next, again) {
        if(!current || !next || !again)
            return 'empty';
        if(next !== again)
            return 'mismatch';
        if([...next].length < MIN_LENGTH)
            return 'short';
        if(new TextEncoder().encode(next).length > MAX_BYTES)
            return 'long';
        if(next === current)
            return 'same';
        return null;
    }

    /**
     * Base64 of a string's UTF-8 bytes.  btoa() alone throws on anything
     * outside Latin-1, which a Russian password is; the server decodes the
     * header as UTF-8.
     *
     * @param {string} s
     * @returns {string}
     */
    function base64(s) {
        let bytes = new TextEncoder().encode(s);
        let bin = '';
        for(let b of bytes)
            bin += String.fromCharCode(b);
        return btoa(bin);
    }

    /**
     * @param {string} user
     * @param {string} password
     * @returns {string}
     */
    function basicAuth(user, password) {
        return 'Basic ' + base64(user + ':' + password);
    }

    /**
     * @param {string} group
     * @param {string} user
     * @returns {string}
     */
    function passwordURL(group, user) {
        let g = group.split('/').map(encodeURIComponent).join('/');
        return `/galene-api/v0/.groups/${g}/.users/` +
            `${encodeURIComponent(user)}/.password`;
    }

    /**
     * What a reply to the change means for the user.  401 is also what the
     * server answers when it may not write the group file; the form is only
     * offered where it may, so that is read as a wrong password.
     *
     * @param {number} status
     * @returns {'ok'|'wrong'|'banned'|'error'}
     */
    function outcome(status) {
        if(status >= 200 && status < 300)
            return 'ok';
        if(status === 401 || status === 403)
            return 'wrong';
        if(status === 429)
            return 'banned';
        return 'error';
    }

    /**
     * Change the password.
     *
     * @param {(url: string, init: Object) => Promise<{status: number}>} fetch
     * @param {string} group
     * @param {string} user
     * @param {string} current
     * @param {string} next
     * @returns {Promise<'ok'|'wrong'|'banned'|'error'>}
     */
    async function change(fetch, group, user, current, next) {
        let r = await fetch(passwordURL(group, user), {
            method: 'POST',
            // Only the credentials we give: never a cached Basic login.
            credentials: 'omit',
            headers: {
                'Content-Type': 'text/plain; charset=utf-8',
                'Authorization': basicAuth(user, current),
            },
            body: next,
        });
        return outcome(r.status);
    }

    const api = {MIN_LENGTH, MAX_BYTES, check, basicAuth, passwordURL, outcome, change};

    global.SozvonPasswordChange = api;
    if(typeof module !== 'undefined' && module.exports)
        module.exports = api;
})(typeof self !== 'undefined' ? self : globalThis);
