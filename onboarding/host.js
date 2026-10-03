// The one thing app.js talks to: the app around the page.  Two apps show the
// onboarding, and each reaches it differently; this file is where the
// difference ends.
//
//   * Android hands the page an object, window.SozvonOnboarding, through
//     addJavascriptInterface.  Its methods are synchronous and take strings
//     only, so every request goes out as call(id, method, json) and the
//     answer comes back later as a script the activity evaluates:
//     SozvonHost._resolve(id, json).  The activity also asks the page what
//     the system Back button should do (SozvonHost.back()).
//   * The desktop app's preload exposes window.sozvonOnboarding, which already
//     returns promises over Electron's IPC.
//   * Neither: the page was opened on its own in a browser, to look at it.
//     A stand-in answers with made-up but plausible results, so every screen
//     can be reached and judged without a phone or a server.  It never runs
//     inside either app.
//
// Every method resolves; failures are part of the answer, never a rejection,
// so a screen cannot be left hanging on an exception nobody caught.
//
// Sozvon is a fork of Galène (MIT); see LICENCE.

(function () {
  'use strict';

  const android = window.SozvonOnboarding;
  const desktop = window.sozvonOnboarding;

  let nextId = 1;
  const pending = new Map();

  /** @type {null | (() => boolean)} */
  let backHandler = null;

  const SozvonHost = {
    /** 'android', 'desktop' or 'preview'. */
    platform: android ? 'android' : desktop ? 'desktop' : 'preview',

    /**
     * What the app knows that the page cannot: its language, its theme, and
     * whether the page is coming back from the deploy wizard (desktop, which
     * shows the wizard in place of this page).  Android answers through its
     * object; the desktop app puts it in the query when it loads the page.
     *
     * @returns {{lang?: string, theme?: string|null, resume?: string|null}}
     */
    env() {
      try {
        if (android) return JSON.parse(android.env());
      } catch (e) {
        console.error('onboarding env:', e);
      }
      const q = new URLSearchParams(location.search);
      return {
        lang: q.get('lang') || navigator.language,
        theme: q.get('theme') || null,
        resume: q.get('resume') || null,
      };
    },

    /**
     * @param {string} method
     * @param {object} [args]
     * @returns {Promise<any>}
     */
    call(method, args) {
      const a = args || {};
      if (android) {
        return new Promise((resolve) => {
          const id = nextId++;
          pending.set(id, resolve);
          try {
            android.call(id, method, JSON.stringify(a));
          } catch (e) {
            pending.delete(id);
            resolve({ error: String(e) });
          }
        });
      }
      if (desktop) {
        return desktop.call(method, a).catch(e => ({ error: String(e) }));
      }
      return preview(method, a);
    },

    /** Android: the answer to call(id, ...). */
    _resolve(id, json) {
      const resolve = pending.get(id);
      if (!resolve) return;
      pending.delete(id);
      let v;
      try {
        v = JSON.parse(json);
      } catch {
        v = { error: 'bad reply' };
      }
      resolve(v);
    },

    /** Set by app.js: what Back means on the current screen. */
    onBack(fn) {
      backHandler = fn;
    },

    /**
     * Android: the system Back button.  Returns true when the page handled
     * it (went a step back), false when the activity should close.
     */
    back() {
      return backHandler ? !!backHandler() : false;
    },
  };

  // ----------------------------------------------------------- preview ---

  const wait = (ms) => new Promise(r => setTimeout(r, ms));

  async function preview(method, a) {
    switch (method) {
      case 'checkServer': {
        await wait(700);
        const host = String(a.url || '');
        if (/unreachable|down/.test(host)) return { status: 'unreachable' };
        if (/self-signed|selfsigned/.test(host)) return { status: 'cert' };
        if (/galene/.test(host)) return { status: 'other' };
        return { status: 'ok' };
      }
      case 'media':
        return { state: 'prompt' };
      case 'requestMedia':
        await wait(500);
        return { camera: true, mic: true };
      case 'paste':
        return { text: 'Заходи: https://meet.example.com/k7m2qx/?token=Hn3' };
      case 'deploy':
        await wait(1200);
        return {
          result: {
            url: 'https://203-0-113-7.sslip.io/',
            origin: 'https://203-0-113-7.sslip.io',
            hostname: '203-0-113-7.sslip.io',
            group: 'meet',
            hub: true,
            admin_user: 'operator',
            admin_password: 'demo-only',
            tls_mode: 'letsencrypt-sslip',
          },
        };
      case 'mint':
        await wait(1400);
        return {
          ok: true,
          url: a.origin.replace(/\/+$/, '') + '/' + a.slug + '/?token=Qm9vb2sx',
        };
      case 'copy':
        try {
          await navigator.clipboard.writeText(a.text);
        } catch { /* a preview may not have the permission */ }
        return { ok: true };
      default:
        console.log('preview host:', method, a);
        return { ok: true };
    }
  }

  window.SozvonHost = SozvonHost;
})();
