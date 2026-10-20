'use strict';

const STAGE_LABELS = {
  preflight: 'Проверяем систему',
  user: 'Создаём служебную учётную запись',
  fetch: 'Скачиваем SOZVON',
  tls: 'Готовим сертификат',
  config: 'Пишем конфигурацию',
  firewall: 'Открываем порты',
  service: 'Ставим службу',
  verify: 'Ждём ответа сервера',
  done: 'Завершаем',
};
const STAGE_ORDER = Object.keys(STAGE_LABELS);

const TLS_HINTS = {
  'letsencrypt-sslip':
    'Имя будет получено из IP сервера через sslip.io, сертификат — от Let\'s Encrypt. ' +
    'Ничего настраивать не нужно, работает в любом браузере.',
  'letsencrypt-domain':
    'Самый независимый вариант: имя ваше, сторонних сервисов в цепочке нет.',
  'self-signed':
    'Не нужен ни домен, ни доступ к Let\'s Encrypt. Но браузеры такой сертификат ' +
    'отвергнут — подключаться можно будет только из приложения.',
};

const $ = (id) => document.getElementById(id);
const views = ['form', 'hostkey', 'progress', 'done', 'error'];
function show(name) {
  for (const v of views) $(`view-${v}`).hidden = (v !== name);
}

let lastResult = null;

// Opened from the first-run onboarding: the answer goes back there, which
// shows the password and a first guest link on its own last screen, and
// "back" returns there rather than to the launcher.
const fromOnboarding = new URLSearchParams(location.search).get('onboarding') === '1';

// ------------------------------------------------------------------ form ---

$('back').addEventListener('click', () => {
  if (fromOnboarding) window.sozvon.onboardingDeployCancelled();
  else window.sozvon.backToLauncher();
});

$('authtype').addEventListener('change', () => {
  const key = $('authtype').value === 'key';
  $('auth-key').hidden = !key;
  $('auth-password').hidden = key;
});

function syncTls() {
  const mode = $('tls').value;
  $('tls-hint').textContent = TLS_HINTS[mode] || '';
  $('domain-wrap').hidden = (mode !== 'letsencrypt-domain');
}
$('tls').addEventListener('change', syncTls);
syncTls();

// A LAN address is a home server behind a router.  The notice says what the
// router needs before anything is installed; the forwards themselves come
// from the installer, which is the one that knows them.
function syncHome() {
  $('home-box').hidden = !HomeServer.isPrivateIPv4($('host').value);
  $('port-taken-wrap').hidden = !$('port-taken').checked;
}
$('host').addEventListener('input', syncHome);
$('port-taken').addEventListener('change', syncHome);
syncHome();

/** The router's forwards, as table rows: its port, protocol, and target. */
function fillForwards(table, forwards) {
  table.textContent = '';
  const head = table.insertRow();
  for (const t of ['Порт роутера', 'Протокол', 'Куда передавать']) {
    const th = document.createElement('th');
    th.textContent = t;
    head.appendChild(th);
  }
  for (const f of forwards) {
    const tr = table.insertRow();
    for (const v of [String(f.port), f.proto.toUpperCase(), `${f.toHost}:${f.toPort}`])
      tr.insertCell().textContent = v;
  }
}

function buildSteps() {
  const ul = $('steps');
  ul.innerHTML = '';
  for (const s of STAGE_ORDER) {
    const li = document.createElement('li');
    li.id = `step-${s}`;
    li.textContent = STAGE_LABELS[s];
    ul.appendChild(li);
  }
}

function markStage(stage) {
  const idx = STAGE_ORDER.indexOf(stage);
  if (idx < 0) return;
  STAGE_ORDER.forEach((s, i) => {
    const li = $(`step-${s}`);
    if (!li) return;
    li.className = i < idx ? 'done' : (i === idx ? 'active' : '');
  });
}

function markFailed() {
  const active = document.querySelector('.steps li.active');
  if (active) active.className = 'failed';
}

$('go').addEventListener('click', async () => {
  const host = $('host').value.trim();
  if (!host) { $('host').focus(); return; }
  const usingKey = $('authtype').value === 'key';
  if (!usingKey && !$('password').value) { $('password').focus(); return; }
  if (usingKey && !$('keypath').value.trim()) { $('keypath').focus(); return; }
  const tlsMode = $('tls').value;
  if (tlsMode === 'letsencrypt-domain' && !$('domain').value.trim()) {
    $('domain').focus();
    return;
  }
  // "443 is taken here" means listening elsewhere, with the router's 443
  // forwarded to it -- only offered for a home server, where there is a
  // router to do that.
  let ports = {};
  if (!$('home-box').hidden && $('port-taken').checked) {
    ports = HomeServer.portOptions($('local-port').value);
    if (!ports) { $('local-port').focus(); return; }
  }

  await runDeploy({
    host,
    port: Number($('port').value) || 22,
    username: $('user').value.trim() || 'root',
    password: usingKey ? undefined : $('password').value,
    privateKeyPath: usingKey ? $('keypath').value.trim() : undefined,
    passphrase: usingKey ? ($('passphrase').value || undefined) : undefined,
    tlsMode,
    domain: tlsMode === 'letsencrypt-domain' ? $('domain').value.trim() : undefined,
    group: $('group').value.trim() || 'meet',
    adminUser: 'operator',
    ...ports,
  });
});

// What the last install was asked to do, so "Run again" can ask the same.
let lastOpts = null;

