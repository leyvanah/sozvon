// Copyright (c) 2020 by Juliusz Chroboczek.

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

'use strict';

/**
 * Sozvon: FOUC guard cleanup.  galene.html hides every content block up front
 * with the `hidden` attribute (the browser honours it with no author CSS, so
 * the strict CSP — which forbids inline <style> — cannot block it) and shows a
 * loading overlay (#app-loading) with a spinner.  Once everything has loaded we
 * clear those `hidden` attributes and drop the overlay.  We run on 'load' (not
 * DOMContentLoaded) so galene.css has certainly applied and we never uncover an
 * unstyled page; the timeout is a safety net.
 */
(function removeLoadingOverlay() {
    function hide() {
        // galene.html sets `hidden` only on the FOUC-guard blocks, so clearing
        // every [hidden] here is safe.
        document.querySelectorAll('[hidden]').forEach(function(el) {
            el.removeAttribute('hidden');
        });
        let o = document.getElementById('app-loading');
        if(o)
            o.remove();
    }
    if(document.readyState === 'complete')
        hide();
    else
        window.addEventListener('load', hide);
    setTimeout(hide, 10000);
})();

/**
 * The name of the group that we join.
 *
 * @type {string}
 */
let group;

/**
 * The connection to the server.
 *
 * @type {ServerConnection}
 */
let serverConnection;

/*
 * Sozvon — automatic reconnection.  When an established connection drops
 * unexpectedly (a network blip, a server restart) we keep the in-call UI,
 * show a "reconnecting" banner and retry with exponential backoff, rather
 * than dumping the user back to the login screen.  A deliberate hang-up or a
 * server refusal clears `wantConnected`, which stops the retries.
 */
/** Whether we intend to stay in the call (false after a deliberate leave). */
let wantConnected = false;
/** True while a reconnect cycle is in progress. */
let reconnecting = false;
/** Consecutive reconnect attempts, used for the backoff and the give-up cap. */
let reconnectAttempt = 0;
/** The pending reconnect timer id, if any. */
let reconnectTimer = null;
/** The join parameters of the dropped connection, replayed to rejoin. */
let reconnectLastJoin = null;
const RECONNECT_MAX_ATTEMPTS = 15;
const RECONNECT_MAX_DELAY = 30000;

/**
 * The group status.  This is set twice, once over HTTP in the start
 * function in order to obtain the WebSocket address, and a second time
 * after joining.
 *
 * @type {Record<string,any>}
 */
let groupStatus = {};

/**
 * Whether "remember me" was ticked at join time; checked on a successful join
 * to decide whether to mint a remember-token (operators only).
 * @type {{group: string, username: string, remember: boolean}|null}
 */
let pendingRemember = null;

/**
 * Set while a maketoken request is in flight specifically to remember this
 * device, so the token reply is stored instead of shown as an invite link.
 * "previous" is the remember-token being replaced, revoked once the new one
 * is stored.  "includeSubgroups" records the scope it was minted with, so the
 * stored entry knows whether it also covers the hub's child rooms.
 * @type {{group: string, username: string, previous: string|null,
 *         includeSubgroups: boolean}|null}
 */
let storingRememberToken = null;

/** True while the current join is an auto-login from a stored remember-token. */
let usingRememberToken = false;

/**
 * Set while a maketoken request is in flight to mint the operator's session
 * token (covers the hub's child rooms), so the reply is stored in
 * sessionStorage instead of shown as an invite link.
 * @type {{hub: string, username: string}|null}
 */
let storingSessionToken = null;

/**
 * True if we need to request a password.
 *
 * @type {boolean}
 */
let pwAuth = false;

/**
 * The token we use to login.  This is erased as soon as possible.
 *
 * @type {string}
 */
let token = null;

/**
 * The state of the login automaton.
 *
 * @type {"probing" | "need-username" | "success"}
 */
let probingState = null;

// Set for one join() call by start(), when we navigated here straight from
// the operator dashboard's "Join" button (see operatorJoin): that click is
// itself the gesture browsers require to allow autoplay on the page it
// navigates to, so this join can skip the token probe-then-reshow dance
// (case null below) that ordinary invite links need. (Sozvon)
let skipAutoplayProbe = false;

// "Remember me on this device" stores a revocable, expiring server-side token
// (not the password) per group in localStorage.  The token is minted on login
// via maketoken with the user's own permissions; it is scoped to the group,
// expires (30 days), and can be revoked server-side.  Only issued to operators
// (see gotJoined), never to ordinary guests.
/**
 * The stored group whose remember-token covers `group`: the group's own entry
 * when there is one, otherwise a hub entry minted with subgroup scope.  That
 * is what lets an operator who ticked "remember me" on the hub open a client
 * link -- a per-client child room, where the checkbox is deliberately not
 * offered -- without retyping the password, giving the remember-token the
 * reach the session token already has.  Entries written before the scope was
 * recorded carry no flag and stay exact-only: the server refuses a
 * hierarchical token they were not minted as.  Most specific hub wins.
 * (Sozvon)
 * @param {string} group
 * @returns {string|null}
 */
function rememberTokenGroup(group) {
    try {
        let all = JSON.parse(window.localStorage.getItem('sozvon.remember'));
        if(!all)
            return null;
        if(all[group] && all[group].token)
            return group;
        let best = null;
        for(let g in all) {
            let t = all[g];
            if(t && t.token && t.includeSubgroups &&
               group.startsWith(g + '/') &&
               (best === null || g.length > best.length))
                best = g;
        }
        return best;
    } catch(e) {
        return null;
    }
}

function loadRememberToken(group) {
    try {
        let key = rememberTokenGroup(group);
        if(key === null)
            return null;
        let all = JSON.parse(window.localStorage.getItem('sozvon.remember'));
        let t = all && all[key];
        if(!t || !t.token)
            return null;
        // Drop it client-side once expired, so we don't try a dead token.
        if(t.expires && new Date(t.expires).getTime() < Date.now()) {
            clearRememberToken(key);
            return null;
        }
        return t;
    } catch(e) {
        return null;
    }
}

function saveRememberToken(group, token, username, expires, includeSubgroups) {
    try {
        let all = JSON.parse(
            window.localStorage.getItem('sozvon.remember')) || {};
        all[group] = {
            token: token, username: username, expires: expires,
            includeSubgroups: !!includeSubgroups,
        };
        window.localStorage.setItem(
            'sozvon.remember', JSON.stringify(all));
    } catch(e) {
        console.warn("Couldn't store token:", e);
    }
}

function clearRememberToken(group) {
    try {
        let all = JSON.parse(window.localStorage.getItem('sozvon.remember'));
        if(all && (group in all)) {
            delete(all[group]);
            window.localStorage.setItem(
                'sozvon.remember', JSON.stringify(all));
        }
    } catch(e) {
    }
}

/**
 * Number of token lists we expect as replies to a silent revocation (the
 * server answers deletetoken with the refreshed list).  Outside the operator
 * dashboard such a list is printed into the chat -- that is what /listtokens
 * is for -- so these replies are swallowed instead.  A count rather than a
 * flag, so two revocations in flight don't swallow one reply too few; it is
 * reset with the connection, since a reply may never arrive (we revoke on
 * logout, just before the socket closes). (Sozvon)
 */
let silentTokenLists = 0;

/**
 * Revoke a stateful token server-side.  Forgetting a token client-side only
 * hides it: it stays valid until it expires, and a remember-token carries the
 * operator's own permissions, so it must actually be deleted.  Silently does
 * nothing unless we are in the token's group with the rights to delete it.
 * (Sozvon)
 * @param {string} [tok]
 */
function revokeToken(tok) {
    if(!tok || !serverConnection || !serverConnection.permissions)
        return;
    if(serverConnection.permissions.indexOf('op') < 0 ||
       serverConnection.permissions.indexOf('token') < 0)
        return;
    try {
        serverConnection.groupAction('deletetoken', {token: tok});
        silentTokenLists++;
    } catch(e) {
        console.warn("Couldn't revoke token:", e);
    }
}

// The operator "session token" is a short-lived (12h) hierarchical token an
// operator mints for their own username on their hub, covering its child
// rooms.  It lives in sessionStorage (per tab, so it follows the operator as
// they navigate hub -> child -> hub, and is gone when the tab closes), and
// auto-authenticates the operator on child pages and on return to the hub.
/**
 * @param {string} grp - the current group (hub or one of its child rooms)
 * @returns {{hub: string, token: string, username: string, expires: string}|null}
 */
function loadOperatorSession(grp) {
    try {
        let s = JSON.parse(
            window.sessionStorage.getItem('sozvon.operatorSession'));
        if(!s || !s.token || !s.hub)
            return null;
        // the token covers the hub and its subgroups only
        if(!(grp === s.hub || grp.startsWith(s.hub + '/')))
            return null;
        if(s.expires && new Date(s.expires).getTime() < Date.now()) {
            window.sessionStorage.removeItem('sozvon.operatorSession');
            return null;
        }
        return s;
    } catch(e) {
        return null;
    }
}

function saveOperatorSession(hub, token, username, expires) {
    try {
        window.sessionStorage.setItem('sozvon.operatorSession',
            JSON.stringify({
                hub: hub, token: token,
                username: username, expires: expires,
            }));
    } catch(e) {
        console.warn("Couldn't store operator session:", e);
    }
}

/**
 * getElementById, then assert that the result is an HTMLSelectElement.
 *
 * @param {string} id
 */
function getSelectElement(id) {
    let elt = document.getElementById(id);
    if(!elt || !(elt instanceof HTMLSelectElement))
        throw new Error(`Couldn't find ${id}`);
    return elt;
}

/**
 * getElementById, then assert that the result is an HTMLInputElement.
 *
 * @param {string} id
 */
function getInputElement(id) {
    let elt = document.getElementById(id);
    if(!elt || !(elt instanceof HTMLInputElement))
        throw new Error(`Couldn't find ${id}`);
    return elt;
}

/**
 * getElementById, then assert that the result is an HTMLButtonElement.
 *
 * @param {string} id
 */
function getButtonElement(id) {
    let elt = document.getElementById(id);
    if(!elt || !(elt instanceof HTMLButtonElement))
        throw new Error(`Couldn't find ${id}`);
    return elt;
}

/**
 * Ensure that the UI reflects the stored settings.
 */
function reflectSettings() {
    let settings = getSettings();
    let store = false;

    setLocalMute(settings.localMute);

    let videoselect = getSelectElement('videoselect');
    if(!settings.hasOwnProperty('video') ||
       !selectOptionAvailable(videoselect, settings.video)) {
        settings.video = selectOptionDefault(videoselect);
        store = true;
    }
    videoselect.value = settings.video;

    let audioselect = getSelectElement('audioselect');
    if(!settings.hasOwnProperty('audio') ||
       !selectOptionAvailable(audioselect, settings.audio)) {
        settings.audio = selectOptionDefault(audioselect);
        store = true;
    }
    audioselect.value = settings.audio;

    // Speaker / output: default to the system speaker ('') unless the user
    // explicitly picked a device that still exists.  Soft lookup so a missing
    // #outputselect (older cached HTML) can't throw here. (Sozvon)
    let outputselect = document.getElementById('outputselect');
    if(outputselect instanceof HTMLSelectElement) {
        if(settings.hasOwnProperty('output') &&
           selectOptionAvailable(outputselect, settings.output)) {
            outputselect.value = settings.output;
        } else {
            if(settings.hasOwnProperty('output') && settings.output !== '') {
                settings.output = '';
                store = true;
            }
            outputselect.value = '';
        }
    }

    if(settings.hasOwnProperty('filter')) {
        getSelectElement('filterselect').value = settings.filter;
    } else {
        let s = getSelectElement('filterselect').value;
        if(s) {
            settings.filter = s;
            store = true;
        }
    }

    // The rotation has no control to reflect any more — two buttons that turn
    // the picture by a quarter, not a list of angles — but the stored value is
    // still the absolute angle, so make sure there is one.
    if(!settings.hasOwnProperty('videoRotation')) {
        settings.videoRotation = '0';
        store = true;
    }

    if(settings.hasOwnProperty('autoRotate')) {
        getInputElement('autorotatebox').checked = settings.autoRotate;
    } else {
        settings.autoRotate = getInputElement('autorotatebox').checked;
        store = true;
    }

    if(settings.hasOwnProperty('request')) {
        getSelectElement('requestselect').value = settings.request;
    } else {
        settings.request = getSelectElement('requestselect').value;
        store = true;
    }

    if(settings.hasOwnProperty('send')) {
        getSelectElement('sendselect').value = settings.send;
    } else {
        settings.send = getSelectElement('sendselect').value;
        store = true;
    }

    if(settings.hasOwnProperty('simulcast')) {
        getSelectElement('simulcastselect').value = settings.simulcast
    } else {
        settings.simulcast = getSelectElement('simulcastselect').value;
        store = true;
    }

    if(settings.hasOwnProperty('blackboardMode')) {
        getInputElement('blackboardbox').checked = settings.blackboardMode;
    } else {
        settings.blackboardMode = getInputElement('blackboardbox').checked;
        store = true;
    }

    if(settings.hasOwnProperty('mirrorView')) {
        getInputElement('mirrorbox').checked = settings.mirrorView;
    } else {
        settings.mirrorView = getInputElement('mirrorbox').checked;
        store = true;
    }

    if(settings.hasOwnProperty('activityDetection')) {
        getInputElement('activitybox').checked = settings.activityDetection;
    } else {
        settings.activityDetection = getInputElement('activitybox').checked;
        store = true;
    }

    if(settings.hasOwnProperty('displayAll')) {
        getInputElement('displayallbox').checked = settings.displayAll;
    } else {
        settings.displayAll = getInputElement('displayallbox').checked;
        store = true;
    }

    if(settings.hasOwnProperty('preprocessing')) {
        getInputElement('preprocessingbox').checked = settings.preprocessing;
    } else {
        settings.preprocessing = getInputElement('preprocessingbox').checked;
        store = true;
    }

    if(settings.hasOwnProperty('hqaudio')) {
        getInputElement('hqaudiobox').checked = settings.hqaudio;
    } else {
        settings.hqaudio = getInputElement('hqaudiobox').checked;
        store = true;
    }

    if(settings.hasOwnProperty('multiShare')) {
        getInputElement('multisharebox').checked = settings.multiShare;
    } else {
        settings.multiShare = getInputElement('multisharebox').checked;
        store = true;
    }

    if(settings.hasOwnProperty('knockSound')) {
        getInputElement('knocksoundbox').checked = settings.knockSound;
    } else {
        settings.knockSound = getInputElement('knocksoundbox').checked;
        store = true;
    }

    if(store)
        storeSettings(settings);
}

/**
 * Returns true if we should use the mobile layout.  This should be kept
 * in sync with the CSS.
 */
function isMobileLayout() {
    return !!window.matchMedia('only screen and (max-width: 1024px)').matches
}

/**
 * Conditionally hide the video pane.  If force is true, hide it even if
 * there are videos.
 *
 * @param {boolean} [force]
 */
function hideVideo(force) {
    let mediadiv = document.getElementById('peers');
    if(mediadiv.childElementCount > 0 && !force) {
        // Video is still on screen (e.g. you turned your own camera off but are
        // still watching the other side): keep auto-immersive armed so it works
        // for an incoming-only call too, not just when you publish video. (Sozvon)
        scheduleChromeHide();
        return;
    }
    setVisibility('video-container', false);
    cancelChromeHide();   // no video pane left: nothing to auto-hide
    // Sozvon: immersive mode (nav-hidden) hides the top bar and relies on tapping
    // the video to bring it back.  Once the video pane is gone there is no tap
    // target left — on mobile #right has no footprint of its own — so the bar
    // would stay stranded off-screen with no way to recover it.  Whenever the
    // video is hidden, always restore the chrome so the user is never stuck.
    if(document.body.classList.contains('nav-hidden'))
        toggleChrome(false);
    scheduleReconsiderDownRate();
}

/**
 * Show the video pane.
 */
function showVideo() {
    let hasmedia = document.getElementById('peers').childElementCount > 0;
    if(isMobileLayout()) {
        setVisibility('show-video', false);
        setVisibility('collapse-video', hasmedia);
    }
    setVisibility('video-container', hasmedia);
    // A call is now on screen: start the auto-immersive countdown.
    if(hasmedia)
        scheduleChromeHide();
    scheduleReconsiderDownRate();
}

/**
 * Returns true if we are running on Safari.
 */
function isSafari() {
    let ua = navigator.userAgent.toLowerCase();
    return ua.indexOf('safari') >= 0 && ua.indexOf('chrome') < 0;
}

/**
 * Returns true if we are running on Firefox.
 */
function isFirefox() {
    let ua = navigator.userAgent.toLowerCase();
    return ua.indexOf('firefox') >= 0;
}

/**
 * setConnected is called whenever we connect or disconnect to the server.
 *
 * @param{boolean} connected
 */
function setConnected(connected) {
    let userbox = document.getElementById('profile');
    let connectionbox = document.getElementById('login-container');
    if(connected) {
        clearChat();
        userbox.classList.remove('invisible');
        connectionbox.classList.add('invisible');
        displayUsername();
        window.onresize = function(e) {
            scheduleReconsiderDownRate();
        }
    } else {
        userbox.classList.add('invisible');
        connectionbox.classList.remove('invisible');
        hideVideo();
        resetCallTimer();       // the call is over (Sozvon)
        unreadChat = false;
        clearKnocks();          // ... and nobody is waiting at its door
        refreshPanelAlert();
        leaveOperatorRoom();   // stop the dashboard poll if it was running
        silentTokenLists = 0;  // replies we will never receive now
        window.onresize = null;
        // Only re-evaluate the pre-join guard on disconnect: on connect the user
        // is still authenticating and the sidebar must stay hidden until join
        // succeeds (see gotJoined 'join'/'change' which calls reflectPreJoin).
        reflectPreJoin();
        reflectRejoinOption();
    }
}

/**
 * Shows a one-click "Rejoin as X" action in place of the full login form
 * when we still hold credentials from earlier in this tab -- reconnectLastJoin
 * survives a deliberate hang-up (only a page reload or picking "log in with
 * different credentials" drops it), so leaving a call no longer forces a full
 * re-login. Skipped mid token-probe / remember-token flows, which already
 * drive their own version of this. (Sozvon)
 */
function reflectRejoinOption() {
    let show = !!reconnectLastJoin && !usingRememberToken && probingState === null;
    setVisibility('rejoin-container', show);
    setVisibility('normal-login-fields', !show);
    setVisibility('connect-container', !show);
    if(show) {
        let elt = document.getElementById('rejoin-username');
        if(elt)
            elt.textContent = reconnectLastJoin.username || '';
    }
}

/**
 * Called when we connect to the server.
 *
 * @this {ServerConnection}
 */
async function gotConnected() {
    if(reconnecting && reconnectLastJoin) {
        // A reconnect: keep the existing in-call UI and chat, and rejoin the
        // group with the saved credentials instead of the login form. (Sozvon)
        await rejoinAfterReconnect();
        return;
    }
    setConnected(true);
    await join();
}

/**
 * Sets the href field of the "change password" link.
 *
 * @param {string} username
 */
function setChangePassword(username) {
    let s = document.getElementById('chpwspan');
    let a = s.children[0];
    if(!(a instanceof HTMLAnchorElement))
        throw new Error('Bad type for chpwspan');
    if(username) {
        a.href = `/change-password.html?group=${encodeURIComponent(group)}&username=${encodeURIComponent(username)}`;
        a.target = '_blank';
        s.classList.remove('invisible');
    } else {
        a.href = null;
        s.classList.add('invisible');
    }
}

/**
 * Join a group.
 */
async function join() {
    let username = getInputElement('username').value.trim();
    let credentials;
    // A remember-token is bound to the operator who minted it: the server uses
    // the token's username and ignores the one we send. So if the user has
    // edited the name to join as somebody else, drop the token and fall through
    // to a normal name/password login rather than silently joining as the old
    // operator (or being refused for a colliding guest name). (Sozvon)
    if(token && usingRememberToken) {
        let remembered = loadRememberToken(group);
        let rememberedName = (remembered && remembered.username) || '';
        if(username !== rememberedName) {
            token = null;
            usingRememberToken = false;
            probingState = null;
        }
    }
    if(token) {
        pwAuth = false;
        credentials = {
            type: 'token',
            token: token,
        };
        switch(probingState) {
        case null:
            if(groupStatus.operatorRoom) {
                // The operator hub shows a dashboard and requests no media,
                // so there is no autoplay gesture to wait for: join straight
                // to the dashboard (the session token carries the username).
                break;
            }
            if(skipAutoplayProbe) {
                skipAutoplayProbe = false;
                break;
            }
            // when logging in with a token, we need to give the user
            // a chance to interact with the page in order to enable
            // autoplay.  Probe the group first in order to determine if
            // we need a username.  We should really extend the protocol
            // to have a simpler protocol for probing.
            probingState = 'probing';
            username = null;
            break;
        case 'need-username':
        case 'success':
            probingState = null;
            break
        default:
            console.warn(`Unexpected probing state ${probingState}`);
            probingState = null;
            break;
        }
    } else {
        if(probingState !== null) {
            console.warn(`Unexpected probing state ${probingState}`);
            probingState = null;
        }
        let pw = getInputElement('password').value;
        getInputElement('password').value = '';
        let rememberElt = document.getElementById('remember');
        pendingRemember = {
            group: group,
            username: username,
            remember: rememberElt instanceof HTMLInputElement &&
                rememberElt.checked,
        };
        if(!groupStatus.authServer) {
            pwAuth = true;
            credentials = pw;
        } else {
            pwAuth = false;
            credentials = {
                type: 'authServer',
                authServer: groupStatus.authServer,
                location: location.href,
                password: pw,
            };
        }
    }

    try {
        await serverConnection.join(group, username, credentials);
    } catch(e) {
        console.error(e);
        displayError(e);
        serverConnection.close();
    }
}

/**
 * @this {ServerConnection}
 */
function onPeerConnection() {
    if(!getSettings().forceRelay)
        return null;
    let old = this.rtcConfiguration;
    /** @type {RTCConfiguration} */
    let conf = {};
    for(let key in old)
        conf[key] = old[key];
    conf.iceTransportPolicy = 'relay';
    return conf;
}

/**
 * @this {ServerConnection}
 * @param {number} code
 * @param {string} reason
 */
function gotClose(code, reason) {
    closeUpMedia(null, this);
    closeSafariStream();
    if(code !== 1000) {
        console.warn('Socket close', code, reason);
    }

    if(wantConnected && reconnectLastJoin) {
        // An established call dropped unexpectedly: keep the in-call UI and try
        // to reconnect rather than throwing the user back to the login. (Sozvon)
        scheduleReconnect();
        return;
    }

    // Deliberate disconnect, or we never managed to join: show the login UI.
    stopReconnect();
    setConnected(false);
}

/**
 * Show or hide the "reconnecting" banner.  (Sozvon)
 *
 * @param {boolean} on
 */
function showReconnect(on) {
    setVisibility('reconnect-banner', on);
}

/** Schedule the next reconnect attempt with exponential backoff. (Sozvon) */
function scheduleReconnect() {
    reconnecting = true;
    showReconnect(true);
    if(reconnectTimer)
        clearTimeout(reconnectTimer);
    let delay = Math.min(
        RECONNECT_MAX_DELAY, 1000 * Math.pow(2, Math.min(reconnectAttempt, 5)),
    );
    reconnectAttempt++;
    reconnectTimer = setTimeout(reconnectNow, delay);
}

