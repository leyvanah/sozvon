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

// ------------------------------------------------------------------ form ---

$('back').addEventListener('click', () => window.sozvon.backToLauncher());

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

  buildSteps();
  $('pr-sub').textContent = 'Подключаемся к серверу…';
  show('progress');

  const res = await window.sozvon.startDeploy({
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
  });

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
    show('done');
  } else {
    markFailed();
    $('e-msg').textContent = (res && res.message) || 'Неизвестная ошибка.';
    if (res && res.detail) {
      $('e-detail').hidden = false;
      $('e-detail').textContent = res.detail;
    }
    show('error');
  }
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
