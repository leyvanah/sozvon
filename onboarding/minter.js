// Mints the first guest link on a server the deploy wizard just installed, so
// the last screen of the onboarding can hand it over instead of sending the
// owner off to find the dashboard.
//
// This file is NOT loaded by the onboarding page.  The app injects it into a
// hidden page it has opened at the server's own origin (its /healthz), then
// calls sozvonMint() there.  The origin is the whole point: the server accepts
// a websocket only from a page of its own (webserver.CheckOrigin), and our
// onboarding page lives on the device.  The hidden page also goes through the
// same certificate check as everything else the app opens, pins included.
//
// What it does is what the operator dashboard does when "Create link" is
// pressed (createOperatorLink in static/galene.js): join the hub as the
// operator, ask for a token on a fresh child room <hub>/<slug>, and read the
// token back.  The server marks a token on a direct child of a hub as a
// client link (rtpconn: isOperatorHub/isDirectChild), and lets it never
// expire.  Nothing here is kept: the password is used for this one join and
// the socket is closed as soon as the answer is in.
//
// Sozvon is a fork of Galène (MIT); see LICENCE.

/* exported sozvonMint */

/**
 * @param {{group: string, username: string, password: string,
 *          slug: string, timeoutMs?: number}} p
 * @returns {Promise<{ok: true, url: string, token: string}
 *                  |{ok: false, error: string}>}
 */
function sozvonMint(p) {
  const done = (r) => {
    // Android cannot await a promise through evaluateJavascript; it polls
    // for this instead.
    window.__sozvonMint = r;
    return r;
  };
  window.__sozvonMint = null;

  return new Promise((resolve) => {
    let ws;
    let finished = false;
    const id = Array.from(crypto.getRandomValues(new Uint8Array(16)),
      b => b.toString(16).padStart(2, '0')).join('');
    const finish = (r) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* already gone */ }
      resolve(done(r));
    };
    const timer = setTimeout(() => finish({ ok: false, error: 'timeout' }),
      p.timeoutMs || 20000);
    const send = (m) => ws.send(JSON.stringify(m));

    try {
      ws = new WebSocket((location.protocol === 'https:' ? 'wss:' : 'ws:') +
        '//' + location.host + '/ws');
    } catch (e) {
      finish({ ok: false, error: 'socket: ' + e });
      return;
    }
    ws.onerror = () => finish({ ok: false, error: 'socket' });
    ws.onclose = () => finish({ ok: false, error: 'closed' });
    ws.onopen = () => send({ type: 'handshake', version: ['2'], id });
    ws.onmessage = (e) => {
      let m;
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      switch (m.type) {
        case 'handshake':
          send({
            type: 'join', kind: 'join', group: p.group,
            username: p.username, password: p.password,
          });
          break;
        case 'ping':
          send({ type: 'pong' });
          break;
        case 'joined':
          if (m.kind === 'fail') {
            finish({ ok: false, error: 'join: ' + (m.value || 'refused') });
          } else if (m.kind === 'join') {
            if (!(m.permissions || []).includes('token')) {
              finish({ ok: false, error: 'no token permission' });
              return;
            }
            send({
              type: 'groupaction', source: id, kind: 'maketoken',
              username: p.username,
              value: {
                group: p.group + '/' + p.slug,
                expires: null,
                permissions: ['present', 'message'],
              },
            });
          }
          break;
        case 'usermessage':
          if (m.kind !== 'token' || !m.privileged) break;
          if (m.error || !m.value || typeof m.value.token !== 'string') {
            finish({ ok: false, error: 'token: ' + (m.value || m.error) });
            return;
          }
          finish({
            ok: true,
            token: m.value.token,
            url: location.origin + '/' + encodeURIComponent(p.slug) +
              '/?token=' + encodeURIComponent(m.value.token),
          });
          break;
      }
    };
  });
}

if (typeof module === 'object' && module.exports)
  module.exports = { sozvonMint };