/** Stop any reconnect cycle and hide the banner. (Sozvon) */
function stopReconnect() {
    reconnecting = false;
    reconnectAttempt = 0;
    if(reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    showReconnect(false);
}

/** Perform one reconnect attempt, or give up after too many. (Sozvon) */
async function reconnectNow() {
    reconnectTimer = null;
    if(!wantConnected || !reconnectLastJoin) {
        stopReconnect();
        return;
    }
    if(reconnectAttempt > RECONNECT_MAX_ATTEMPTS) {
        wantConnected = false;
        stopReconnect();
        setConnected(false);
        displayError(Sozvon.i18n.t('toast.reconnectFailed'));
        return;
    }
    // serverConnect() rebuilds the connection and wires the callbacks; on a
    // successful handshake gotConnected() sees `reconnecting` and rejoins.  A
    // failed attempt comes back through gotClose(), which schedules the next.
    try {
        await serverConnect();
    } catch(e) {
        console.error('Reconnect attempt failed', e);
        scheduleReconnect();
    }
}

/** Rejoin the group after a reconnect, using the saved credentials. (Sozvon) */
async function rejoinAfterReconnect() {
    try {
        await serverConnection.join(
            reconnectLastJoin.group, reconnectLastJoin.username,
            reconnectLastJoin.credentials, reconnectLastJoin.data,
        );
    } catch(e) {
        console.error('Rejoin failed', e);
        wantConnected = false;
        stopReconnect();
        setConnected(false);
        displayError(e);
    }
}

/**
 * @this {ServerConnection}
 * @param {Stream} c
 */
function gotDownStream(c) {
    c.onclose = function(replace) {
        if(!replace)
            delMedia(c.localId);
    };
    c.onerror = function(e) {
        console.error(e);
        displayError(e);
    };
    c.ondowntrack = function(track, transceiver, stream) {
        if(e2eeEnabled())
            serverConnection.e2ee.attachReceiver(
                transceiver.receiver, c.source, track.kind);
        setMedia(c);
    };
    c.onnegotiationcompleted = function() {
        resetMedia(c);
    }
    c.onstatus = function(status) {
        setMediaStatus(c);
    };
    c.onstats = gotDownStats;
    if(getSettings().activityDetection)
        c.setStatsInterval(activityDetectionInterval);

    setMedia(c);
}

// Store current browser viewport height in css variable
function setViewportHeight() {
    document.documentElement.style.setProperty(
        '--vh', `${window.innerHeight/100}px`,
    );
    showVideo();
    // Ajust video component size
    resizePeers();
}

// On resize and orientation change, we update viewport height
addEventListener('resize', setViewportHeight);

/*
 * Sozvon: re-fit the peer grid whenever the call area changes size, not only
 * when the window does.  Opening the settings drawer or the people panel
 * changes the available width without firing a window resize, and the change
 * is animated — so a single call at click time would measure the old width and
 * lay the tiles out for a pane that is about to shrink.
 */
if(typeof ResizeObserver !== 'undefined') {
    let right = document.getElementById('right');
    if(right) {
        // Coalesce: the width is animated when the drawer opens, so the
        // observer fires every frame, and resizePeers() re-measures every
        // tile.  One pass per frame at most, and only the settled size
        // matters anyway.
        let pending = 0;
        new ResizeObserver(function() {
            if(pending)
                return;
            pending = requestAnimationFrame(function() {
                pending = 0;
                resizePeers();
            });
        }).observe(right);
    }
}

/*
 * Sozvon: and once more after the window's resize has settled.  setViewportHeight
 * (above) already re-fits synchronously on every resize event, and the observer
 * covers changes the window does not see; this adds the frame *after* the last
 * of them, when the new size is final.  The self-thumbnail is the one piece of
 * the layout carrying an absolute position, so it is the one that a
 * measurement taken mid-resize can strand — and clampSelfThumb() will not put
 * it back until something asks for a layout.
 */
{
    let pending = 0;
    addEventListener('resize', function() {
        if(pending)
            return;
        pending = requestAnimationFrame(function() {
            pending = 0;
            resizePeers();
        });
    });
}

/*
 * Sozvon: keep the participant tiles — both the empty stage's and the grid's
 * cells for people with no stream — in step with the people list.  Watching
 * #users covers joins, departures and status changes in one place: addUser(),
 * delUser() and setUserStatus() all end up mutating it, and hooking the DOM
 * rather than each of those means a fourth caller cannot forget to.  The
 * layout pass writes to #peers and #stage-people, never to #users, so this
 * cannot re-trigger itself.
 */
if(typeof MutationObserver !== 'undefined') {
    let users = document.getElementById('users');
    if(users)
        new MutationObserver(() => resizePeers()).observe(users, {
            childList: true, subtree: true,
            attributes: true, attributeFilter: ['class'],
        });
}
// On mobile the viewport's new width/height are not in effect yet when
// orientationchange fires, so recomputing immediately uses stale sizes and
// leaves the video shifted/cropped. Recompute on the next frame and once more
// shortly after, by which point the rotated dimensions have settled. (Sozvon)
addEventListener('orientationchange', function() {
    requestAnimationFrame(setViewportHeight);
    setTimeout(setViewportHeight, 300);
});

getButtonElement('presentbutton').onclick = async function(e) {
    e.preventDefault();
    let button = this;
    if(!(button instanceof HTMLButtonElement))
        throw new Error('Unexpected type for this.');
    // there's a potential race condition here: the user might click the
    // button a second time before the stream is set up and the button hidden.
    button.disabled = true;
    try {
        let c = findUpMedia('camera');
        if(c && c.stream && c.stream.getVideoTracks().length)
            return;   // already presenting video
        // turn the camera on, keeping the microphone exactly as it is
        let micUp = !!(c && c.stream && c.stream.getAudioTracks().length);
        await addLocalMedia(c ? c.localId : undefined,
                            {video: true, audio: micUp});
    } finally {
        button.disabled = false;
    }
};

getButtonElement('unpresentbutton').onclick = async function(e) {
    e.preventDefault();
    let c = findUpMedia('camera');
    // "camera off" must mean every camera stream, not just the first one we
    // find, or a duplicate would go on sending video after the user believes
    // the camera is off. (Sozvon)
    closeExtraUpMedia('camera', c);
    // turn the camera off, but keep the microphone running if it is on
    if(c && c.stream && c.stream.getAudioTracks().length)
        await addLocalMedia(c.localId, {video: false, audio: true});
    else
        closeUpMedia('camera');
    resizePeers();
};

/**
 * reflectPreJoin toggles the 'pre-join' body class, which hides the
 * participants sidebar and the chat while the login or waiting-room screen
 * is shown, keeping those screens clean and centred.
 */
function reflectPreJoin() {
    let pre = getVisibility('login-container') || getVisibility('lobby-waiting') ||
        getVisibility('operator-room');
    document.body.classList.toggle('pre-join', pre);
    // Always start a call with the top bar shown, even if a previous call left
    // it slid away (see toggleChrome).
    if(pre) {
        document.body.classList.remove('nav-hidden');
        cancelChromeHide();   // back on a pre-join screen: stop auto-immersive
    }
}

/**
 * collapsePanelsOnJoin collapses the combined people+chat panel when we first
 * join a room, so the video area is maximised by default.  The user summons
 * the panel with the header button.  On the mobile layout the panel is already
 * collapsed (it opens as an overlay), so this is a no-op there.
 */
function collapsePanelsOnJoin() {
    // Collapse the people+chat panel on the desktop layout.
    if(!isMobileLayout()) {
        let sidebar = document.getElementById('left-sidebar');
        if(!sidebar.classList.contains('active')) {
            sidebar.classList.add('active');
            document.getElementById('mainrow').classList.add('full-width-active');
        }
    }
    resizePeers();
    refreshPanelAlert();   // the panel just changed sides
}

/**
 * Whether the combined people+chat panel is currently on screen.  The `active`
 * class collapses the panel on desktop but opens the overlay on mobile, so the
 * meaning is inverted between the two layouts.
 *
 * @returns {boolean}
 */
function panelVisible() {
    let active = document.getElementById('left-sidebar').classList.contains('active');
    return isMobileLayout() ? active : !active;
}

/**
 * Whether a chat message has arrived that has not been on screen yet.  Only
 * half of what the alert dot means; see refreshPanelAlert.  (Sozvon)
 */
let unreadChat = false;

/**
 * Paint the unobtrusive alert dot on the panel toggle.  Nothing outside
 * refreshPanelAlert() should call this.
 *
 * @param {boolean} on
 */
function setPanelAlert(on) {
    let btn = document.getElementById('sidebarCollapse');
    if(btn)
        btn.classList.toggle('panel-alert', on);
}

/**
 * Re-derive the alert dot from what is genuinely outstanding: an unread chat
 * message, or somebody still waiting in the lobby.
 *
 * The dot used to be set and cleared by hand, and the clearing only happened
 * when the panel was opened.  Admitting a knocker straight from the toast --
 * which is the whole point of the toast having an Admit button -- therefore
 * left the dot blinking about a person who was already in the room, until you
 * opened and closed the panel you had just been spared.  Nothing sets the dot
 * directly any more: both conditions are read back from the live state here,
 * so whichever of them ends takes the dot with it.  (Sozvon)
 */
function refreshPanelAlert() {
    let knocking = !!document.querySelector('#users .knock-p');
    setPanelAlert(!panelVisible() && (unreadChat || knocking));
}

/**
 * @param {string} id
 * @param {boolean} visible
 */
function setVisibility(id, visible) {
    let elt = document.getElementById(id);
    if(visible)
        elt.classList.remove('invisible');
    else
        elt.classList.add('invisible');
    if(id === 'login-container' || id === 'lobby-waiting' ||
       id === 'operator-room')
        reflectPreJoin();
}

/**
 * getVisibility tells whether specified element is visible.
 *
 * @param {string} id
 */
function getVisibility(id) {
    let elt = document.getElementById(id);
    return !elt.classList.contains('invisible');
}

/**
 * Tell the Android shell whether a call is active, so it can route audio to
 * the loudspeaker (or a headset) instead of the phone earpiece.  A no-op in a
 * normal browser, where the bridge is absent and routing is the browser's job.
 * Best-effort: never let a bridge hiccup break the UI refresh. (Sozvon)
 *
 * @param {boolean} active
 */
function reflectInCall(active) {
    try {
        let app = /** @type{any} */ (window).SozvonApp;
        if(app && typeof app.setInCall === 'function')
            app.setInCall(!!active);
    } catch(e) {
        // ignore: the app bridge is optional
    }
}

/**
 * Shows and hides various UI elements depending on the protocol state.
 */
function setButtonsVisibility() {
    let connected = serverConnection && serverConnection.socket;
    // Hands-free speaker routing follows being in a call (the Android app
    // listens; browsers ignore it). (Sozvon)
    reflectInCall(connected);
    let permissions = serverConnection.permissions;
    let canWebrtc = !(typeof RTCPeerConnection === 'undefined');
    let canPresent = canWebrtc &&
        ('mediaDevices' in navigator) &&
        ('getUserMedia' in navigator.mediaDevices) &&
        permissions.indexOf('present') >= 0;
    let canShare = canWebrtc &&
        ('mediaDevices' in navigator) &&
        ('getDisplayMedia' in navigator.mediaDevices) &&
        permissions.indexOf('present') >= 0;
    // Camera (present) and microphone (mute) are independent: present tracks
    // the video, mute tracks the audio, so you can have either, both, or
    // neither.  Base the camera buttons on a live video track, not on the mere
    // existence of a 'camera' stream (which may be audio-only).
    let cam = findUpMedia('camera');
    let hasVideo = !!(cam && cam.stream && cam.stream.getVideoTracks().length);
    let micLive = !!(cam && cam.stream &&
                     cam.stream.getAudioTracks().some(t => t.enabled));
    let mediacount = document.getElementById('peers').childElementCount;
    let mobilelayout = isMobileLayout();

    // don't allow multiple presentations
    setVisibility('presentbutton', canPresent && !hasVideo);
    setVisibility('unpresentbutton', hasVideo);

    // keep the mic icon honest: "off" unless a live audio track is enabled
    reflectMuteButton(!micLive);

    setVisibility('mutebutton', !connected || canPresent);

    // allow multiple shared documents, but highlight while a share is live
    // (the click handler decides whether to start or stop based on the
    // multiShare setting).
    setVisibility('sharebutton', canShare);
    // Highlight the share button while a share is live so the user knows a
    // second click will stop the share (when multiShare is disabled).  Set
    // unconditionally here: the toggle logic in the click handler reads
    // getSettings().multiShare, the highlight just reflects the stream state.
    document.getElementById('sharebutton').classList.toggle(
        'sharing', hasShareMedia());

    setVisibility('mediaoptions', canPresent);
    setVisibility('sendform', canPresent);
    setVisibility('simulcastform', canPresent);

    setVisibility('collapse-video', mediacount && mobilelayout);

    // Sozvon: the call clock defaults to the role, so both the readout and the
    // drawer checkbox are re-derived whenever our permissions may have changed.
    reflectCallTimerBox();
    reflectCallTimer();
    reflectFullscreenButton();
}

/**
 * Sets the local mute state.  If reflect is true, updates the stored settings.
 *
 * @param {boolean} mute
 * @param {boolean} [reflect]
 */
function setLocalMute(mute, reflect) {
    muteLocalTracks(mute);
    reflectMuteButton(mute);
    if(reflect)
        updateSettings({localMute: mute});
    publishMuteState(mute);
    // Muting does not touch #users — the audio stream is still there, only its
    // track is disabled — so the observer watching that list never fires and
    // the stage tiles would keep showing the previous microphone state until
    // something unrelated happened to redraw them. (Sozvon)
    reflectStageEmpty();
}

/**
 * Sozvon: tell the room whether our microphone is muted.
 *
 * Muting only disables the local track — the stream stays published, which is
 * what lets the microphone come back without renegotiating — so from everyone
 * else's side nothing at all happens: their copy of our streams still says
 * "audio", and setUserStatus() derives the microphone indicator from exactly
 * that.  A muted participant therefore showed as unmuted on every other
 * screen.  Say it explicitly, over the same per-user data channel the raised
 * hand uses: `data.muted`, which the server merges and pushes to the room.
 *
 * @param {boolean} mute
 */
function publishMuteState(mute) {
    if(!serverConnection || !serverConnection.id)
        return;
    let me = serverConnection.users[serverConnection.id];
    // Nothing to say if the room already believes it.  setLocalMute() runs on
    // every settings pass, not only on a real click.
    if(me && !!me.data.muted === !!mute)
        return;
    try {
        serverConnection.userAction(
            'setdata', serverConnection.id, {'muted': mute ? true : null},
        );
    } catch(e) {
        console.warn('Could not publish mute state', e);
    }
}

/**
 * Update only the microphone button's icon/state, without touching any
 * tracks or stored settings.  Used both by setLocalMute and by
 * setButtonsVisibility (to keep the icon honest when the audio track
 * presence changes independently of an explicit mute).
 *
 * @param {boolean} mute
 */
function reflectMuteButton(mute) {
    let button = document.getElementById('mutebutton');
    let icon = button.querySelector("span .fas");
    if(mute){
        icon.classList.add('fa-microphone-slash');
        icon.classList.remove('fa-microphone');
        button.classList.add('muted');
    } else {
        icon.classList.remove('fa-microphone-slash');
        icon.classList.add('fa-microphone');
        button.classList.remove('muted');
    }
}

getSelectElement('videoselect').onchange = function(e) {
    e.preventDefault();
    if(!(this instanceof HTMLSelectElement))
        throw new Error('Unexpected type for this');
    updateSettings({video: this.value});
    if(this.value === '') {
        // "off" must actually turn the camera off (keeping the mic if it is on),
        // exactly like the camera button.  Previously this called
        // replaceCameraStream, which preserves the live tracks and re-opened the
        // default camera -- so picking "off" did nothing. (Sozvon)
        let c = findUpMedia('camera');
        let hasAudio = !!(c && c.stream && c.stream.getAudioTracks().length);
        if(hasAudio)
            addLocalMedia(c.localId, {audio: true, video: false});
        else if(c)
            closeUpMedia('camera');
    } else {
        replaceCameraStream();
    }
};

getSelectElement('audioselect').onchange = function(e) {
    e.preventDefault();
    if(!(this instanceof HTMLSelectElement))
        throw new Error('Unexpected type for this');
    updateSettings({audio: this.value});
    if(this.value === '') {
        // "off" must actually turn the microphone off (keeping the camera if it
        // is on), exactly like the mic button.  Previously this re-opened the
        // default mic, so picking "off" did nothing. (Sozvon)
        let c = findUpMedia('camera');
        let hasVideo = !!(c && c.stream && c.stream.getVideoTracks().length);
        if(hasVideo)
            addLocalMedia(c.localId, {audio: false, video: true});
        else if(c)
            closeUpMedia('camera');
    } else {
        replaceCameraStream();
    }
};

// Soft lookup: the speaker picker is a Sozvon addition, so a missing
// #outputselect (e.g. an older cached galene.html served with this newer
// galene.js) must NOT throw here at load and take the whole client down with
// it -- that left phones with a dead mic/preview. (Sozvon)
{
    let outputselectElt = document.getElementById('outputselect');
    if(outputselectElt instanceof HTMLSelectElement) {
        outputselectElt.onchange = function(e) {
            e.preventDefault();
            if(!(this instanceof HTMLSelectElement))
                throw new Error('Unexpected type for this');
            updateSettings({output: this.value});
            // Output choice is purely playback-side: no need to touch the
            // camera or the connection, just re-point the media elements.
            applyAudioOutput();
        };
    }
}

/**
 * Route playback to the chosen speaker (output) device via setSinkId, on every
 * remote media element (or just one, when given).  A no-op where the browser
 * lacks setSinkId -- on phones the OS/app picks the output (see the native
 * AudioRouter and reflectInCall). (Sozvon)
 *
 * @param {HTMLMediaElement} [media]
 */
function applyAudioOutput(media) {
    let id = getSettings().output || '';
    let els = media ? [media] :
        Array.from(document.querySelectorAll('.media'));
    els.forEach(el => {
        // setSinkId is only meaningful for what we hear -- remote streams.
        // The self tile is always muted, so skip it.
        if(el instanceof HTMLMediaElement &&
           typeof el.setSinkId === 'function' && !el.muted) {
            el.setSinkId(id).catch(e => console.warn('setSinkId failed', e));
        }
    });
}

getInputElement('mirrorbox').onchange = function(e) {
    e.preventDefault();
    if(!(this instanceof HTMLInputElement))
        throw new Error('Unexpected type for this');
    updateSettings({mirrorView: this.checked});
    // no need to reopen the camera
    replaceUpStreams('camera');
};

getInputElement('blackboardbox').onchange = function(e) {
    e.preventDefault();
    if(!(this instanceof HTMLInputElement))
        throw new Error('Unexpected type for this');
    updateSettings({blackboardMode: this.checked});
    replaceCameraStream();
};

getInputElement('preprocessingbox').onchange = async function(e) {
    e.preventDefault();
    if(!(this instanceof HTMLInputElement))
        throw new Error('Unexpected type for this');
    let pp = this.checked;
    updateSettings({preprocessing: pp});
    let c = findUpMedia('camera');
    let track = c && c.stream && c.stream.getAudioTracks()[0];
    if(track) {
        // Toggle ONLY noiseSuppression on the live track.  We never disable
        // echoCancellation (that silenced the mic on phones/tablets) and never
        // re-open the stream (that drops outgoing audio on mobile), so the
        // call's audio keeps flowing.  noiseSuppression is a light, safe change
        // to the running track.  If the browser can't change it live, it is
        // saved and applies the next time the mic opens. (Sozvon)
        if(track.applyConstraints) {
            try {
                await track.applyConstraints({noiseSuppression: pp});
                return;
            } catch(err) {
                console.warn('Live noise-suppression change failed', err);
            }
        }
        displayMessage(Sozvon.i18n.t('toast.settingNextCall'));
        return;
    }
    // No live microphone to retune -- apply it via a (re)open if a stream exists.
    replaceCameraStream();
};

getInputElement('hqaudiobox').onchange = function(e) {
    e.preventDefault();
    if(!(this instanceof HTMLInputElement))
        throw new Error('Unexpected type for this');
    updateSettings({hqaudio: this.checked});
    replaceCameraStream();
};

document.getElementById('mutebutton').onclick = async function(e) {
    e.preventDefault();
    let c = findUpMedia('camera');
    let hasAudio = !!(c && c.stream && c.stream.getAudioTracks().length);
    let hasVideo = !!(c && c.stream && c.stream.getVideoTracks().length);
    if(hasAudio) {
        // an audio track already exists: just toggle mute, camera untouched
        setLocalMute(!getSettings().localMute, true);
        return;
    }
    // no microphone yet: open one, keeping the camera exactly as it is
    await addLocalMedia(c ? c.localId : undefined, {audio: true, video: hasVideo});
    if(findUpMedia('camera'))
        setLocalMute(false, true);
};

document.getElementById('sharebutton').onclick = function(e) {
    e.preventDefault();
    // Default behaviour: toggle.  If a screen share is already live and the
    // user has not opted into multiple shares, clicking the button stops the
    // current share instead of starting a new one — the button stays
    // highlighted in blue while a share is live (see #sharebutton.sharing
    // in galene.css).  With multiShare enabled, the button always starts a
    // new share and never stops anything.
    if(!getSettings().multiShare && hasShareMedia()) {
        removeShareMedia();
        return;
    }
    addShareMedia();
};

getSelectElement('filterselect').onchange = async function(e) {
    if(!(this instanceof HTMLSelectElement))
        throw new Error('Unexpected type for this');
    updateSettings({filter: this.value});
    let c = findUpMedia('camera');
    if(c) {
        let filter = (this.value && filters[this.value]) || null;
        if(filter)
            c.userdata.filterDefinition = filter;
        else
            delete c.userdata.filterDefinition;
        replaceUpStream(c);
    }
};

// Video orientation: a fixed base rotation (to correct devices whose camera is
// mounted oddly) that the auto-rotation builds on, plus a toggle for the
// auto-rotation itself.  Both reopen the camera so addLocalMedia re-evaluates
// whether the orientation canvas should be applied (see mobileOrientationFilter
// and the gate in addLocalMedia). (Sozvon)

/**
 * Sozvon: turn the camera a quarter turn, the direction the arrow points.
 *
 * The setting stays what it always was — the absolute angle the orientation
 * canvas applies — but it is reached by turning rather than by picking a
 * number out of a list: you look at the picture, not at "180°", and four
 * presses bring you back where you started.
 *
 * Which way that is takes two facts, neither of which can be reasoned out
 * from the button.  Adding 90 to the stored angle turns the frame clockwise
 * (measured, not deduced: a mark in the top-left corner of the camera image
 * moves to the top-right).  And your own tile is mirrored unless you turned
 * that off, which reverses the direction a turn appears to go — so the same
 * change of angle reads as anticlockwise on your screen and clockwise on
 * everybody else's.  The arrow promises what *you* see while you press it,
 * because that is the only feedback you have, so the sign follows the mirror.
 *
 * @param {number} quarters - +1 to turn the picture the way the right-hand
 *     arrow points, -1 for the left-hand one
 */
function rotateVideo(quarters) {
    let mirrored = getSettings().mirrorView !== false;
    let delta = (mirrored ? -90 : 90) * quarters;
    let base = parseInt(getSettings().videoRotation, 10) || 0;
    // Positive modulo: -90 has to land on 270, not on -90, because the canvas
    // filter switches on the value and addLocalMedia parses it back.
    let next = ((base + delta) % 360 + 360) % 360;
    updateSettings({videoRotation: String(next)});
    replaceCameraStream();
}

getButtonElement('rotate-left').onclick = function(e) {
    e.preventDefault();
    rotateVideo(-1);
};

getButtonElement('rotate-right').onclick = function(e) {
    e.preventDefault();
    rotateVideo(1);
};

getInputElement('autorotatebox').onchange = function(e) {
    e.preventDefault();
    if(!(this instanceof HTMLInputElement))
        throw new Error('Unexpected type for this');
    updateSettings({autoRotate: this.checked});
    replaceCameraStream();
};

/**
 * Returns the desired max video throughput depending on the settings.
 *
 * @returns {number}
 */
function getMaxVideoThroughput() {
    let v = getSettings().send;
    switch(v) {
    case 'lowest':
        return 150000;
    case 'low':
        return 300000;
    case 'normal':
        return 700000;
    case 'unlimited':
        return null;
    default:
        console.error('Unknown video quality', v);
        return 700000;
    }
}

getSelectElement('sendselect').onchange = async function(e) {
    if(!(this instanceof HTMLSelectElement))
        throw new Error('Unexpected type for this');
    updateSettings({send: this.value});
    await reconsiderSendParameters();
};

getSelectElement('simulcastselect').onchange = async function(e) {
    if(!(this instanceof HTMLSelectElement))
        throw new Error('Unexpected type for this');
    updateSettings({simulcast: this.value});
    await reconsiderSendParameters();
};

/**
 * Maps the state of the receive UI element to a protocol request.
 *
 * @param {string} what
 * @returns {Record<string,Array<string>>}
 */

function mapRequest(what) {
    switch(what) {
    case '':
        return {'': []};
    case 'audio':
        return {'': ['audio']};
    case 'screenshare':
        return {screenshare: ['audio','video'], '': ['audio']};
    case 'everything-low':
        return {'': ['audio','video-low']};
    case 'everything':
        return {'': ['audio','video']}
    default:
        throw new Error(`Unknown value ${what} in request`);
    }
}

/**
 * Like mapRequest, but for a single label.
 *
 * @param {string} what
 * @param {string} label
 * @returns {Array<string>}
 */

function mapRequestLabel(what, label) {
    let r = mapRequest(what);
    if(label in r)
        return r[label];
    else
        return r[''];
}


getSelectElement('requestselect').onchange = function(e) {
    e.preventDefault();
    if(!(this instanceof HTMLSelectElement))
        throw new Error('Unexpected type for this');
    updateSettings({request: this.value});
    serverConnection.request(mapRequest(this.value));
    reconsiderDownRate();
};

const activityDetectionInterval = 200;
const activityDetectionPeriod = 700;
const activityDetectionThreshold = 0.2;

getInputElement('activitybox').onchange = function(e) {
    if(!(this instanceof HTMLInputElement))
        throw new Error('Unexpected type for this');
    updateSettings({activityDetection: this.checked});
    for(let id in serverConnection.down) {
        let c = serverConnection.down[id];
        if(this.checked)
            c.setStatsInterval(activityDetectionInterval);
        else {
            c.setStatsInterval(0);
            setActive(c, false);
        }
    }
};

getInputElement('displayallbox').onchange = function(e) {
    if(!(this instanceof HTMLInputElement))
        throw new Error('Unexpected type for this');
    updateSettings({displayAll: this.checked});
    // The placeholder tiles obey this setting too, and nothing else redraws
    // them: toggling it changes no stream and touches no row in #users. (Sozvon)
    reflectStageEmpty();
    for(let id in serverConnection.down) {
        let c = serverConnection.down[id];
        let elt = document.getElementById('peer-' + c.localId);
        showHideMedia(c, elt);
    }
};

getInputElement('multisharebox').onchange = function(e) {
    if(!(this instanceof HTMLInputElement))
        throw new Error('Unexpected type for this');
    updateSettings({multiShare: this.checked});
};

// Sozvon: 1-on-1 lock toggle in the host-only settings section.  When
// flipped, the server flips its in-memory `locked1on1` flag and
// refuses any third participant; ops are exempt.
getInputElement('locked1on1box').onchange = function(e) {
    if(!(this instanceof HTMLInputElement))
        throw new Error('Unexpected type for this');
    if(!serverConnection)
        return;
    serverConnection.groupAction('setgroup',
        {locked1on1: this.checked});
};

// Sozvon: client-only mute switch for the lobby-knock sound.  Persisted in
// session storage (same place as other client settings); default true.
getInputElement('knocksoundbox').onchange = function(e) {
    if(!(this instanceof HTMLInputElement))
        throw new Error('Unexpected type for this');
    updateSettings({knockSound: this.checked});
};


/**
 * @param {Stream} c
 * @param {boolean} value
 */
function setActive(c, value) {
    let peer = document.getElementById('peer-' + c.localId);
    if(value)
        peer.classList.add('peer-active');
    else
        peer.classList.remove('peer-active');
}

/**
 * @this {Stream}
 * @param {Record<string,any>} stats
 */
function gotDownStats(stats) {
    if(!getInputElement('activitybox').checked)
        return;

    let c = this;

    let maxEnergy = 0;

    c.pc.getReceivers().forEach(r => {
        let tid = r.track && r.track.id;
        let s = tid && stats[tid];
        let energy = s && s['inbound-rtp'] && s['inbound-rtp'].audioEnergy;
        if(typeof energy === 'number')
            maxEnergy = Math.max(maxEnergy, energy);
    });

    // totalAudioEnergy is defined as the integral of the square of the
    // volume, so square the threshold.
    if(maxEnergy > activityDetectionThreshold * activityDetectionThreshold) {
        c.userdata.lastVoiceActivity = Date.now();
        setActive(c, true);
    } else {
        let last = c.userdata.lastVoiceActivity;
        if(!last || Date.now() - last > activityDetectionPeriod)
            setActive(c, false);
    }
}

/**
 * Add an option to an HTMLSelectElement.
 *
 * @param {HTMLSelectElement} select
 * @param {string} label
 * @param {string} [value]
 */
function addSelectOption(select, label, value, title) {
    if(!value)
        value = label;
    for(let i = 0; i < select.children.length; i++) {
        let child = select.children[i];
        if(!(child instanceof HTMLOptionElement)) {
            console.warn('Unexpected select child');
            continue;
        }
        if(child.value === value) {
            if(child.label !== label) {
                child.label = label;
            }
            if(title && child.title !== title)
                child.title = title;
            return;
        }
    }

    let option = document.createElement('option');
    option.value = value;
    option.textContent = label;
    // Full (untruncated) name as a hover tooltip, when the caller passes one.
    if(title)
        option.title = title;
    select.appendChild(option);
}

/**
 * Device names can be long (e.g. "Набор микрофонов (Технология Intel® Smart
 * Sound)").  A native <select> in Firefox sizes its open dropdown to the widest
 * option, so a long name makes the popup overflow the settings panel — width
 * that CSS cannot cap on a native control.  Shorten the visible option text (the
 * full name still shows via the option's title tooltip) so the dropdown never
 * grows past its box. (Sozvon)
 *
 * @param {string} label
 * @param {number} [max]
 * @returns {string}
 */
function truncateDeviceLabel(label, max) {
    max = max || 30;
    if(!label || label.length <= max)
        return label;
    return label.slice(0, max - 1).trimEnd() + '…';
}

/**
 * Returns true if an HTMLSelectElement has an option with a given value.
 *
 * @param {HTMLSelectElement} select
 * @param {string} value
 */
function selectOptionAvailable(select, value) {
    let children = select.children;
    for(let i = 0; i < children.length; i++) {
        let child = select.children[i];
        if(!(child instanceof HTMLOptionElement)) {
            console.warn('Unexpected select child');
            continue;
        }
        if(child.value === value)
            return true;
    }
    return false;
}

/**
 * @param {HTMLSelectElement} select
 * @returns {string}
 */
function selectOptionDefault(select) {
    /* First non-empty option. */
    for(let i = 0; i < select.children.length; i++) {
        let child = select.children[i];
        if(!(child instanceof HTMLOptionElement)) {
            console.warn('Unexpected select child');
            continue;
        }
        if(child.value)
            return child.value;
    }
    /* The empty option is always available. */
    return '';
}

/**
 * Point a settings device picker at the device a live track is actually
 * capturing from, and persist that choice.  The mic/camera can be turned on
 * with the system default (via the toolbar buttons, which force media without
 * writing settings.audio/video), which used to leave the picker stuck on
 * "off" even though the device was live — the exact mismatch users report.
 * Syncing to track.getSettings().deviceId keeps the drawer honest. (Sozvon)
 *
 * @param {string} selectId
 * @param {MediaStreamTrack} [track]
 * @param {string} settingKey - 'audio' or 'video'
 */
function syncDeviceSelect(selectId, track, settingKey) {
    if(!track || typeof track.getSettings !== 'function')
        return;
    let id = track.getSettings().deviceId;
    if(!id)
        return;
    let sel = document.getElementById(selectId);
    if(!(sel instanceof HTMLSelectElement))
        return;
    if(selectOptionAvailable(sel, id)) {
        sel.value = id;
        updateSetting(settingKey, id);
    }
}

/**
  * True if we already went through setMediaChoices twice.
  *
  * @type {boolean}
  */
let mediaChoicesDone = false;

/**
 * Populate the media choices menu.
 *
 * Since media names might not be available before we call
 * getDisplayMedia, we call this function twice, the second time in order
 * to update the menu with user-readable labels.
 *
 * @param{boolean} done
 */
async function setMediaChoices(done) {
    if(mediaChoicesDone)
        return;

    let devices = [];
    try {
        if('mediaDevices' in navigator)
            devices = await navigator.mediaDevices.enumerateDevices();
    } catch(e) {
        console.error(e);
        return;
    }

    // Drop stale device options (any option with a real value) before
    // repopulating, keeping only the fixed "off" entry (value=='').  Without
    // this, a list first built pre-permission — when deviceIds/labels are
    // blank — would keep its placeholder entries forever, so the picker showed
    // a phantom "Microphone 1" alongside the real device once permission
    // arrived. (Sozvon)
    ['videoselect', 'audioselect', 'outputselect'].forEach(id => {
        let sel = document.getElementById(id);
        if(!(sel instanceof HTMLSelectElement))
            return;
        for(let i = sel.options.length - 1; i >= 0; i--) {
            if(sel.options[i].value)
                sel.remove(i);
        }
    });

    let cn = 1, mn = 1, on = 1;

    devices.forEach(d => {
        // Before the user grants permission the browser hides deviceId (and
        // label); an entry with no deviceId is a placeholder we cannot actually
        // select, and addSelectOption would otherwise synthesise a bogus value
        // from the label ("Microphone 1"), producing an un-selectable phantom.
        // Skip it — the real entry appears after permission is granted. (Sozvon)
        if((d.kind === 'videoinput' || d.kind === 'audioinput' ||
            d.kind === 'audiooutput') && !d.deviceId)
            return;
        let label = d.label;
        if(d.kind === 'videoinput') {
            if(!label)
                label = `Camera ${cn}`;
            addSelectOption(getSelectElement('videoselect'),
                            truncateDeviceLabel(label), d.deviceId, label);
            cn++;
        } else if(d.kind === 'audioinput') {
            if(!label)
                label = `Microphone ${mn}`;
            addSelectOption(getSelectElement('audioselect'),
                            truncateDeviceLabel(label), d.deviceId, label);
            mn++;
        } else if(d.kind === 'audiooutput') {
            // Speaker / output picker.  Only useful where the browser supports
            // setSinkId (mostly desktop); on phones the OS/app handles routing
            // (see the native AudioRouter), so the list may be just "default".
            // Soft lookup so a missing #outputselect can't throw. (Sozvon)
            let outsel = document.getElementById('outputselect');
            if(outsel instanceof HTMLSelectElement) {
                if(!label)
                    label = `Speaker ${on}`;
                addSelectOption(outsel, truncateDeviceLabel(label),
                                d.deviceId, label);
                on++;
            }
        }
    });

    mediaChoicesDone = done;
}

// Refresh the device pickers when hardware is plugged or unplugged mid-session
// (e.g. a headset connected during a call, or a mic removed): re-enumerate and
// re-reflect so the list never goes stale and a vanished device falls back to
// a valid choice. (Sozvon)
if(navigator.mediaDevices &&
   typeof navigator.mediaDevices.addEventListener === 'function') {
    navigator.mediaDevices.addEventListener('devicechange', async () => {
        mediaChoicesDone = false;
        try {
            await setMediaChoices(true);
            reflectSettings();
        } catch(e) {
            console.warn(e);
        }
    });
}


/**
 * @param {string} [localId]
 */
function newUpStream(localId) {
    if(!serverConnection)
        throw new Error("Not connected");
    let c = serverConnection.newUpStream(localId);
    c.onstatus = function(status) {
        setMediaStatus(c);
    };
    c.onerror = function(e) {
        console.error(e);
        displayError(e);
    };
    return c;
}

/**
 * Sets an up stream's video throughput and simulcast parameters.
 *
 * @param {Stream} c
 * @param {number} bps
 * @param {boolean} simulcast
 */
async function setSendParameters(c, bps, simulcast) {
    if(!c.up)
        throw new Error('Setting throughput of down stream');
    if(c.label === 'screenshare')
        simulcast = false;
    let senders = c.pc.getSenders();
    for(let i = 0; i < senders.length; i++) {
        let s = senders[i];
        if(!s.track || s.track.kind !== 'video')
            continue;
        let p = s.getParameters();
        if((!p.encodings ||
            !simulcast && p.encodings.length !== 1) ||
           (simulcast && p.encodings.length !== 2)) {
            await replaceUpStream(c);
            return;
        }
        p.encodings.forEach(e => {
            if(!e.rid || e.rid === 'h')
                e.maxBitrate = bps || unlimitedRate;
        });
        await s.setParameters(p);
    }
}

let reconsiderParametersTimer = null;

/**
 * Sets the send parameters for all up streams.
 */
async function reconsiderSendParameters() {
    cancelReconsiderParameters();
    let t = getMaxVideoThroughput();
    let s = doSimulcast();
    let promises = [];
    for(let id in serverConnection.up) {
        let c = serverConnection.up[id];
        promises.push(setSendParameters(c, t, s));
    }
    await Promise.all(promises);
}

/**
 * Schedules a call to reconsiderSendParameters after a delay.
 * The delay avoids excessive flapping.
 */
function scheduleReconsiderParameters() {
    cancelReconsiderParameters();
    reconsiderParametersTimer =
        setTimeout(reconsiderSendParameters, 10000 + Math.random() * 10000);
}

function cancelReconsiderParameters() {
    if(reconsiderParametersTimer) {
        clearTimeout(reconsiderParametersTimer);
        reconsiderParametersTimer = null;
    }
}

const unlimitedRate = 1000000000;
const simulcastRate = 100000;
const hqAudioRate = 128000;

/**
 * Decide whether we want to send simulcast.
 *
 * @returns {boolean}
 */
function doSimulcast() {
    switch(getSettings().simulcast) {
    case 'on':
        return true;
    case 'off':
        return false;
    default:
        let count = 0;
        for(let n in serverConnection.users) {
            if(!serverConnection.users[n].permissions["system"]) {
                count++;
                if(count > 2)
                    break;
            }
        }
        if(count <= 2)
            return false;
        let bps = getMaxVideoThroughput();
        return bps <= 0 || bps >= 2 * simulcastRate;
    }
}

/**
 * Sets up c to send the given stream.  Some extra parameters are stored
 * in c.userdata.
 *
 * @param {Stream} c
 * @param {MediaStream} stream
 */

async function setUpStream(c, stream) {
    if(c.stream !== null)
        throw new Error("Setting nonempty stream");

    c.setStream(stream);

    // set up the handler early, in case setFilter fails.
    c.onclose = async replace => {
        await removeFilter(c);
        if(!replace) {
            stopStream(c.stream);
            if(c.userdata.onclose)
                c.userdata.onclose.call(c);
            delMedia(c.localId);
        }
    }

    await setFilter(c);

    /**
     * @param {MediaStreamTrack} t
     */
    function addUpTrack(t) {
        let settings = getSettings();
        if(c.label === 'camera') {
            if(t.kind === 'audio') {
                if(settings.localMute)
                    t.enabled = false;
            } else if(t.kind === 'video') {
                if(settings.blackboardMode) {
                    t.contentHint = 'detail';
                }
            }
        }
        t.onended = e => {
            stream.onaddtrack = null;
            stream.onremovetrack = null;
            c.close();
        };

        let encodings = [];
        let simulcast = c.label !== 'screenshare' && doSimulcast();
        if(e2eeEnabled())
            // E2EE uses a single VP8 encoding: the worker assumes VP8 and a
            // per-stream frame counter, and we don't split layers.
            simulcast = false;
        if(t.kind === 'video') {
            let bps = getMaxVideoThroughput();
            // Firefox doesn't like us setting the RID if we're not
            // simulcasting.
            if(simulcast) {
                encodings.push({
                    rid: 'h',
                    maxBitrate: bps || unlimitedRate,
                });
                encodings.push({
                    rid: 'l',
                    scaleResolutionDownBy: 2,
                    maxBitrate: simulcastRate,
                });
            } else {
                encodings.push({
                    maxBitrate: bps || unlimitedRate,
                });
            }
        } else {
            if(settings.hqaudio) {
                encodings.push({
                    maxBitrate: hqAudioRate,
                });
            }
        }
        let tr = c.pc.addTransceiver(t, {
            direction: 'sendonly',
            streams: [stream],
            sendEncodings: encodings,
        });

        // Firefox before 110 does not implement sendEncodings, and
        // requires this hack, which throws an exception on Chromium.
        try {
            let p = tr.sender.getParameters();
            if(!p.encodings) {
                p.encodings = encodings;
                tr.sender.setParameters(p);
            }
        } catch(e) {
        }

        if(e2eeEnabled()) {
            preferVP8(tr, t.kind);
            serverConnection.e2ee.attachSender(tr.sender, t.kind);
        }
    }

    // c.stream might be different from stream if there's a filter
    c.stream.getTracks().forEach(addUpTrack);

    stream.onaddtrack = function(e) {
        addUpTrack(e.track);
    };

    stream.onremovetrack = function(e) {
        let t = e.track;

        /** @type {RTCRtpSender} */
        let sender;
        c.pc.getSenders().forEach(s => {
            if(s.track === t)
                sender = s;
        });
        if(sender) {
            c.pc.removeTrack(sender);
        } else {
            console.warn('Removing unknown track');
        }

        let found = false;
        c.pc.getSenders().forEach(s => {
            if(s.track)
                found = true;
        });
        if(!found) {
            stream.onaddtrack = null;
            stream.onremovetrack = null;
            c.close();
        }
    };
}

/**
 * Replaces c with a freshly created stream, duplicating any relevant
 * parameters in c.userdata.
 *
 * @param {Stream} c
 * @returns {Promise<Stream>}
 */
async function replaceUpStream(c) {
    await removeFilter(c);
    let cn = newUpStream(c.localId);
    cn.label = c.label;
    if(c.userdata.filterDefinition)
        cn.userdata.filterDefinition = c.userdata.filterDefinition;
    if(c.userdata.onclose)
        cn.userdata.onclose = c.userdata.onclose;
    let media = /** @type{HTMLVideoElement} */
        (document.getElementById('media-' + c.localId));
    try {
        await setUpStream(cn, c.stream);
    } catch(e) {
        console.error(e);
        displayError(e);
        cn.close();
        c.close();
        return null;
    }

    await setMedia(cn,
                   cn.label === 'camera' && getSettings().mirrorView,
                   cn.label === 'video' && media);

    return cn;
}

/**
 * Replaces all up streams with the given label.  If label is null,
 * replaces all up stream.
 *
 * @param {string} label
 */
async function replaceUpStreams(label) {
    let promises = [];
    for(let id in serverConnection.up) {
        let c = serverConnection.up[id];
        if(label && c.label !== label)
            continue
        promises.push(replaceUpStream(c));
    }
    await Promise.all(promises);
}

/**
 * Closes and reopens the camera then replaces the camera stream.
 */
function replaceCameraStream() {
    let c = findUpMedia('camera');
    if(c)
        // preserve which tracks are currently live so a device/filter change
        // doesn't silently turn the camera or microphone on or off
        addLocalMedia(c.localId, {
            audio: !!(c.stream && c.stream.getAudioTracks().length),
            video: !!(c.stream && c.stream.getVideoTracks().length),
        });
}

/**
 * Serialises addLocalMedia.  Opening a device takes time -- a permission
 * prompt, a slow phone camera -- and two calls that overlap would each
 * publish their own stream, which is two cameras and two microphones from a
 * single participant.  Queueing them means the second one finds the first
 * one's stream and replaces it. (Sozvon)
 *
 * @type {Promise<void>}
 */
let addLocalMediaQueue = Promise.resolve();

/**
 * @param {string} [localId]
 * @param {{audio?: boolean, video?: boolean}} [force]
 *     Optional overrides for which tracks to capture, independent of the saved
 *     device selection: the camera and microphone buttons pass explicit
 *     audio/video booleans so each toggles only its own track without
 *     disturbing the other.  An empty constraint object means "default device".
 */
async function addLocalMedia(localId, force) {
    let next = addLocalMediaQueue.then(
        () => addLocalMediaNow(localId, force),
        () => addLocalMediaNow(localId, force),
    );
    // the queue must survive a failed call, so swallow the error here; the
    // caller still sees it through the promise we return
    addLocalMediaQueue = next.catch(() => {});
    return next;
}

/**
 * Does the work of addLocalMedia.  Do not call directly: go through
 * addLocalMedia, which serialises these. (Sozvon)
 *
 * @param {string} [localId]
 * @param {{audio?: boolean, video?: boolean}} [force]
 */
async function addLocalMediaNow(localId, force) {
    if(serverConnection && serverConnection.e2ee &&
       serverConnection.e2ee.state === 'blocked') {
        // The group requires end-to-end encryption but this call cannot be
        // encrypted; refuse to publish rather than send media in clear.
        displayError(Sozvon.i18n.t('e2ee.blocked'));
        return;
    }

    // The connection this call belongs to.  getUserMedia below can take
    // seconds -- a permission prompt, a slow phone camera -- and the user may
    // leave and come back in the meantime, so we check afterwards that we are
    // still publishing into the session that asked for this. (Sozvon)
    let sc = serverConnection;

    let settings = getSettings();

    /** @type{boolean|MediaTrackConstraints} */
    let audio = settings.audio ? {deviceId: settings.audio} : false;
    /** @type{boolean|MediaTrackConstraints} */
    let video = settings.video ? {deviceId: settings.video} : false;

    if(force) {
        if(force.audio === true && !audio) audio = {};
        if(force.audio === false) audio = false;
        if(force.video === true && !video) video = {};
        if(force.video === false) video = false;
    }

    if(!audio && !video) {
        displayError(Sozvon.i18n.t('toast.noMedia'));
        return;
    }

    if(video) {
        let resolution = settings.resolution;
        if(resolution) {
            video.width = { ideal: resolution[0] };
            video.height = { ideal: resolution[1] };
        } else if(settings.blackboardMode) {
            video.width = { min: 640, ideal: 1920 };
            video.height = { min: 400, ideal: 1080 };
        } else {
            video.aspectRatio = { ideal: 4/3 };
        }
    }

    if(audio) {
        // The "Noise suppression" checkbox toggles ONLY the browser's noise
        // suppression -- echoCancellation and autoGainControl stay at their
        // (enabled) defaults on purpose.  Disabling echoCancellation puts the
        // browser into a raw-capture mode that yields a SILENT microphone on
        // many phones and tablets (the long-standing "no audio when noise
        // suppression is off" bug).  Upstream disabled all three here as a
        // music/hi-fi switch; we keep the mic working instead. (Sozvon)
        if(!settings.preprocessing)
            audio.noiseSuppression = false;
    }

    let old = serverConnection.findByLocalId(localId);
    if(old) {
        // make sure that the camera is released before we try to reopen it
        await removeFilter(old);
        stopStream(old.stream);
    }

    if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        // No camera/microphone API at all: an unsupported browser.
        showBrowserUnsupported();
        return;
    }

    let constraints = {audio: audio, video: video};
    /** @type {MediaStream} */
    let stream = null;
    // Some browsers (notably Xiaomi's Mi Browser) expose getUserMedia but never
    // settle the promise.  Warn if the request hangs; hide the warning if it
    // eventually succeeds.
    let hangTimer = setTimeout(showBrowserUnsupported, 12000);
    try {
        stream = await navigator.mediaDevices.getUserMedia(constraints);
        clearTimeout(hangTimer);
        hideBrowserUnsupported();
    } catch(e) {
        clearTimeout(hangTimer);
        hideBrowserUnsupported();
        if(e && e.name === 'NotAllowedError')
            displayError(Sozvon.i18n.t('toast.permissionDenied'));
        else if(e && (e.name === 'NotFoundError' ||
                      e.name === 'OverconstrainedError' ||
                      e.name === 'DevicesNotFoundError'))
            displayError(Sozvon.i18n.t('toast.noDevice'));
        else if(e && e.name === 'NotSupportedError')
            showBrowserUnsupported();
        else
            displayError(e);
        return;
    }

    if(serverConnection !== sc || !sc.group) {
        // We left the group, or the connection was rebuilt, while the camera
        // was still opening.  Publishing now would attach this stream to a
        // session that never asked for it, next to the media that session has
        // already published -- two cameras and two microphones from one
        // participant, under a single name in the list.  Drop it. (Sozvon)
        stopStream(stream);
        return;
    }

    if(!localId) {
        // Another call opened the camera while we were waiting for this one:
        // a second tap on a button, or a join that raced us.  Take over its
        // local id so newUpStream replaces that stream below instead of
        // publishing a second one alongside it. (Sozvon)
        let existing = findUpMedia('camera');
        if(existing) {
            localId = existing.localId;
            // as above: release the camera before the replacement takes over
            await removeFilter(existing);
            stopStream(existing.stream);
        }
    }

    // Permission may have just been granted, which is the first moment the
    // browser reveals real device labels/ids.  Re-enumerate (the flag reset
    // defeats the "already done" guard) and then point the settings pickers at
    // the device that is actually capturing, so the drawer stops showing "off"
    // (or a stale entry) while the mic/camera is live. (Sozvon)
    mediaChoicesDone = false;
    await setMediaChoices(true);
    syncDeviceSelect('audioselect', stream.getAudioTracks()[0], 'audio');
    syncDeviceSelect('videoselect', stream.getVideoTracks()[0], 'video');

    // A track that ends on its own — permission revoked mid-call, or the
    // device unplugged — fires 'ended'; our own teardown uses track.stop(),
    // which does NOT.  So a fired 'ended' means an involuntary loss the user
    // should be told about, rather than the mic silently going dead. (Sozvon)
    stream.getAudioTracks().forEach(t => {
        t.addEventListener('ended', () => {
            displayError(Sozvon.i18n.t('toast.micEnded'));
        });
    });

    let c;

    try {
        c = newUpStream(localId);
    } catch(e) {
        console.error(e);
        displayError(e);
        return;
    }

    c.label = 'camera';

    if(settings.filter) {
        let filter = filters[settings.filter];
        if(filter)
            c.userdata.filterDefinition = filter;
        else
            displayWarning(`Unknown filter ${settings.filter}`);
    }

    // Route the camera through the orientation canvas (mobileOrientationFilter)
    // when it can help: auto-rotate is on and this looks like a phone/tablet (a
    // mobile-style facingMode, a touch screen, or the mobile layout), OR a
    // manual base rotation is set (which also lets a desktop fix a sideways
    // webcam).  We key off the device/camera, NOT the CSS "mobile layout" alone
    // -- a tablet uses the desktop layout yet still needs this.  Skip it when
    // there is no camera track (audio-only -- else we'd send a blank canvas),
    // when the user already picked a filter (it draws from the same frame, so
    // orientation is handled anyway), in blackboard mode (a document camera we
    // must not resample), or when canvas capture is unavailable. (Sozvon)
    let vtrack = stream.getVideoTracks()[0];
    let facing = (vtrack && vtrack.getSettings) ?
        vtrack.getSettings().facingMode : '';
    let mobileDevice = facing === 'user' || facing === 'environment' ||
        navigator.maxTouchPoints > 0 || isMobileLayout();
    let base = parseInt(settings.videoRotation, 10) || 0;
    let autoRotate = settings.autoRotate !== false;
    if(!c.userdata.filterDefinition && vtrack &&
       !settings.blackboardMode &&
       HTMLCanvasElement.prototype.captureStream &&
       ((autoRotate && mobileDevice) || base !== 0))
        c.userdata.filterDefinition = mobileOrientationFilter;

    try {
        await setUpStream(c, stream);
        await setMedia(c, settings.mirrorView);
    } catch(e) {
        console.error(e);
        displayError(e);
        c.close();
    }
    setButtonsVisibility();
}

