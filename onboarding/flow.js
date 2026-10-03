// The onboarding's decisions, with nothing on screen: what an address someone
// pasted actually points at, which step comes next, and what the progress bar
// says about it.  Kept apart from app.js so that Node's own test runner can
// reach every one of them without a window (see onboarding/test/).
//
// Shared by the Android and the desktop app: both show this directory as
// their first-run screen.  It is copied into each at build time, never edited
// there -- see onboarding/README.md.
//
// Sozvon is a fork of Galène (MIT); see LICENCE.

(function (root, factory) {
  if (typeof module === 'object' && module.exports)
    module.exports = factory();
  else
    root.SozvonFlow = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * The first https address in a piece of text.  People paste whole messages
   * ("Join the call: https://..."), not bare links, and the app should not
   * make them trim one by hand.
   *
   * @param {string} text
   * @returns {string|null}
   */
  function findAddress(text) {
    const s = String(text || '');
    const m = s.match(/https?:\/\/[^\s<>"'«»]+/i);
    if (m) return m[0].replace(/[.,;:!?)\]]+$/, '');
    // A bare host ("meet.example.com", "203.0.113.7:8443/group/x/"): no
    // scheme, but a dot in the host (or localhost) and nothing else on the
    // line.  A VPS owner is as likely to type the IP as a name.
    const t = s.trim();
    if (/^(localhost|[a-z0-9-]+(\.[a-z0-9-]+)+)(:\d+)?(\/\S*)?$/i.test(t))
      return 'https://' + t;
    return null;
  }

  /**
   * What a pasted invitation points at.
   *
   * The forms a Sozvon server hands out:
   *   https://host/group/<room>/            an ordinary room
   *   https://host/group/<room>/?token=...  a room with an invitation token
   *   https://host/<slug>/?token=...        a personal link from an operator
   *   https://host/                         the server itself (an operator hub)
   * A name the inviter put after '#' travels with the link untouched.
   *
   * @param {string} text
   * @returns {{ok: true, url: string, origin: string, host: string,
   *            kind: 'room'|'link'|'server', room: string|null}
   *          |{ok: false, error: 'empty'|'not-url'|'not-https'}}
   */
  function parseInvite(text) {
    if (!String(text || '').trim()) return { ok: false, error: 'empty' };
    const found = findAddress(text);
    if (!found) return { ok: false, error: 'not-url' };
    let u;
    try {
      u = new URL(found);
    } catch {
      return { ok: false, error: 'not-url' };
    }
    if (!u.hostname) return { ok: false, error: 'not-url' };
    // A call needs camera and microphone, and browsers grant those to secure
    // pages only.  An http address would load and then fail at the one
    // moment that matters, so it is turned away here, where the reason can
    // still be said.
    if (u.protocol !== 'https:') return { ok: false, error: 'not-https' };

    const segs = u.pathname.split('/').filter(Boolean);
    let kind = 'server';
    let room = null;
    if (segs[0] === 'group' && segs.length > 1) {
      kind = 'room';
      room = segs.slice(1).map(safeDecode).join('/');
    } else if (segs.length === 1 && u.searchParams.has('token')) {
      kind = 'link';
      room = safeDecode(segs[0]);
    } else if (segs.length > 0) {
      // Some other page of the server: open it as given and let the server
      // decide what it is.
      kind = 'room';
      room = segs.map(safeDecode).join('/');
    }
    return { ok: true, url: u.href, origin: u.origin, host: u.host, kind, room };
  }

  function safeDecode(s) {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  }

  /**
   * A server address typed by somebody who has one: a bare host, or any page
   * of it.  Only the origin is kept -- the room is asked for on its own step
   * -- but a room found in the address is offered as that step's answer.
   *
   * @param {string} text
   * @returns {{ok: true, origin: string, host: string, room: string|null}
   *          |{ok: false, error: 'empty'|'not-url'|'not-https'}}
   */
  function parseServer(text) {
    const r = parseInvite(text);
    if (!r.ok) return r;
    return {
      ok: true,
      origin: r.origin,
      host: r.host,
      room: r.kind === 'room' ? r.room : null,
    };
  }

  /**
   * The address of a room on a server, the way the web client builds it.
   *
   * @param {string} origin
   * @param {string} room   empty for the server itself
   */
  function roomUrl(origin, room) {
    const base = String(origin).replace(/\/+$/, '');
    const r = String(room || '').trim().replace(/^\/+|\/+$/g, '');
    if (!r) return base + '/';
    return base + '/group/' + r.split('/').map(encodeURIComponent).join('/') + '/';
  }

  /**
   * The origin of a server the deploy wizard just installed.  The installer
   * reports it; older installers did not, and then it is recovered from the
   * room address -- never rebuilt from the bare hostname, which would drop a
   * non-standard port and knock on whatever else lives on 443.
   *
   * @param {{origin?: string, url?: string, hostname?: string}} result
   */
  function deployOrigin(result) {
    if (result.origin) return String(result.origin).replace(/\/+$/, '');
    const u = String(result.url || '');
    if (u.startsWith('https://')) return u.split('/group/')[0].replace(/\/+$/, '');
    return 'https://' + result.hostname;
  }

  const SLUG_CHARS = 'abcdefghijkmnpqrstuvwxyz23456789';

  /**
   * A name for a new client room under an operator hub.  Random on purpose:
   * with end-to-end encryption on, the server must not learn from the room
   * name who the link is for -- the same rule the dashboard follows.
   *
   * @param {(n: number) => Uint8Array} [randomBytes]
   */
  function randomSlug(randomBytes) {
    const bytes = (randomBytes || defaultRandom)(10);
    let s = '';
    for (let i = 0; i < bytes.length; i++)
      s += SLUG_CHARS[bytes[i] % SLUG_CHARS.length];
    return s;
  }

  function defaultRandom(n) {
    const a = new Uint8Array(n);
    (globalThis.crypto || require('node:crypto').webcrypto).getRandomValues(a);
    return a;
  }

  /**
   * The personal link a guest opens: the short /<slug>/ form the dashboard
   * hands out, which hides the hub's name from the guest.
   */
  function inviteUrl(origin, slug, token) {
    return String(origin).replace(/\/+$/, '') + '/' + encodeURIComponent(slug) +
      '/?token=' + encodeURIComponent(token);
  }

  // ------------------------------------------------------------- steps ---

  /**
   * The three ways through, by what the person already has.  Each is the
   * list of steps the progress bar counts; side trips (the VPS guide) are
   * not on it, since they are help, not progress.
   */
  const PATHS = {
    invite: ['choose', 'invite', 'media', 'ready'],
    server: ['choose', 'server', 'role', 'media', 'ready'],
    own: ['choose', 'need', 'deploy', 'done'],
  };

  /** The VPS guide, a side trip from 'need'. */
  const GUIDE = ['guide-find', 'guide-signup', 'guide-order', 'guide-panel',
    'guide-copy', 'guide-paste'];

  /**
   * Where a step sits on the bar, as [filled, total].  0 filled before a path
   * is chosen.
   *
   * @param {string|null} path
   * @param {string} step
   * @param {{skipMedia?: boolean}} [opts]
   */
  function progress(path, step, opts) {
    if (!path || !PATHS[path]) return [0, 4];
    const steps = visibleSteps(path, opts);
    if (GUIDE.includes(step)) step = 'need';
    const i = steps.indexOf(step);
    return [i < 0 ? 0 : i + 1, steps.length];
  }

  /**
   * A path's steps as this person will meet them.  The permission step goes
   * when there is nothing to ask: already granted on Android, and on Windows
   * whenever the system has not blocked the devices outright, since there no
   * dialog exists for it to prepare anyone for.
   */
  function visibleSteps(path, opts) {
    const steps = PATHS[path] || [];
    if (opts && opts.skipMedia) return steps.filter(s => s !== 'media');
    return steps.slice();
  }

  /**
   * The step after this one on a path.
   *
   * @returns {string|null}  null at the end
   */
  function nextStep(path, step, opts) {
    const gi = GUIDE.indexOf(step);
    if (gi >= 0) return gi + 1 < GUIDE.length ? GUIDE[gi + 1] : 'need';
    const steps = visibleSteps(path, opts);
    const i = steps.indexOf(step);
    return i >= 0 && i + 1 < steps.length ? steps[i + 1] : null;
  }

  /**
   * Whether the onboarding should greet this person at all.  It is for
   * somebody who has never connected anywhere: an existing user upgrading the
   * app must not be walked through it, nor anybody arriving by a link that
   * already says where to go.
   *
   * @param {{done?: boolean, servers?: number, deepLink?: boolean,
   *          changeServer?: boolean}} s
   */
  function shouldShow(s) {
    return !s.done && !(s.servers > 0) && !s.deepLink && !s.changeServer;
  }

  return {
    findAddress, parseInvite, parseServer, roomUrl, deployOrigin,
    randomSlug, inviteUrl, PATHS, GUIDE, progress, visibleSteps, nextStep,
    shouldShow,
  };
});
