// The onboarding's screens: welcome, the three ways in, and the steps of
// each, ending where the person meant to be -- in a call, on the operator
// dashboard, or on their own new server with a first link to hand out.
//
// What is decided lives in flow.js and is tested there; what is said lives in
// i18n.js; what needs the app (the network, permissions, the deploy wizard)
// goes through host.js.  This file draws and wires.
//
// Built with the DOM, never with innerHTML on anything a person typed or a
// server sent: an invitation link is somebody else's text.  The only markup
// strings are the icons below, which are constants.
//
// Sozvon is a fork of Galène (MIT); see LICENCE.

(function () {
  'use strict';

  const Flow = window.SozvonFlow;
  const Text = window.SozvonOnboardingText;
  const host = window.SozvonHost;

  // Outline icons on a 24-unit grid, drawn in the text colour.
  const ICONS = {
    back: '<path d="M15 5l-7 7 7 7"/>',
    chevron: '<path d="M9 5l7 7-7 7"/>',
    arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
    link: '<path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1"/><path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1"/>',
    server: '<rect x="4" y="4" width="16" height="7" rx="2"/><rect x="4" y="13" width="16" height="7" rx="2"/><path d="M8 7.5h.01M8 16.5h.01"/>',
    rocket: '<path d="M12 15l-3-3a13 13 0 0 1 9-8 13 13 0 0 1-6 11z"/><path d="M9 12H5l2-4h4M12 15v4l4-2v-4"/><path d="M6 16c-1.5 1-2 3-2 4 1 0 3-.5 4-2"/>',
    camera: '<rect x="3" y="6" width="13" height="12" rx="2"/><path d="M16 10l5-3v10l-5-3z"/>',
    mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
    shield: '<path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z"/><path d="M9 12l2 2 4-4"/>',
    check: '<circle cx="12" cy="12" r="9"/><path d="M8 12l3 3 5-6"/>',
    alert: '<circle cx="12" cy="12" r="9"/><path d="M12 7v6M12 16.5h.01"/>',
    copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/>',
    share: '<circle cx="18" cy="5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="19" r="2.5"/><path d="M8.2 10.8l7.6-4.4M8.2 13.2l7.6 4.4"/>',
    clipboard: '<rect x="6" y="4" width="12" height="17" rx="2"/><path d="M9 4h6v3H9z"/>',
    key: '<circle cx="8" cy="15" r="4"/><path d="M11 12l8-8M16 7l3 3"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    dashboard: '<rect x="4" y="4" width="7" height="9" rx="1.5"/><rect x="13" y="4" width="7" height="5" rx="1.5"/><rect x="13" y="11" width="7" height="9" rx="1.5"/><rect x="4" y="15" width="7" height="5" rx="1.5"/>',
    door: '<path d="M6 21V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v17M3 21h18"/><path d="M14 12h.01"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7 7 0 0 0-2-1.2L14 3h-4l-.5 2.6a7 7 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a7 7 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1a7 7 0 0 0 2 1.2L10 21h4l.5-2.6a7 7 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6A7 7 0 0 0 19 12z"/>',
  };

  function icon(name) {
    const span = document.createElement('span');
    span.setAttribute('aria-hidden', 'true');
    span.className = 'ico';
    span.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' +
      ICONS[name] + '</svg>';
    return span;
  }

  /**
   * A small element builder.  Strings become text nodes, never markup.
   *
   * @param {string} tag
   * @param {Record<string, any>|null} [attrs]
   * @param {...(Node|string|null|false|undefined)} children
   */
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat(Infinity)) {
      if (c === null || c === undefined || c === false) continue;
      el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return el;
  }

  // ------------------------------------------------------------- state ---

  const env = host.env() || {};
  if (env.theme === 'dark' || env.theme === 'light')
    document.documentElement.dataset.theme = env.theme;

  const state = {
    lang: Text.pick(env.lang),
    path: /** @type {null|'invite'|'server'|'own'} */ (null),
    step: 'welcome',
    /** @type {string[]} */
    history: [],
    /** What the system says about camera and microphone before we ask. */
    media: /** @type {{state: string, camera?: string, mic?: string}} */ ({ state: 'prompt' }),
    invite: { text: '', parsed: null, check: null, error: null },
    server: { text: '', parsed: null, check: null, error: null },
    role: /** @type {null|'hub'|'room'} */ (null),
    room: '',
    roomError: null,
    granted: /** @type {null|{camera: boolean, mic: boolean, permanent?: boolean}} */ (null),
    deploy: /** @type {any} */ (null),
    mint: /** @type {null|{state: string, url?: string}} */ (null),
    note: /** @type {string|null} */ (null),
    copied: /** @type {string|null} */ (null),
  };

  const t = (key, vars) => Text.t(state.lang, key, vars);
  const desktop = host.platform === 'desktop';
  const android = host.platform === 'android';

  function skipMedia() {
    // Nothing to prepare anybody for: already granted on Android, and on
    // Windows unless the system has blocked the devices -- there is no
    // permission dialog there to explain in advance.
    if (state.media.state === 'granted' || state.media.state === 'n/a') return true;
    return desktop && state.media.state !== 'blocked';
  }

  // -------------------------------------------------------- navigation ---

  function go(step) {
    state.history.push(state.step);
    state.step = step;
    state.note = null;
    render(false);
  }

  function back() {
    if (!state.history.length || state.step === 'done') return false;
    state.step = state.history.pop();
    if (state.step === 'choose' || state.step === 'welcome') state.path = null;
    render(true);
    return true;
  }
  host.onBack(back);

  function next() {
    const n = Flow.nextStep(state.path, state.step, { skipMedia: skipMedia() });
    if (n) go(n);
  }

  /** The end of the road: open the server, and the app forgets the onboarding. */
  function finish(target) {
    host.call('finish', target);
  }

  // ------------------------------------------------------------ render ---

  const $stage = document.getElementById('stage');
  const $back = document.getElementById('back');
  const $skip = document.getElementById('skip');
  const $progress = document.getElementById('progress');

  $back.appendChild(icon('back'));
  $back.addEventListener('click', back);
  $skip.addEventListener('click', () => {
    if (state.step === 'welcome') {
      state.lang = state.lang === 'ru' ? 'en' : 'ru';
      render(false, true);
    } else {
      host.call('skip');
    }
  });

  /** Set by each screen: what Enter does. */
  let primaryAction = null;

  function render(isBack, keepFocus) {
    document.documentElement.lang = state.lang;
    const screen = SCREENS[state.step]();

    $back.hidden = !state.history.length || state.step === 'done' || state.step === 'deploy';
    $back.setAttribute('aria-label', t('common.back'));
    $back.title = t('common.back');

    // On the welcome screen the corner offers the other language instead of
    // skipping: skipping is already one of that screen's own two buttons.
    $skip.hidden = state.step === 'done' || state.step === 'deploy';
    $skip.textContent = state.step === 'welcome' ? t('lang.other') : t('common.skip');
    if (state.step === 'welcome')
      $skip.setAttribute('lang', state.lang === 'ru' ? 'en' : 'ru');
    else
      $skip.removeAttribute('lang');

    const [filled, total] = Flow.progress(state.path, state.step, { skipMedia: skipMedia() });
    $progress.hidden = state.step === 'welcome';
    $progress.textContent = '';
    for (let i = 0; i < total; i++)
      $progress.appendChild(h('i', { class: i < filled ? 'on' : '' }));
    $progress.setAttribute('aria-valuemin', '0');
    $progress.setAttribute('aria-valuemax', String(total));
    $progress.setAttribute('aria-valuenow', String(filled));
    $progress.setAttribute('aria-label', t('common.step', { n: filled, total }));

    const el = h('section', { class: 'screen ' + (screen.cls || '') + (isBack ? ' back' : '') },
      screen.body);
    primaryAction = null;
    if (screen.actions) el.appendChild(actions(screen.actions));
    $stage.textContent = '';
    $stage.appendChild(el);

    if (!keepFocus) {
      // The heading takes focus, so a screen reader announces the new step;
      // on the desktop an address field takes it instead, to type straight
      // away.  Not on a phone, where focusing a field raises the keyboard
      // over the explanation the person has not read yet.
      const field = desktop && el.querySelector('input');
      const target = field || el.querySelector('h1');
      if (target) target.focus({ preventScroll: true });
    }
    window.scrollTo(0, 0);
  }

  /**
   * @param {{primary?: {label: string, run: Function, icon?: string, disabled?: boolean},
   *          secondary?: Array<{label: string, run: Function}>}} a
   */
  function actions(a) {
    const box = h('div', { class: 'actions' });
    if (a.primary) {
      const p = a.primary;
      const btn = h('button', {
        class: 'primary', type: 'button',
        'aria-disabled': p.disabled ? 'true' : null,
        onclick: () => { if (!p.disabled) p.run(); },
      },
      // A forward arrow reads after the words; any other icon before them.
      p.icon && p.icon !== 'arrow' ? icon(p.icon) : null, p.label,
      p.icon === 'arrow' ? icon(p.icon) : null);
      box.appendChild(btn);
      primaryAction = () => btn.click();
    }
    for (const s of a.secondary || [])
      box.appendChild(h('button', { class: 'secondary', type: 'button', onclick: s.run }, s.label));
    return box;
  }

  function heading(text) {
    return h('h1', { tabindex: '-1' }, text);
  }

  function statusLine(kind, text) {
    const glyph = kind === 'busy' ? h('span', { class: 'spinner', 'aria-hidden': 'true' })
      : icon(kind === 'ok' ? 'check' : 'alert');
    return h('p', { class: 'status ' + (kind === 'busy' ? '' : kind), role: 'status' }, glyph,
      h('span', null, text));
  }

  // ------------------------------------------------------ server check ---

  let checkSeq = 0;

  /**
   * Ask the app whether there is a Sozvon server at an origin.  The answer is
   * stored on the slot (state.invite or state.server), and a later question
   * supersedes an earlier one still in flight.
   */
  function checkServer(slot, origin, redraw) {
    const seq = ++checkSeq;
    slot.check = { status: 'checking', origin };
    redraw();
    const p = host.call('checkServer', { url: origin }).then((r) => {
      if (seq !== checkSeq) return slot.check;
      slot.check = { status: (r && r.status) || 'unreachable', origin };
      redraw();
      return slot.check;
    });
    slot.check.promise = p;
    return p;
  }

  function checkStatusLine(check) {
    if (!check) return null;
    switch (check.status) {
      case 'checking': return statusLine('busy', t('check.checking'));
      case 'ok': return statusLine('ok', t('check.ok'));
      case 'other': return statusLine('warn', t('check.other'));
      case 'cert': return statusLine('bad', t(desktop ? 'check.cert.desktop' : 'check.cert'));
      case 'cert-changed': return statusLine('bad', t('check.cert-changed'));
      default: return statusLine('bad', t('check.unreachable'));
    }
  }

  /**
   * The address field shared by the invitation and the server screens:
   * parse as the person types, check the server once the address holds
   * still, and redraw only the part under the field so typing is never
   * interrupted.
   */
  function addressField(slot, parse, opts) {
    const dyn = h('div');
    const input = h('input', {
      class: 'input', id: 'address', type: 'url', inputmode: 'url',
      autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false',
      placeholder: opts.placeholder,
      'aria-describedby': 'address-status',
    });
    input.value = slot.text;
    dyn.id = 'address-status';

    const redraw = () => {
      dyn.textContent = '';
      input.setAttribute('aria-invalid', slot.error ? 'true' : 'false');
      if (slot.error) dyn.appendChild(h('p', { class: 'error' }, t('error.' + slot.error)));
      if (slot.parsed && slot.parsed.ok && opts.card) dyn.appendChild(opts.card(slot.parsed));
      const line = checkStatusLine(slot.check);
      if (line) dyn.appendChild(line);
      if (slot.check && slot.check.status === 'unreachable')
        dyn.appendChild(h('button', {
          class: 'inline-btn', type: 'button',
          onclick: () => checkServer(slot, slot.parsed.origin, redraw),
        }, t('check.retry')));
    };

    let timer = null;
    const update = (submit) => {
      slot.text = input.value;
      const r = parse(slot.text);
      slot.parsed = r.ok ? r : null;
      // An error is said on submit, or once the field has been left -- not
      // while somebody is halfway through typing an address.
      slot.error = r.ok ? null : (submit ? r.error : (slot.error && r.error));
      if (!r.ok) {
        slot.check = null;
        checkSeq++;
      }
      redraw();
      clearTimeout(timer);
      if (r.ok && (!slot.check || slot.check.origin !== r.origin))
        timer = setTimeout(() => checkServer(slot, r.origin, redraw), submit ? 0 : 450);
    };
    input.addEventListener('input', () => update(false));
    input.addEventListener('blur', () => { if (input.value.trim()) update(true); });

    const children = [
      h('div', { class: 'field' },
        h('label', { for: 'address' }, opts.label),
        input),
    ];
    if (opts.paste)
      children.push(h('button', {
        class: 'inline-btn', type: 'button',
        onclick: async () => {
          const r = await host.call('paste');
          if (r && r.text) {
            input.value = r.text;
            update(true);
          }
        },
      }, icon('clipboard'), t('invite.paste')));
    children.push(dyn);
    redraw();

    /** Submit: true when it is fine to go on. */
    async function submit() {
      clearTimeout(timer);
      update(true);
      if (!slot.parsed) {
        input.focus();
        return false;
      }
      let check = slot.check;
      if (!check || check.origin !== slot.parsed.origin)
        check = await checkServer(slot, slot.parsed.origin, redraw);
      else if (check.status === 'checking')
        check = await check.promise;
      // A certificate that failed would only fail again in the web view,
      // with less said about why; everything else may be tried.
      return check.status !== 'cert' && check.status !== 'cert-changed';
    }
    return { nodes: children, submit };
  }

  // ----------------------------------------------------------- screens ---

  const SCREENS = {
    welcome() {
      return {
        cls: 'welcome',
        body: [
          h('div', { class: 'hero' },
            h('span', { class: 'ring', 'aria-hidden': 'true' }),
            h('span', { class: 'ring', 'aria-hidden': 'true' }),
            h('img', { class: 'mark', src: 'mark.svg', alt: 'SOZVON' })),
          h('p', { class: 'wordmark', 'aria-hidden': 'true' }, 'Sozvon'),
          heading(t('welcome.title')),
          h('p', { class: 'lead' }, t('welcome.text')),
        ],
        actions: {
          primary: { label: t('welcome.start'), icon: 'arrow', run: () => go('choose') },
          secondary: [{ label: t('welcome.skip'), run: () => host.call('skip') }],
        },
      };
    },

    choose() {
      const option = (path, glyph) => h('button', {
        class: 'option', type: 'button',
        onclick: () => {
          state.path = path;
          go(Flow.PATHS[path][1]);
        },
      },
      h('span', { class: 'glyph' }, icon(glyph)),
      h('span', null, h('b', null, t(`choose.${path}.title`)), h('span', { class: 'desc' }, t(`choose.${path}.text`))),
      h('span', { class: 'chev' }, icon('chevron')));

      return {
        body: [
          h('p', { class: 'kicker' }, t('choose.kicker')),
          heading(t('choose.title')),
          h('p', { class: 'lead' }, t('choose.text')),
          h('div', { class: 'options' },
            option('invite', 'link'),
            option('server', 'server'),
            option('own', 'rocket')),
        ],
      };
    },

    invite() {
      const card = (p) => {
        const rows = [h('dt', null, t('invite.server')), h('dd', { class: 'mono' }, p.host)];
        if (p.kind === 'room') rows.push(h('dt', null, t('invite.room')), h('dd', null, p.room));
        else if (p.kind === 'link') rows.push(h('dt', null, t('invite.room')), h('dd', null, t('invite.link')));
        else rows.push(h('dt', null, t('invite.room')), h('dd', null, t('invite.whole')));
        return h('div', { class: 'card' }, h('dl', { class: 'rows' }, rows));
      };
      const field = addressField(state.invite, Flow.parseInvite, {
        label: t('invite.label'), placeholder: t('invite.placeholder'), paste: true, card,
      });
      return {
        body: [kickerFor(), heading(t('invite.title')), h('p', { class: 'lead' }, t('invite.text')),
          field.nodes],
        actions: {
          primary: {
            label: t('common.next'),
            run: async () => { if (await field.submit()) next(); },
          },
        },
      };
    },

    server() {
      const field = addressField(state.server, Flow.parseServer, {
        label: t('server.label'), placeholder: t('server.placeholder'),
      });
      return {
        body: [kickerFor(), heading(t('server.title')), h('p', { class: 'lead' }, t('server.text')),
          field.nodes],
        actions: {
          primary: {
            label: t('common.next'),
            run: async () => {
              if (!(await field.submit())) return;
              // An address that already named a room answers the next
              // question; it is still asked, with that answer ticked.
              if (state.server.parsed.room && !state.role) {
                state.role = 'room';
                state.room = state.server.parsed.room;
              }
              next();
            },
          },
        },
      };
    },

    role() {
      const roomField = h('div', { class: 'field' },
        h('label', { for: 'room' }, t('role.room.label')),
        h('input', {
          class: 'input', id: 'room', type: 'text', autocomplete: 'off',
          autocapitalize: 'off', spellcheck: 'false',
          placeholder: t('role.room.placeholder'),
          'aria-invalid': state.roomError ? 'true' : 'false',
          oninput: (e) => { state.room = e.target.value; },
        }),
        state.roomError ? h('p', { class: 'error' }, t('role.room.empty')) : null);
      roomField.querySelector('input').value = state.room;

      const option = (role, glyph) => h('button', {
        class: 'option', type: 'button', 'aria-pressed': state.role === role ? 'true' : 'false',
        onclick: () => {
          state.role = role;
          state.roomError = null;
          if (role === 'hub') next();
          else {
            render(false, true);
            document.getElementById('room').focus();
          }
        },
      },
      h('span', { class: 'glyph' }, icon(glyph)),
      h('span', null, h('b', null, t(`role.${role}.title`)), h('span', { class: 'desc' }, t(`role.${role}.text`))),
      h('span', { class: 'chev' }, icon('chevron')));

      return {
        body: [kickerFor(), heading(t('role.title')), h('p', { class: 'lead' }, t('role.text')),
          h('div', { class: 'options' }, option('hub', 'dashboard'), option('room', 'door')),
          state.role === 'room' ? roomField : null],
        actions: state.role === 'room' ? {
          primary: {
            label: t('common.next'),
            run: () => {
              state.room = state.room.trim();
              if (!state.room) {
                state.roomError = true;
                render(false, true);
                document.getElementById('room').focus();
                return;
              }
              next();
            },
          },
        } : null,
      };
    },

    media() {
      if (desktop) return desktopMedia();
      const g = state.granted;
      let status = null;
      let after = null;
      if (g) {
        if (g.camera && g.mic) status = statusLine('ok', t('media.granted'));
        else {
          status = statusLine('warn', t(g.camera || g.mic ? 'media.partial' : 'media.denied'));
          after = h('button', {
            class: 'inline-btn', type: 'button',
            onclick: () => host.call('openSettings'),
          }, icon('settings'), t('media.settings'));
        }
      }
      return {
        body: [kickerFor(), heading(t('media.title')), h('p', { class: 'lead' }, t('media.text')),
          h('ul', { class: 'points' },
            h('li', null, icon('camera'), h('span', null, t('media.point.camera'))),
            h('li', null, icon('shield'), h('span', null, t('media.point.server')))),
          status, after],
        actions: g ? {
          primary: { label: t('common.next'), run: next },
        } : {
          primary: {
            label: t('media.allow'),
            run: async () => {
              state.granted = await host.call('requestMedia');
              render(false, true);
              if (state.granted.camera && state.granted.mic) setTimeout(() => {
                if (state.step === 'media') next();
              }, 700);
            },
          },
          secondary: [{ label: t('media.later'), run: next }],
        },
      };
    },

    ready() {
      const target = readyTarget();
      return {
        body: [kickerFor(), heading(t('ready.title')),
          h('p', { class: 'lead' }, t(target.hub ? 'ready.text.hub' : 'ready.text.room')),
          h('div', { class: 'card' },
            h('dl', { class: 'rows' },
              h('dt', null, t('invite.server')), h('dd', { class: 'mono' }, new URL(target.origin).host),
              target.room ? [h('dt', null, t('invite.room')), h('dd', null, target.room)] : null)),
          h('p', { class: 'note' }, t(desktop ? 'ready.saved.desktop' : 'ready.saved.android'))],
        actions: {
          primary: {
            label: t(target.hub ? 'ready.go.hub' : 'ready.go.room'), icon: 'arrow',
            run: () => finish(target),
          },
        },
      };
    },

    need() {
      return {
        body: [kickerFor(), heading(t('need.title')),
          h('ul', { class: 'points' },
            h('li', null, icon('server'), h('span', null, t('need.vps'))),
            h('li', null, icon('key'), h('span', null, t('need.access'))),
            h('li', null, icon('globe'), h('span', null, t('need.domain'))),
            h('li', null, icon('clock'), h('span', null, t('need.time')))),
          state.note ? statusLine('warn', state.note) : null],
        actions: {
          primary: { label: t('need.ready'), icon: 'arrow', run: startDeploy },
          secondary: [{ label: t('need.guide'), run: () => go(Flow.GUIDE[0]) }],
        },
      };
    },

    'guide-find': () => guide('find', null, 3),
    'guide-signup': () => guide('signup', null, 1),
    'guide-order': () => guide('order', specRows(['os', 'cpu', 'ram', 'disk', 'ip'], 'order'), 2),
    'guide-panel': () => guide('panel', null, 2),
    'guide-copy': () => guide('copy', specRows(['ip', 'password'], 'copy'), 2),
    'guide-paste': () => guide('paste', h('div', null,
      h('div', { class: 'map' },
        mapRow('host'), mapRow('user'), mapRow('password')),
      h('ul', { class: 'tips' },
        h('li', null, t('guide.paste.tls')),
        h('li', null, t('guide.paste.safe')))), 0),

    deploy() {
      return {
        body: [kickerFor(), heading(t('deploy.waiting')),
          h('div', { class: 'status' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }))],
      };
    },

    done() {
      const r = state.deploy;
      const origin = Flow.deployOrigin(r);
      const hub = !!r.hub;
      const m = state.mint;

      const cred = (label, value, opts) => h('div', { class: 'cred' },
        h('span', { class: 'label' }, label),
        h('span', { class: 'value mono' }, value),
        opts && opts.copy ? copyButton(opts.copy, opts.sensitive) : h('span'));

      let invite;
      if (!m || m.state === 'pending') invite = statusLine('busy', t('done.minting'));
      else if (m.state === 'ok') invite = h('div', null,
        h('div', { class: 'cred' },
          h('span', { class: 'value mono' }, m.url),
          copyButton(m.url, false)),
        h('p', { class: 'note' }, t(hub ? 'done.invite.hub' : 'done.invite.room')));
      else invite = statusLine('warn', t('done.mint.failed'));

      const target = { url: hub ? origin + '/' : (r.url || origin + '/'), origin, room: hub ? '' : (r.group || ''), hub };
      const openLabel = t(hub ? 'done.open' : 'done.open.room');
      const shareLink = m && m.state === 'ok' ? m.url : null;

      return {
        body: [kickerFor(), heading(t('done.title')), h('p', { class: 'lead' }, t('done.text')),
          h('div', { class: 'card' },
            cred(t('done.address'), origin, { copy: origin }),
            cred(t('done.user'), r.admin_user || 'operator'),
            r.admin_password
              ? cred(t('done.password'), r.admin_password, { copy: r.admin_password, sensitive: true })
              : cred(t('done.password'), t('done.password.unchanged'))),
          h('p', { class: 'kicker gap' }, t('done.invite')),
          h('div', { class: 'card' }, invite),
          r.tls_mode === 'self-signed' ? h('p', { class: 'note' }, t('done.selfsigned')) : null],
        actions: shareLink ? {
          primary: android
            ? { label: t('done.share'), icon: 'share', run: () => host.call('share', { text: t('done.share.text', { url: shareLink }) }) }
            : { label: state.copied === shareLink ? t('common.copied') : t('done.copy.link'), icon: 'copy', run: () => copy(shareLink, false) },
          secondary: [{ label: openLabel, run: () => finish(target) }],
        } : {
          primary: { label: openLabel, icon: 'arrow', run: () => finish(target) },
        },
      };
    },
  };

  /** "Step 2 of 4" above a step's heading. */
  function kickerFor() {
    if (Flow.GUIDE.includes(state.step)) {
      const i = Flow.GUIDE.indexOf(state.step);
      return h('p', { class: 'kicker' }, t('guide.kicker', { n: i + 1, total: Flow.GUIDE.length }));
    }
    const [n, total] = Flow.progress(state.path, state.step, { skipMedia: skipMedia() });
    return h('p', { class: 'kicker' }, t('common.step', { n, total }));
  }

  function guide(name, extra, tips) {
    const last = state.step === Flow.GUIDE[Flow.GUIDE.length - 1];
    const tipList = [];
    for (let i = 1; i <= tips; i++) tipList.push(h('li', null, t(`guide.${name}.tip${i}`)));
    return {
      body: [kickerFor(), heading(t(`guide.${name}.title`)),
        h('p', { class: 'lead' }, t(`guide.${name}.text`)),
        extra ? h('div', { class: extra.classList.contains('rows') ? 'card' : '' }, extra) : null,
        tipList.length ? h('ul', { class: 'tips' }, tipList) : null],
      actions: {
        primary: last
          ? { label: t('guide.paste.go'), icon: 'arrow', run: startDeploy }
          : { label: t('common.next'), run: next },
      },
    };
  }

  function specRows(keys, step) {
    const rows = [];
    for (const k of keys)
      rows.push(h('dt', null, t(`guide.${step}.${k}`)), h('dd', null, t(`guide.${step}.${k}.value`)));
    return h('dl', { class: 'rows' }, rows);
  }

  function mapRow(field) {
    return h('div', { class: 'map-row' },
      h('span', { class: 'chip from' }, t(`guide.paste.${field}.from`)),
      icon('arrow'),
      h('span', { class: 'chip to' }, t(`guide.paste.${field}`)));
  }

  function copyButton(text, sensitive) {
    return h('button', {
      class: 'copy-btn', type: 'button',
      onclick: () => copy(text, sensitive),
    }, icon('copy'), state.copied === text ? t('common.copied') : t('common.copy'));
  }

  async function copy(text, sensitive) {
    await host.call('copy', { text, sensitive: !!sensitive });
    state.copied = text;
    render(false, true);
    setTimeout(() => {
      if (state.copied !== text) return;
      state.copied = null;
      if (state.step === 'done') render(false, true);
    }, 2000);
  }

  function readyTarget() {
    if (state.path === 'invite') {
      const p = state.invite.parsed;
      return {
        url: p.url, origin: p.origin,
        room: p.kind === 'room' ? p.room : '',
        hub: p.kind === 'server',
      };
    }
    const origin = state.server.parsed.origin;
    if (state.role === 'hub') return { url: origin + '/', origin, room: '', hub: true };
    return { url: Flow.roomUrl(origin, state.room), origin, room: state.room, hub: false };
  }

  // ------------------------------------------------------------ deploy ---

  async function startDeploy() {
    state.path = 'own';
    go('deploy');
    // On Android the wizard opens over this page and the answer comes back
    // here.  On the desktop it takes this page's place, and the answer
    // arrives with the page's next load instead (see resume below).
    const r = await host.call('deploy');
    deployAnswered(r);
  }

  function deployAnswered(r) {
    if (r && r.result) {
      state.deploy = r.result;
      state.history = [];
      state.step = 'done';
      render(false);
      mint();
      return;
    }
    // Back out of the wizard: return to the checklist and say so, rather
    // than leaving somebody on a spinner for an install that never started.
    state.step = 'need';
    if (state.history[state.history.length - 1] === 'need') state.history.pop();
    state.note = t('deploy.cancelled');
    render(true);
  }

  async function mint() {
    const r = state.deploy;
    if (!r.hub) {
      // An ordinary room: its own address is the invitation.
      state.mint = { state: 'ok', url: r.url };
      render(false, true);
      return;
    }
    if (!r.admin_password) {
      // A reinstall over an existing server keeps the old password and so
      // does not report it; without it there is no signing in to mint.
      state.mint = { state: 'failed' };
      render(false, true);
      return;
    }
    state.mint = { state: 'pending' };
    render(false, true);
    const out = await host.call('mint', {
      origin: Flow.deployOrigin(r),
      group: r.group,
      username: r.admin_user,
      password: r.admin_password,
      slug: Flow.randomSlug(),
    });
    state.mint = out && out.ok && out.url ? { state: 'ok', url: out.url } : { state: 'failed' };
    if (state.mint.state === 'failed') console.warn('mint failed:', out && out.error);
    if (state.step === 'done') render(false, true);
  }

  // ---------------------------------------------------------- keyboard ---

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && desktop) {
      if (back()) e.preventDefault();
      return;
    }
    if (e.key !== 'Enter' || e.isComposing) return;
    const tag = e.target && e.target.tagName;
    if (tag === 'BUTTON' || tag === 'A' || tag === 'TEXTAREA') return;
    if (primaryAction) {
      e.preventDefault();
      primaryAction();
    }
  });

  // -------------------------------------------------------------- boot ---

  async function boot() {
    const m = await host.call('media');
    if (m && m.state) state.media = m;
    if (env.resume === 'deploy') {
      state.path = 'own';
      state.history = ['welcome', 'choose', 'need'];
      const r = await host.call('takeDeployResult');
      deployAnswered(r);
    }
  }

  // Coming back from the desktop's deploy wizard, the welcome screen must
  // not flash up first: boot() draws the right one.
  if (env.resume !== 'deploy') render(false);
  boot();
})();