let safariScreenshareDone = false;

async function addShareMedia() {
    if(!safariScreenshareDone) {
        if(isSafari()) {
            let ok = confirm(
                'Screen sharing in Safari is broken.  ' +
                    'It will work at first, ' +
                    'but then your video will randomly freeze.  ' +
                    'Are you sure that you wish to enable screensharing?'
            );
            if(!ok)
                return
        }
        safariScreenshareDone = true;
    }

    /** @type {MediaStream} */
    let stream = null;
    try {
        if(!('getDisplayMedia' in navigator.mediaDevices))
            throw new Error('Your browser does not support screen sharing');
        stream = await navigator.mediaDevices.getDisplayMedia({
            video: true,
            audio: true,
        });
    } catch(e) {
        console.error(e);
        displayError(e);
        return;
    }

    let c = newUpStream();
    c.label = 'screenshare';
    await setUpStream(c, stream);
    await setMedia(c);
    setButtonsVisibility();
}

/**
 * Stops every local screen-share up-stream.  Used by the share button when
 * multiShare is disabled and a share is already live (so the same button
 * toggles share on/off).  When the user clicks the browser's own "Stop
 * sharing" UI, the track fires onended which already closes the up-stream
 * via setUpStream, so this only fires for in-app toggles.
 */
function removeShareMedia() {
    closeUpMedia('screenshare');
    setButtonsVisibility();
}

/**
 * Returns true if the local client has at least one screen-share up-stream.
 * Drives the share button's highlight (see #sharebutton.sharing in
 * galene.css) and the toggle behaviour of the button.
 *
 * @returns {boolean}
 */
function hasShareMedia() {
    return !!findUpMedia('screenshare');
}

/**
 * @param {File} file
 */
async function addFileMedia(file) {
    let url = URL.createObjectURL(file);
    let video = document.createElement('video');
    video.src = url;
    video.controls = true;
    let stream;
    /** @ts-ignore */
    if(video.captureStream)
        /** @ts-ignore */
        stream = video.captureStream();
    /** @ts-ignore */
    else if(video.mozCaptureStream)
        /** @ts-ignore */
        stream = video.mozCaptureStream();
    else {
        displayError("This browser doesn't support file playback");
        return;
    }

    let c = newUpStream();
    c.label = 'video';
    c.userdata.onclose = function() {
        let media = /** @type{HTMLVideoElement} */
            (document.getElementById('media-' + this.localId));
        if(media && media.src) {
            URL.revokeObjectURL(media.src);
            media.src = null;
        }
    };
    await setUpStream(c, stream);

    let presenting = !!findUpMedia('camera');
    let muted = getSettings().localMute;
    if(presenting && !muted) {
        setLocalMute(true, true);
        displayWarning(Sozvon.i18n.t('toast.muted'));
    }

    await setMedia(c, false, video);
    c.userdata.play = true;
    setButtonsVisibility();
}

/**
 * @param {MediaStream} s
 */
function stopStream(s) {
    s.getTracks().forEach(t => {
        try {
            t.stop();
        } catch(e) {
            console.warn(e);
        }
    });
}

/**
 * closeUpMedia closes all up connections with the given label.  If label
 * is null, it closes all up connections.
 *
 * @param {string} [label]
 * @param {ServerConnection} [sc]
 *     The connection to close streams on; defaults to the current one.  A
 *     late socket close must pass its own connection, or it would tear down
 *     the media of the connection that has already replaced it. (Sozvon)
*/
function closeUpMedia(label, sc) {
    sc = sc || serverConnection;
    if(!sc)
        return;
    for(let id in sc.up) {
        let c = sc.up[id];
        if(label && c.label !== label)
            continue
        c.close();
    }
}

/**
 * closeExtraUpMedia closes every up connection with the given label except
 * `keep`.  There is only ever meant to be one camera stream; this is the belt
 * to addLocalMedia's braces, so that a duplicate which somehow got published
 * cannot keep sending after the user has turned the camera off. (Sozvon)
 *
 * @param {string} label
 * @param {Stream} [keep]
 */
function closeExtraUpMedia(label, keep) {
    if(!serverConnection)
        return;
    for(let id in serverConnection.up) {
        let c = serverConnection.up[id];
        if(c.label !== label || c === keep)
            continue;
        console.warn('Closing duplicate ' + label + ' stream');
        c.close();
    }
}

/**
 * @param {string} label
 * @returns {Stream}
 */
function findUpMedia(label) {
    if(!serverConnection)
        return null;
    for(let id in serverConnection.up) {
        let c = serverConnection.up[id];
        if(c.label === label)
            return c;
    }
    return null;
}

/**
 * @param {boolean} mute
 */
function muteLocalTracks(mute) {
    if(!serverConnection)
        return;
    for(let id in serverConnection.up) {
        let c = serverConnection.up[id];
        if(c.label === 'camera') {
            let stream = c.stream;
            stream.getTracks().forEach(t => {
                if(t.kind === 'audio') {
                    t.enabled = !mute;
                }
            });
        }
    }
}

/**
 * @param {string} id
 * @param {boolean} force
 * @param {boolean} [value]
 */
function forceDownRate(id, force, value) {
    let c = serverConnection.down[id];
    if(!c)
        throw new Error("Unknown down stream");
    if('requested' in c.userdata) {
        if(force)
            c.userdata.requested.force = !!value;
        else
            delete(c.userdata.requested.force);
    } else {
        if(force)
            c.userdata.requested = {force: value};
    }
    reconsiderDownRate(id);
}

/**
 * Maps 'video' to 'video-low'.  Returns null if nothing changed.
 *
 * @param {string[]} requested
 * @returns {string[]}
 */
function mapVideoToLow(requested) {
    let result = [];
    let found = false;
    for(let i = 0; i < requested.length; i++) {
        let r = requested[i];
        if(r === 'video') {
            r = 'video-low';
            found = true;
        }
        result.push(r);
    }
    if(!found)
        return null;
    return result;
}

/**
 * Reconsider the video track requested for a given down stream.
 *
 * @param {string} [id] - the id of the track to reconsider, all if null.
 */
function reconsiderDownRate(id) {
    if(!serverConnection)
        return;
    if(!id) {
        for(let id in serverConnection.down) {
            reconsiderDownRate(id);
        }
        return;
    }
    let c = serverConnection.down[id];
    if(!c)
        throw new Error("Unknown down stream");
    let normalrequest = mapRequestLabel(getSettings().request, c.label);

    let requestlow = mapVideoToLow(normalrequest);
    if(requestlow === null)
        return;

    let old = c.userdata.requested;
    let low = false;
    if(old && ('force' in old)) {
        low = old.force;
    } else {
        let media = /** @type {HTMLVideoElement} */
            (document.getElementById('media-' + c.localId));
        if(!media)
            throw new Error("No media for stream");
        let w = media.scrollWidth;
        let h = media.scrollHeight;
        if(w && h && w * h <= 320 * 240) {
            low = true;
        }
    }

    if(low !== !!(old && old.low)) {
        if('requested' in c.userdata)
            c.userdata.requested.low = low;
        else
            c.userdata.requested = {low: low};
        c.request(low ? requestlow : null);
    }
}

let reconsiderDownRateTimer = null;

/**
 * Schedules reconsiderDownRate() to be run later.  The delay avoids too
 * much recomputations when resizing the window.
 */
function scheduleReconsiderDownRate() {
    if(reconsiderDownRateTimer)
        return;
    reconsiderDownRateTimer =
        setTimeout(() => {
            reconsiderDownRateTimer = null;
            reconsiderDownRate();
        }, 200);
}

/**
 * setMedia adds a new media element corresponding to stream c.
 *
 * @param {Stream} c
 * @param {boolean} [mirror]
 *     - whether to mirror the video
 * @param {HTMLVideoElement} [video]
 *     - the video element to add.  If null, a new element with custom
 *       controls will be created.
 */
async function setMedia(c, mirror, video) {
    let div = document.getElementById('peer-' + c.localId);
    if(!div) {
        div = document.createElement('div');
        div.id = 'peer-' + c.localId;
        div.classList.add('peer');
        let peersdiv = document.getElementById('peers');
        peersdiv.appendChild(div);
    }

    // mark local vs remote so a 1-on-1 can be shown as a speaker view
    div.classList.toggle('peer-self', !!c.up);
    div.classList.toggle('peer-remote', !c.up);
    // remember the stream kind so framing refuses to crop a shared screen
    div.dataset.label = c.label || '';
    if(c.up)
        makeSelfThumbDraggable(div);

    showHideMedia(c, div)

    let media = /** @type {HTMLVideoElement} */
        (document.getElementById('media-' + c.localId));
    if(!media) {
        if(video) {
            media = video;
        } else {
            media = document.createElement('video');
            if(c.up)
                media.muted = true;
        }

        media.classList.add('media');
        media.autoplay = true;
        media.playsInline = true;
        media.id = 'media-' + c.localId;
        div.appendChild(media);
        addCustomControls(media, div, c, !!video);

        // Recompute fill-vs-fit once the real video dimensions are known and
        // whenever they change (e.g. the remote rotates their phone). (Sozvon)
        if(!c.up) {
            media.addEventListener('loadedmetadata', applyRemoteFraming);
            media.addEventListener('resize', applyRemoteFraming);
            // Send playback to the user's chosen speaker (Sozvon).
            applyAudioOutput(media);
        }
    }

    if(mirror)
        media.classList.add('mirror');
    else
        media.classList.remove('mirror');

    if(!video && media.srcObject !== c.stream)
        media.srcObject = c.stream;

    // Your own up-stream must NEVER play back through your own speaker, or you
    // hear your own microphone locally (a loopback that sounds like an echo).
    // Per-user volume / mute is a property of REMOTE participants only; applying
    // it to the self tile (whose stored state defaults to un-muted) was
    // overriding the media.muted = true set above and causing the loopback. (Sozvon)
    if(c.up) {
        media.muted = true;
    } else if(c.source) {
        let s = getUserAudioState(c.source);
        media.volume = s.volume;
        media.muted = s.muted;
    }

    if(!c.up) {
        media.onfullscreenchange = function(e) {
            let entering = document.fullscreenElement === media;
            forceDownRate(c.id, entering, false);
            // Leaving fullscreen (often together with a rotation that happened
            // meanwhile) leaves the tile layout and any dragged self-thumbnail
            // still sized for the fullscreen view, so the video drifts/crops.
            // Recompute the layout once we are back. (Sozvon)
            if(!entering)
                resizePeers();
        }
    }

    let label = document.getElementById('label-' + c.localId);
    if(!label) {
        label = document.createElement('div');
        label.id = 'label-' + c.localId;
        label.classList.add('label');
        div.appendChild(label);
    }

    setLabel(c);
    setMediaStatus(c);

    // Reflect the user's "hide self" preference as soon as the self tile
    // exists in the DOM (so the floating pill has somewhere to detach to).
    // (Sozvon)
    if(c.up)
        applySelfHidden();

    showVideo();
    resizePeers();
}

/**
 * Sozvon: whether the self tile is currently a floating thumbnail rather than a
 * cell in the grid — which is what makes it draggable, and what takes it off
 * the stage for reflectStageEmpty().  Three views float it: the 1-on-1
 * speaker view, the multi-remote overlay, and the self-only view (which wears
 * .speaker-many too).
 *
 * @param {Element} peers
 * @returns {boolean}
 */
function selfThumbFloats(peers) {
    return !!peers && (peers.classList.contains('speaker') ||
                       peers.classList.contains('speaker-many'));
}

/**
 * Make the self-view thumbnail draggable while it is a floating thumbnail, so
 * the user can move their own little tile out of the way. A no-op in grid
 * view, where the self tile is just a normal cell: the handlers bail out
 * unless #peers is in one of the speaker views.
 *
 * @param {HTMLElement} div - the .peer-self container
 */
function makeSelfThumbDraggable(div) {
    if(div.dataset.draggable)
        return;                       // wire each tile only once
    div.dataset.draggable = 'true';
    let peers = document.getElementById('peers');
    let startX = 0, startY = 0, baseLeft = 0, baseTop = 0;
    let dragging = false, moved = false;

    div.addEventListener('pointerdown', function(e) {
        if(!selfThumbFloats(peers))
            return;                   // only a thumbnail is draggable
        if(e.pointerType === 'mouse' && e.button !== 0)
            return;
        // A press that lands on the hide-self eye (or anything in the top
        // control bar) must not start a drag: the setPointerCapture below
        // would retarget the follow-up `click` to .peer-self, so the eye's
        // own onclick never fires.  That is the real cause of the
        // "eye does nothing in desktop speaker view" bug — not the <video>
        // swallowing clicks.  Bail out and let the native click through.
        // (Touch synthesises the click on the eye itself, which is why the
        // eye already worked on mobile.) (Sozvon)
        if(e.target instanceof Element && e.target.closest('.top-video-controls'))
            return;
        let rect = div.getBoundingClientRect();
        let prect = peers.getBoundingClientRect();
        baseLeft = rect.left - prect.left;
        baseTop = rect.top - prect.top;
        startX = e.clientX;
        startY = e.clientY;
        dragging = true;
        moved = false;
        // switch from the CSS right/bottom anchor to an explicit left/top
        div.style.left = baseLeft + 'px';
        div.style.top = baseTop + 'px';
        div.style.right = 'auto';
        div.style.bottom = 'auto';
        div.classList.add('dragging');
        try { div.setPointerCapture(e.pointerId); } catch(err) { /* ignore */ }
        e.preventDefault();
    });

    div.addEventListener('pointermove', function(e) {
        if(!dragging)
            return;
        let dx = e.clientX - startX;
        let dy = e.clientY - startY;
        if(!moved && (Math.abs(dx) > 3 || Math.abs(dy) > 3))
            moved = true;
        let pw = peers.clientWidth, ph = peers.clientHeight;
        let w = div.offsetWidth, h = div.offsetHeight;
        let left = Math.max(0, Math.min(baseLeft + dx, pw - w));
        let top = Math.max(0, Math.min(baseTop + dy, ph - h));
        div.style.left = left + 'px';
        div.style.top = top + 'px';
    });

    function endDrag(e) {
        if(!dragging)
            return;
        dragging = false;
        div.classList.remove('dragging');
        try { div.releasePointerCapture(e.pointerId); } catch(err) { /* ignore */ }
        if(moved) {
            div.dataset.dragged = 'true';   // remember it left the home corner
            // Record the position as a fraction of the free drag range, so it
            // can be re-derived after a resize/rotation instead of keeping
            // stale pixels that fall outside the rotated viewport. (Sozvon)
            let pw = peers.clientWidth, ph = peers.clientHeight;
            let w = div.offsetWidth, h = div.offsetHeight;
            let left = parseFloat(div.style.left) || 0;
            let top = parseFloat(div.style.top) || 0;
            div.dataset.fracX = (pw - w > 0 ? left / (pw - w) : 0).toString();
            div.dataset.fracY = (ph - h > 0 ? top / (ph - h) : 0).toString();
        }
    }
    div.addEventListener('pointerup', endDrag);
    div.addEventListener('pointercancel', endDrag);
}

/**
 * Re-anchor a dragged self-thumbnail after a layout, window-size or orientation
 * change, so it keeps its relative place and can't be stranded off-screen. Only
 * acts on a tile the user has actually moved (dataset.dragged); an untouched
 * tile keeps its CSS corner position. The position is re-derived from the
 * fraction of the drag range stored at drop time (dataset.fracX/Y), which
 * survives rotation; we fall back to the current inline px otherwise, and clamp
 * into view either way.
 */
function clampSelfThumb() {
    let peers = document.getElementById('peers');
    if(!selfThumbFloats(peers))
        return;
    let self = peers.querySelector('.peer-self');
    if(!(self instanceof HTMLElement) || !self.dataset.dragged)
        return;
    let pw = peers.clientWidth, ph = peers.clientHeight;
    let w = self.offsetWidth, h = self.offsetHeight;
    let fx = parseFloat(self.dataset.fracX);
    let fy = parseFloat(self.dataset.fracY);
    let left = !isNaN(fx) ? fx * Math.max(0, pw - w) :
        (parseFloat(self.style.left) || 0);
    let top = !isNaN(fy) ? fy * Math.max(0, ph - h) :
        (parseFloat(self.style.top) || 0);
    self.style.left = Math.max(0, Math.min(left, pw - w)) + 'px';
    self.style.top = Math.max(0, Math.min(top, ph - h)) + 'px';
    // Override the CSS right/bottom corner anchor: resetSelfThumbPosition may
    // have cleared the inline ones while we were in grid view.
    self.style.right = 'auto';
    self.style.bottom = 'auto';

    // Self-healing.  The arithmetic above is only as good as the box it is
    // measured against: if the stage was mid-layout when this ran, or a resize
    // arrived that nothing recomputed, the tile can be left somewhere the user
    // cannot see and therefore cannot drag back.  It is the only view of your
    // own camera on the screen, so rather than trust the sums, check the
    // result — and if it has ended up off the stage, send it home to the
    // corner the CSS anchors it to. (Sozvon)
    let rect = self.getBoundingClientRect();
    let stage = peers.getBoundingClientRect();
    let margin = 8;
    if(rect.width < 1 || rect.height < 1 ||
       rect.right < stage.left + margin || rect.left > stage.right - margin ||
       rect.bottom < stage.top + margin || rect.top > stage.bottom - margin) {
        resetSelfThumbPosition();
        delete self.dataset.dragged;
    }
}

/**
 * Clear any dragged inline positioning from the self-view tile so it flows
 * back into the even grid. Called when leaving speaker view; the dragged
 * fraction (dataset.fracX/Y) is kept so a later return to speaker view restores
 * the moved position via clampSelfThumb. (Sozvon)
 */
function resetSelfThumbPosition() {
    let peers = document.getElementById('peers');
    if(!peers)
        return;
    let self = peers.querySelector('.peer-self');
    if(!(self instanceof HTMLElement))
        return;
    self.style.left = '';
    self.style.top = '';
    self.style.right = '';
    self.style.bottom = '';
}


/**
 * @param {Stream} c
 * @param {HTMLElement} elt
 */
function showHideMedia(c, elt) {
    let display = c.up || getSettings().displayAll;
    if(!display && c.stream) {
        let tracks = c.stream.getTracks();
        for(let i = 0; i < tracks.length; i++) {
            let t = tracks[i];
            if(t.kind === 'video') {
                display = true;
                break;
            }
        }
    }
    if(display)
        elt.classList.remove('peer-hidden');
    else
        elt.classList.add('peer-hidden');
}

/**
 * resetMedia resets the source stream of the media element associated
 * with c.  This has the side-effect of resetting any frozen frames.
 *
 * @param {Stream} c
 */
function resetMedia(c) {
    let media = /** @type {HTMLVideoElement} */
        (document.getElementById('media-' + c.localId));
    if(!media) {
        console.error("Resetting unknown media element")
        return;
    }
    media.srcObject = media.srcObject;
}

/**
 * @param {Element} elt
 */
function cloneHTMLElement(elt) {
    if(!(elt instanceof HTMLElement))
        throw new Error('Unexpected element type');
    return /** @type{HTMLElement} */(elt.cloneNode(true));
}

/**
 * @param {HTMLVideoElement} media
 * @param {HTMLElement} container
 * @param {Stream} c
 * @param {boolean} toponly
 */
function addCustomControls(media, container, c, toponly) {
    if(!toponly && !document.getElementById('controls-' + c.localId)) {
        media.controls = false;

        let template =
            document.getElementById('videocontrols-template').firstElementChild;
        // The bottom-controls panel used to host volume / PiP / fullscreen /
        // play. After dropping volume / PiP / fullscreen in Sozvon, the only
        // remaining content is the play button, which is only useful for
        // autoplay-blocked media. Skip rendering an empty gradient bar over
        // the video — its `vc-overlay` background and 25px bottom offset were
        // a visible dark band that obscured the picture for no reason. The
        // play button itself is now mirrored into the top controls row in
        // galene.html. (Sozvon)
        if(template && template.firstElementChild) {
            let controls = cloneHTMLElement(template);
            controls.id = 'controls-' + c.localId;
            container.appendChild(controls);
        }
    }

    if(c.up && !document.getElementById('topcontrols-' + c.localId)) {
        let toptemplate =
            document.getElementById('topvideocontrols-template').firstElementChild;
        let topcontrols = cloneHTMLElement(toptemplate);
        topcontrols.id = 'topcontrols-' + c.localId;
        container.appendChild(topcontrols);
    }

    // Reflect the media's play/pause state on the tile so the play button is
    // only shown for genuinely paused media (e.g. autoplay-blocked video),
    // not as an always-present control on a live stream.
    let reflectPaused = function() {
        container.classList.toggle('paused', media.paused);
    };
    media.addEventListener('play', reflectPaused);
    media.addEventListener('pause', reflectPaused);
    reflectPaused();

    // Touch layouts have no hover.  The old tap-to-reveal of the bottom controls
    // fought the immersive tap (a tap on the video toggles the whole chrome):
    // the same tap that should have shown the controls slid the bar away and
    // stripped them, leaving volume / fullscreen / picture-in-picture dead.  The
    // controls are now shown by CSS whenever the chrome is up (and hidden with it
    // when going immersive), so no per-tile reveal is needed here. (Sozvon)

    registerControlHandlers(c.localId, media, container);
}

/**
 * @param {HTMLElement} container
 * @param {string} name
 */
function getVideoButton(container, name) {
    return /** @type {HTMLElement} */(container.getElementsByClassName(name)[0]);
}

/**
 * Reflect the user's preference to hide their own self-view on the layout.
 * When self-hidden, the .peer-self tile is removed from layout
 * (`display: none`) so it stops taking grid space (in grid mode) or
 * floating overlay space (in speaker / speaker-many mode), and a small
 * floating pill with the hide/stop buttons is anchored to the top-right of
 * #video-container. A second click on the pill re-shows the tile. (Sozvon)
 */
function applySelfHidden() {
    let container = document.getElementById('video-container');
    if(!container)
        return;
    let hidden = !!getSettings().selfHidden;
    container.classList.toggle('self-hidden', hidden);
    if(hidden)
        ensureSelfPill(container);
    let pill = container.querySelector('.self-controls-pill');
    if(!pill)
        return;
    pill.classList.toggle('visible', hidden);
    // Re-flow either way.  A grid cell freed by display: none has to collapse,
    // and hiding the tile also takes a picture off the stage — alone in the
    // room that is the last one, so the placeholder has to come up rather than
    // leave a black field with a pill floating in the corner of it. (Sozvon)
    resizePeers();
}

/**
 * Create the floating controls pill used when self-view is hidden. It is a
 * child of #video-container (NOT of .peer-self, which is `display: none` in
 * the hidden state and would take its children with it). The pill's two
 * buttons mirror the actions of the `_` and ✕ on the actual self tile; both
 * end up calling the same handlers via delegation on the pill. Built once
 * and then toggled by the .visible class. (Sozvon)
 * @param {HTMLElement} container
 */
function ensureSelfPill(container) {
    if(container.querySelector('.self-controls-pill'))
        return;
    let pill = document.createElement('div');
    pill.className = 'self-controls-pill';
    // Only the show ("eye open") button now. ✕ was dropped: the camera
    // on/off button in the bottom dock already covers stopping the camera.
    pill.innerHTML =
        '<span class="hide-icon video-hide" ' +
            'title="Show video" data-i18n-title="vc.show">' +
            '<i class="fas fa-eye-slash" aria-hidden="true"></i></span>';
    if(window.Sozvon && window.Sozvon.i18n)
        pill.querySelector('.video-hide').title =
            window.Sozvon.i18n.t('vc.show');
    // Click on the show button toggles selfHidden off, restoring the self
    // tile. The whole pill is one clickable area; we react to clicks on the
    // pill itself, the inner <span class="video-hide">, or the <i> icon.
    // (Sozvon)
    pill.addEventListener('click', function(e) {
        e.preventDefault();
        e.stopPropagation();
        updateSetting('selfHidden', false);
        applySelfHidden();
    });
    container.appendChild(pill);
}

/**
 * @param {string} localId
 * @param {HTMLVideoElement} media
 * @param {HTMLElement} container
 */
function registerControlHandlers(localId, media, container) {
    // Hide-self button: a less destructive alternative to the camera
    // on/off button. The up-stream keeps flowing so the remote still sees
    // me, but the self tile is removed from my own layout. A floating pill
    // with the show-icon (eye) appears in the top-right of #video-container
    // to bring the self-view back. (Sozvon)
    let hide = getVideoButton(container, 'video-hide');
    if(hide) {
        hide.onclick = function(event) {
            event.preventDefault();
            event.stopPropagation();
            let cur = !!getSettings().selfHidden;
            updateSetting('selfHidden', !cur);
            applySelfHidden();
        };
    }
}

/**
 * @param {string} localId
 */
function delMedia(localId) {
    let mediadiv = document.getElementById('peers');
    let peer = document.getElementById('peer-' + localId);
    if(!peer)
        throw new Error('Removing unknown media');

    let media = /** @type{HTMLVideoElement} */
        (document.getElementById('media-' + localId));

    media.srcObject = null;
    mediadiv.removeChild(peer);

    setButtonsVisibility();
    resizePeers();
    hideVideo();
}

/**
 * @param {Stream} c
 */
function setMediaStatus(c) {
    let state = c && c.pc && c.pc.iceConnectionState;
    let good = state === 'connected' || state === 'completed';

    let media = document.getElementById('media-' + c.localId);
    if(!media) {
        console.warn('Setting status of unknown media.');
        return;
    }
    if(good) {
        media.classList.remove('media-failed');
        if(c.userdata.play) {
            if(media instanceof HTMLMediaElement)
                media.play().catch(e => {
                    console.error(e);
                    displayError(e);
                });
            delete(c.userdata.play);
        }
    } else {
        media.classList.add('media-failed');
    }

    if(!c.up && state === 'failed') {
        let from = c.username ?
            `from user ${c.username}` :
            'from anonymous user';
        displayWarning(`Cannot receive media ${from}, still trying...`);
    }
}


/**
 * @param {Stream} c
 * @param {string} [fallback]
 */
function setLabel(c, fallback) {
    let label = document.getElementById('label-' + c.localId);
    if(!label)
        return;
    let l = c.username;
    if(l) {
        label.textContent = l;
        label.classList.remove('label-fallback');
    } else if(fallback) {
        label.textContent = fallback;
        label.classList.add('label-fallback');
    } else {
        label.textContent = '';
        label.classList.remove('label-fallback');
    }
}

/**
 * Smart framing of the 1-on-1 remote (speaker view). The remote tile already
 * fills the stage; these helpers decide how the *picture* fills its box:
 *   - "fill" (object-fit: cover) edge-to-edge when filling would crop only a
 *     little (the video and the screen are close in shape);
 *   - "fit" (object-fit: contain) showing the whole frame otherwise.
 * A shared screen is never cropped. (Sozvon)
 */
const FRAMING_MIN_VISIBLE = 0.6;

/**
 * Decide whether the remote picture should fill (cover) the stage. True only
 * when at least FRAMING_MIN_VISIBLE of the frame survives the crop.
 *
 * @param {HTMLElement} remote - the .peer-remote container
 * @param {HTMLVideoElement} media - its <video class="media">
 * @returns {boolean}
 */
function decideFill(remote, media) {
    if(!remote || !media)
        return false;
    // A shared screen must stay fully visible — never crop it.
    if(remote.dataset.label === 'screenshare')
        return false;
    let vw = media.videoWidth, vh = media.videoHeight;
    if(!vw || !vh)
        return false;   // real dimensions unknown yet → show the whole frame
    let sw = remote.clientWidth, sh = remote.clientHeight;
    if(!sw || !sh) {
        let stage = document.getElementById('video-container');
        if(stage) {
            sw = stage.clientWidth;
            sh = stage.clientHeight;
        }
    }
    if(!sw || !sh)
        return false;
    let videoAR = vw / vh, stageAR = sw / sh;
    let visible = Math.min(videoAR, stageAR) / Math.max(videoAR, stageAR);
    return visible >= FRAMING_MIN_VISIBLE;
}

/**
 * Apply the fill/fit decision to every remote tile. A no-op outside speaker
 * view (the framing CSS is scoped to #peers.speaker, so any stale classes left
 * behind are harmless). Called from resizePeers() and from the remote video's
 * loadedmetadata/resize events. (Sozvon)
 */
function applyRemoteFraming() {
    let peers = document.getElementById('peers');
    if(!peers)
        return;
    let speaker = peers.classList.contains('speaker');
    peers.querySelectorAll('.peer-remote').forEach(remote => {
        if(!(remote instanceof HTMLElement))
            return;
        let media = /** @type {HTMLVideoElement} */
            (remote.querySelector('video.media'));
        remote.classList.toggle('framing-fill', speaker && decideFill(remote, media));
    });
}

/**
 * Sozvon: how many tiles are showing a picture, counted separately for your own
 * tile and for everyone else's.
 *
 * The split matters because in the speaker views your tile is not *on* the
 * stage: it floats over it as a thumbnail, and what is behind it can perfectly
 * well be empty.
 *
 * @returns {{self: number, others: number}}
 */