async function runDeploy(opts) {
  lastOpts = opts;
  buildSteps();
  $('pr-sub').textContent = 'Подключаемся к серверу…';
  show('progress');

  const res = await window.sozvon.startDeploy(opts);

  if (res && res.ok && fromOnboarding) {
    window.sozvon.onboardingDeployed(res.result);
    return;
  }
  if (res && res.ok) {
    lastResult = res.result;
    $('r-url').textContent = res.result.url;
    $('r-user').textContent = res.result.admin_user;
    $('r-pass').textContent = res.result.admin_password || '(не изменён)';
    $('r-ver').textContent = res.result.version;
    if (res.result.tls_mode === 'self-signed') {
      $('r-selfsigned').hidden = false;
      $('r-fp').textContent = 'SHA-256: ' + (res.result.cert_sha256 || '');
    }
    // Behind a router the install is only half the job: the forwards stay
    // the person's to keep, or calls from outside load the page and then
    // get no sound or picture.  The address above is already the public
    // one -- the installer reports the router's, not the LAN's.
    const home = HomeServer.homeServerOf(res.result);
    $('r-home').hidden = !home.behindNat;
    if (home.behindNat) {
      $('r-home-text').textContent =
        `Сервер стоит за роутером: снаружи его видно по адресу ${home.publicIp || 'роутера'}, ` +
        `а роутер передаёт подключения на ${home.lanIp || 'этот сервер'}. ` +
        'Эти порты должны оставаться проброшенными, иначе собеседники снаружи откроют ' +
        'страницу, но не услышат и не увидят друг друга.';
      fillForwards($('r-fw'), home.forwards);
    }
    show('done');
  } else {
    markFailed();
    // What the installer itself said stays, below, for a bug report.
    const said = (res && res.message) || '';
    const text = res && installErrorText(res.reason);
    $('e-msg').textContent = text || said || 'Неизвестная ошибка.';
    const detail = [text ? said : '', (res && res.detail) || '']
      .filter(Boolean).join('\n\n');
    $('e-detail').hidden = !detail;
    $('e-detail').textContent = detail;
    // Stopped for want of the router's forwards: the list is the one thing
    // to act on, so it comes before the log, and running the install again
    // is one click -- the installer finishes what this run started, and
    // shows the operator password it kept back.  A rate-limited certificate
    // is the same situation an hour later.
    const reason = res && res.reason;
    const forwards = HomeServer.parseForwards(res && res.forwards);
    const homeFailure = reason === 'port-forward' || reason === 'certificate-rate-limited';
    $('e-home').hidden = !(homeFailure && forwards.length);
    if (!$('e-home').hidden) fillForwards($('e-fw'), forwards);
    $('e-rerun').hidden = !homeFailure;
    $('e-retry').className = homeFailure ? 'secondary' : '';
    show('error');
  }
}

$('e-rerun').addEventListener('click', () => {
  if (lastOpts) runDeploy(lastOpts);
});

// --------------------------------------------------------------- hostkey ---

window.sozvon.onHostKey((info) => {
  const changed = info.status === 'changed';
  $('hk-text').textContent = changed
    ? `Ключ сервера ${info.host} изменился с прошлого раза.`
    : `Вы подключаетесь к ${info.host} впервые.`;
  $('hk-fp').textContent = info.fingerprint;
  $('hk-prev-wrap').hidden = !changed;
  if (changed) $('hk-prev').textContent = info.previous || '';
  show('hostkey');
});

$('hk-yes').addEventListener('click', () => {
  window.sozvon.answerHostKey(true);
  show('progress');
});
$('hk-no').addEventListener('click', () => {
  window.sozvon.answerHostKey(false);
  show('form');
});

// -------------------------------------------------------------- progress ---

window.sozvon.onDeployProgress((ev) => {
  if (ev.type === 'phase') {
    const text = {
      checking: 'Проверяем права доступа…',
      uploading: 'Передаём установщик…',
      starting: 'Запускаем установку…',
      installing: 'Идёт установка…',
    }[ev.phase];
    if (text) $('pr-sub').textContent = text;
  }
  if (ev.type === 'stage') {
    markStage(ev.stage);
    $('pr-sub').textContent = `Шаг ${ev.index} из ${ev.total}`;
  }
});

// ------------------------------------------------------------------ done ---

$('d-open').addEventListener('click', () => {
  if (!lastResult) return;
  // The installer's own origin, not one rebuilt from the hostname: rebuilding
  // drops the port, and the client then knocks on 443 and meets whatever else
  // lives there.
  const origin = lastResult.origin ||
    (String(lastResult.url || '').startsWith('https://')
      ? String(lastResult.url).split('/group/')[0]
      : `https://${lastResult.hostname}`);
  // A server installed with an operator hub opens at its root, where the
  // operator logs in and gets the dashboard; without one there is only the
  // ordinary room to go to.
  window.sozvon.openGroup(origin, lastResult.hub ? '' : lastResult.group);
});

$('d-copy').addEventListener('click', async () => {
  if (!lastResult) return;
  const lines = [
    `Адрес:    ${lastResult.url}`,
    `Оператор: ${lastResult.admin_user}`,
    `Пароль:   ${lastResult.admin_password}`,
    `Версия:   ${lastResult.version}`,
  ];
  if (lastResult.tls_mode === 'self-signed') {
    lines.push(`Отпечаток сертификата SHA-256: ${lastResult.cert_sha256}`);
  }
  const home = HomeServer.homeServerOf(lastResult);
  if (home.behindNat && home.forwards.length) {
    lines.push('', 'Порты, проброшенные на роутере:', HomeServer.forwardsText(home.forwards));
  }
  try {
    await navigator.clipboard.writeText(lines.join('\n'));
    $('d-copy').textContent = 'Скопировано';
    setTimeout(() => { $('d-copy').textContent = 'Скопировать данные'; }, 2000);
  } catch {
    $('d-copy').textContent = 'Не удалось скопировать';
  }
});

$('e-retry').addEventListener('click', () => show('form'));

$('host').focus();