function stageVideoCounts() {
    let peers = document.getElementById('peers');
    let counts = {self: 0, others: 0};
    if(!peers)
        return counts;
    peers.querySelectorAll('.peer').forEach(function(tile) {
        if(!tileShowsPicture(tile))
            return;
        if(tile.classList.contains('peer-self'))
            counts.self++;
        else
            counts.others++;
    });
    return counts;
}

/**
 * Sozvon: whether a tile is actually showing a picture right now.
 *
 * Both halves matter.  A tile that is not being rendered is not a picture on
 * the stage: hiding your own view with the eye leaves the stream running (the
 * others still see you) and takes the tile out of layout, which used to leave
 * the stage a black void — a live camera, and nothing drawn.  And a tile can
 * exist with no picture in it at all, because publishing a microphone gets you
 * a tile too.
 *
 * @param {Element} tile
 * @returns {boolean}
 */
function tileShowsPicture(tile) {
    if(!(tile instanceof HTMLElement) || tile.offsetParent === null)
        return false;
    let v = tile.querySelector('video');
    let s = v && v.srcObject;
    return !!(s && typeof (/** @type{MediaStream} */(s)).getVideoTracks === 'function' &&
              (/** @type{MediaStream} */(s)).getVideoTracks().some(
                  function(t) { return t.readyState === 'live'; }));
}

/**
 * Sozvon: the ids of the users whose face is already on the screen — on the
 * stage, or in the corner as the self-thumbnail.
 *
 * Up streams belong to us (serverConnection.id); down streams carry their
 * sender in c.source.  Same derivation setUserAudioState() uses.
 *
 * @returns {Set<string>}
 */
function usersShowingPicture() {
    let ids = new Set();
    if(!serverConnection)
        return ids;
    /** @param {Stream} c @param {string} userId */
    let note = function(c, userId) {
        if(!userId)
            return;
        if(tileShowsPicture(document.getElementById('peer-' + c.localId)))
            ids.add(userId);
    };
    for(let id in serverConnection.up)
        note(serverConnection.up[id], serverConnection.id);
    for(let id in serverConnection.down)
        note(serverConnection.down[id], serverConnection.down[id].source);
    return ids;
}

/**
 * Sozvon: how many tiles on the stage are actually showing a picture.
 *
 * @returns {number}
 */
function stageVideoCount() {
    let counts = stageVideoCounts();
    return counts.self + counts.others;
}

/**
 * Sozvon: toggle the "nobody is publishing" placeholder.
 *
 * #video-container is hidden whenever there are no tiles, which left the main
 * area as an unexplained black void — a call with participants but no cameras
 * looked broken rather than quiet.
 *
 * Reads the layout classes, so it has to run *after* resizePeers() has settled
 * them: in a speaker view your own picture has left the stage for the corner,
 * and the stage behind it is empty even though a camera is on.
 */
function reflectStageEmpty() {
    // Count video, not streams.  Turning the microphone on publishes an
    // audio-only stream, which still gets a tile — an empty box with no
    // picture in it.  Counting tiles therefore hid the placeholder exactly
    // when its own message ("nobody has turned their camera on") was true.
    let peers = document.getElementById('peers');
    let counts = stageVideoCounts();
    let floating = !!peers && (peers.classList.contains('speaker') ||
                               peers.classList.contains('speaker-many'));
    let count = counts.others + (floating ? 0 : counts.self);
    if(!count)
        renderStagePeople();
    setVisibility('stage-empty', !count);
    // The placeholder is opaque but click-through, so without this the tile
    // underneath still takes hover and clicks the user cannot see: its video
    // controls would light up behind the cover and be clickable there.
    document.body.classList.toggle('stage-idle', !count);
    // ...except the self-thumbnail, which has a picture and floats over the
    // placeholder rather than hiding under it.  The sheet needs to know about
    // that combination as one thing, because what it has to lift is the call
    // area rather than the grid inside it — see the rule for this class.
    document.body.classList.toggle('thumb-over-idle', !count && floating);
}

/**
 * Sozvon: a decorative state glyph for a stage tile.
 *
 * @param {string} name - the Font Awesome class, e.g. 'fa-microphone-slash'
 * @returns {HTMLElement}
 */
function stateGlyph(name) {
    let i = document.createElement('i');
    i.className = 'fas ' + name;
    i.setAttribute('aria-hidden', 'true');
    return i;
}

/* The narrowest a tile may be before the grid drops to fewer columns, and the
 * gaps between them — which must match the column-gap and row-gap the sheet
 * gives .stage-people. */
const STAGE_TILE_MIN = 220;
const STAGE_TILE_GAP = 10;
const STAGE_TILE_ROW_GAP = 5;

/**
 * Sozvon: draw the people in the room onto the empty stage.
 *
 * Derived from the rows in #users rather than from serverConnection, so there
 * is one source of truth for who is present, what their initial and avatar
 * shade are, and whether they have a live microphone — setUserStatus() already
 * works all of that out.  Showing the room's participants is more use than a
 * logo when the reason the stage is empty is that nobody has a camera on.
 */
function renderStagePeople() {
    let host = document.getElementById('stage-people');
    if(!host)
        return;
    host.textContent = '';

    // .user-p is also worn by lobby knock entries, which are not participants.
    let rows = document.querySelectorAll('#users .user-p:not(.knock-p)');

    // Nobody else in the room: a placeholder tile carrying your own name tells
    // you nothing you do not already know, and in the self-only speaker view
    // your face is in the corner anyway.  Say the useful thing instead.
    let alone = !!serverConnection && rows.length === 1 &&
        rows[0].id === 'user-' + serverConnection.id;
    setVisibility('stage-note', alone);
    if(alone)
        return;

    // "Display audio-only users" governs this exactly as it governs the real
    // tiles in showHideMedia(): with it off, a participant who is publishing
    // nothing is not shown at all, and the stage stays empty.
    if(!getSettings().displayAll)
        return;

    // Whoever is already on the screen is not drawn again.  The placeholder
    // used to appear only when nobody at all had a camera, so a tile per
    // participant was a tile per missing picture; now it also comes up behind
    // the self-thumbnail, and there you would see your own face in the corner
    // and a placeholder tile with your name on it at the same time.  It says
    // who is *not* showing a picture.
    let showing = usersShowingPicture();
    let people = Array.prototype.filter.call(rows, function(row) {
        return !showing.has(row.id.replace(/^user-/, ''));
    });

    // Same square-ish grid resizePeers() lays the video tiles out on — but no
    // narrower than a tile can usefully be: two people on a phone held
    // upright were two 195px chips side by side in an otherwise empty screen,
    // where stacking them gives two tiles twice the size.  And no taller than
    // the rows have room for, since the placeholder cannot scroll: the cap
    // goes out as a custom property the tiles read, so the shape stays 16:9
    // rather than squashing.
    let columns = Math.max(1, Math.min(
        Math.ceil(Math.sqrt(people.length)),
        Math.floor((host.clientWidth + STAGE_TILE_GAP) /
                   (STAGE_TILE_MIN + STAGE_TILE_GAP)),
    ));
    host.style['grid-template-columns'] =
        `repeat(${columns}, minmax(0, var(--stage-tile-max)))`;
    let tileRows = Math.ceil(people.length / columns);
    let maxHeight = Math.floor(
        (host.clientHeight - (tileRows - 1) * STAGE_TILE_ROW_GAP) / tileRows,
    );
    host.style.setProperty('--stage-tile-h',
                           maxHeight > 0 ? maxHeight + 'px' : 'none');

    people.forEach(function(row) {
        let label = personLabel(row);
        if(!label)
            return;
        let tile = document.createElement('div');
        tile.className = 'stage-person';
        tile.appendChild(label);
        host.appendChild(tile);
    });
}

/**
 * Sozvon: the bottom label for a participant who is not showing a picture —
 * their name and what they are not publishing.  Shared by the empty stage and
 * by the placeholder cells in the grid, so the two are the same object drawn
 * in two places rather than two things that look alike.
 *
 * @param {Element} row - the participant's row in #users
 * @returns {HTMLElement|null}
 */
function personLabel(row) {
    let nameEl = row.querySelector('.up-name');
    if(!nameEl)
        return null;

    let label = document.createElement('span');
    label.className = 'stage-person-label';

    let name = document.createElement('span');
    name.className = 'stage-person-name';
    name.textContent = nameEl.textContent;
    label.appendChild(name);

    // These tiles stand in for a missing picture, so the camera is off by
    // definition; the microphone has to be asked about.  Two things have to
    // agree: .user-status-microphone says there is an audio stream, and
    // .user-muted says they have silenced it (publishMuteState()).  For
    // ourselves the setting is the more immediate answer — it is true before
    // the round trip through the server that sets the class.
    let self = serverConnection && row.id === 'user-' + serverConnection.id;
    let audible = row.classList.contains('user-status-microphone') &&
        !row.classList.contains('user-muted');
    if(self && getSettings().localMute)
        audible = false;

    let state = document.createElement('span');
    state.className = 'stage-person-state';
    if(!audible)
        state.appendChild(stateGlyph('fa-microphone-slash'));
    state.appendChild(stateGlyph('fa-video-slash'));
    label.appendChild(state);

    return label;
}

/**
 * Sozvon: give every participant who has no tile of their own a cell in the
 * grid.
 *
 * A participant who publishes nothing at all — no camera, no microphone — has
 * no stream, and the grid is built from streams, so they were simply absent
 * from it: with your own camera on, the stage was your face at full size and
 * no sign that anyone else was in the room.  (Publish a microphone and you
 * already get a tile with no picture in it, which is what these copy.)
 *
 * Governed by "display audio-only users", which is the setting that decides
 * whether people who are not sending a picture appear on the stage at all.
 *
 * @returns {number} how many cells were added
 */
function syncPersonTiles() {
    let peers = document.getElementById('peers');
    if(!peers || !serverConnection)
        return 0;

    /** @type {Map<string,Element>} */
    let wanted = new Map();
    // Nothing on the stage at all is the empty stage's business: it covers the
    // whole thing opaquely and draws these same people itself, so cells
    // underneath would be two mechanisms doing one job — and counting them
    // would take resizePeers() off the path it has always taken when there is
    // nothing to lay out.  These cells are for a stage that has pictures on it
    // and people missing from it.
    let counts = stageVideoCounts();
    if(counts.self + counts.others > 0 &&
       getSettings().displayAll && !document.body.classList.contains('pre-join')) {
        let withTile = usersWithTile();
        document.querySelectorAll('#users .user-p:not(.knock-p)').forEach(
            function(row) {
                let id = row.id.replace(/^user-/, '');
                if(id && !withTile.has(id))
                    wanted.set(id, row);
            });
    }

    // Diff rather than rebuild: resizePeers() runs on every resize event, and
    // replacing these nodes sixty times a second would restart their fade and
    // churn the grid for no reason.
    peers.querySelectorAll('.peer-person').forEach(function(tile) {
        let id = tile instanceof HTMLElement ? tile.dataset.userId : null;
        let row = id ? wanted.get(id) : null;
        if(!row) {
            tile.remove();
            return;
        }
        let label = personLabel(row);
        if(label) {
            tile.textContent = '';
            tile.appendChild(label);
        }
        wanted.delete(id);
    });

    wanted.forEach(function(row, id) {
        let label = personLabel(row);
        if(!label)
            return;
        let tile = document.createElement('div');
        tile.className = 'peer peer-person';
        tile.dataset.userId = id;
        tile.appendChild(label);
        peers.appendChild(tile);
    });

    reflectPicturelessTiles();

    return peers.querySelectorAll('.peer-person').length;
}

/**
 * Sozvon: a real tile with no picture in it gets the same label as a placeholder
 * cell — the name, and what is not being published.
 *
 * Publish a microphone and the grid gives you a tile, but the tile is built
 * for a picture: upstream's label carries `c.username`, which is empty for
 * anyone who joined without a name, and nothing at all says whether the
 * microphone that earned the tile is even live.  An empty box in the middle of
 * the stage was the result.  The people list knows all of it, so borrow the
 * same label the placeholder cells use and hide the plain one underneath.
 */
function reflectPicturelessTiles() {
    if(!serverConnection)
        return;
    /** @param {Stream} c @param {string} userId */
    let reflect = function(c, userId) {
        let tile = document.getElementById('peer-' + c.localId);
        if(!tile)
            return;
        let old = tile.querySelector(':scope > .stage-person-label');
        // A picture needs no explaining: it shows a face, and the plain label
        // under it is upstream's business.
        if(tileShowsPicture(tile)) {
            if(old)
                old.remove();
            tile.classList.remove('peer-nopicture');
            return;
        }
        let row = userId && document.getElementById('user-' + userId);
        let label = row ? personLabel(row) : null;
        if(!label) {
            if(old)
                old.remove();
            tile.classList.remove('peer-nopicture');
            return;
        }
        if(old)
            old.remove();
        tile.classList.add('peer-nopicture');
        tile.appendChild(label);
    };
    for(let id in serverConnection.up)
        reflect(serverConnection.up[id], serverConnection.id);
    for(let id in serverConnection.down)
        reflect(serverConnection.down[id], serverConnection.down[id].source);
}

/**
 * Sozvon: the ids of the users who have a tile of their own on the stage,
 * whether or not there is a picture in it.
 *
 * @returns {Set<string>}
 */
function usersWithTile() {
    let ids = new Set();
    if(!serverConnection)
        return ids;
    /** @param {Stream} c @param {string} userId */
    let note = function(c, userId) {
        let tile = document.getElementById('peer-' + c.localId);
        // .peer-hidden is how showHideMedia() drops a tile the user has asked
        // not to see; such a tile is not on the stage.
        if(userId && tile && tile.offsetParent !== null)
            ids.add(userId);
    };
    for(let id in serverConnection.up)
        note(serverConnection.up[id], serverConnection.id);
    for(let id in serverConnection.down)
        note(serverConnection.down[id], serverConnection.down[id].source);
    return ids;
}

function resizePeers() {
    // Window resize can call this method too early
    if (!serverConnection)
        return;
    let up = Object.keys(serverConnection.up).length;
    let down = Object.keys(serverConnection.down).length;
    // Participants with no stream of their own get a cell too, and it takes
    // part in the grid like any other — so it is counted here, before the
    // columns are worked out.  It is deliberately not counted towards the
    // speaker views below: those are about pictures, and these cells have
    // none.
    let persons = syncPersonTiles();
    let count = up + down + persons;
    let peers = document.getElementById('peers');
    if (!count) {
        // No video, nothing to resize.
        peers.classList.remove('speaker');
        peers.classList.remove('speaker-many');
        peers.classList.remove('speaker-self');
        updateViewToggle(false, false, false);
        reflectStageEmpty();
        return;
    }

    // Speaker view shows the remote video full-size with my own video as a
    // small self-thumbnail in the corner, the way Zoom and similar tools do
    // it. The "speaker-many" variant is the same idea but for 3+ participants:
    // the remotes stay in an even grid, and only the self tile is pulled out
    // as a small floating overlay. The View button toggles between the chosen
    // mode and the even grid; that choice is remembered for the session.
    //
    // The same choice is offered when nobody else is publishing: your own
    // picture either fills the stage (grid) or steps into the corner as the
    // thumbnail, leaving the stage to say who is in the room — "you are the
    // only one here", or a tile per person if others are present without a
    // camera. It is the view you will be in when you open the room first and
    // wait for someone, and hiding the button there meant the layout could
    // only be arranged once a second person had arrived.
    let speakerCapable = up >= 1 && down === 1;
    let speakerManyCapable = up >= 1 && down >= 2;
    // Only worth offering if you have a picture to move: an audio-only
    // publication is a tile with nothing in it, and a thumbnail of nothing is
    // not a view.
    let selfOnlyCapable = down === 0 && stageVideoCounts().self > 0;
    let mode = getSettings().viewMode;
    let useSpeaker = false, useSpeakerMany = false, useSelfOnly = false;
    if (selfOnlyCapable) {
        // No smart default here: alone, the natural view is your own picture
        // at full size, so the corner thumbnail is something you ask for.
        useSelfOnly = mode === 'speaker' || mode === 'speaker-many';
    } else if (speakerManyCapable) {
        if (mode === 'grid')
            useSpeakerMany = false;
        else if (mode === 'speaker-many')
            useSpeakerMany = true;
        else
            // Smart default: 3+ opens with the self-overlay thumbnail.
            useSpeakerMany = true;
    } else if (speakerCapable) {
        if (mode === 'grid')
            useSpeaker = false;
        else if (mode === 'speaker')
            useSpeaker = true;
        else
            // Smart default: a plain 1-on-1 call opens in speaker view.
            useSpeaker = up === 1 && down === 1;
    }

    updateViewToggle(speakerCapable || speakerManyCapable || selfOnlyCapable,
                     useSpeaker, useSpeakerMany || useSelfOnly);

    if (useSpeaker) {
        peers.classList.add('speaker');
        peers.classList.remove('speaker-many');
        peers.classList.remove('speaker-self');
        peers.style['grid-template-columns'] = '';
        peers.querySelectorAll('.media').forEach(m => {
            if (m instanceof HTMLElement)
                m.style['max-height'] = '';
        });
        clampSelfThumb();   // keep a moved self-thumbnail on-screen
        applyRemoteFraming();   // fill vs fit (Sozvon)
        reflectStageEmpty();
        return;
    }
    if (useSelfOnly) {
        // Same geometry as speaker-many — the self tile floats in the corner —
        // but with nothing at all in the grid behind it, so the placeholder is
        // what fills the stage.  .speaker-self only lifts the (otherwise
        // empty) grid over that placeholder, which would else paint across the
        // thumbnail: #peers carries its own stacking context.
        peers.classList.remove('speaker');
        peers.classList.add('speaker-many');
        peers.classList.add('speaker-self');
        peers.style['grid-template-columns'] = '';
        clampSelfThumb();
        reflectStageEmpty();
        return;
    }
    if (useSpeakerMany) {
        peers.classList.remove('speaker');
        peers.classList.add('speaker-many');
        peers.classList.remove('speaker-self');
        // Remotes keep the regular grid; the CSS for .speaker-many only
        // pulls the self tile out as a floating overlay.  Clamp rather than
        // reset: the thumbnail can be dragged in this view too, and resetting
        // here snapped it back to its home corner on every relayout — every
        // window resize, every stream coming or going.
        clampSelfThumb();
    } else {
        peers.classList.remove('speaker');
        peers.classList.remove('speaker-many');
        peers.classList.remove('speaker-self');
        // Leaving speaker view: a self-thumbnail the user dragged carries inline
        // left/top/right/bottom that, against the grid cell, would shove it out of
        // place and break the grid. Clear them so it flows into the grid as an even
        // cell. (Sozvon)
        resetSelfThumbPosition();
    }
    reflectStageEmpty();

    let columns = Math.ceil(Math.sqrt(count));
    // Never cut the stage into columns too narrow to show a face in: on a
    // phone the square-ish grid asks for three columns of a hundred pixels
    // where two of a hundred and sixty read far better.  The row cap below
    // then shrinks the tiles vertically to match, so nothing spills. (Sozvon)
    let fits = Math.max(1, Math.floor(peers.clientWidth / 160));
    columns = Math.max(1, Math.min(columns, fits));
    let container = document.getElementById("video-container");
    // Peers div has total padding of 40px, we remove 40 on offsetHeight
    // Grid has row-gap of 5px
    let rows = Math.ceil(count / columns);
    let margins = (rows - 1) * 5 + 40;

    if (count <= 2 && container.offsetHeight > container.offsetWidth) {
        peers.style['grid-template-columns'] = "repeat(1, 1fr)";
        rows = count;
    } else {
        peers.style['grid-template-columns'] = `repeat(${columns}, 1fr)`;
    }
    if (count === 1)
        return;
    let max_video_height = (peers.offsetHeight - margins) / rows;
    let media_list = peers.querySelectorAll(".media");
    for(let i = 0; i < media_list.length; i++) {
        let media = media_list[i];
        if(!(media instanceof HTMLMediaElement)) {
            console.warn('Unexpected media');
            continue;
        }
        media.style['max-height'] = max_video_height + "px";
    }
    // The placeholder cells have no <video> to be capped by the loop above, so
    // their aspect ratio alone would let a row grow past its share and push
    // the grid under the dock. (Sozvon)
    peers.querySelectorAll('.peer-person').forEach(function(tile) {
        if(tile instanceof HTMLElement)
            tile.style['max-height'] = max_video_height + "px";
    });
    applyRemoteFraming();   // keep framing classes in sync (Sozvon)
}

/**
 * Show or hide the grid/speaker view toggle and make it reflect the current
 * layout. The button only appears when switching is meaningful (a 1-on-1 call
 * or a 3+ call with my own camera); its icon and tooltip describe the view
 * that a click switches to.
 *
 * @param {boolean} capable - whether any speaker-style view is available
 * @param {boolean} speaker - whether 1-on-1 speaker view is currently active
 * @param {boolean} speakerMany - whether the multi-remote self-overlay view is active
 */
function updateViewToggle(capable, speaker, speakerMany) {
    let btn = document.getElementById('viewtoggle');
    if(!btn)
        return;
    setVisibility('viewtoggle', capable);
    let inSpeaker = speaker || speakerMany;
    let icon = btn.querySelector('i');
    if(icon) {
        // Show the icon of the view a click switches to: the FontAwesome grid
        // glyph while in speaker view, and a picture-in-picture glyph (a framed
        // rectangle with an inset corner rectangle, drawn in CSS via .view-pip)
        // while in grid view. The old fa-user speaker glyph is retired — it was
        // unclear and clashed with the participants toggle.
        icon.classList.remove('fa-user');
        icon.classList.toggle('fas', inSpeaker);
        icon.classList.toggle('fa-th-large', inSpeaker);
        icon.classList.toggle('view-pip', !inSpeaker);
    }
    let key = inSpeaker ? 'nav.gridView' : 'nav.speakerView';
    btn.setAttribute('data-i18n-title', key);
    if(window.Sozvon && window.Sozvon.i18n)
        btn.title = window.Sozvon.i18n.t(key);
}

/**
 * Lexicographic order, with case differences secondary.
 * @param{string} a
 * @param{string} b
 */
function stringCompare(a, b) {
    let la = a.toLowerCase();
    let lb = b.toLowerCase();
    if(la < lb)
        return -1;
    else if(la > lb)
        return +1;
    else if(a < b)
        return -1;
    else if(a > b)
        return +1;
    return 0
}

/**
 * @param {string} v
 */
function dateFromInput(v) {
    let d = new Date(v);
    if(d.toString() === 'Invalid Date')
        throw new Error('Invalid date');
    return d;
}

/**
 * @param {Date} d
 */
function dateToInput(d) {
    let dd = new Date(d);
    dd.setMinutes(dd.getMinutes() - dd.getTimezoneOffset());
    return dd.toISOString().slice(0, -1);
}

function inviteMenu() {
    let d = /** @type {HTMLDialogElement} */
        (document.getElementById('invite-dialog'));
    if(!('HTMLDialogElement' in window) || !d.showModal) {
        displayError("This browser doesn't support modal dialogs");
        return;
    }
    d.returnValue = '';
    let c = getButtonElement('invite-cancel');
    c.onclick = function(e) { d.close('cancel'); };
    let u = getInputElement('invite-username');
    u.value = '';
    let now = new Date();
    now.setMilliseconds(0);
    now.setSeconds(0);
    let nb = getInputElement('invite-not-before');
    nb.min = dateToInput(now);
    let ex = getInputElement('invite-expires');
    let expires = new Date(now);
    expires.setDate(expires.getDate() + 2);
    ex.min = dateToInput(now);
    ex.value = dateToInput(expires);
    d.showModal();
}

document.getElementById('invite-dialog').onclose = function(e) {
    if(!(this instanceof HTMLDialogElement))
        throw new Error('Unexpected type for this');
    let dialog = /** @type {HTMLDialogElement} */(this);
    if(dialog.returnValue !== 'invite')
        return;
    let u = getInputElement('invite-username');
    let username = u.value.trim() || null;
    let nb = getInputElement('invite-not-before');
    let notBefore = null;
    if(nb.value) {
        try {
            notBefore = dateFromInput(nb.value);
        } catch(e) {
            displayError(`Couldn't parse ${nb.value}: ${e.message}`);
            return;
        }
    }
    let ex = getInputElement('invite-expires');
    let expires = null;
    if(ex.value) {
        try {
            expires = dateFromInput(ex.value);
        } catch(e) {
            displayError(`Couldn't parse ${ex.value}: ${e.message}`);
            return;
        }
    }
    let template = {}
    if(username)
        template.username = username;
    if(notBefore)
        template['not-before'] = notBefore;
    if(expires)
        template.expires = expires;
    makeToken(template);
};

/**
 * @param {HTMLElement} elt
 */
function userMenu(elt) {
    if(!elt.id.startsWith('user-'))
        throw new Error('Unexpected id for user menu');
    let id = elt.id.slice('user-'.length);
    let user = serverConnection.users[id];
    if(!user)
        throw new Error("Couldn't find user")
    let items = [];
    if(id === serverConnection.id) {
        let mydata = serverConnection.users[serverConnection.id].data;
        if(mydata['raisehand'])
            items.push({label: Sozvon.i18n.t('menu.unraiseHand'), onClick: () => {
                serverConnection.userAction(
                    'setdata', serverConnection.id, {'raisehand': null},
                );
            }});
        else
            items.push({label: Sozvon.i18n.t('menu.raiseHand'), onClick: () => {
                serverConnection.userAction(
                    'setdata', serverConnection.id, {'raisehand': true},
                );
            }});
        if(serverConnection.version !== "1" &&
           serverConnection.permissions.indexOf('token') >= 0) {
            items.push({label: Sozvon.i18n.t('menu.inviteUser'), onClick: () => {
                inviteMenu();
            }});
        }
        if(serverConnection.permissions.indexOf('present') >= 0 && canFile())
            items.push({label: Sozvon.i18n.t('menu.broadcastFile'), onClick: presentFile});
        items.push({label: Sozvon.i18n.t('menu.restartMedia'), onClick: renegotiateStreams});
    } else {
        items.push({label: Sozvon.i18n.t('menu.sendFile'), onClick: () => {
            sendFile(id);
        }});
        if(serverConnection.permissions.indexOf('op') >= 0) {
            items.push({type: 'seperator'}); // sic
            if(user.permissions.indexOf('present') >= 0)
                items.push({label: Sozvon.i18n.t('menu.forbidPresent'), onClick: () => {
                    serverConnection.userAction('unpresent', id);
                }});
            else
                items.push({label: Sozvon.i18n.t('menu.allowPresent'), onClick: () => {
                    serverConnection.userAction('present', id);
                }});
            items.push({label: Sozvon.i18n.t('menu.mute'), onClick: () => {
                serverConnection.userMessage('mute', id);
            }});
            items.push({label: Sozvon.i18n.t('menu.kick'), onClick: () => {
                serverConnection.userAction('kick', id);
            }});
            items.push({label: Sozvon.i18n.t('menu.identify'), onClick: () => {
                serverConnection.userAction('identify', id);
            }});
        }
    }
    /** @ts-ignore */
    new Contextual({
        items: items,
    });
}

/**
 * @param {string} id
 * @param {user} userinfo
 */
function addUser(id, userinfo) {
    let div = document.getElementById('users');
    let user = document.createElement('div');
    user.id = 'user-' + id;
    user.classList.add("user-p");
    setUserStatus(id, user, userinfo);
    user.addEventListener('click', function(e) {
        let elt = e.currentTarget;
        if(!elt || !(elt instanceof HTMLElement))
            throw new Error("Couldn't find user div");
        userMenu(elt);
    });

    let us = div.children;

    if(id === serverConnection.id) {
        if(us.length === 0)
            div.appendChild(user);
        else
            div.insertBefore(user, us[0]);
        return;
    }

    if(userinfo.username) {
        for(let i = 0; i < us.length; i++) {
            let child = us[i];
            let childid = child.id.slice('user-'.length);
            if(childid === serverConnection.id)
                continue;
            let childuser = serverConnection.users[childid] || null;
            let childname = (childuser && childuser.username) || null;
            if(!childname || stringCompare(childname, userinfo.username) > 0) {
                div.insertBefore(user, child);
                return;
            }
        }
    }

    div.appendChild(user);
}

 /**
  * @param {string} id
  * @param {user} userinfo
  */
function changeUser(id, userinfo) {
    let elt = document.getElementById('user-' + id);
    if(!elt) {
        console.warn('Unknown user ' + id);
        return;
    }
    setUserStatus(id, elt, userinfo);
}

/**
 * @param {string} id
 * @param {HTMLElement} elt
 * @param {user} userinfo
 */
function setUserStatus(id, elt, userinfo) {
    let name = userinfo.username ? userinfo.username : '(anon)';

    // Sozvon: structured row = round avatar (initial + presence dot) + name +
    // (when the user has audio) a per-user volume slider and mute toggle.
    // Built once and then updated in place, so a status change no longer
    // clobbers it (the old code did elt.textContent = name, which is why this
    // must own the row structure now). The mic/cam glyph still floats in via
    // the ::after rule; a raised hand still comes from ::before.
    let nameEl = elt.querySelector('.up-name');
    if(!nameEl) {
        elt.textContent = '';
        let avatar = document.createElement('span');
        avatar.classList.add('up-avatar');
        let ini = document.createElement('span');
        ini.classList.add('up-ini');
        let dot = document.createElement('span');
        dot.classList.add('up-dot');
        avatar.appendChild(ini);
        avatar.appendChild(dot);
        nameEl = document.createElement('span');
        nameEl.classList.add('up-name');
        elt.appendChild(avatar);
        elt.appendChild(nameEl);
    }
    nameEl.textContent = name;

    // Avatar: first letter/number of the name, plus a stable colour bucket.
    let m = name.match(/[\p{L}\p{N}]/u);
    elt.querySelector('.up-ini').textContent = m ? m[0].toUpperCase() : '?';
    let h = 0;
    for(let i = 0; i < name.length; i++)
        h = (h * 31 + name.charCodeAt(i)) >>> 0;
    let avatar = elt.querySelector('.up-avatar');
    avatar.classList.remove('av-0', 'av-1', 'av-2', 'av-3', 'av-4');
    avatar.classList.add('av-' + (h % 5));

    if(userinfo.data.raisehand)
        elt.classList.add('user-status-raisehand');
    else
        elt.classList.remove('user-status-raisehand');

    // Whether they have silenced themselves, which is a different question
    // from whether they publish audio at all: muting disables the track and
    // leaves the stream in place, so `streams` below cannot tell.  Published
    // by publishMuteState() over the same per-user data as the raised hand.
    // (Sozvon)
    elt.classList.toggle('user-muted', !!userinfo.data.muted);

    let microphone=false, camera = false;
    for(let label in userinfo.streams) {
        for(let kind in userinfo.streams[label]) {
            if(kind === 'audio')
                microphone = true;
            else
                camera = true;
        }
    }
    if(camera) {
        elt.classList.remove('user-status-microphone');
        elt.classList.add('user-status-camera');
    } else if(microphone) {
        elt.classList.add('user-status-microphone');
        elt.classList.remove('user-status-camera');
    } else {
        elt.classList.remove('user-status-microphone');
        elt.classList.remove('user-status-camera');
    }

    // Per-user volume slider: shown only when the user has at least one audio
    // track. The slider mutates client-side audio.volume / audio.muted for
    // every media element we have for that user; nothing is sent to the
    // server, and a refresh resets the levels. (Sozvon)
    let volEl = elt.querySelector('.up-volume');
    if(microphone) {
        if(!volEl) {
            volEl = document.createElement('span');
            volEl.classList.add('up-volume');
            let muteBtn = document.createElement('i');
            muteBtn.className = 'fas fa-volume-up up-volume-mute';
            muteBtn.setAttribute('data-i18n-title', 'userlist.mute');
            if(window.Sozvon && window.Sozvon.i18n)
                muteBtn.title = window.Sozvon.i18n.t('userlist.mute');
            let slider = document.createElement('input');
            slider.type = 'range';
            slider.min = '0';
            slider.max = '100';
            slider.step = '5';
            slider.value = '100';
            slider.className = 'up-volume-slider';
            slider.setAttribute('data-i18n-title', 'userlist.volume');
            if(window.Sozvon && window.Sozvon.i18n)
                slider.title = window.Sozvon.i18n.t('userlist.volume');
            volEl.appendChild(muteBtn);
            volEl.appendChild(slider);
            // Click on mute or drag on the slider should NOT open the row's
            // context menu. (Sozvon)
            volEl.addEventListener('click', e => e.stopPropagation());
            muteBtn.addEventListener('click', e => {
                e.stopPropagation();
                toggleUserMute(id);
            });
            slider.addEventListener('input', e => {
                e.stopPropagation();
                let v = parseInt(/** @type{HTMLInputElement}*/(e.target).value, 10);
                setUserAudioState(id, v / 100, getUserAudioState(id).muted);
            });
            elt.appendChild(volEl);
        }
        // Reflect the stored state in the UI (e.g. on a status refresh that
        // rebuilt nothing but the row classes).
        let s = getUserAudioState(id);
        let muteBtn = volEl.querySelector('.up-volume-mute');
        let slider = /** @type{HTMLInputElement} */
            (volEl.querySelector('.up-volume-slider'));
        if(s.muted) {
            muteBtn.classList.remove('fa-volume-up');
            muteBtn.classList.add('fa-volume-mute');
            muteBtn.classList.add('muted');
            muteBtn.setAttribute('data-i18n-title', 'userlist.unmute');
            if(window.Sozvon && window.Sozvon.i18n)
                muteBtn.title = window.Sozvon.i18n.t('userlist.unmute');
        } else {
            muteBtn.classList.remove('fa-volume-mute');
            muteBtn.classList.remove('muted');
            muteBtn.classList.add('fa-volume-up');
            muteBtn.setAttribute('data-i18n-title', 'userlist.mute');
            if(window.Sozvon && window.Sozvon.i18n)
                muteBtn.title = window.Sozvon.i18n.t('userlist.mute');
        }
        slider.value = String(Math.round(s.volume * 100));
    } else if(volEl) {
        // No audio for this user (yet) — keep the row clean.
        volEl.remove();
    }
}

/**
 * In-memory per-user audio overrides (mute + volume). Not persisted; a
 * refresh resets the levels. The user asked for the volume control to live
 * in the participant list and the simplest model is per-session client-side
 * state. (Sozvon)
 * @type {Record<string, {volume: number, muted: boolean}>}
 */
let userAudioStates = {};

/**
 * @param {string} userId
 * @returns {{volume: number, muted: boolean}}
 */
function getUserAudioState(userId) {
    if(!userAudioStates[userId])
        userAudioStates[userId] = {volume: 1.0, muted: false};
    return userAudioStates[userId];
}

/**
 * Apply a (volume, muted) override to every media element we currently
 * have for this user (audio and combined audio/video tiles).
 * @param {string} userId
 * @param {number} [volume]
 * @param {boolean} [muted]
 */
function setUserAudioState(userId, volume, muted) {
    let s = getUserAudioState(userId);
    if(typeof volume === 'number')
        s.volume = Math.max(0, Math.min(1, volume));
    if(typeof muted === 'boolean')
        s.muted = muted;
    // Walk every Stream belonging to this user. Up streams have userId =
    // serverConnection.id; down streams carry it in c.source. We re-derive
    // the userId from the stream so the same helper works for self and
    // for remotes. (Sozvon)
    if(!serverConnection)
        return;
    let apply = (c) => {
        let media = /** @type{HTMLMediaElement|null} */
            (document.getElementById('media-' + c.localId));
        if(!media)
            return;
        if(c.up) {
            // self never plays back through its own speaker
            media.muted = true;
            return;
        }
        media.volume = s.volume;
        media.muted = s.muted;
    };
    for(let id in serverConnection.up) {
        let c = serverConnection.up[id];
        if(userId === serverConnection.id)
            apply(c);
    }
    for(let id in serverConnection.down) {
        let c = serverConnection.down[id];
        if(c.source === userId)
            apply(c);
    }
    // Refresh the row's slider/mute icon in place (the row's DOM was
    // already updated by setUserStatus, but if a status refresh hasn't
    // happened since the slider was created we still need to reflect the
    // new muted state in the icon).
    let row = document.getElementById('user-' + userId);
    if(!row)
        return;
    let volEl = row.querySelector('.up-volume');
    if(!volEl)
        return;
    let muteBtn = volEl.querySelector('.up-volume-mute');
    let slider = /** @type{HTMLInputElement} */
        (volEl.querySelector('.up-volume-slider'));
    if(muteBtn) {
        if(s.muted) {
            muteBtn.classList.remove('fa-volume-up');
            muteBtn.classList.add('fa-volume-mute');
            muteBtn.classList.add('muted');
            muteBtn.setAttribute('data-i18n-title', 'userlist.unmute');
            if(window.Sozvon && window.Sozvon.i18n)
                muteBtn.title = window.Sozvon.i18n.t('userlist.unmute');
        } else {
            muteBtn.classList.remove('fa-volume-mute');
            muteBtn.classList.remove('muted');
            muteBtn.classList.add('fa-volume-up');
            muteBtn.setAttribute('data-i18n-title', 'userlist.mute');
            if(window.Sozvon && window.Sozvon.i18n)
                muteBtn.title = window.Sozvon.i18n.t('userlist.mute');
        }
    }
    if(slider)
        slider.value = String(Math.round(s.volume * 100));
}

/**
 * @param {string} userId
 */
function toggleUserMute(userId) {
    let s = getUserAudioState(userId);
    setUserAudioState(userId, undefined, !s.muted);
}

/**
 * @param {string} id
 */
function delUser(id) {
    let div = document.getElementById('users');
    let user = document.getElementById('user-' + id);
    div.removeChild(user);
}

/**
 * The largest number of participants seen during the current group session
 * (reset on join). Used to tell a genuine 1-on-1 from a larger meeting that
 * happened to drain down to one person, so chat is only auto-wiped for the
 * former. See maybeClearChatOnSolo.
 *
 * @type {number}
 */
let peakUserCount = 0;

/**
 * After a participant leaves, if I'm now the only person left in what was a
 * 1-on-1 call, clear the chat. This keeps a private conversation from
 * lingering on screen once the other party is gone, and — when I have operator
 * rights — drops the server-side history too, so it can't be replayed to
 * whoever joins next. A non-operator can only clear their own view.
 *
 * Restricted to calls that never grew past two people (peakUserCount <= 2) so
 * a larger meeting winding down doesn't unexpectedly lose its history.
 */
function maybeClearChatOnSolo() {
    if(!serverConnection || !serverConnection.users)
        return;
    if(Object.keys(serverConnection.users).length !== 1)
        return;                       // someone other than me is still here
    if(peakUserCount > 2)
        return;                       // was a group call, leave its history be
    let op = serverConnection.permissions &&
        serverConnection.permissions.indexOf('op') >= 0;
    if(op)
        // clears my own box (via the broadcast echo) AND the stored history
        serverConnection.groupAction('clearchat');
    else
        // no rights to touch the server; at least clear my own view
        clearChat();
}

/**
 * Sozvon: the call clock.
 *
 * When the call became a call -- the moment a second person appeared in the
 * room -- or null while we are here on our own.  Deliberately not the moment
 * *we* joined: an operator who opens the room twenty minutes early is not in
 * a twenty-minute call, and would be shown a clock that had already run.
 *
 * @type {number|null}
 */
let callStart = null;

/**
 * Pending "the room has emptied out" check.  A peer that drops and comes
 * straight back (a phone changing network, a browser reload, our own
 * reconnect) must not restart the clock: knowing how far into the session you
 * are is the entire point of it.  So the clock keeps running for a grace
 * period after the room drains to one, and only then gives up on the call.
 *
 * @type {number|null}
 */
let callAloneTimeout = null;

/** How long a call survives being alone in the room, in milliseconds. */
const callResumeGrace = 2 * 60 * 1000;

/** @type {number|null} */
let callTimerInterval = null;

/**
 * The number of real people in the room, ourselves included.  Recorders and
 * other bots carry the "system" permission and are not company.
 *
 * (Permissions are a list of strings -- indexOf, not a lookup.  doSimulcast()
 * still spells the same test as a property access, which has quietly been a
 * no-op since upstream changed the shape; not this change to fix.)
 *
 * @returns {number}
 */
function participantCount() {
    if(!serverConnection || !serverConnection.users)
        return 0;
    let count = 0;
    for(let id in serverConnection.users) {
        let u = serverConnection.users[id];
        if(u && u.permissions && u.permissions.indexOf('system') >= 0)
            continue;
        count++;
    }
    return count;
}

/**
 * Whether the call clock should be on screen.  Once the user has touched the
 * checkbox the stored answer stands; until then it follows the role, because
 * the two want opposite defaults.  The host is running a session and needs to
 * know how far into it they are; the guest did not ask for a stopwatch on
 * their conversation, so they get the switch but not the clock.  (Sozvon)
 *
 * @returns {boolean}
 */
function callTimerEnabled() {
    let s = getSettings();
    if(typeof s.showCallTimer === 'boolean')
        return s.showCallTimer;
    return !!(serverConnection && serverConnection.permissions &&
              serverConnection.permissions.indexOf('op') >= 0);
}

/**
 * Format a duration as mm:ss, or h:mm:ss once it passes the hour.
 *
 * @param {number} ms
 * @returns {string}
 */
function formatDuration(ms) {
    let total = Math.max(0, Math.floor(ms / 1000));
    let seconds = total % 60;
    let minutes = Math.floor(total / 60) % 60;
    let hours = Math.floor(total / 3600);
    // Not padStart: the client is type-checked against an ES6 lib, and this
    // would be the only line in it that needed ES2017.
    /** @param {number} n */
    let two = function(n) { return (n < 10 ? '0' : '') + n; };
    let text = two(minutes) + ':' + two(seconds);
    return hours > 0 ? hours + ':' + text : text;
}

/** Repaint the readout once. */
function paintCallTimer() {
    let elt = document.getElementById('call-timer');
    if(elt && callStart !== null)
        elt.textContent = formatDuration(Date.now() - callStart);
}

/**
 * Show or hide the readout and own its one-second tick, so no caller has to
 * remember to start or stop the interval.  Cheap and idempotent: call it
 * whenever anything it depends on (the clock, the setting, our permissions)
 * may have changed.
 */
function reflectCallTimer() {
    let on = callStart !== null && callTimerEnabled();
    if(on)
        paintCallTimer();
    setVisibility('call-timer', on);
    if(on && !callTimerInterval)
        callTimerInterval = setInterval(paintCallTimer, 1000);
    else if(!on && callTimerInterval) {
        clearInterval(callTimerInterval);
        callTimerInterval = null;
    }
}

/** Make the drawer checkbox agree with the effective setting. */
function reflectCallTimerBox() {
    let box = document.getElementById('calltimerbox');
    if(box instanceof HTMLInputElement)
        box.checked = callTimerEnabled();
}

/**
 * Start, keep or drop the call clock after the room population changed.
 */
function updateCallTimer() {
    if(participantCount() >= 2) {
        if(callAloneTimeout) {
            clearTimeout(callAloneTimeout);
            callAloneTimeout = null;
        }
        if(callStart === null)
            callStart = Date.now();
    } else if(callStart !== null && !callAloneTimeout) {
        callAloneTimeout = setTimeout(function() {
            callAloneTimeout = null;
            if(participantCount() < 2) {
                callStart = null;   // they are not coming back
                reflectCallTimer();
            }
        }, callResumeGrace);
    }
    reflectCallTimer();
}

/** Forget the current call entirely (a new room, or back to the login). */
function resetCallTimer() {
    if(callAloneTimeout) {
        clearTimeout(callAloneTimeout);
        callAloneTimeout = null;
    }
    callStart = null;
    reflectCallTimer();
}

/**
 * @param {string} id
 * @param {string} kind
 */
function gotUser(id, kind) {
    switch(kind) {
    case 'add':
        addUser(id, serverConnection.users[id]);
        if(e2eeActive())
            serverConnection.e2ee.addUser(id);
        peakUserCount = Math.max(
            peakUserCount, Object.keys(serverConnection.users).length,
        );
        updateCallTimer();
        if(Object.keys(serverConnection.users).length === 3)
            reconsiderSendParameters();
        break;
    case 'delete':
        delUser(id);
        if(e2eeActive())
            serverConnection.e2ee.delUser(id);
        maybeClearChatOnSolo();
        updateCallTimer();
        if(Object.keys(serverConnection.users).length < 3)
            scheduleReconsiderParameters();
        break;
    case 'change':
        changeUser(id, serverConnection.users[id]);
        break;
    default:
        console.warn('Unknown user kind', kind);
        break;
    }
}

/**
 * Whether the current group runs in E2EE mode at all, independently of
 * whether this browser can encrypt.  The controller tracks peers and drives
 * the security indicator whenever this is true.
 *
 * @returns {boolean}
 */
function e2eeActive() {
    // The operator-room hub serves a dashboard, not a call — E2EE is
    // meaningless there, and treating other operators as E2EE peers
    // would trip the multipeer/blocked state.  Child rooms of a hub
    // have operatorRoom=false, so they still get full E2EE.
    return !!(groupStatus.e2ee && !groupStatus.operatorRoom &&
              serverConnection && serverConnection.e2ee);
}

/**
 * Whether the current group runs in E2EE mode and this browser can encrypt,
 * so we attach the encrypting transforms and prefer VP8.
 *
 * @returns {boolean}
 */
function e2eeEnabled() {
    return e2eeActive() && serverConnection.e2ee.supported;
}

/**
 * Restrict a video transceiver to VP8 (+rtx), the codec the E2EE worker
 * assumes when it leaves the keyframe header in clear.
 *
 * @param {RTCRtpTransceiver} tr
 * @param {string} kind
 */
function preferVP8(tr, kind) {
    if(kind !== 'video' || !tr.setCodecPreferences ||
       typeof RTCRtpSender === 'undefined' || !RTCRtpSender.getCapabilities)
        return;
    try {
        let caps = RTCRtpSender.getCapabilities('video');
        if(!caps)
            return;
        let codecs = caps.codecs.filter(c => {
            let m = c.mimeType.toLowerCase();
            return m === 'video/vp8' || m === 'video/rtx';
        });
        if(codecs.length)
            tr.setCodecPreferences(codecs);
    } catch(e) {
        console.warn('E2EE preferVP8:', e);
    }
}

/**
 * Called by the E2EE controller when the authentication string is ready.
 *
 * @this {SozvonE2EE}
 * @param {string[]} sas
 */
function gotE2EESas(sas) {
    updateE2EEUI();
}

/**
 * Called by the E2EE controller whenever its state changes.
 *
 * @this {SozvonE2EE}
 */
function gotE2EEState() {
    updateE2EEUI();
    enforceE2EEMediaPolicy();
}

/**
 * When the group requires end-to-end encryption but this call cannot be
 * encrypted (a peer that cannot encrypt, or — defensively — more than two
 * participants), stop publishing local media and surface a clear notice, so
 * the call can never silently downgrade to cleartext.  Called on every E2EE
 * state change.
 */
function enforceE2EEMediaPolicy() {
    let e2ee = serverConnection && serverConnection.e2ee;
    let blocked = !!(e2ee && e2ee.state === 'blocked');
    setVisibility('e2ee-block-overlay', blocked);
    if(blocked) {
        // Never publish in clear when encryption is required.
        closeUpMedia('camera');
        closeUpMedia('screenshare');
        setButtonsVisibility();
    }
}

/**
 * Show a full-screen notice that the browser cannot do video calls (missing or
 * broken WebRTC, e.g. Xiaomi Mi Browser whose getUserMedia never resolves),
 * with the current link so the user can open it in a working browser.
 */
function showBrowserUnsupported() {
    let urlElt = document.getElementById('browser-unsupported-url');
    if(urlElt)
        urlElt.textContent = location.href;
    setVisibility('browser-unsupported-overlay', true);
}

function hideBrowserUnsupported() {
    setVisibility('browser-unsupported-overlay', false);
}

/**
 * Reflect the E2EE controller's state in the top-bar lock + emoji indicator.
 * The emoji are the Short Authentication String the two participants compare;
 * there is no separate banner or confirmation button.
 */
function updateE2EEUI() {
    let ind = document.getElementById('e2ee-indicator');
    let sas = document.getElementById('e2ee-sas');
    if(!ind)
        return;
    let e2ee = serverConnection && serverConnection.e2ee;
    if(!e2eeActive() || !e2ee) {
        setVisibility('e2ee-indicator', false);
        return;
    }
    ind.classList.remove('e2ee-on', 'e2ee-bad');
    if(sas)
        sas.textContent = '';
    let icon = ind.querySelector('i');
    switch(e2ee.state) {
    case 'established':
        ind.classList.add('e2ee-on');
        if(icon)
            icon.className = 'fas fa-lock';
        ind.title = Sozvon.i18n.t('e2ee.secure');
        if(sas)
            sas.textContent = e2ee.sas ? e2ee.sas.join('') : '';
        setVisibility('e2ee-indicator', true);
        break;
    case 'unencrypted':
        // Call is allowed but not end-to-end encrypted (3+ participants or a
        // peer that cannot encrypt, with "require encryption" off).
        ind.classList.add('e2ee-bad');
        if(icon)
            icon.className = 'fas fa-unlock';
        ind.title = Sozvon.i18n.t('e2ee.notEncrypted');
        setVisibility('e2ee-indicator', true);
        break;
    case 'blocked':
        ind.classList.add('e2ee-bad');
        if(icon)
            icon.className = 'fas fa-unlock';
        ind.title = Sozvon.i18n.t('e2ee.blocked');
        setVisibility('e2ee-indicator', true);
        break;
    case 'failed':
        ind.classList.add('e2ee-bad');
        if(icon)
            icon.className = 'fas fa-unlock';
        ind.title = Sozvon.i18n.t('e2ee.failed');
        setVisibility('e2ee-indicator', true);
        break;
    default: // idle / handshaking: nothing to compare yet
        setVisibility('e2ee-indicator', false);
        break;
    }
}

// Sound played to operators when someone enters the waiting room.
// Lazily created on the first knock: most browsers block Audio playback
// until the page has had a user gesture, so the first .play() may be
// rejected.  We catch that and arm a one-shot pointerdown listener that
// retries once the operator next clicks/taps anywhere on the page.
const KNOCK_SOUND_URL = '/knock.mp3';
let knockSound = null;
let knockSoundUnlocker = null;

function playKnockSound() {
    try {
        // honour the per-user toggle in operator settings; default on if
        // the setting is absent (e.g. before updateSettingsUI has run)
        let s = getSettings();
        if(s && s.knockSound === false)
            return;

        if(!knockSound) {
            knockSound = new Audio(KNOCK_SOUND_URL);
            knockSound.preload = 'auto';
        }
        // restart from the beginning on every knock
        knockSound.currentTime = 0;
        let p = knockSound.play();
        if(p && typeof p.catch === 'function') {
            p.catch(() => {
                if(knockSoundUnlocker) return;
                knockSoundUnlocker = function() {
                    window.removeEventListener('pointerdown',
                        knockSoundUnlocker, true);
                    window.removeEventListener('keydown',
                        knockSoundUnlocker, true);
                    knockSoundUnlocker = null;
                    playKnockSound();
                };
                window.addEventListener('pointerdown',
                    knockSoundUnlocker, true);
                window.addEventListener('keydown',
                    knockSoundUnlocker, true);
            });
        }
    } catch(e) {
        // sound is best-effort; never break the knock handling
    }
}

/**
 * Builds an Admit or Deny button that calls userAction on click. Shared by
 * the participants-panel knock row and the knock toast so both surfaces
 * trigger the same action.
 *
 * @param {'admit'|'deny'} kind
 * @param {string} id
 */
function makeKnockButton(kind, id) {
    let button = document.createElement('button');
    button.classList.add('knock-' + kind);
    button.title = Sozvon.i18n.t('knock.' + kind);
    button.setAttribute('aria-label', button.title);
    let icon = document.createElement('i');
    icon.className = kind === 'admit' ? 'fas fa-check' : 'fas fa-times';
    button.appendChild(icon);
    button.addEventListener('click', function(e) {
        e.stopPropagation();
        serverConnection.userAction(kind, id);
    });
    return button;
}

// Toastify instances for actionable knock popups, keyed by knocker id, so
// gotKnock can dismiss the popup once the knock is resolved (admitted,
// denied or withdrawn) no matter where that happened.
let knockToasts = {};

// When the operator entered this child room via the dashboard's "Admit &
// join" action, admit whoever is already knocking as their knock is pushed
// to us on arrival (see gotKnock), instead of only surfacing the actionable
// toast.  Time-boxed so it catches only the batch delivered on join, not
// later knockers.  (Sozvon)
let admitOnJoinUntil = 0;

/**
 * Shows an actionable toast for a lobby knock, with the same Admit/Deny
 * buttons as the participants panel, so an operator can act on it without
 * opening the panel.
 *
 * @param {string} id
 * @param {string} username
 */
function displayKnockToast(id, username) {
    let body = document.createElement('div');
    body.classList.add('knock-toast-body');

    let label = document.createElement('span');
    label.textContent = Sozvon.i18n.t('toast.askingToJoin',
        {who: username || Sozvon.i18n.t('toast.someone')});
    body.appendChild(label);

    let actions = document.createElement('span');
    actions.classList.add('knock-toast-actions');
    actions.appendChild(makeKnockButton('admit', id));
    actions.appendChild(makeKnockButton('deny', id));
    body.appendChild(actions);

    /** @ts-ignore */
    let toast = Toastify({
        node: body,
        duration: 0,
        close: true,
        position: 'center',
        gravity: 'top',
        className: 'info knock-toast',
        callback: function() {
            delete knockToasts[id];
        },
    });
    toast.showToast();
    return toast;
}

/**
 * Drop every pending knock: the rows in the participants panel and the toasts
 * offering to admit them.  The server never withdraws them for us on a
 * disconnect, so without this a knocker survives a hang-up as a row and a live
 * Admit button for a room we have left -- and, since the alert dot is derived
 * from those rows, as a dot about nobody.  (Sozvon)
 */
function clearKnocks() {
    document.querySelectorAll('#users .knock-p').forEach(function(row) {
        row.remove();
    });
    for(let id in knockToasts) {
        let toast = knockToasts[id];
        delete knockToasts[id];
        if(toast)
            toast.hideToast();
    }
    refreshPanelAlert();
}

/**
 * gotKnock is called (on operators) when a user knocks at the waiting
 * room, or when such a knock is withdrawn.
 *
 * @param {string} id
 * @param {string} username
 * @param {boolean} present
 */
function gotKnock(id, username, present) {
    let div = document.getElementById('users');
    let existing = document.getElementById('knock-' + id);
    if(!present) {
        if(existing)
            div.removeChild(existing);
        let toast = knockToasts[id];
        if(toast) {
            delete knockToasts[id];
            toast.hideToast();
        }
        // Admitted, denied or gone: if the dot was about them, it stops now,
        // whether or not the panel was ever opened.  (Sozvon)
        refreshPanelAlert();
        return;
    }
    if(existing)
        return;

    // Arrived via the dashboard's "Admit & join": let this waiting client
    // straight in instead of surfacing another prompt here. (Sozvon)
    if(Date.now() < admitOnJoinUntil) {
        serverConnection.userAction('admit', id);
        return;
    }

    // new knock arrived — play the notification sound (best-effort)
    playKnockSound();

    let knock = document.createElement('div');
    knock.id = 'knock-' + id;
    knock.classList.add('user-p');
    knock.classList.add('knock-p');

    let label = document.createElement('span');
    label.classList.add('knock-label');
    label.textContent = '🔔 ' + (username || '(anon)');
    knock.appendChild(label);
    knock.appendChild(makeKnockButton('admit', id));
    knock.appendChild(makeKnockButton('deny', id));

    if(div.firstChild)
        div.insertBefore(knock, div.firstChild);
    else
        div.appendChild(knock);

    refreshPanelAlert();   // someone is knocking

    knockToasts[id] = displayKnockToast(id, username);
}

function displayUsername() {
    document.getElementById('userspan').textContent = serverConnection.username;
    let op = serverConnection.permissions.indexOf('op') >= 0;
    let present = serverConnection.permissions.indexOf('present') >= 0;
    let text = '';
    if(op && present)
        text = '(op, presenter)';
    else if(op)
        text = 'operator';
    else if(present)
        text = 'presenter';
    document.getElementById('permspan').textContent = text;
}

let presentRequested = null;

/**
 * @param {string} s
 */
function capitalise(s) {
    if(s.length <= 0)
        return s;
    return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * @param {string} title
 */
function setTitle(title) {
    function set(title) {
        document.title = title;
        document.getElementById('title').textContent = title;
    }
    if(title)
        set(title);
    else
        set('Sozvon');
}

/**
 * Under Safari, we request access to the camera at startup in order to
 * enable autoplay.  The camera stream is stored in safariStream.
 *
 * @type {MediaStream}
 */
let safariStream = null;

async function openSafariStream() {
    if(!isSafari())
        return;

    if(!safariStream)
        safariStream = await navigator.mediaDevices.getUserMedia({audio: true})
}

async function closeSafariStream() {
    if(!safariStream)
        return;
    stopStream(safariStream);
    safariStream = null;
}

/**
 * @this {ServerConnection}
 * @param {string} kind
 * @param {string} group
 * @param {Array<string>} perms
 * @param {Record<string,any>} status
 * @param {Record<string,any>} data
 * @param {string} error
 * @param {string} message
 */
async function gotJoined(kind, group, perms, status, data, error, message) {
    let present = presentRequested;
    presentRequested = null;

    switch(kind) {
    case 'fail':
        // Sozvon: the server refused the (re)join — stop any reconnect cycle.
        wantConnected = false;
        stopReconnect();
        pendingRemember = null;
        if(probingState === 'probing' && error === 'need-username') {
            probingState = 'need-username';
            setVisibility('passwordform', false);
            // Entering a name to use a token (e.g. an invite link) is a
            // guest-style login; "remember me" is operator-only, so hide it.
            setVisibility('rememberform', false);
        } else if(usingRememberToken) {
            // A remembered token expired or was revoked: forget it quietly and
            // fall back to the normal login form rather than showing an error.
            usingRememberToken = false;
            token = null;
            probingState = null;
            clearRememberToken(group);
            setVisibility('userform', true);
            setVisibility('passwordform', true);
            // back to operator login ("remember me" is hub-only, see below)
            setVisibility('rememberform', !groupStatus.operatorRoomChild);
            setVisibility('login-container', true);
            displayMessage(Sozvon.i18n.t('toast.rememberExpired'));
            closeSafariStream();
            this.close();
            setButtonsVisibility();
            return;
        } else if(groupStatus.requireE2ee && message &&
                  message.indexOf('two participants') >= 0) {
            // Server turned us away: an encryption-required group is full (2).
            token = null;
            displayError(Sozvon.i18n.t('e2ee.blocked'));
        } else if(message && message.indexOf('Room is busy') >= 0) {
            // 1-on-1 lock engaged: the third participant is turned away.
            // (Sozvon)
            token = null;
            displayError(Sozvon.i18n.t('toast.roomBusy'));
        } else {
            token = null;
            displayError(Sozvon.i18n.t('msg.serverSaid', {message: message}));
        }
        closeSafariStream();
        this.close();
        setButtonsVisibility();
        return;
    case 'redirect':
        wantConnected = false;   // Sozvon: leaving for another URL, do not reconnect
        stopReconnect();
        closeSafariStream();
        this.close();
        token = null;
        document.location.href = message;
        return;
    case 'knock': {
        // we are in the waiting room; keep the connection open
        stopReconnect();   // Sozvon: reached the server, hide any reconnect banner
        presentRequested = present;
        let who = serverConnection.username ?
            (', ' + serverConnection.username) : '';
        document.getElementById('lobby-waiting-text').textContent =
            Sozvon.i18n.t('lobby.waitingFor', {who: who});
        setVisibility('login-container', false);
        setVisibility('lobby-waiting', true);
        setButtonsVisibility();
        return;
    }
    case 'rejoin':
        // admitted by an operator; protocol.js re-sends the join
        stopReconnect();   // Sozvon: reached the server, hide any reconnect banner
        presentRequested = present;
        document.getElementById('lobby-waiting-text').textContent =
            Sozvon.i18n.t('lobby.admitted');
        return;
    case 'deny':
        wantConnected = false;   // Sozvon: refused entry, do not reconnect
        stopReconnect();
        token = null;
        // Denied: forget the stashed knock token so a reload doesn't re-knock.
        try {
            window.sessionStorage.removeItem('sozvon.pendingToken:' + group);
        } catch(e) { /* ignore */ }
        setVisibility('lobby-waiting', false);
        displayError(message || Sozvon.i18n.t('toast.hostDeclined'));
        closeSafariStream();
        this.close();
        setButtonsVisibility();
        return;
    case 'leave':
        closeSafariStream();
        this.close();
        setButtonsVisibility();
        setChangePassword(null);
        return;
    case 'join':
    case 'change':
        setVisibility('lobby-waiting', false);
        if(probingState === 'probing') {
            probingState = 'success';
            // A token probe succeeded: we re-show the card for the autoplay
            // gesture (the user clicks "Join"). For a remembered operator keep
            // their pre-filled name visible so they can see who they join as;
            // an invite-link probe has no name to show, so hide the field as
            // before. The password is never needed here, and "remember me" is
            // redundant (we already hold a token) and inert (token joins never
            // mint one), so drop both. We do keep the "Log in as operator" link
            // for a remembered operator, so a wrong-name or dead token can never
            // strand them on a nameless card with no way to authenticate. (Sozvon)
            setVisibility('userform', usingRememberToken);
            setVisibility('passwordform', false);
            setVisibility('rememberform', false);
            setVisibility('operator-login', usingRememberToken);
            closeSafariStream();
            this.close();
            setButtonsVisibility();
            return;
        } else {
            token = null;
        }
        // don't discard endPoint and friends
        for(let key in status)
            groupStatus[key] = status[key];
        if(serverConnection.e2ee)
            serverConnection.e2ee.require = !!groupStatus.requireE2ee;
        usingRememberToken = false;
        // Sozvon: we are connected and in the group.  Remember the intent to stay
        // connected and the join parameters so an unexpected drop reconnects,
        // and clear any reconnect cycle that has just succeeded.
        wantConnected = true;
        reconnectLastJoin = serverConnection.lastJoin || reconnectLastJoin;
        let wasReconnecting = reconnecting;
        if(reconnecting)
            displayMessage(Sozvon.i18n.t('toast.reconnected'));
        stopReconnect();
        if(pendingRemember) {
            let isOp = serverConnection.permissions.indexOf('op') >= 0;
            // Never in a per-client child room: the token would live in that
            // room's group, and the operator reaches child rooms from the hub
            // with their session token anyway.  The checkbox is hidden there,
            // this is the guard behind it. (Sozvon)
            if(pendingRemember.remember && isOp &&
               !groupStatus.operatorRoomChild) {
                // Mint a 30-day revocable token to remember this device; the
                // 'token' reply is stored by gotUserMessage (storingRememberToken).
                // Carry the token being replaced, so it is revoked server-side
                // once the new one is safely stored -- otherwise every re-login
                // leaves another live operator token behind.
                let previous = loadRememberToken(pendingRemember.group);
                // On an operator hub, cover its child rooms too: the operator
                // opens a client link straight from a chat, in a fresh tab
                // where the sessionStorage session token is not there to help,
                // and the checkbox is not offered inside the child room.  The
                // server allows the hierarchical form only for an operator
                // minting it on their own group for their own username, which
                // is exactly this call. (Sozvon)
                let subgroups = !!groupStatus.operatorRoom;
                storingRememberToken = {
                    group: pendingRemember.group,
                    username: pendingRemember.username,
                    previous: (previous && previous.token) || null,
                    includeSubgroups: subgroups,
                };
                makeToken({
                    username: pendingRemember.username,
                    includeSubgroups: subgroups,
                    expires: new Date(Date.now() + 30 * 24 * 3600 * 1000),
                    permissions: serverConnection.permissions.slice(),
                });
            } else {
                // Guests are not remembered (operator only); drop any stale token.
                clearRememberToken(pendingRemember.group);
                if(pendingRemember.remember && !isOp)
                    displayMessage(Sozvon.i18n.t('toast.rememberOpOnly'));
            }
            pendingRemember = null;
        }
        setTitle((status && status.displayName) || capitalise(group));
        displayUsername();
        setButtonsVisibility();
        // Sozvon: reveal the host-only controls (1-on-1 lock etc.) to ops
        // and reflect the server's current locked1on1 state.
        setVisibility('operator-settings',
            serverConnection.permissions.indexOf('op') >= 0);
        let l1on1 = document.getElementById('locked1on1box');
        if(l1on1 && status && typeof status.locked1on1 === 'boolean')
            l1on1.checked = status.locked1on1;
        setChangePassword(pwAuth && !!groupStatus.canChangePassword &&
                          serverConnection.username
        );
        openSafariStream();
        // Now that the user is in the room, drop the pre-join guard so the
        // sidebar becomes accessible.  We deferred this from setConnected(true)
        // to avoid the sidebar flashing during the auth handshake. (Sozvon)
        reflectPreJoin();
        if(groupStatus.operatorRoom &&
           serverConnection.permissions.indexOf('op') >= 0) {
            // Operator hub: show the management dashboard instead of the call
            // UI and request no media.  Returning here skips the media/subscribe
            // block below (the operator only takes calls inside child rooms).
            enterOperatorRoom();
            return;
        }
        if(kind === 'change')
            return;
        peakUserCount = 0;   // fresh call: start counting participants again
        // A reconnect drops us back into the same conversation, so it keeps the
        // clock it was already running; anything else is a new call. (Sozvon)
        if(!wasReconnecting)
            resetCallTimer();
        updateCallTimer();
        collapsePanelsOnJoin();
        break;
    default:
        wantConnected = false;   // Sozvon: unknown terminal state, do not reconnect
        stopReconnect();
        token = null;
        displayError('Unknown join message');
        closeSafariStream();
        this.close();
        return;
    }

    let input = /** @type{HTMLTextAreaElement} */
        (document.getElementById('input'));
    input.placeholder = Sozvon.i18n.t('chat.placeholder');
    setTimeout(() => {input.placeholder = '';}, 8000);

    if(status.locked && !groupStatus.lobby)
        displayWarning(Sozvon.i18n.t('toast.groupLocked'));

    if(typeof RTCPeerConnection === 'undefined')
        showBrowserUnsupported();
    else
        this.request(mapRequest(getSettings().request));

    // Per-user data does not survive a join, so say the microphone state once
    // we are in the room: somebody who arrives already muted would otherwise
    // show as unmuted to everyone until the first time they touched the
    // button. (Sozvon)
    publishMuteState(!!getSettings().localMute);

    if(('mediaDevices' in navigator) &&
       ('getUserMedia' in navigator.mediaDevices) &&
       serverConnection.permissions.indexOf('present') >= 0 &&
       !findUpMedia('camera')) {
        if(present) {
            // settings.audio/video were already set from the pre-join
            // device check; just fill in defaults for anything unset.
            reflectSettings();

            let button = getButtonElement('presentbutton');
            button.disabled = true;
            try {
                await addLocalMedia();
            } finally {
                button.disabled = false;
            }
        } else {
            displayMessage(Sozvon.i18n.t('toast.enableHint'));
        }
    }
}

/**
 * @param {TransferredFile} f
 */
function gotFileTransfer(f) {
    f.onevent = gotFileTransferEvent;
    let p = document.createElement('p');
    if(f.up)
        p.textContent =
        `We have offered to send a file called "${f.name}" ` +
        `to user ${f.username}.`;
    else
        p.textContent =
        `User ${f.username} offered to send us a file ` +
        `called "${f.name}" of size ${f.size}.`
    let bno = null, byes = null;
    if(!f.up) {
        byes = document.createElement('button');
        byes.textContent = 'Accept';
        byes.onclick = function(e) {
            f.receive();
        };
        byes.id = "byes-" + f.fullid();
    }
    bno = document.createElement('button');
    bno.textContent = f.up ? 'Cancel' : 'Reject';
    bno.onclick = function(e) {
        f.cancel();
    };
    bno.id = "bno-" + f.fullid();
    let status = document.createElement('span');
    status.id = 'status-' + f.fullid();
    if(!f.up) {
        status.textContent =
            '(Choosing "Accept" will disclose your IP address.)';
    }
    let statusp = document.createElement('p');
    statusp.id = 'statusp-' + f.fullid();
    statusp.appendChild(status);
    let div = document.createElement('div');
    div.id = 'file-' + f.fullid();
    div.appendChild(p);
    if(byes)
        div.appendChild(byes);
    if(bno)
        div.appendChild(bno);
    div.appendChild(statusp);
    div.classList.add('message');
    div.classList.add('message-private');
    div.classList.add('message-row');
    let box = document.getElementById('box');
    box.appendChild(div);
    return div;
}

/**
 * @param {TransferredFile} f
 * @param {string} status
 * @param {number} [value]
 */
function setFileStatus(f, status, value) {
    let statuselt = document.getElementById('status-' + f.fullid());
    if(!statuselt)
        throw new Error("Couldn't find statusp");
    statuselt.textContent = status;
    if(value) {
        let progress = document.getElementById('progress-' + f.fullid());
         if(!progress || !(progress instanceof HTMLProgressElement))
            throw new Error("Couldn't find progress element");
        progress.value = value;
        let label = document.getElementById('progresstext-' + f.fullid());
        let percent = Math.round(100 * value / progress.max);
        label.textContent = `${percent}%`;
    }
}

/**
 * @param {TransferredFile} f
 * @param {number} [max]
 */
function createFileProgress(f, max) {
    let statusp = document.getElementById('statusp-' + f.fullid());
    if(!statusp)
        throw new Error("Couldn't find status div");
    /** @type HTMLProgressElement */
    let progress = document.createElement('progress');
    progress.id = 'progress-' + f.fullid();
    progress.classList.add('file-progress');
    progress.max = max;
    progress.value = 0;
    statusp.appendChild(progress);
    let progresstext = document.createElement('span');
    progresstext.id = 'progresstext-' + f.fullid();
    progresstext.textContent = '0%';
    statusp.appendChild(progresstext);
}

/**
 * @param {TransferredFile} f
 * @param {boolean} delyes
 * @param {boolean} delno
 * @param {boolean} [delprogress]
 */
function delFileStatusButtons(f, delyes, delno, delprogress) {
    let div = document.getElementById('file-' + f.fullid());
    if(!div)
        throw new Error("Couldn't find file div");
    if(delyes) {
        let byes = document.getElementById('byes-' + f.fullid())
        if(byes)
            div.removeChild(byes);
    }
    if(delno) {
        let bno = document.getElementById('bno-' + f.fullid())
        if(bno)
            div.removeChild(bno);
    }
    if(delprogress) {
        let statusp = document.getElementById('statusp-' + f.fullid());
        let progress = document.getElementById('progress-' + f.fullid());
        let progresstext =
            document.getElementById('progresstext-' + f.fullid());
        if(progress)
            statusp.removeChild(progress);
        if(progresstext)
            statusp.removeChild(progresstext);
    }
}

/**
 * @this {TransferredFile}
 * @param {string} state
 * @param {any} [data]
 */
function gotFileTransferEvent(state, data) {
    let f = this;
    switch(state) {
    case 'inviting':
        break;
    case 'connecting':
        delFileStatusButtons(f, true, false);
        setFileStatus(f, 'Connecting...');
        createFileProgress(f, f.size);
        break;
    case 'connected':
        setFileStatus(f, f.up ? 'Sending...' : 'Receiving...', f.datalen);
        break;
    case 'done':
        delFileStatusButtons(f, true, true, true);
        setFileStatus(f, 'Done.');
        if(!f.up) {
            let url = URL.createObjectURL(data);
            let a = document.createElement('a');
            a.href = url;
            a.textContent = f.name;
            a.download = f.name;
            a.type = f.mimetype;
            a.click();
            URL.revokeObjectURL(url);
        }
        break;
    case 'cancelled':
        delFileStatusButtons(f, true, true, true);
        if(data)
            setFileStatus(f, `Cancelled: ${data.toString()}.`);
        else
            setFileStatus(f, 'Cancelled.');
        break;
    case 'closed':
        break;
    default:
        console.error(`Unexpected state "${state}"`);
        f.cancel(`unexpected state "${state}" (this shouldn't happen)`);
        break;
    }
}

/**
 * @param {string} id
 * @param {string} dest
 * @param {string} username
 * @param {Date} time
 * @param {boolean} privileged
 * @param {string} kind
 * @param {string} error
 * @param {any} message
 */
function gotUserMessage(id, dest, username, time, privileged, kind, error, message) {
    switch(kind) {
    case 'e2ee':
        if(e2eeActive())
            serverConnection.e2ee.onMessage(id, message);
        return;
    case 'e2eechat':
        if(e2eeActive() && serverConnection.e2ee) {
            serverConnection.e2ee.decryptChat(message).then(function(res) {
                if(!res)
                    return;
                let u = serverConnection.users[id];
                addToChatbox(id, null, '', (u && u.username) || username,
                             time || new Date(), false, false,
                             res.kind, res.text);
            }).catch(function(err) {
                console.warn('e2ee chat decrypt:', err);
            });
        }
        return;
    case 'kicked':
    case 'error':
    case 'warning':
    case 'info': {
        if(!privileged) {
            console.error(`Got unprivileged message of kind ${kind}`);
            return;
        }
        let from = id ? (username || 'Anonymous') : 'The Server';
        displayError(`${from} said: ${message}`, kind);
        break;
    }
    case 'mute': {
        if(!privileged) {
            console.error(`Got unprivileged message of kind ${kind}`);
            return;
        }
        setLocalMute(true, true);
        displayWarning(username ?
            Sozvon.i18n.t('toast.mutedBy', {who: username}) :
            Sozvon.i18n.t('toast.muted'));
        break;
    }
    case 'clearchat': {
        if(!privileged) {
            console.error(`Got unprivileged message of kind ${kind}`);
            return;
        }
        let id = message && message.id;
        let userId = message && message.userId;
        clearChat(id, userId);
        break;
    }
    case 'token': {
        if(!privileged) {
            console.error(`Got unprivileged message of kind ${kind}`);
            return;
        }
        if(error) {
            if(storingRememberToken) {
                // Couldn't mint a remember-token; fail quietly, don't remember.
                console.warn('remember-token mint failed:', message);
                storingRememberToken = null;
                return;
            }
            if(storingSessionToken) {
                // Couldn't mint the operator session token; the operator can
                // still use the dashboard, they just re-auth on child pages.
                console.warn('session-token mint failed:', message);
                storingSessionToken = null;
                return;
            }
            displayError(`Token operation failed: ${message}`)
            return
        }
        if(typeof message !== 'object') {
            displayError('Unexpected type for token');
            return;
        }
        if(storingRememberToken) {
            // This token is for remembering this device, not an invite link.
            saveRememberToken(storingRememberToken.group, message.token,
                              storingRememberToken.username, message.expires,
                              storingRememberToken.includeSubgroups);
            // The device is now remembered by the new token: revoke the one
            // it replaces, so re-logging in doesn't pile up live operator
            // tokens on the group. (Sozvon)
            revokeToken(storingRememberToken.previous);
            storingRememberToken = null;
            return;
        }
        if(storingSessionToken) {
            // The operator's session token: stash it for hub<->child navigation.
            saveOperatorSession(storingSessionToken.hub, message.token,
                                storingSessionToken.username, message.expires);
            storingSessionToken = null;
            return;
        }
        if(operatorRoom.active) {
            // A dashboard-created link: don't dump it into chat or share it,
            // the dashboard refreshes its own list.
            pollOperatorRoom();
            break;
        }
        let f = formatToken(message, false);
        localMessage(f[0] + ': ' + f[1]);
        if('share' in navigator) {
            try {
                navigator.share({
                    title: `Invitation to Sozvon group ${message.group}`,
                    text: f[0],
                    url: f[1],
                });
            } catch(e) {
                console.warn("Share failed", e);
            }
        }
        break;
    }
    case 'tokenlist': {
        if(!privileged) {
            console.error(`Got unprivileged message of kind ${kind}`);
            return;
        }
        // A reply to a revocation nobody asked for out loud (see revokeToken):
        // useful to the dashboard, which refreshes from it, but not something
        // to report or to print into the chat.
        let silent = silentTokenLists > 0;
        if(silent)
            silentTokenLists--;
        if(error) {
            if(silent) {
                console.warn('token revocation failed:', message);
                return;
            }
            displayError(`Token operation failed: ${message}`)
            return
        }
        if(operatorRoom.active) {
            operatorRoom.tokens = Array.isArray(message) ? message : [];
            renderOperatorRoom();
            break;
        }
        if(silent)
            break;
        let s = '';
        for(let i = 0; i < message.length; i++) {
            let f = formatToken(message[i], true);
            s = s + f[0] + ': ' + f[1] + "\n";
        }
        localMessage(s);
        break;
    }
    case 'subgroupstatus':
        if(!privileged) {
            console.error(`Got unprivileged message of kind ${kind}`);
            return;
        }
        operatorRoom.status = Array.isArray(message) ? message : [];
        if(operatorRoom.active)
            renderOperatorRoom();
        break;
    case 'userinfo': {
        if(!privileged) {
            console.error(`Got unprivileged message of kind ${kind}`);
            return;
        }
        let u = message.username ?
            'username ' + message.username :
            'unknown username';
        let a = message.address ?
            'address ' + message.address :
            'unknown address';
        localMessage(`User ${message.id} has ${u} and ${a}.`);
        break;
    }
    default:
        console.warn(`Got unknown user message ${kind}`);
        break;
    }
};

/**
 * @param {Object} token
 * @param {boolean} [details]
 */
function formatToken(token, details) {
    let url = new URL(window.location.href);
    let params = new URLSearchParams();
    params.append('token', token.token);
    url.search = params.toString();
    let foruser = '', by = '', togroup = '';
    if(token.username)
        foruser = ` for user ${token.username}`;
    if(details) {
        if(token.issuedBy)
            by = ' issued by ' + token.issuedBy;
        if(token.issuedAt) {
            if(by === '')
                by = ' issued at ' + (new Date(token.issuedAt)).toLocaleString();
            else
                by = by + ' at ' + (new Date(token.issuedAt)).toLocaleString();
        }
    } else {
        if(token.group)
            togroup = ' to group ' + token.group;
    }
    let since = '';
    if(token["not-before"])
        since = ` since ${(new Date(token['not-before'])).toLocaleString()}`
    /** @type{Date} */
    let expires = null;
    let until = '';
    if(token.expires) {
        expires = new Date(token.expires)
        until = ` until ${expires.toLocaleString()}`;
    }
    return [
        (expires && (expires >= new Date())) ?
            `Invitation${foruser}${togroup}${by} valid${since}${until}` :
            `Expired invitation${foruser}${togroup}${by}`,
        url.toString(),
    ];
}

// ==== Operator room (dashboard) ============================================
// On an operator-room hub the operator lands on this dashboard instead of the
// call UI.  They stay joined to the hub over the WebSocket and watch every
// per-client child room (hub/<slug>) by polling listtokens (every link, even
// idle) and subgroupstatus (live occupancy and knocks).  Clicking Join
// navigates into a child room where the ordinary in-room knock/admit UI runs.

let operatorRoom = {
    active: false,
    /** @type {number} */
    timer: null,
    /** @type {Array<Object>} */
    tokens: [],
    /** @type {Array<Object>} */
    status: [],
    /** @type {Object<string, Array<string>>} */
    knockers: {},
    /** @type {Object<string, Object>} live knock toasts, keyed by child group */
    knockToasts: {},
};

function enterOperatorRoom() {
    if(operatorRoom.active) {
        renderOperatorRoom();
        return;
    }
    operatorRoom.active = true;
    operatorRoom.knockers = {};
    operatorRoom.knockToasts = {};
    // We are on the hub now: forget any "return to this hub" marker so a later
    // ordinary call in this tab is not hijacked by the red-button return.
    try {
        window.sessionStorage.removeItem('sozvon.operatorReturn');
    } catch(e) { /* ignore */ }
    // The heading is static translated markup ("Operator panel"): it names the
    // page, not the room, and the hub's own name was saying nothing an operator
    // does not know.  Where the hub name *does* still earn its place is the
    // browser tab — a server may carry more than one operator group (only the
    // first is served at "/") and tabs are where you tell them apart — and
    // gotJoined already puts it there via setTitle. (Sozvon)
    setVisibility('operator-room', true);
    mintOperatorSession();
    renderOperatorRoom();
    pollOperatorRoom();
    operatorRoom.timer = window.setInterval(() => {
        if(document.visibilityState === 'hidden')
            return;
        pollOperatorRoom();
    }, 3000);
}

function leaveOperatorRoom() {
    if(!operatorRoom.active)
        return;
    operatorRoom.active = false;
    if(operatorRoom.timer) {
        window.clearInterval(operatorRoom.timer);
        operatorRoom.timer = null;
    }
    for(let g in operatorRoom.knockToasts)
        dismissOperatorKnockToast(g);
    operatorPrecheck.stop();   // release the camera/mic if the preview was on
    setVisibility('operator-room', false);
}

/**
 * Fully log the operator out: unlike the plain hang-up (#disconnectbutton),
 * this also forgets the session token and any remembered device, and drops
 * the "Rejoin as X" quick action, so the login card comes back empty rather
 * than silently re-authenticating on the next reload or reopening of the
 * tab. (Sozvon)
 */
function operatorLogout() {
    try {
        window.sessionStorage.removeItem('sozvon.operatorSession');
    } catch(e) { /* ignore */ }
    // Forgetting this device must also revoke it: the token is still live
    // server-side otherwise, and it grants op.  Sent before the socket is
    // closed below -- close() flushes what is already queued. (Sozvon)
    // Forget it under the key it is actually stored as: logging out of a
    // child room covered by a hub token must clear that hub entry, or the
    // next visit signs back in with the token we have just revoked.
    let rememberKey = rememberTokenGroup(group);
    let remembered = loadRememberToken(group);
    if(remembered)
        revokeToken(remembered.token);
    clearRememberToken(rememberKey || group);
    reconnectLastJoin = null;
    usingRememberToken = false;
    token = null;
    wantConnected = false;
    stopReconnect();
    let u = document.getElementById('username');
    if(u instanceof HTMLInputElement)
        u.value = '';
    serverConnection.close();
    closeNav();
}

function pollOperatorRoom() {
    if(!operatorRoom.active || !serverConnection)
        return;
    try {
        serverConnection.groupAction('listtokens');
        serverConnection.groupAction('subgroupstatus');
    } catch(e) {
        console.warn("operator poll failed", e);
    }
}

/**
 * Mint the operator's session token (once per tab), so navigating into a
 * child room -- and back to the hub -- re-authenticates without a password.
 * No-op if we already hold a live one, or if we lack the permission to mint.
 */
function mintOperatorSession() {
    if(loadOperatorSession(group))
        return;
    if(serverConnection.permissions.indexOf('op') < 0 ||
       serverConnection.permissions.indexOf('token') < 0 ||
       !serverConnection.username)
        return;
    storingSessionToken = {hub: group, username: serverConnection.username};
    makeToken({
        username: serverConnection.username,
        includeSubgroups: true,
        expires: new Date(Date.now() + 12 * units.h),
        permissions: serverConnection.permissions.slice(),
    });
}

/**
 * The last path segment of a child room "<hub>/<slug>".  Used to build the
 * short client link /<slug>/ that hides the hub name (and the /group/ prefix)
 * from guests -- the server maps /<slug>/ back to <hub>/<slug>.
 * @param {string} childGroup
 * @returns {string}
 */
function childSlug(childGroup) {
    let prefix = group + '/';
    if(childGroup.startsWith(prefix))
        return childGroup.slice(prefix.length);
    let i = childGroup.lastIndexOf('/');
    return i >= 0 ? childGroup.slice(i + 1) : childGroup;
}

/**
 * The full URL of a personal invite link (the short /<slug>/?token=... form,
 * pointing at the child room, not the hub the operator is viewing).
 * @param {Object} t
 * @returns {string}
 */
function operatorLinkUrl(t) {
    let url = new URL(window.location.href);
    url.pathname = '/' + childSlug(t.group) + '/';
    url.search = 'token=' + encodeURIComponent(t.token);
    url.hash = '';
    return url.toString();
}

function renderOperatorRoom() {
    let list = document.getElementById('operator-links');
    if(!list)
        return;

    let byGroup = {};
    for(let st of operatorRoom.status)
        byGroup[st.name] = st;

    // Ring the knock sound and pop an actionable toast when a client newly
    // appears in a room's queue.  The dashboard can't admit directly (it only
    // holds usernames, not client ids), so the toast's button joins the room
    // and admits on arrival (see operatorAdmitAndJoin / admitOnJoinUntil).
    // We don't receive knockcancel here (we're on the hub, not the child
    // room), so a toast is dismissed when the poll shows its queue emptied.
    let newKnock = false;
    for(let st of operatorRoom.status) {
        let prev = operatorRoom.knockers[st.name] || [];
        let cur = st.knocking || [];
        let fresh = cur.filter(u => prev.indexOf(u) < 0);
        operatorRoom.knockers[st.name] = cur.slice();
        if(fresh.length > 0) {
            newKnock = true;
            dismissOperatorKnockToast(st.name);
            operatorRoom.knockToasts[st.name] =
                operatorKnockToast(st.name, cur);
        } else if(cur.length === 0) {
            dismissOperatorKnockToast(st.name);
        }
    }
    for(let g in operatorRoom.knockers) {
        if(!byGroup[g]) {
            delete operatorRoom.knockers[g];
            dismissOperatorKnockToast(g);
        }
    }
    if(newKnock)
        playKnockSound();

    list.textContent = '';
    // A hub's listtokens returns every token of the subtree: its own
    // (group === group), the per-client links it minted, and whatever was
    // minted *inside* a child room -- a remembered operator device, an
    // /invite.  Only the links belong on the dashboard: showing a token
    // minted in the room would show several cards for the same room, and a
    // remembered device carries the operator's own permissions, so copying
    // that card to a client would hand them the room as an operator. (Sozvon)
    let links = operatorRoom.tokens.filter(t => {
        if(!t.group || t.group === group)
            return false;
        if(t.link)
            return true;
        // Minted before the server recorded `link`: fall back to the old
        // guess, minus the tokens that no client link can be -- an invite
        // never grants op.  Drop this once the deployed tokens have been
        // reissued or migrated.
        return (t.permissions || []).indexOf('op') < 0;
    });

    // Ordering (Sozvon): listtokens sorts by expiry with an unstable tie-break,
    // so equal-expiry links (all the never-expiring ones) reshuffle on every
    // 3s poll.  Impose a deterministic order here, where the live occupancy
    // data (byGroup) also lives.  Tiers, top to bottom: a client knocking
    // (needs the operator to act) > a call already in progress > idle; within
    // each tier the newest links (by creation time) come first.
    let activityRank = t => {
        let st = byGroup[t.group];
        let knocking = (st && st.knocking) || [];
        let clients = (st && st.clients) || [];
        if(knocking.length > 0)
            return 2;
        if(clients.length > 0)
            return 1;
        return 0;
    };
    // Missing issuedAt (tokens minted before it was recorded) sorts oldest.
    let created = t => t.issuedAt ? Date.parse(t.issuedAt) : 0;
    links.sort((a, b) =>
               activityRank(b) - activityRank(a) || created(b) - created(a));

    if(links.length === 0) {
        let empty = document.createElement('p');
        empty.className = 'operator-empty';
        empty.textContent = Sozvon.i18n.t('operator.noLinks');
        list.appendChild(empty);
        return;
    }
    for(let t of links)
        list.appendChild(operatorRow(t, byGroup[t.group]));
}

/**
 * @param {Object} t   a token from listtokens
 * @param {Object} [st] the matching subgroupstatus entry, if any
 * @returns {HTMLElement}
 */
function operatorRow(t, st) {
    let slug = t.group.slice((group + '/').length);
    let label = t.username || slug;

    let row = document.createElement('div');
    row.className = 'operator-link';

    let head = document.createElement('div');
    head.className = 'operator-link-head';
    // Name and expiry are both what this link *is*, so they share the first
    // line and the row costs three lines rather than four: identity, the link
    // itself, what you can do with it. (Sozvon)
    let id = document.createElement('div');
    id.className = 'operator-link-id';
    let name = document.createElement('span');
    name.className = 'operator-link-label';
    name.textContent = label;
    id.appendChild(name);
    head.appendChild(id);

    let badge = document.createElement('span');
    badge.className = 'operator-badge';
    let knocking = (st && st.knocking) || [];
    let clients = (st && st.clients) || [];
    if(knocking.length > 0) {
        badge.classList.add('knocking');
        badge.textContent =
            Sozvon.i18n.t('operator.statusKnocking', {names: knocking.join(', ')});
    } else if(clients.length > 0) {
        badge.classList.add('incall');
        let names = clients.map(c => c.username || '?').join(', ');
        badge.textContent =
            Sozvon.i18n.t('operator.statusInCall', {names: names});
    } else {
        badge.classList.add('empty');
        badge.textContent = Sozvon.i18n.t('operator.statusEmpty');
    }
    head.appendChild(badge);

    let meta = document.createElement('span');
    meta.className = 'operator-link-meta';
    if(t.expires) {
        let exp = new Date(t.expires);
        if(exp < new Date()) {
            meta.textContent = Sozvon.i18n.t('operator.expired');
            row.classList.add('operator-link-expired');
        } else {
            meta.textContent = Sozvon.i18n.t('operator.expires',
                                           {date: exp.toLocaleDateString()});
        }
    } else {
        meta.textContent = Sozvon.i18n.t('operator.noExpiry');
    }
    id.appendChild(meta);
    row.appendChild(head);

    let urlRow = document.createElement('div');
    urlRow.className = 'operator-link-url';
    let urlInput = document.createElement('input');
    urlInput.type = 'text';
    urlInput.readOnly = true;
    urlInput.className = 'operator-url-input';
    urlInput.value = operatorLinkUrl(t);
    urlInput.onclick = () => urlInput.select();
    urlRow.appendChild(urlInput);
    let copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'btn operator-copy';
    copy.textContent = Sozvon.i18n.t('operator.copy');
    copy.onclick = () => {
        let done = () => {
            copy.textContent = Sozvon.i18n.t('operator.copied');
            window.setTimeout(() => {
                copy.textContent = Sozvon.i18n.t('operator.copy');
            }, 1500);
        };
        if(navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(urlInput.value).then(done, () => {
                urlInput.select();
                document.execCommand('copy');
                done();
            });
        } else {
            urlInput.select();
            document.execCommand('copy');
            done();
        }
    };
    urlRow.appendChild(copy);
    row.appendChild(urlRow);

    let actions = document.createElement('div');
    actions.className = 'operator-link-actions';
    let join = document.createElement('button');
    join.type = 'button';
    join.className = 'btn btn-blue operator-join';
    join.textContent = Sozvon.i18n.t('operator.join');
    join.onclick = () => operatorJoin(t);
    actions.appendChild(join);
    let del = document.createElement('button');
    del.type = 'button';
    del.className = 'btn operator-delete';
    del.textContent = Sozvon.i18n.t('operator.delete');
    del.onclick = () => {
        if(window.confirm(Sozvon.i18n.t('operator.deleteConfirm', {name: label})))
            serverConnection.groupAction('deletetoken', {token: t.token});
    };
    actions.appendChild(del);
    row.appendChild(actions);

    return row;
}

/**
 * Navigate into a child room to take the call.  Remember the hub so the red
 * hang-up button there returns here (see the disconnectbutton handler).
 * @param {Object} t
 */
function operatorJoin(t) {
    let present = operatorPrecheck.applyChoices();
    try {
        // Remember the hub and the exact page we came from (the dashboard is
        // served at "/" on a root hub, or at /group/<hub>/ otherwise), so the
        // red hang-up button in the child room returns to it.
        window.sessionStorage.setItem('sozvon.operatorReturn',
            JSON.stringify({hub: group, url: window.location.href}));
        // Carry the camera/mic choice across the navigation (start() in the
        // child room reads and clears this) so the call starts with the
        // devices already on instead of a second device-check screen there.
        window.sessionStorage.setItem('sozvon.operatorJoinPresent', present || '');
    } catch(e) { /* ignore */ }
    window.location.href = '/' + childSlug(t.group) + '/';
}

/**
 * Dismiss the dashboard knock toast for a child room, if one is showing.
 * @param {string} childGroup   full "<hub>/<slug>" group name
 */
function dismissOperatorKnockToast(childGroup) {
    let toast = operatorRoom.knockToasts[childGroup];
    if(toast) {
        delete operatorRoom.knockToasts[childGroup];
        toast.hideToast();
    }
}

/**
 * Actionable toast shown on the dashboard when a client newly knocks in a
 * child room.  Its button enters that room and admits the waiting client in
 * one gesture -- the dashboard can't admit on its own (it only knows the
 * knockers' usernames, not their client ids), so the admit happens on
 * arrival (see operatorAdmitAndJoin / admitOnJoinUntil).
 * @param {string} childGroup    full "<hub>/<slug>" group name
 * @param {Array<string>} names  usernames currently knocking in that room
 * @returns {Object}
 */
function operatorKnockToast(childGroup, names) {
    let body = document.createElement('div');
    body.classList.add('knock-toast-body');

    let label = document.createElement('span');
    let who = names.join(', ') || Sozvon.i18n.t('toast.someone');
    label.textContent = Sozvon.i18n.t('operator.knockToast',
        {who: who, room: childSlug(childGroup)});
    body.appendChild(label);

    let actions = document.createElement('span');
    actions.classList.add('knock-toast-actions');
    let join = document.createElement('button');
    join.classList.add('knock-admit');
    join.textContent = Sozvon.i18n.t('operator.admitJoin');
    join.addEventListener('click', function(e) {
        e.stopPropagation();
        toast.hideToast();
        operatorAdmitAndJoin(childGroup);
    });
    actions.appendChild(join);
    body.appendChild(actions);

    /** @ts-ignore */
    let toast = Toastify({
        node: body,
        duration: 0,
        close: true,
        position: 'center',
        gravity: 'top',
        className: 'info knock-toast',
        callback: function() {
            if(operatorRoom.knockToasts[childGroup] === toast)
                delete operatorRoom.knockToasts[childGroup];
        },
    });
    toast.showToast();
    return toast;
}

/**
 * Enter a child room to take a waiting client's knock: arm the admit-on-join
 * flag, then navigate in exactly as the dashboard's Join button does, so the
 * knock pushed to us on arrival is admitted automatically.
 * @param {string} childGroup   full "<hub>/<slug>" group name
 */
function operatorAdmitAndJoin(childGroup) {
    try {
        window.sessionStorage.setItem('sozvon.operatorAdmitOnJoin', '1');
    } catch(e) { /* ignore */ }
    let t = operatorRoom.tokens.find(x => x.group === childGroup);
    if(t)
        operatorJoin(t);
    else
        window.location.href = '/' + childSlug(childGroup) + '/';
}

// Cyrillic + punctuation -> a lowercase URL-safe slug fragment.
const translitMap = {
    'а':'a','б':'b','в':'v','г':'g','д':'d','е':'e','ё':'e','ж':'zh','з':'z',
    'и':'i','й':'i','к':'k','л':'l','м':'m','н':'n','о':'o','п':'p','р':'r',
    'с':'s','т':'t','у':'u','ф':'f','х':'h','ц':'c','ч':'ch','ш':'sh','щ':'sch',
    'ъ':'','ы':'y','ь':'','э':'e','ю':'yu','я':'ya',
};

/**
 * @param {string} s
 * @returns {string}
 */
function transliterate(s) {
    let out = '';
    for(let ch of (s || '').toLowerCase()) {
        if(ch in translitMap)
            out += translitMap[ch];
        else if(/[a-z0-9]/.test(ch))
            out += ch;
        else
            out += '-';
    }
    return out.replace(/-+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * @returns {string} four random URL-safe characters
 */
function randomSlugSuffix() {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let a = new Uint8Array(4);
    (window.crypto || /** @type{any} */ (window).msCrypto).getRandomValues(a);
    let s = '';
    for(let i = 0; i < 4; i++)
        s += chars[a[i] % chars.length];
    return s;
}

/**
 * A fresh single-segment slug for a new child room, not colliding with an
 * existing link.
 * @param {string} label
 * @returns {string}
 */
function makeSlug(label) {
    let base = transliterate(label).slice(0, 24);
    let existing = {};
    for(let t of operatorRoom.tokens)
        if(t.group)
            existing[t.group] = true;
    for(let i = 0; i < 20; i++) {
        let slug = (base ? base + '-' : '') + randomSlugSuffix();
        if(!existing[group + '/' + slug])
            return slug;
    }
    return randomSlugSuffix() + randomSlugSuffix();
}

function createOperatorLink() {
    let labelElt = /** @type{HTMLInputElement} */
        (document.getElementById('operator-label'));
    let nameElt = /** @type{HTMLInputElement} */
        (document.getElementById('operator-clientname'));
    let expElt = /** @type{HTMLSelectElement} */
        (document.getElementById('operator-expiry'));
    let label = (labelElt && labelElt.value || '').trim();
    let clientName = (nameElt && nameElt.value || '').trim();
    let days = expElt ? parseInt(expElt.value) : 0;
    if(isNaN(days))
        days = 0;
    // No label and no client name: makeSlug('') yields a purely random slug,
    // so the link still gets a unique name -- no need to force the operator
    // to type one.
    let slug = makeSlug(label || clientName);
    let template = {
        group: group + '/' + slug,
        // days === 0 means a perpetual link (null expiry, never expires)
        expires: days > 0 ? new Date(Date.now() + days * units.d) : null,
        permissions: ['present', 'message'],
    };
    if(clientName)
        template.username = clientName;
    makeToken(template);
    if(labelElt)
        labelElt.value = '';
    if(nameElt)
        nameElt.value = '';
    window.setTimeout(pollOperatorRoom, 300);
}

const urlRegexp = /https?:\/\/[-a-zA-Z0-9@:%/._\\+~#&()=?]+[-a-zA-Z0-9@:%/_\\+~#&()=]/g;

/**
 * @param {string} text
 * @returns {HTMLDivElement}
 */
function formatText(text) {
    let r = new RegExp(urlRegexp);
    let result = [];
    let pos = 0;
    while(true) {
        let m = r.exec(text);
        if(!m)
            break;
        result.push(document.createTextNode(text.slice(pos, m.index)));
        let a = document.createElement('a');
        a.href = m[0];
        a.textContent = m[0];
        a.target = '_blank';
        a.rel = 'noreferrer noopener';
        result.push(a);
        pos = m.index + m[0].length;
    }
    result.push(document.createTextNode(text.slice(pos)));

    let div = document.createElement('div');
    result.forEach(e => {
        div.appendChild(e);
    });
    return div;
}

/**
 * @param {Date} time
 * @returns {string}
 */
function formatTime(time) {
    let delta = Date.now() - time.getTime();
    let m = time.getMinutes();
    if(delta > -30000)
        return time.getHours() + ':' + ((m < 10) ? '0' : '') + m;
    return time.toLocaleString();
}

/**
 * @typedef {Object} lastMessage
 * @property {string} [nick]
 * @property {string} [peerId]
 * @property {string} [dest]
 * @property {Date} [time]
 */

/** @type {lastMessage} */
let lastMessage = {};

/**
 * @param {string} id
 * @param {string} peerId
 * @param {string} dest
 * @param {string} nick
 * @param {Date} time
 * @param {boolean} privileged
 * @param {boolean} history
 * @param {string} kind
 * @param {string|HTMLElement} message
 */
function addToChatbox(id, peerId, dest, nick, time, privileged, history, kind, message) {
    if(kind === 'caption') {
        displayCaption(message);
        return;
    }

    // Flag unread chat on the panel toggle when a live message from someone
    // else arrives while the panel isn't on screen.
    if(peerId && !history &&
       (!serverConnection || peerId !== serverConnection.id) &&
       !panelVisible()) {
        unreadChat = true;
        refreshPanelAlert();
    }

    let row = document.createElement('div');
    row.classList.add('message-row');
    let container = document.createElement('div');
    container.classList.add('message');
    row.appendChild(container);
    let footer = document.createElement('p');
    footer.classList.add('message-footer');
    if(!peerId)
        container.classList.add('message-system');
    if(serverConnection && peerId === serverConnection.id)
        container.classList.add('message-sender');
    if(dest)
        container.classList.add('message-private');

    if(id)
        container.dataset.id = id;
    if(peerId) {
        container.dataset.peerId = peerId;
        container.dataset.username = nick;
        container.addEventListener('click', function(e) {
            if(e.detail !== 2)
                return;
            let elt = e.currentTarget;
            if(!elt || !(elt instanceof HTMLElement))
                throw new Error("Couldn't find chat message div");
            chatMessageMenu(elt);
        });
    }

    /** @type{HTMLElement} */
    let body;
    if(message instanceof HTMLElement) {
        body = message;
    } else if(typeof message === 'string') {
        body = formatText(message);
    } else {
        throw new Error('Cannot add element to chatbox');
    }

    if(kind !== 'me') {
        let doHeader = true;
        if(lastMessage.nick !== (nick || null) ||
           lastMessage.peerId !== (peerId || null) ||
           lastMessage.dest !== (dest || null) ||
           !time || !lastMessage.time) {
            doHeader = true;
        } else {
            let delta = time.getTime() - lastMessage.time.getTime();
            doHeader = delta < 0 || delta > 60000;
        }

        if(doHeader) {
            let header = document.createElement('p');
            let user = document.createElement('span');
            let u = dest && serverConnection.users[dest];
            let name = (u && u.username);
            user.textContent = dest ?
                `${nick || '(anon)'} \u2192 ${name || '(anon)'}` :
                (nick || '(anon)');
            user.classList.add('message-user');
            header.appendChild(user);
            header.classList.add('message-header');
            container.appendChild(header);
            if(time) {
                let tm = document.createElement('span');
                tm.textContent = formatTime(time);
                tm.classList.add('message-time');
                header.appendChild(tm);
            }
        }

        let p = document.createElement('p');
        p.appendChild(body);
        p.classList.add('message-content');
        container.appendChild(p);
        lastMessage.nick = (nick || null);
        lastMessage.peerId = peerId;
        lastMessage.dest = (dest || null);
        lastMessage.time = (time || null);
    } else {
        let asterisk = document.createElement('span');
        asterisk.textContent = '*';
        asterisk.classList.add('message-me-asterisk');
        let user = document.createElement('span');
        user.textContent = nick || '(anon)';
        user.classList.add('message-me-user');
        body.classList.add('message-me-content');
        container.appendChild(asterisk);
        container.appendChild(user);
        container.appendChild(body);
        container.classList.add('message-me');
        lastMessage = {};
    }
    container.appendChild(footer);

    let box = document.getElementById('box');
    box.appendChild(row);
    if(box.scrollHeight > box.clientHeight) {
        box.scrollTop = box.scrollHeight - box.clientHeight;
    }

    return;
}

/**
 * @param {HTMLElement} elt
 */
function chatMessageMenu(elt) {
    if(!(serverConnection && serverConnection.permissions &&
         serverConnection.permissions.indexOf('op') >= 0))
        return;

    let messageId = elt.dataset.id;
    let peerId = elt.dataset.peerId;
    if(!peerId)
        return;
    let username = elt.dataset.username;
    let u = username || 'user';

    let items = [];
    if(messageId)
        items.push({label: 'Delete message', onClick: () => {
            serverConnection.groupAction('clearchat', {
                id: messageId,
                userId: peerId,
            });
        }});
    items.push({label: `Delete all from ${u}`,
                onClick: () => {
                    serverConnection.groupAction('clearchat', {
                        userId: peerId,
                    });
                }});
    items.push({label: `Identify ${u}`, onClick: () => {
        serverConnection.userAction('identify', peerId);
    }});
    items.push({label: `Kick out ${u}`, onClick: () => {
        serverConnection.userAction('kick', peerId);
    }});

    /** @ts-ignore */
    new Contextual({
        items: items,
    });
}

/**
 * @param {string|HTMLElement} message
 */
function setCaption(message) {
    let container = document.getElementById('captions-container');
    let captions = document.getElementById('captions');
    if(!message) {
        captions.replaceChildren();
        container.classList.add('invisible');
    } else {
        if(message instanceof HTMLElement)
            captions.replaceChildren(message);
        else
            captions.textContent = message;
        container.classList.remove('invisible');
    }
}

let captionsTimer = null;

/**
 * @param {string|HTMLElement} message
 */
function displayCaption(message) {
    if(captionsTimer !== null) {
        clearTimeout(captionsTimer);
        captionsTimer = null;
    }
    setCaption(message);
    captionsTimer = setTimeout(() => setCaption(null), 3000);
}

/**
 * @param {string|HTMLElement} message
 */
function localMessage(message) {
    return addToChatbox(null, null, null, null, new Date(), false, false, '', message);
}

/**
 * @param {string} [id]
 * @param {string} [userId]
 */
function clearChat(id, userId) {
    lastMessage = {};

    let box = document.getElementById('box');
    if(!id && !userId) {
        box.textContent = '';
        return;
    }

    let elts = box.children;
    let i = 0;
    while(i < elts.length) {
        let row = elts.item(i);
        if(row instanceof HTMLDivElement) {
            let div = row.firstChild;
            if(div instanceof HTMLDivElement)
                if((!id || div.dataset.id === id) &&
                   div.dataset.peerId === userId) {
                    box.removeChild(row);
                    continue;
                }
        }
        i++;
    }
}

/**
 * A command known to the command-line parser.
 *
 * @typedef {Object} command
 * @property {string} [parameters]
 *     - A user-readable list of parameters.
 * @property {string} [description]
 *     - A user-readable description, null if undocumented.
 * @property {() => string} [predicate]
 *     - Returns null if the command is available.
 * @property {(c: string, r: string) => void} f
 */

/**
 * The set of commands known to the command-line parser.
 *
 * @type {Object.<string,command>}
 */
let commands = {};

function operatorPredicate() {
    if(serverConnection && serverConnection.permissions &&
       serverConnection.permissions.indexOf('op') >= 0)
        return null;
    return 'You are not an operator';
}

function recordingPredicate() {
    if(serverConnection && serverConnection.permissions &&
       serverConnection.permissions.indexOf('record') >= 0)
        return null;
    return 'You are not allowed to record';
}

commands.help = {
    description: 'display this help',
    f: (c, r) => {
        /** @type {string[]} */
        let cs = [];
        for(let cmd in commands) {
            let c = commands[cmd];
            if(!c.description)
                continue;
            if(c.predicate && c.predicate())
                continue;
            cs.push(`/${cmd}${c.parameters?' ' + c.parameters:''}: ${c.description}`);
        }
        localMessage(cs.sort().join('\n'));
    }
};

commands.me = {
    f: (c, r) => {
        // handled as a special case
        throw new Error("this shouldn't happen");
    }
};

commands.set = {
    f: (c, r) => {
        if(!r) {
            let settings = getSettings();
            let s = "";
            for(let key in settings)
                s = s + `${key}: ${JSON.stringify(settings[key])}\n`;
            localMessage(s);
            return;
        }
        let p = parseCommand(r);
        let value;
        if(p[1]) {
            value = JSON.parse(p[1]);
        } else {
            value = true;
        }
        updateSetting(p[0], value);
        reflectSettings();
    }
};

commands.unset = {
    f: (c, r) => {
        delSetting(r.trim());
        return;
    }
};

commands.leave = {
    description: "leave group",
    f: (c, r) => {
        if(!serverConnection)
            throw new Error('Not connected');
        // Deliberate leave: do not auto-reconnect. (Sozvon)
        wantConnected = false;
        stopReconnect();
        serverConnection.close();
    }
};

commands.clear = {
    predicate: operatorPredicate,
    description: 'clear the chat history',
    f: (c, r) => {
        serverConnection.groupAction('clearchat');
    }
};

commands.lock = {
    predicate: operatorPredicate,
    description: 'lock this group',
    parameters: '[message]',
    f: (c, r) => {
        serverConnection.groupAction('lock', r);
    }
};

commands.unlock = {
    predicate: operatorPredicate,
    description: 'unlock this group, revert the effect of /lock',
    f: (c, r) => {
        serverConnection.groupAction('unlock');
    }
};

commands.record = {
    predicate: recordingPredicate,
    description: 'start recording',
    f: (c, r) => {
        serverConnection.groupAction('record');
    }
};

commands.unrecord = {
    predicate: recordingPredicate,
    description: 'stop recording',
    f: (c, r) => {
        serverConnection.groupAction('unrecord');
    }
};

commands.subgroups = {
    predicate: operatorPredicate,
    description: 'list subgroups',
    f: (c, r) => {
        serverConnection.groupAction('subgroups');
    }
};

/**
 * @type {Record<string,number>}
 */
const units = {
    s: 1000,
    min: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
    mon: 31 * 24 * 60 * 60 * 1000,
    yr: 365 * 24 * 60 * 60 * 1000,
};

/**
 * @param {string} s
 * @returns {Date|number}
 */
function parseExpiration(s) {
    if(!s)
        return null;
    let re = /^([0-9]+)(s|min|h|d|mon|yr)$/
    let e = re.exec(s)
    if(e) {
        let unit = units[e[2]];
        if(!unit)
            throw new Error(`Couldn't find unit ${e[2]}`);
        return parseInt(e[1]) * unit;
    }
    let d = new Date(s);
    if(d.toString() === 'Invalid Date')
        throw new Error("Couldn't parse expiration date");
    return d;
}

function makeTokenPredicate() {
    return (serverConnection.permissions.indexOf('token') < 0 ?
            "You don't have permission to create tokens" : null);
}

function editTokenPredicate() {
    return (serverConnection.permissions.indexOf('token') < 0 ||
            serverConnection.permissions.indexOf('op') < 0 ?
            "You don't have permission to edit or list tokens" : null);
}

/**
 * @param {Object} [template]
 */
function makeToken(template) {
    if(!template)
        template = {};
    let v = {
        group: ('group' in template) ? template.group : group,
    }
    if('username' in template)
        v.username = template.username;
    if('includeSubgroups' in template)
        v.includeSubgroups = template.includeSubgroups;
    if('expires' in template)
        v.expires = template.expires;
    else
        v.expires = units.d;
    if('not-before' in template)
        v["not-before"] = template["not-before"];
    if('permissions' in template)
        v.permissions = template.permissions;
    else {
        v.permissions = [];
        if(serverConnection.permissions.indexOf('present') >= 0)
            v.permissions.push('present');
        if(serverConnection.permissions.indexOf('message') >= 0)
            v.permissions.push('message');
    }
    serverConnection.groupAction('maketoken', v);
}

commands.invite = {
    predicate: makeTokenPredicate,
    description: "create an invitation link",
    parameters: "[username] [expiration]",
    f: (c, r) => {
        let p = parseCommand(r);
        let template = {};
        if(p[0])
            template.username = p[0];
        let expires = parseExpiration(p[1]);
        if(expires)
            template.expires = expires;
        makeToken(template);
    }
}

/**
 * @param {string} t
 */
function parseToken(t) {
    let m = /^https?:\/\/.*?token=([^?]+)/.exec(t);
    if(m) {
        return m[1];
    } else if(!/^https?:\/\//.exec(t)) {
        return t
    } else {
        throw new Error("Couldn't parse link");
    }
}

commands.reinvite = {
    predicate: editTokenPredicate,
    description: "extend an invitation link",
    parameters: "link [expiration]",
    f: (c, r) => {
        let p = parseCommand(r);
        let v = {}
        v.token = parseToken(p[0]);
        if(p[1])
            v.expires = parseExpiration(p[1]);
        else
            v.expires = units.d;
        serverConnection.groupAction('edittoken', v);
    }
}

commands.revoke = {
    predicate: editTokenPredicate,
    description: "revoke an invitation link",
    parameters: "link",
    f: (c, r) => {
        let token = parseToken(r);
        serverConnection.groupAction('edittoken', {
            token: token,
            expires: -units.s,
        });
    }
}

commands.listtokens = {
    predicate: editTokenPredicate,
    description: "list invitation links",
    f: (c, r) => {
        serverConnection.groupAction('listtokens');
    }
}

function renegotiateStreams() {
    for(let id in serverConnection.up)
        serverConnection.up[id].restartIce();
    for(let id in serverConnection.down)
        serverConnection.down[id].restartIce();
}

commands.renegotiate = {
    description: 'renegotiate media streams',
    f: (c, r) => {
        renegotiateStreams();
    }
};

commands.replace = {
    f: (c, r) => {
        replaceUpStreams(null);
    }
};

commands.sharescreen = {
    description: 'start a screen share',
    f: (c, r) => {
        addShareMedia();
    }
}

commands.unsharescreen = {
    description: 'stop screen share',
    f: (c, r) => {
        closeUpMedia('screenshare');
    }
}

/**
 * parseCommand splits a string into two space-separated parts.  The first
 * part may be quoted and may include backslash escapes.
 *
 * @param {string} line
 * @returns {string[]}
 */
function parseCommand(line) {
    let i = 0;
    while(i < line.length && line[i] === ' ')
        i++;
    let start = ' ';
    if(i < line.length && (line[i] === '"' || line[i] === "'")) {
        start = line[i];
        i++;
    }
    let first = "";
    while(i < line.length) {
        if(line[i] === start) {
            if(start !== ' ')
                i++;
            break;
        }
        if(line[i] === '\\' && i < line.length - 1)
            i++;
        first = first + line[i];
        i++;
    }

    while(i < line.length && line[i] === ' ')
        i++;
    return [first, line.slice(i)];
}

/**
 * @param {string} user
 */
function findUserId(user) {
    if(user in serverConnection.users)
        return user;

    for(let id in serverConnection.users) {
        let u = serverConnection.users[id];
        if(u && u.username === user)
            return id;
    }
    return null;
}

commands.msg = {
    parameters: 'user message',
    description: 'send a private message',
    f: (c, r) => {
        let p = parseCommand(r);
        if(!p[0])
            throw new Error('/msg requires parameters');
        let id = findUserId(p[0]);
        if(!id)
            throw new Error(`Unknown user ${p[0]}`);
        serverConnection.chat('', id, p[1]);
        addToChatbox(serverConnection.id, null, id, serverConnection.username,
                     new Date(), false, false, '', p[1]);
    }
};

/**
   @param {string} c
   @param {string} r
*/
function userCommand(c, r) {
    let p = parseCommand(r);
    if(!p[0])
        throw new Error(`/${c} requires parameters`);
    let id = findUserId(p[0]);
    if(!id)
        throw new Error(`Unknown user ${p[0]}`);
    serverConnection.userAction(c, id, p[1]);
}

function userMessage(c, r) {
    let p = parseCommand(r);
    if(!p[0])
        throw new Error(`/${c} requires parameters`);
    let id = findUserId(p[0]);
    if(!id)
        throw new Error(`Unknown user ${p[0]}`);
    serverConnection.userMessage(c, id, p[1]);
}

commands.kick = {
    parameters: 'user [message]',
    description: 'kick out a user',
    predicate: operatorPredicate,
    f: userCommand,
};

commands.identify = {
    parameters: 'user [message]',
    description: 'identify a user',
    predicate: operatorPredicate,
    f: userCommand,
};

commands.op = {
    parameters: 'user',
    description: 'give operator status',
    predicate: operatorPredicate,
    f: userCommand,
};

commands.unop = {
    parameters: 'user',
    description: 'revoke operator status',
    predicate: operatorPredicate,
    f: userCommand,
};

commands.present = {
    parameters: 'user',
    description: 'give user the right to present',
    predicate: operatorPredicate,
    f: userCommand,
};

commands.unpresent = {
    parameters: 'user',
    description: 'revoke the right to present',
    predicate: operatorPredicate,
    f: userCommand,
};

commands.shutup = {
    parameters: 'user',
    description: 'revoke the right to send chat messages',
    predicate: operatorPredicate,
    f: userCommand,
};

commands.unshutup = {
    parameters: 'user',
    description: 'give the right to send chat messages',
    predicate: operatorPredicate,
    f: userCommand,
};

commands.mute = {
    parameters: 'user',
    description: 'mute a remote user',
    predicate: operatorPredicate,
    f: userMessage,
};

commands.muteall = {
    description: 'mute all remote users',
    predicate: operatorPredicate,
    f: (c, r) => {
        serverConnection.userMessage('mute', null, null, true);
    }
}

commands.warn = {
    parameters: 'user message',
    description: 'send a warning to a user',
    predicate: operatorPredicate,
    f: (c, r) => {
        userMessage('warning', r);
    },
};

commands.wall = {
    parameters: 'message',
    description: 'send a warning to all users',
    predicate: operatorPredicate,
    f: (c, r) => {
        if(!r)
            throw new Error('empty message');
        serverConnection.userMessage('warning', '', r);
    },
};

commands.raise = {
    description: 'raise hand',
    f: (c, r) => {
        serverConnection.userAction(
            "setdata", serverConnection.id, {"raisehand": true},
        );
    }
}

commands.unraise = {
    description: 'unraise hand',
    f: (c, r) => {
        serverConnection.userAction(
            "setdata", serverConnection.id, {"raisehand": null},
        );
    }
}

/** @returns {boolean} */
function canFile() {
    let v =
        /** @ts-ignore */
        !!HTMLVideoElement.prototype.captureStream ||
        /** @ts-ignore */
        !!HTMLVideoElement.prototype.mozCaptureStream;
    return v;
}

function presentFile() {
    let input = document.createElement('input');
    input.type = 'file';
    input.accept="audio/*,video/*";
    input.onchange = function(e) {
        if(!(this instanceof HTMLInputElement))
            throw new Error('Unexpected type for this');
        let files = this.files;
        for(let i = 0; i < files.length; i++) {
            addFileMedia(files[i]).catch(e => {
                console.error(e);
                displayError(e);
            });
        }
    };
    input.click();
}

commands.presentfile = {
    description: 'broadcast a video or audio file',
    f: (c, r) => {
        presentFile();
    },
    predicate: () => {
        if(!canFile())
            return 'Your browser does not support presenting arbitrary files';
        if(!serverConnection || !serverConnection.permissions ||
           serverConnection.permissions.indexOf('present') < 0)
            return 'You are not authorised to present.';
        return null;
    }
};


/**
 * @param {string} id
 */
function sendFile(id) {
    let input = document.createElement('input');
    input.type = 'file';
    input.onchange = function(e) {
        if(!(this instanceof HTMLInputElement))
            throw new Error('Unexpected type for this');
        let files = this.files;
        for(let i = 0; i < files.length; i++) {
            try {
                serverConnection.sendFile(id, files[i]);
            } catch(e) {
                console.error(e);
                displayError(e);
            }
        }
    };
    input.click();
}

commands.sendfile = {
    parameters: 'user',
    description: 'send a file (this will disclose your IP address)',
    f: (c, r) => {
        let p = parseCommand(r);
        if(!p[0])
            throw new Error(`/${c} requires parameters`);
        let id = findUserId(p[0]);
        if(!id)
            throw new Error(`Unknown user ${p[0]}`);
        sendFile(id);
    },
};

/**
 * Test loopback through a TURN relay.
 *
 * @returns {Promise<number>}
 */
async function relayTest() {
    if(!serverConnection)
        throw new Error('not connected');
    let conf = Object.assign({}, serverConnection.getRTCConfiguration());
    conf.iceTransportPolicy = 'relay';
    let pc1 = new RTCPeerConnection(conf);
    let pc2 = new RTCPeerConnection(conf);
    pc1.onicecandidate = e => {e.candidate && pc2.addIceCandidate(e.candidate);};
    pc2.onicecandidate = e => {e.candidate && pc1.addIceCandidate(e.candidate);};
    try {
        return await new Promise(async (resolve, reject) => {
            let d1 = pc1.createDataChannel('loopbackTest');
            d1.onopen = e => {
                d1.send(Date.now().toString());
            };

            let offer = await pc1.createOffer();
            await pc1.setLocalDescription(offer);
            await pc2.setRemoteDescription(pc1.localDescription);
            let answer = await pc2.createAnswer();
            await pc2.setLocalDescription(answer);
            await pc1.setRemoteDescription(pc2.localDescription);

            pc2.ondatachannel = e => {
                let d2 = e.channel;
                d2.onmessage = e => {
                    let t = parseInt(e.data);
                    if(isNaN(t))
                        reject(new Error('corrupt data'));
                    else
                        resolve(Date.now() - t);
                }
            }

            setTimeout(() => reject(new Error('timeout')), 5000);
        })
    } finally {
        pc1.close();
        pc2.close();
    }
}

commands['relay-test'] = {
    f: async (c, r) => {
        localMessage('Relay test in progress...');
        try {
            let s = Date.now();
            let rtt = await relayTest();
            let e = Date.now();
            localMessage(`Relay test successful in ${e-s}ms, RTT ${rtt}ms`);
        } catch(e) {
            localMessage(`Relay test failed: ${e}`);
        }
    }
}

function handleInput() {
    let input = /** @type {HTMLTextAreaElement} */
        (document.getElementById('input'));
    let data = input.value;
    input.value = '';

    let message, me;

    if(data === '')
        return;

    if(data[0] === '/') {
        if(data.length > 1 && data[1] === '/') {
            message = data.slice(1);
            me = false;
        } else {
            let cmd, rest;
            let space = data.indexOf(' ');
            if(space < 0) {
                cmd = data.slice(1);
                rest = '';
            } else {
                cmd = data.slice(1, space);
                rest = data.slice(space + 1);
            }

            if(cmd === 'me') {
                message = rest;
                me = true;
            } else {
                let c = commands[cmd];
                if(!c) {
                    displayError(
                        `Unknown command /${cmd}, type /help for help`
                    );
                    return;
                }
                if(c.predicate) {
                    let s = c.predicate();
                    if(s) {
                        displayError(s);
                        return;
                    }
                }
                try {
                    c.f(cmd, rest);
                } catch(e) {
                    console.error(e);
                    displayError(e);
                }
                return;
            }
        }
    } else {
        message = data;
        me = false;
    }

    if(!serverConnection || !serverConnection.socket) {
        displayError(Sozvon.i18n.t('toast.notConnected'));
        return;
    }

    let kind = me ? 'me' : '';
    try {
        let e2ee = serverConnection.e2ee;
        if(e2eeActive() && e2ee && e2ee.canChat()) {
            // Two-party encrypted call: send the text over the (un-stored)
            // user-message channel and echo it locally, so the server never
            // sees the cleartext nor keeps it in chat history.
            e2ee.sendChat(kind, message).then(function(sent) {
                if(sent)
                    addToChatbox(serverConnection.id, null, '',
                                 serverConnection.username, new Date(),
                                 false, false, kind, message);
                else
                    serverConnection.chat(kind, '', message);
            }).catch(function(err) {
                console.error(err);
                serverConnection.chat(kind, '', message);
            });
        } else {
            serverConnection.chat(kind, '', message);
        }
    } catch(e) {
        console.error(e);
        displayError(e);
    }
}

document.getElementById('inputform').onsubmit = function(e) {
    e.preventDefault();
    handleInput();
};

document.getElementById('input').onkeypress = function(e) {
    if(e.key === 'Enter' && !e.ctrlKey && !e.shiftKey && !e.metaKey) {
        e.preventDefault();
        handleInput();
    }
};

/**
 * @param {unknown} message
 * @param {string} [level]
 */
function displayError(message, level) {
    if(message instanceof Error)
        message = message.message;
    if(!level)
        level = "error";
    // Sozvon: route every notification (error / warning / info / kicked) to
    // the top of the screen so the bottom dock stays clear of toasts.
    let position = 'center';
    let gravity = 'top';

    switch(level) {
    case "kicked":
        level = "error";
        break;
    }

    /** @ts-ignore */
    Toastify({
        text: message,
        duration: 4000,
        close: true,
        position: position,
        gravity: gravity,
        className: level,
    }).showToast();
}

/**
 * @param {unknown} message
 */
function displayWarning(message) {
    return displayError(message, "warning");
}

/**
 * @param {unknown} message
 */
function displayMessage(message) {
    return displayError(message, "info");
}

document.getElementById('operator-login-link').onclick = function(e) {
    e.preventDefault();
    // An explicit operator login must not silently reuse a remembered token
    // (whose username would override the typed one server-side); drop it so the
    // entered name and password are what actually log in, and the "remember me"
    // box reappears because there is no longer a working token. (Sozvon)
    token = null;
    usingRememberToken = false;
    probingState = null;
    setVisibility('userform', true);
    setVisibility('passwordform', true);
    // Operator login: offer "remember me" -- except in a per-client child
    // room, where the token would land in that room's group and surface on
    // the hub dashboard as if it were the client's own link.  The operator
    // enters child rooms from the hub anyway, carrying the session token.
    // (Sozvon)
    setVisibility('rememberform', !groupStatus.operatorRoomChild);
    setVisibility('operator-login', false);
    document.getElementById('password').focus();
};

/* ==========================================================================
   Pre-join device check (login card, operator dashboard)

   Two icon toggles, both off by default.  Turning the camera on shows a
   live preview, turning the microphone on shows a level meter, and each
   reveals a device picker, so people can check that everything works
   before they join.  applyChoices() writes the choice to settings.audio /
   settings.video and returns it as a presentRequested value ('both' |
   'mike' | null); the preview streams are stopped so the devices are free
   for the real call.

   makePrecheck(prefix) builds one instance wired to elements
   `${prefix}-cam`, `${prefix}-mic`, etc.  There are two instances:
   loginPrecheck drives the login card (shared by the "Rejoin as X" quick
   action and the normal login fields) and operatorPrecheck drives the
   operator dashboard, so an operator arrives in a child room with the
   camera/mic already chosen instead of seeing a second device-check screen
   there (see operatorJoin).
   ========================================================================== */

/**
 * @param {string} prefix - element id prefix, e.g. 'precheck' or 'operator-precheck'
 */
function makePrecheck(prefix) {
    let elementId = suffix => `${prefix}-${suffix}`;

    let state = {
        cam: false,
        mic: false,
        /** @type {MediaStream} */
        camStream: null,
        /** @type {MediaStream} */
        micStream: null,
        /** @type {AudioContext} */
        audioCtx: null,
        /** @type {number} */
        meterRAF: null,
    };

    /**
     * @param {string} kind - 'video' or 'audio'
     * @returns {HTMLSelectElement}
     */
    function select(kind) {
        return getSelectElement(
            kind === 'video' ? elementId('videoselect') : elementId('audioselect'),
        );
    }

    /**
     * @param {string} msg - empty to clear
     * @param {boolean} [soft] - advisory hint (amber) rather than a hard error (red)
     */
    function error(msg, soft) {
        let el = document.getElementById(elementId('error'));
        el.textContent = msg;
        el.classList.toggle('soft', !!msg && !!soft);
        setVisibility(elementId('error'), !!msg);
    }

    /**
     * Map a getUserMedia rejection to a specific, actionable message key.
     * The common real-world failures — a blocked permission, a missing
     * device, or a remembered deviceId that no longer exists — each need a
     * different instruction, so we no longer collapse them into one generic
     * "could not access" line. (Sozvon)
     *
     * @param {any} err
     * @param {string} kind - 'audio' or 'video'
     * @returns {string} a Sozvon.i18n key
     */
    function mediaErrorKey(err, kind) {
        let name = err && err.name;
        let mic = kind === 'audio';
        if(name === 'NotAllowedError' || name === 'SecurityError')
            return mic ? 'login.micDenied' : 'login.camDenied';
        if(name === 'NotFoundError' || name === 'DevicesNotFoundError')
            return mic ? 'login.micNotFound' : 'login.camNotFound';
        if(name === 'OverconstrainedError' || name === 'NotReadableError' ||
           name === 'TrackStartError')
            return mic ? 'login.micUnavailable' : 'login.camUnavailable';
        return mic ? 'login.noMic' : 'login.noCamera';
    }

    /**
     * Repopulate this instance's device pickers, and refresh the settings
     * drawer's pickers too: a permission grant has just revealed the real
     * device labels and ids.
     */
    async function enumerate() {
        let devices = [];
        try {
            devices = await navigator.mediaDevices.enumerateDevices();
        } catch(e) {
            console.warn(e);
            return;
        }

        let videoselect = getSelectElement('videoselect');
        let audioselect = getSelectElement('audioselect');
        while(videoselect.options.length > 1)
            videoselect.remove(1);
        while(audioselect.options.length > 1)
            audioselect.remove(1);
        mediaChoicesDone = false;
        await setMediaChoices(true);

        let pv = select('video'), pa = select('audio');
        let pvValue = pv.value, paValue = pa.value;
        while(pv.options.length > 0)
            pv.remove(0);
        while(pa.options.length > 0)
            pa.remove(0);
        let cn = 1, mn = 1;
        devices.forEach(d => {
            if(d.kind === 'videoinput') {
                let l = d.label || `Camera ${cn++}`;
                addSelectOption(pv, truncateDeviceLabel(l), d.deviceId, l);
            } else if(d.kind === 'audioinput') {
                let l = d.label || `Microphone ${mn++}`;
                addSelectOption(pa, truncateDeviceLabel(l), d.deviceId, l);
            }
        });
        if(pvValue && selectOptionAvailable(pv, pvValue))
            pv.value = pvValue;
        if(paValue && selectOptionAvailable(pa, paValue))
            pa.value = paValue;
    }

    /**
     * Show the preview the way the call will show it: the fixed base rotation
     * the outgoing canvas applies (mobileOrientationFilter draws at
     * settings.videoRotation), and then the self-view mirror on top — the same
     * order, so the arrow turns the picture the way it points here too.
     *
     * Only the manual base is applied.  The auto-rotation the filter adds on a
     * phone follows the device's live orientation, which a login form has
     * nothing to say about, and a plain <video> already shows the camera
     * upright locally — replaying it here would spin a preview that is
     * already right.
     *
     * A quarter turn also swaps the picture's box (see .precheck-stage.quarter)
     * so it still fills the 4:3 stage instead of hanging out of it. (Sozvon)
     */
    function reflectRotation() {
        let stage = document.getElementById(elementId('stage'));
        let settings = getSettings();
        let base = parseInt(settings.videoRotation, 10) || 0;
        stage.style.setProperty('--precheck-rot', `${base}deg`);
        stage.classList.toggle('quarter', base === 90 || base === 270);
        stage.classList.toggle('mirrored', settings.mirrorView !== false);
    }

    /**
     * Make the toggles, the preview area and the pickers reflect state.
     */
    function reflect() {
        let cam = document.getElementById(elementId('cam'));
        let mic = document.getElementById(elementId('mic'));
        cam.classList.toggle('on', state.cam);
        mic.classList.toggle('on', state.mic);
        cam.setAttribute('aria-pressed', String(state.cam));
        mic.setAttribute('aria-pressed', String(state.mic));
        cam.querySelector('i').className =
            state.cam ? 'fas fa-video' : 'fas fa-video-slash';
        mic.querySelector('i').className =
            state.mic ? 'fas fa-microphone' : 'fas fa-microphone-slash';

        setVisibility(elementId('stage'), state.cam);
        setVisibility(elementId('meter'), state.mic);
        setVisibility(elementId('preview'), state.cam || state.mic);
        setVisibility(elementId('videoselect'), state.cam);
        setVisibility(elementId('audioselect'), state.mic);
        reflectRotation();
    }

    async function startCam() {
        stopCam();
        let vid = select('video').value;
        /** @type {MediaTrackConstraints} */
        let video = vid ? {deviceId: vid} : {};
        video.aspectRatio = {ideal: 4/3};
        let stream = await navigator.mediaDevices.getUserMedia({video: video});
        state.camStream = stream;
        let v = /** @type {HTMLVideoElement} */
            (document.getElementById(elementId('video')));
        v.srcObject = stream;
        await enumerate();
        let t = stream.getVideoTracks()[0];
        if(t && t.getSettings) {
            let current = t.getSettings().deviceId;
            if(current && selectOptionAvailable(select('video'), current))
                select('video').value = current;
        }
    }

    function stopCam() {
        if(state.camStream) {
            stopStream(state.camStream);
            state.camStream = null;
        }
        let v = /** @type {HTMLVideoElement} */
            (document.getElementById(elementId('video')));
        v.srcObject = null;
    }

    async function startMic() {
        stopMic();
        let aid = select('audio').value;
        let stream = await navigator.mediaDevices.getUserMedia(
            {audio: aid ? {deviceId: aid} : true},
        );
        state.micStream = stream;
        await enumerate();
        let t = stream.getAudioTracks()[0];
        if(t && t.getSettings) {
            let current = t.getSettings().deviceId;
            if(current && selectOptionAvailable(select('audio'), current))
                select('audio').value = current;
        }
        // Permission revoked (or device unplugged) while the check is running
        // fires 'ended' — surface it and drop the toggle, instead of a meter
        // that just silently freezes. (Sozvon)
        if(t) {
            t.addEventListener('ended', () => {
                if(!state.mic)
                    return;
                state.mic = false;
                stopMic();
                error(Sozvon.i18n.t('login.micEnded'));
                reflect();
            });
        }
        startMeter(stream);
    }

    function stopMic() {
        stopMeter();
        if(state.micStream) {
            stopStream(state.micStream);
            state.micStream = null;
        }
    }

    /**
     * Drive the microphone level meter: an analyser node feeds an RMS level
     * (fast attack, slow release) to precheckDrawMeter on animation frames.
     *
     * @param {MediaStream} stream
     */
    function startMeter(stream) {
        stopMeter();
        let ctx;
        try {
            ctx = new (window.AudioContext ||
                       /** @ts-ignore */
                       window.webkitAudioContext)();
        } catch(e) {
            console.warn(e);
            return;
        }
        // Autoplay policy can hand back a suspended context; the toggle click is
        // a user gesture, so resume it or the meter would read a flat zero even
        // on a perfectly good mic. (Sozvon)
        if(ctx.state === 'suspended' && ctx.resume)
            ctx.resume().catch(e => console.warn(e));
        state.audioCtx = ctx;
        let analyser = ctx.createAnalyser();
        analyser.fftSize = 1024;
        ctx.createMediaStreamSource(stream).connect(analyser);
        let data = new Uint8Array(analyser.fftSize);
        let canvas = /** @type {HTMLCanvasElement} */
            (document.getElementById(elementId('meter')));
        let level = 0;
        // Silence watchdog: permission can be granted yet the captured device
        // be the wrong/dead default (a very common "no sound" cause on Windows
        // laptops), in which case getUserMedia succeeds but the meter never
        // moves and nothing tells the user.  If we see no real input for a few
        // seconds we surface an advisory hint pointing at the device picker;
        // the moment we detect actual sound we clear it. (Sozvon)
        const SPEAK_LEVEL = 0.06;    // RMS (pre-boost) that counts as "sound"
        const SILENCE_MS = 3500;
        let startedAt = (window.performance || Date).now();
        let spoke = false, hintShown = false;
        function draw() {
            state.meterRAF = requestAnimationFrame(draw);
            analyser.getByteTimeDomainData(data);
            let sum = 0;
            for(let i = 0; i < data.length; i++) {
                let s = (data[i] - 128) / 128;
                sum += s * s;
            }
            let rms = Math.sqrt(sum / data.length);
            // boost the RMS so ordinary speech lights most of the bar
            let v = Math.min(1, rms * 2.5);
            level = Math.max(v, level * 0.92);
            precheckDrawMeter(canvas, level);

            if(rms > SPEAK_LEVEL) {
                spoke = true;
                if(hintShown) {
                    error('');
                    hintShown = false;
                }
            } else if(!spoke && !hintShown &&
                      (window.performance || Date).now() - startedAt > SILENCE_MS) {
                error(Sozvon.i18n.t('login.micSilent'), true);
                hintShown = true;
            }
        }
        draw();
    }

    function stopMeter() {
        if(state.meterRAF != null) {
            cancelAnimationFrame(state.meterRAF);
            state.meterRAF = null;
        }
        if(state.audioCtx) {
            state.audioCtx.close();
            state.audioCtx = null;
        }
    }

    /**
     * Stop both previews and reset the toggles; called once the choice has
     * been applied, so the devices are free for the real call.
     */
    function stop() {
        state.cam = false;
        state.mic = false;
        stopCam();
        stopMic();
        error('');
        reflect();
    }

    document.getElementById(elementId('cam')).onclick = async function(e) {
        e.preventDefault();
        let button = /** @type {HTMLButtonElement} */(this);
        button.disabled = true;
        error('');
        try {
            if(!state.cam) {
                await startCam();
                state.cam = true;
            } else {
                stopCam();
                state.cam = false;
            }
        } catch(err) {
            console.warn(err);
            state.cam = false;
            error(Sozvon.i18n.t(mediaErrorKey(err, 'video')));
        } finally {
            button.disabled = false;
            reflect();
        }
    };

    document.getElementById(elementId('mic')).onclick = async function(e) {
        e.preventDefault();
        let button = /** @type {HTMLButtonElement} */(this);
        button.disabled = true;
        error('');
        try {
            if(!state.mic) {
                await startMic();
                state.mic = true;
            } else {
                stopMic();
                state.mic = false;
            }
        } catch(err) {
            console.warn(err);
            state.mic = false;
            error(Sozvon.i18n.t(mediaErrorKey(err, 'audio')));
        } finally {
            button.disabled = false;
            reflect();
        }
    };

    // The same quarter turn the settings drawer's arrows make, available where
    // people actually notice a sideways camera: while they are looking at the
    // preview.  rotateVideo writes the setting the call will use, so a turn
    // made here carries into the call; its replaceCameraStream is a no-op
    // before we have joined, which is the only state these are shown in. (Sozvon)
    /**
     * @param {string} suffix
     * @param {number} quarters
     */
    function wireRotate(suffix, quarters) {
        document.getElementById(elementId(suffix)).onclick = function(e) {
            e.preventDefault();
            rotateVideo(quarters);
            reflectRotation();
        };
    }
    wireRotate('rotate-left', -1);
    wireRotate('rotate-right', 1);

    select('video').onchange = async function(e) {
        if(!state.cam)
            return;
        error('');
        try {
            await startCam();
        } catch(err) {
            console.warn(err);
            state.cam = false;
            error(Sozvon.i18n.t(mediaErrorKey(err, 'video')));
            reflect();
        }
    };

    select('audio').onchange = async function(e) {
        if(!state.mic)
            return;
        error('');
        try {
            await startMic();
        } catch(err) {
            console.warn(err);
            state.mic = false;
            error(Sozvon.i18n.t(mediaErrorKey(err, 'audio')));
            reflect();
        }
    };

    // Settle the markup into the state above before anything is shown: a
    // rotation remembered from a previous session has to be on the preview the
    // first time it opens, not only after the first press of an arrow.
    reflect();

    return {
        get state() { return state; },
        stop,
        /**
         * Turns the toggles into a presentRequested value ('both' | 'mike' |
         * null) plus persisted device settings, then stops the preview
         * streams so the devices are free for the real call.
         * @returns {string}
         */
        applyChoices() {
            let present = state.cam ? 'both' : state.mic ? 'mike' : null;
            presentRequested = present;
            if(state.cam) {
                let vid = select('video').value;
                if(vid)
                    updateSettings({video: vid});
                else
                    delSetting('video');   // reflectSettings picks the default
            } else {
                updateSettings({video: ''});
            }
            if(state.mic) {
                let aid = select('audio').value;
                if(aid)
                    updateSettings({audio: aid});
                else
                    delSetting('audio');
            } else {
                updateSettings({audio: ''});
            }
            stop();
            return present;
        },
    };
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {number} level - 0..1
 */
function precheckDrawMeter(canvas, level) {
    let g = canvas.getContext('2d');
    let w = canvas.width, h = canvas.height;
    g.clearRect(0, 0, w, h);
    let styles = getComputedStyle(document.documentElement);
    let grad = g.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0, styles.getPropertyValue('--accent').trim() || '#5B8CFF');
    grad.addColorStop(1, styles.getPropertyValue('--accent-2').trim() || '#7A6CFF');
    let n = 24, gap = 4;
    let bw = (w - gap * (n - 1)) / n;
    let lit = Math.round(level * n);
    for(let i = 0; i < n; i++) {
        g.fillStyle = i < lit ? grad : 'rgba(255, 255, 255, 0.10)';
        g.fillRect(i * (bw + gap), h * 0.2, bw, h * 0.6);
    }
}

let loginPrecheck = makePrecheck('precheck');
let operatorPrecheck = makePrecheck('operator-precheck');

document.getElementById('loginform').onsubmit = async function(e) {
    e.preventDefault();

    let form = this;
    if(!(form instanceof HTMLFormElement))
        throw new Error('Bad type for loginform');

    if(!groupStatus.lobby)
        setVisibility('passwordform', true);

    loginPrecheck.applyChoices();

    // Connect to the server, gotConnected will join.
    serverConnect();
};

document.getElementById('disconnectbutton').onclick = function(e) {
    // Sozvon: an operator who came into this child room from the dashboard
    // returns to the hub (their session token auto-signs them back in) rather
    // than dropping to the login card.
    let ret = null;
    try {
        ret = JSON.parse(window.sessionStorage.getItem('sozvon.operatorReturn'));
    } catch(err) { /* ignore */ }
    if(ret && ret.hub && group !== ret.hub && group.startsWith(ret.hub + '/')) {
        try {
            window.sessionStorage.removeItem('sozvon.operatorReturn');
        } catch(err) { /* ignore */ }
        wantConnected = false;
        stopReconnect();
        window.location.href = ret.url || ('/group/' + ret.hub + '/');
        return;
    }
    // Sozvon: on the operator hub there is no call to hang up, so "Logout" here
    // means the same thing as the dashboard's own button -- a full logout.
    // Treating it as a hang-up left the login card showing "Rejoin as X" with
    // the name and password fields hidden, which reads as a login form that
    // has stopped working, and kept the session and remembered tokens alive so
    // a reload signed the operator straight back in.
    if(groupStatus.operatorRoom) {
        operatorLogout();
        return;
    }
    // Deliberate hang-up: do not auto-reconnect. (Sozvon)
    wantConnected = false;
    stopReconnect();
    serverConnection.close();
    closeNav();
};

// Sozvon: the operator-room dashboard "Create link" form.
{
    let f = document.getElementById('operator-create-form');
    if(f)
        f.onsubmit = function(e) {
            e.preventDefault();
            createOperatorLink();
        };
    // The label / client-name / expiry fields are collapsed by default; this
    // toggle reveals them for a customised link.
    let toggle = document.getElementById('operator-advanced-toggle');
    let adv = document.getElementById('operator-advanced');
    if(toggle && adv)
        toggle.onclick = function() {
            let hidden = adv.classList.toggle('invisible');
            toggle.setAttribute('aria-expanded', hidden ? 'false' : 'true');
        };
    let logout = document.getElementById('operator-logout');
    if(logout)
        logout.onclick = operatorLogout;
}

// Sozvon: the round "Leave" button in the bottom control dock reuses the exact
// same hang-up path as the Logout link in the settings drawer.
{
    let leavebutton = document.getElementById('leavebutton');
    if(leavebutton)
        leavebutton.onclick = function() {
            document.getElementById('disconnectbutton').click();
        };
}

// Sozvon: quick rejoin after a deliberate hang-up. Reuses the exact same
// saved-credentials path as an automatic reconnect-after-drop (gotConnected
// sees `reconnecting` and calls rejoinAfterReconnect instead of the login
// form's join()) -- just triggered by a click instead of an unexpected close.
document.getElementById('rejoinbutton').onclick = function(e) {
    e.preventDefault();
    loginPrecheck.applyChoices();
    wantConnected = true;
    reconnecting = true;
    // Unlike a network-drop reconnect, the login screen really was showing
    // here, so (unlike gotConnected's reconnecting branch) we do need the
    // optimistic setConnected(true) a normal join would give us. (Sozvon)
    setConnected(true);
    serverConnect();
};

// Sozvon: bypass the quick rejoin to log in as someone else. reconnectLastJoin
// is left alone -- a later hang-up of the new session offers its own rejoin.
document.getElementById('rejoin-other-link').onclick = function(e) {
    e.preventDefault();
    setVisibility('rejoin-container', false);
    setVisibility('normal-login-fields', true);
    // reflectRejoinOption() hid the connect button along with the normal
    // fields; bring it back or the revealed form cannot be submitted.
    setVisibility('connect-container', true);
    let u = getInputElement('username');
    u.value = '';
    u.focus();
};

/**
 * Sozvon: open/close the settings drawer.
 *
 * The width lives in galene.css keyed off body.drawer-open, not in an inline
 * style here, so that CSS can also shrink the call area by exactly the same
 * amount on desktop.  On desktop the drawer pushes the video aside the way the
 * people/chat panel does; on mobile there is no room to push, so it stays an
 * overlay.  A ResizeObserver on the call area re-fits the peer grid once the
 * width transition has actually happened.
 */
function openNav() {
    document.body.classList.add('drawer-open');
}

function closeNav() {
    document.body.classList.remove('drawer-open');
}

/**
 * Show or hide the combined people + chat panel (the single toggle behind the
 * #sidebarCollapse button).  Factored out so toggleChrome() can also close the
 * panel when going immersive.
 */
function togglePanel() {
    document.getElementById("left-sidebar").classList.toggle("active");
    document.getElementById("mainrow").classList.toggle("full-width-active");
    if(panelVisible())
        unreadChat = false;   // opening the panel marks the chat seen
    refreshPanelAlert();
    resizePeers();   // the video area changed width, re-fit the grid
}

document.getElementById('sidebarCollapse').onclick = function(e) {
    togglePanel();
};

/**
 * Sozvon: close an overlay panel by tapping outside it.
 *
 * On a phone both the people+chat column and the settings drawer cover the
 * call, and the only way out of either was its own ✕ — a small target in a
 * corner, and the one thing a person does not look for when they simply want
 * the call back.  A tap anywhere outside the open panel now dismisses it.
 *
 * On the document rather than on the call area, because "outside the panel"
 * is not the same region for the two of them: the drawer is on the right, and
 * on a 375px phone the strip it leaves uncovered belongs to the chat column,
 * not to the stage — a handler on the call area never saw that tap.
 *
 * In the capture phase, so the tap can be *spent*: closing the panel and also
 * toggling the immersive chrome underneath would be one tap doing two things.
 * Anything you operate is exempt and keeps its own tap.
 *
 * Only where the panel actually covers something: on a desktop both push the
 * call aside instead, nothing is hidden, and closing one because the user
 * clicked on the video would be a surprise rather than a shortcut.
 */
document.addEventListener('click', function(e) {
    if(!isMobileLayout() || document.body.classList.contains('pre-join'))
        return;
    let target = /** @type{HTMLElement} */(e.target);
    if(!(target instanceof Element))
        return;
    // Anything you operate keeps its tap, wherever it is.
    if(target.closest(
        'button, a, input, select, textarea, label, ' +
        '.nav-menu, .self-controls-pill, .video-controls, .top-video-controls'))
        return;

    let closed = false;
    if(document.body.classList.contains('drawer-open')) {
        if(!target.closest('#sidebarnav')) {
            closeNav();
            closed = true;
        }
    } else if(panelVisible() && !target.closest('#left-sidebar')) {
        togglePanel();
        closed = true;
    }
    if(closed) {
        e.stopPropagation();
        e.preventDefault();
    }
}, true);

/**
 * Sozvon: swipe a panel away, in the direction it would leave.
 *
 * @param {string} id - the panel's element id
 * @param {number} sign - -1 closes on a leftward swipe, +1 on a rightward one
 * @param {function(): boolean} isOpen
 * @param {function(): void} close
 */
function makeSwipeDismissible(id, sign, isOpen, close) {
    let el = document.getElementById(id);
    if(!el)
        return;
    let startX = 0, startY = 0, tracking = false;

    // Touch events, not pointer events.  Written with pointerdown/pointermove
    // first, this worked against synthetic events and did nothing under a real
    // finger: instrumenting the panel on the device showed `pointerdown` and
    // `touchstart` arriving and then **no pointermove at all** — the browser
    // takes the gesture over once the finger starts moving and simply stops
    // delivering pointer moves to the listener.  touchmove keeps coming, which
    // is why every carousel on the web is written this way.
    el.addEventListener('touchstart', function(e) {
        if(!isMobileLayout() || !isOpen())
            return;
        if(e.touches.length !== 1)
            return;                      // a pinch is not a swipe
        // Only the controls a sideways drag actually means something to are
        // exempt: the composer and any text field (where it moves a caret or
        // selects), the volume sliders (where it sets the value), and the
        // panel resizer.
        //
        // Buttons, links, selects and checkboxes are deliberately *not*
        // exempt, though they were at first.  A drag across them means nothing
        // to them — they act on a tap, and the browser has already cancelled
        // the activation by the time a finger has travelled the 60px this
        // gesture asks for — while excluding them left almost nowhere to swipe
        // from: the drawer is a column of selects, links and segmented
        // buttons, and the user found the whole lower half of it dead to the
        // gesture.
        let target = /** @type{HTMLElement} */(e.target);
        if(target instanceof Element &&
           target.closest('textarea, .resizer, ' +
                          'input:not([type="checkbox"]):not([type="radio"])'))
            return;
        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
        tracking = true;
    }, {passive: true});

    el.addEventListener('touchmove', function(e) {
        if(!tracking || e.touches.length !== 1)
            return;
        let dx = e.touches[0].clientX - startX;
        let dy = e.touches[0].clientY - startY;
        // Horizontal has to clearly win, or every scroll of the chat log
        // would be read as a half-hearted swipe.
        if(Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5)
            return;
        tracking = false;
        if(Math.sign(dx) === sign)
            close();
    }, {passive: true});

    let stop = function() { tracking = false; };
    el.addEventListener('touchend', stop, {passive: true});
    el.addEventListener('touchcancel', stop, {passive: true});
}

// The chat column lives on the left, so it leaves to the left; the drawer is
// on the right and leaves to the right.  Each swipe pushes the panel the way
// it would go. (Sozvon)
makeSwipeDismissible('left-sidebar', -1, panelVisible, togglePanel);
makeSwipeDismissible('sidebarnav', 1,
                     () => document.body.classList.contains('drawer-open'),
                     closeNav);

/*
 * Sozvon: leave the panel where the user left it when the layout changes.
 *
 * `active` means "collapsed" on the desktop layout and "open" on the mobile
 * overlay — one class, opposite meanings (see panelVisible()) — so crossing
 * 1024px silently reverses it: a panel the user had closed sprang open by
 * itself the moment the window was narrowed past the breakpoint, and closed
 * itself again on the way back.  Toggling at the crossing restates the same
 * visible panel in the new layout's vocabulary, which leaves the screen as it
 * was.  (togglePanel() is exactly the right operation: it flips both the class
 * and #mainrow's width class, and re-fits the grid.)
 */
{
    let q = window.matchMedia('only screen and (max-width: 1024px)');
    let onLayoutChange = function() { togglePanel(); };
    if(q.addEventListener)
        q.addEventListener('change', onLayoutChange);
    else if(q.addListener)
        q.addListener(onLayoutChange);   // Safari < 14
}

// Sozvon: the ✕ in the panel header closes it. Needed now that the toggle lives in
// the bottom dock (which fades when the panel is open on mobile), so there is
// always a visible way out of the people + chat panel.
{
    let pc = document.getElementById('panel-close');
    if(pc)
        pc.onclick = function() {
            if(panelVisible())   // open->closed on either layout (see panelVisible)
                togglePanel();
        };
}

/**
 * Drag handle between the participant list and the chat: adjusts how the two
 * halves of the panel split the available height.
 *
 * @param {MouseEvent} e
 */
function panelResizer(e) {
    e.preventDefault();
    let users = document.getElementById('users');
    let chat = document.getElementById('chat');
    let startY = e.clientY;
    let startH = users.getBoundingClientRect().height;
    let total = startH + chat.getBoundingClientRect().height;
    function onMove(ev) {
        let h = startH + (ev.clientY - startY);
        // keep a sensible minimum for each half
        h = Math.max(80, Math.min(h, total - 120));
        // The default max-height caps the list at 45% of the panel; a drag is
        // an explicit choice, so let it out of that cap.
        users.style.maxHeight = 'none';
        users.style.flex = '0 0 ' + h + 'px';
        chat.style.flex = '1 1 0';
    }
    function onUp() {
        document.documentElement.removeEventListener('mousemove', onMove, false);
        document.documentElement.removeEventListener('mouseup', onUp, false);
    }
    document.documentElement.addEventListener('mousemove', onMove, false);
    document.documentElement.addEventListener('mouseup', onUp, false);
}

document.getElementById('panel-resizer').addEventListener('mousedown', panelResizer, false);

document.getElementById('openside').onclick = function(e) {
      e.preventDefault();
      if (document.body.classList.contains('drawer-open')) {
          closeNav();
          return;
      } else {
          openNav();
      }
};


document.getElementById('clodeside').onclick = function(e) {
    e.preventDefault();
    closeNav();
};

document.getElementById('collapse-video').onclick = function(e) {
    e.preventDefault();
    setVisibility('collapse-video', false);
    setVisibility('show-video', true);
    hideVideo(true);
};

document.getElementById('show-video').onclick = function(e) {
    e.preventDefault();
    setVisibility('video-container', true);
    setVisibility('collapse-video', true);
    setVisibility('show-video', false);
    scheduleChromeHide();   // video back on screen: re-arm auto-immersive (Sozvon)
};

/** Whether the people+chat panel was open when we last went immersive, so it
 *  can be restored when the chrome comes back. */
let chromePanelWasOpen = false;

/**
 * Sozvon — auto-immersive.  During a call the chrome (top bar + bottom control
 * dock) slides away on its own after a few seconds of inactivity, and any
 * activity — a pointer move on the desktop, a tap on mobile, a key or a scroll —
 * brings it straight back and restarts the countdown.  This mirrors how a video
 * player auto-hides its controls.  CHROME_IDLE_MS is the inactivity delay;
 * chromeIdleTimer holds the pending hide, or null when none is armed.
 */
const CHROME_IDLE_MS = 3000;
let chromeIdleTimer = null;

/**
 * Sozvon — immersive video.  A tap (mobile) or click (desktop) on the central
 * video area slides the whole chrome away — the top bar AND the people+chat
 * panel — so the picture fills the screen; the next tap/click restores it to
 * exactly how it was, reopening the panel only if it had been open.  Buttons
 * and the on-video controls keep working — only background / video taps toggle
 * the chrome.
 *
 * @param {boolean} [force] - force the chrome hidden (true) or shown (false)
 */
function toggleChrome(force) {
    let wasHidden = document.body.classList.contains('nav-hidden');
    let hidden = (force === undefined) ? !wasHidden : !!force;
    document.body.classList.toggle('nav-hidden', hidden);
    if(hidden && !wasHidden) {
        // Going immersive: remember whether the panel was open, then close it
        // so it isn't stranded behind the hidden bar (its toggle slides away).
        chromePanelWasOpen = panelVisible();
        if(chromePanelWasOpen)
            togglePanel();
    } else if(!hidden && wasHidden) {
        // Leaving immersive: restore the panel to how it was before.
        if(chromePanelWasOpen && !panelVisible())
            togglePanel();
    }
    // The video pane changed height; re-fit the grid now and once the slide
    // animation has settled.
    resizePeers();
    setTimeout(resizePeers, 280);
    // Auto-immersive bookkeeping: while the chrome is up during a call, arm the
    // inactivity countdown; once it is down, cancel any pending hide.
    if(document.body.classList.contains('nav-hidden'))
        cancelChromeHide();
    else
        scheduleChromeHide();
}

/**
 * Whether it is currently sensible to auto-hide the chrome: a call is on
 * screen, we are not on the login / waiting-room screen, the people+chat panel
 * is closed (don't yank an open panel out from under the user) and the user is
 * not typing.
 *
 * @returns {boolean}
 */
function autoImmersiveEligible() {
    if(document.body.classList.contains('pre-join'))
        return false;
    if(!getVisibility('video-container'))
        return false;
    if(panelVisible())
        return false;
    let ae = /** @type{HTMLElement} */(document.activeElement);
    if(ae && ae.closest('input, textarea, select'))
        return false;
    return true;
}

/** Cancel any pending auto-hide of the chrome. */
function cancelChromeHide() {
    if(chromeIdleTimer) {
        clearTimeout(chromeIdleTimer);
        chromeIdleTimer = null;
    }
}

/**
 * (Re)arm the inactivity countdown that slides the chrome away, but only while
 * auto-immersive is currently appropriate.
 */
function scheduleChromeHide() {
    cancelChromeHide();
    if(!autoImmersiveEligible())
        return;
    chromeIdleTimer = setTimeout(function() {
        chromeIdleTimer = null;
        // Re-check: the state may have changed while we waited.
        if(autoImmersiveEligible() &&
           !document.body.classList.contains('nav-hidden'))
            toggleChrome(true);
    }, CHROME_IDLE_MS);
}

/**
 * Activity that should reveal the chrome (a desktop pointer move or a key) and
 * keep it up: show it if it had slid away, otherwise just restart the
 * countdown.
 */
function revealChrome() {
    if(document.body.classList.contains('pre-join'))
        return;
    if(document.body.classList.contains('nav-hidden'))
        toggleChrome(false);   // toggleChrome() re-arms the hide timer itself
    else
        scheduleChromeHide();
}

/**
 * Lighter activity that should keep the chrome up but never summon it: a tap or
 * a scroll while the chrome is already shown (e.g. reaching for the dock) just
 * defers the auto-hide.  A tap meant to *reveal* the chrome goes through the
 * #right click handler instead, so we must not also reveal it here — otherwise
 * a single mobile tap would flash the bar in and immediately hide it again.
 */
function keepChrome() {
    if(!document.body.classList.contains('nav-hidden'))
        scheduleChromeHide();
}

/**
 * Flip between speaker (one remote full-size + self thumbnail) and the even
 * grid. Shared by the #viewtoggle button and the double-tap on the remote
 * video: 3+ with my camera flips grid↔speaker-many; a 1-on-1 flips
 * grid↔speaker. (Sozvon)
 */
function toggleView() {
    let peers = document.getElementById('peers');
    if(peers.classList.contains('speaker') ||
       peers.classList.contains('speaker-many')) {
        updateSetting('viewMode', 'grid');
    } else {
        let up = Object.keys(serverConnection.up).length;
        let down = Object.keys(serverConnection.down).length;
        updateSetting('viewMode', (up >= 1 && down >= 2) ? 'speaker-many' : 'speaker');
    }
    resizePeers();
}

let chromeClickTimer = null;

// Listen on the whole central column (#right), not just the video tiles, so the
// chrome can be toggled from anywhere in the grid area — including when the
// video pane is empty or collapsed, where a #video-container-only handler would
// leave nothing to tap.
document.getElementById('right').addEventListener('click', function(e) {
    if(document.body.classList.contains('pre-join'))
        return;   // login / waiting-room screen: there is no chrome to toggle
    let target = /** @type{HTMLElement} */(e.target);
    // Leave the on-video controls, the floating chat / show-video buttons and
    // any real buttons, links or fields to do their own job.
    if(target.closest(
        '.video-controls, .top-video-controls, .chat-btn, .show-video, ' +
        'button, a, input, select, textarea, .self-controls-pill'))
        return;
    // A tap on the draggable self-thumbnail is for moving it, not for toggling
    // the chrome — in every view where the tile floats, not just the 1-on-1
    // one: speaker-many and the self-only view drag it the same way, and in the
    // self-only view the thumbnail is the only thing on the stage to tap.
    let peers = document.getElementById('peers');
    if((peers.classList.contains('speaker') ||
        peers.classList.contains('speaker-many')) &&
       target.closest('.peer-self'))
        return;
    // A double tap/click on the remote video flips speaker↔grid (Sozvon);
    // a single tap toggles the immersive chrome. Only the remote area has a
    // double action, so wait briefly to tell single from double there, and act
    // instantly everywhere else.
    let onRemote = !!target.closest('.peer-remote') && serverConnection &&
        Object.keys(serverConnection.down).length >= 1;
    if(!onRemote) {
        toggleChrome();
        return;
    }
    if(chromeClickTimer) {
        clearTimeout(chromeClickTimer);
        chromeClickTimer = null;
        toggleView();
        return;
    }
    chromeClickTimer = setTimeout(function() {
        chromeClickTimer = null;
        toggleChrome();
    }, 250);
});

// Sozvon — auto-immersive activity hooks.  A desktop pointer move or a key reveals
// the chrome and keeps it up; a tap or a scroll only defers the auto-hide (the
// tap itself reveals via the #right click handler above).
//
// Touch devices synthesise a mousemove (and a mouse* burst) right after every
// tap.  Left unguarded, that synthetic mousemove would revealChrome() and then
// the tap's own click would toggle the chrome straight back off — flashing it
// for under a second on mobile.  So we stamp the time of the last touch and let
// mousemove ignore anything landing within a short window of it; a real mouse
// never moves that close to a touch.  mousemove is also throttled so a flood of
// events doesn't re-arm the timer dozens of times a second.
let lastChromeReveal = 0;
let lastChromeTouch = 0;
function noteChromeTouch() {
    lastChromeTouch = Date.now();
    keepChrome();
}
document.addEventListener('mousemove', function() {
    let now = Date.now();
    if(now - lastChromeTouch < 800)
        return;   // synthetic mousemove from a tap, not a real mouse move
    if(now - lastChromeReveal < 200)
        return;
    lastChromeReveal = now;
    revealChrome();
}, {passive: true});
document.addEventListener('keydown', revealChrome, {passive: true});
document.addEventListener('touchstart', noteChromeTouch, {passive: true});
document.addEventListener('touchend', noteChromeTouch, {passive: true});
document.addEventListener('scroll', keepChrome, {passive: true, capture: true});

document.getElementById('viewtoggle').onclick = function(e) {
    e.preventDefault();
    toggleView();
};

/**
 * Sozvon: whether this browser can put the page itself into fullscreen.  iOS
 * Safari only ever offers fullscreen for a <video> element, so there the
 * button is not shown at all rather than shown and doing nothing.
 *
 * @returns {boolean}
 */
function canFullscreen() {
    return !!(document.fullscreenEnabled &&
              document.documentElement.requestFullscreen);
}

/**
 * Whether the page -- rather than a single video tile, which the browser can
 * also do on its own -- is currently filling the screen.
 *
 * @returns {boolean}
 */
function pageFullscreen() {
    return document.fullscreenElement === document.documentElement;
}

/**
 * The dock button behind what F11 does, for everyone who is in a call rather
 * than at a keyboard with a function row.  (Sozvon)
 */
async function toggleFullscreen() {
    try {
        if(document.fullscreenElement)
            await document.exitFullscreen();
        else
            await document.documentElement.requestFullscreen();
    } catch(e) {
        // A refused request is not worth a toast: the browser has already
        // said so in its own words, and F11 is still there.
        console.warn("Couldn't toggle fullscreen:", e);
    }
}

/**
 * Show the button where fullscreen is possible at all, and make its icon and
 * tooltip describe what a click will do, the way the view toggle does.
 */
function reflectFullscreenButton() {
    let btn = document.getElementById('fullscreenbutton');
    if(!btn)
        return;
    setVisibility('fullscreenbutton', canFullscreen());
    let full = pageFullscreen();
    let icon = btn.querySelector('i');
    if(icon)
        icon.classList.toggle('icon-fullscreen-exit', full);
    let key = full ? 'nav.exitFullscreen' : 'nav.fullscreen';
    btn.setAttribute('data-i18n-title', key);
    let label = btn.querySelector('label');
    if(label)
        label.setAttribute('data-i18n', key);
    let text = Sozvon.i18n.t(key);
    btn.title = text;
    if(label)
        label.textContent = text;
}

document.getElementById('fullscreenbutton').onclick = function(e) {
    e.preventDefault();
    toggleFullscreen();
};

document.addEventListener('fullscreenchange', function() {
    reflectFullscreenButton();
    // Entering and leaving fullscreen changes the stage size; browsers do fire
    // a resize for it, but the tile grid is cheap to re-fit and a missed one
    // leaves the video cropped.
    resizePeers();
});

// Sozvon: the call clock, a per-tab display preference like the rest of the
// drawer.  Writing the setting is what pins it: until the first click the
// readout follows the role (see callTimerEnabled).
getInputElement('calltimerbox').onchange = function(e) {
    if(!(this instanceof HTMLInputElement))
        throw new Error('Unexpected type for this');
    updateSettings({showCallTimer: this.checked});
    reflectCallTimer();
};

async function serverConnect() {
    if(serverConnection && serverConnection.socket)
        serverConnection.close();
    serverConnection = new ServerConnection();
    serverConnection.onconnected = gotConnected;
    serverConnection.onerror = function(e) {
        console.error(e);
        // While reconnecting, the banner conveys the state; don't spam toasts
        // for each failed attempt. (Sozvon)
        if(!reconnecting)
            displayError(e);
    };
    serverConnection.onpeerconnection = onPeerConnection;
    serverConnection.onclose = gotClose;
    serverConnection.ondownstream = gotDownStream;
    serverConnection.onuser = gotUser;
    serverConnection.onknock = gotKnock;
    serverConnection.onjoined = gotJoined;
    serverConnection.onchat = addToChatbox;
    serverConnection.onusermessage = gotUserMessage;
    serverConnection.onfiletransfer = gotFileTransfer;
    if(typeof SozvonE2EE !== 'undefined') {
        serverConnection.e2ee = new SozvonE2EE(serverConnection);
        serverConnection.e2ee.onsas = gotE2EESas;
        serverConnection.e2ee.onstate = gotE2EEState;
    }

    let url = groupStatus.endpoint;
    if(!url) {
        console.warn("no endpoint in status");
        url = `ws${location.protocol === 'https:' ? 's' : ''}://${location.host}/ws`;
    }

    try {
        await serverConnection.connect(url);
    } catch(e) {
        console.error(e);
        if(reconnecting)
            // a failed reconnect attempt: keep retrying quietly, no toast
            scheduleReconnect();
        else
            displayError(e.message ? e.message : Sozvon.i18n.t('toast.cantConnect', {url: url}));
    }
}

/**
 * App-level settings — change the server and reset the saved login — shown only
 * inside the Sozvon Android app, which exposes a window.SozvonApp bridge.  In a
 * normal browser there is no app to configure, so the section stays hidden.
 */
function setupAppSettings() {
    let bridge = /** @type {any} */(window).SozvonApp;
    if(!bridge)
        return;
    setVisibility('app-settings', true);
    let cs = document.getElementById('app-change-server');
    if(cs) {
        if(typeof bridge.changeServer === 'function') {
            cs.onclick = function(e) {
                e.preventDefault();
                bridge.changeServer();
            };
        } else {
            // older app without the bridge method: nothing to call
            cs.classList.add('invisible');
        }
    }
    let rl = document.getElementById('app-reset-login');
    if(rl) {
        rl.onclick = function(e) {
            e.preventDefault();
            // Drop the web-side remember-token at once, then ask the app to
            // wipe its storage and cookies and reload so login is re-prompted.
            try {
                window.localStorage.removeItem('sozvon.remember');
            } catch(err) { /* ignore */ }
            if(typeof bridge.resetLogin === 'function')
                bridge.resetLogin();
            else
                window.location.reload();
        };
    }
}

/**
 * Tell the host app which appearance the user chose, so its own chrome — the
 * status bar and server list on Android, the window and launcher on the
 * desktop — matches the page inside it instead of staying dark behind a light
 * client.
 *
 * The *preference* is reported, not the theme it resolves to: "system" is a
 * standing instruction, and both hosts have their own way of following the
 * system (DayNight, nativeTheme) that keeps working when the page is not on
 * screen.  Older apps have no setTheme, hence the check.
 */
function reportThemeToApp() {
    let bridge = /** @type {any} */(window).SozvonApp;
    let theme = /** @type {any} */(window).Sozvon && window.Sozvon.theme;
    if(!bridge || !theme || typeof bridge.setTheme !== 'function')
        return;
    let last = null;
    let send = () => {
        // Only when the *preference* changes.  The listener also fires when
        // the theme in force changes, and inside a desktop app that happens
        // for a reason the host already knows about: setting its own
        // appearance is what moves prefers-color-scheme here, so a page whose
        // preference is "system" re-resolves and would report "system" back —
        // undoing the choice the host had just made, whereupon the host's
        // undoing moves the media query again.  That is the flicker: two
        // stores talking past each other, one of them echoing.
        if(theme.pref === last)
            return;
        last = theme.pref;
        try {
            bridge.setTheme(last);
        } catch(e) {
            console.error(e);
        }
    };
    theme.onChange(send);
    send();
}

/**
 * Show the "Download the Android app" link on the login card if this
 * deployment serves an APK (data/sozvon.apk on the server, see webserver).
 * Hidden inside the Android app itself, which appends an SozvonApp marker
 * to its user agent.
 */
async function probeAPK() {
    if(navigator.userAgent.indexOf('SozvonApp') >= 0)
        return;
    try {
        let r = await fetch('/sozvon.apk', {method: 'HEAD'});
        if(!r.ok)
            return;
    } catch(e) {
        return;   // no APK on this server: keep the link hidden
    }
    let link = document.getElementById('apk-link');
    if(link && /android/i.test(navigator.userAgent)) {
        // On Android, prefer opening an installed app over downloading. This
        // intent URL launches the app (it registers the sozvon:// scheme) and,
        // when it isn't installed, the browser follows browser_fallback_url to
        // the APK — so one control means "open in app, or download if you don't
        // have it". (Sozvon)
        let here = location.origin + location.pathname;
        let apk = location.origin + '/sozvon.apk';
        link.setAttribute('href',
            'intent://open?u=' + encodeURIComponent(here) +
            '#Intent;scheme=sozvon;package=org.sozvon.app;' +
            'S.browser_fallback_url=' + encodeURIComponent(apk) + ';end');
        let icon = link.querySelector('i');
        if(icon) {
            icon.classList.remove('fa-mobile-alt');
            icon.classList.add('fa-external-link-alt');
        }
        let span = link.querySelector('span');
        if(span) {
            span.setAttribute('data-i18n', 'login.openInApp');
            span.textContent = Sozvon.i18n.t('login.openInApp');
        }
    }
    setVisibility('apk-link', true);
}

async function start() {
    probeAPK();
    setupAppSettings();
    reportThemeToApp();
    try {
        let r = await fetch(".status")
        if(!r.ok)
            throw new Error(`${r.status} ${r.statusText}`);
        groupStatus = await r.json()
    } catch(e) {
        console.error(e);
        displayWarning(Sozvon.i18n.t('toast.fetchStatus', {error: e}));
        groupStatus = {};
    }

    if(groupStatus.name) {
        group = groupStatus.name;
    } else {
        console.warn("no group name in status");
        group = decodeURIComponent(
            location.pathname.replace(/^\/[a-z]*\//, '').replace(/\/$/, ''),
        );
    }

    // Disable simulcast on Firefox by default, it's buggy.
    if(isFirefox())
        getSelectElement('simulcastselect').value = 'off';

    let parms = new URLSearchParams(window.location.search);
    if(window.location.search)
        window.history.replaceState(null, '', window.location.pathname);
    setTitle(groupStatus.displayName || capitalise(group));

    addFilters();
    await setMediaChoices(false);
    reflectSettings();
    reflectCallTimerBox();
    reflectFullscreenButton();

    if(parms.has('token')) {
        token = parms.get('token');
        // Stash the invite token so a reload re-knocks instead of dropping to
        // the login card (the query string was cleared from the URL above).
        try {
            window.sessionStorage.setItem('sozvon.pendingToken:' + group, token);
        } catch(e) { /* ignore */ }
    }

    // An operator's session token (covers this hub and its child rooms)
    // auto-authenticates navigation between the hub dashboard and the rooms.
    // It reuses the ordinary token-join flow, so a dead one falls back to the
    // login form.
    if(!token) {
        let session = loadOperatorSession(group);
        if(session)
            token = session.token;
    }

    // Auto-login from a remembered device (operator only; revocable token).
    // Reuses the same flow as an invite link; a dead token falls back to the
    // login form (see gotJoined 'fail').
    if(!token) {
        let remembered = loadRememberToken(group);
        if(remembered) {
            token = remembered.token;
            usingRememberToken = true;
            let uElt = document.getElementById('username');
            if(uElt instanceof HTMLInputElement)
                uElt.value = remembered.username || '';
        }
    }

    // A pending invite token stashed on an earlier visit (e.g. before a
    // reload), so a waiting client re-knocks without the ?token= query.
    if(!token) {
        try {
            let p = window.sessionStorage.getItem('sozvon.pendingToken:' + group);
            if(p)
                token = p;
        } catch(e) { /* ignore */ }
    }

    // If we just navigated here from the operator dashboard's "Join" button,
    // that click is the gesture that lets this page autoplay -- skip the
    // token probe-then-reshow dance (join()) and join straight into the call
    // with the camera/mic the operator chose on the dashboard, instead of a
    // second device-check screen here (see operatorJoin).
    if(token) {
        try {
            let p = window.sessionStorage.getItem('sozvon.operatorJoinPresent');
            if(p !== null) {
                window.sessionStorage.removeItem('sozvon.operatorJoinPresent');
                skipAutoplayProbe = true;
                presentRequested = p || null;
            }
        } catch(e) { /* ignore */ }
    }

    // Entered from the dashboard's "Admit & join": admit the knock(s) pushed
    // to us right after we join, so the waiting client comes straight in.
    if(token) {
        try {
            if(window.sessionStorage.getItem('sozvon.operatorAdmitOnJoin')) {
                window.sessionStorage.removeItem('sozvon.operatorAdmitOnJoin');
                admitOnJoinUntil = Date.now() + 5000;
            }
        } catch(e) { /* ignore */ }
    }

    if(token) {
        await serverConnect();
    } else if(groupStatus.authPortal) {
        window.location.href = groupStatus.authPortal;
    } else {
        if(groupStatus.lobby) {
            // guests only need a name; hide the password field, but let
            // an operator reveal it on demand. "Remember me" is operator-only,
            // so it stays hidden until the password is revealed. (Sozvon)
            setVisibility('passwordform', false);
            setVisibility('rememberform', false);
            setVisibility('operator-login', true);
            setVisibility('lobby-note', true);
        }
        setVisibility('login-container', true);
        document.getElementById('username').focus()
    }
    setViewportHeight();
}

start();
