(async () => {
  let cfg = await window.sozvon.getConfig();
  const $server = document.getElementById('server');
  const $group = document.getElementById('group');
  const $insecure = document.getElementById('insecure');
  const $join = document.getElementById('join');
  const $recentWrap = document.getElementById('recent-wrap');
  const $recent = document.getElementById('recent');
  const $serversWrap = document.getElementById('servers-wrap');
  const $servers = document.getElementById('servers');

  // Why we are back here, when we were sent back by a failed load.
  const failed = new URLSearchParams(location.search).get('error');
  if (failed) {
    const $err = document.getElementById('load-error');
    $err.textContent = `Не удалось открыть сервер: ${failed}`;
    $err.hidden = false;
  }

  $server.value = cfg.serverUrl || '';
  $group.value = cfg.lastGroup || '';
  $insecure.checked = !!cfg.allowInsecureCerts;

  const trimmed = (u) => String(u || '').replace(/\/+$/, '');
  const hostOf = (u) => {
    try { return new URL(u).host; } catch { return trimmed(u); }
  };
  const entryFor = (url) =>
    (cfg.servers || []).find(s => trimmed(s.url) === trimmed(url));

  /** Recent rooms belong to the server in the field, not to the app. */
  function renderRooms() {
    const entry = entryFor($server.value.trim());
    const rooms = (entry && Array.isArray(entry.rooms) ? entry.rooms : []);
    $recent.textContent = '';
    $recentWrap.hidden = !rooms.length;
    for (const g of rooms) {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.textContent = g;
      chip.addEventListener('click', () => { $group.value = g; });
      $recent.appendChild(chip);
    }
  }

  function renderServers() {
    const servers = (cfg.servers || []).filter(s => s && s.url);
    $servers.textContent = '';
    $serversWrap.hidden = !servers.length;

    for (const s of servers) {
      const card = document.createElement('div');
      card.className = 'server-card';
      if (trimmed(s.url) === trimmed($server.value.trim())) card.classList.add('current');

      const main = document.createElement('div');
      main.className = 'server-main';
      main.title = 'Подставить в форму';

      const name = document.createElement('div');
      name.className = 'server-name';
      name.textContent = s.name || hostOf(s.url);

      // The address on its own line, what to expect of it on the next: with
      // the buttons taking the right-hand side, one line ellipsises away the
      // part that actually tells them apart.
      const meta = document.createElement('div');
      meta.className = 'server-meta';
      meta.textContent = trimmed(s.url);

      const sub = document.createElement('div');
      sub.className = 'server-meta server-sub';
      sub.textContent = s.lastGroup
        ? `комната: ${s.lastGroup}`
        : 'открывается целиком';
      // A server whose certificate we pinned at install time: worth saying,
      // since that is what makes a self-signed one reachable at all.
      let host = hostOf(s.url).split(':')[0];
      if (cfg.pinnedCerts && cfg.pinnedCerts[host]) {
        const pin = document.createElement('span');
        pin.className = 'server-pin';
        pin.textContent = ' · сертификат закреплён';
        sub.appendChild(pin);
      }

      main.appendChild(name);
      main.appendChild(meta);
      main.appendChild(sub);
      main.addEventListener('click', () => {
        $server.value = trimmed(s.url);
        $group.value = s.lastGroup || '';
        renderRooms();
        renderServers();
        $group.focus();
      });

      const actions = document.createElement('div');
      actions.className = 'server-actions';

      const open = document.createElement('button');
      open.className = 'primary';
      open.textContent = 'Открыть';
      open.addEventListener('click', async () => {
        open.disabled = true;
        await window.sozvon.openGroup(trimmed(s.url), s.lastGroup || '');
      });

      const rename = document.createElement('button');
      rename.textContent = 'Имя';
      rename.title = 'Переименовать';
      rename.addEventListener('click', () => {
        const input = document.createElement('input');
        input.className = 'server-rename';
        input.value = s.name || '';
        input.placeholder = hostOf(s.url);
        main.textContent = '';
        main.appendChild(input);
        input.focus();
        input.select();
        // Enter, Escape and losing focus all end the edit; whichever comes
        // first wins, so the other two must not fire a second save.
        let done = false;
        const save = async () => {
          if (done) return;
          done = true;
          cfg = await window.sozvon.renameServer(s.url, input.value);
          renderServers();
        };
        input.addEventListener('keydown', e => {
          if (e.key === 'Enter') save();
          if (e.key === 'Escape') { done = true; renderServers(); }
        });
        input.addEventListener('blur', save);
      });

      const del = document.createElement('button');
      del.textContent = 'Удалить';
      del.addEventListener('click', async () => {
        if (!window.confirm(`Убрать ${s.name || hostOf(s.url)} из списка?`))
          return;
        cfg = await window.sozvon.removeServer(s.url);
        renderServers();
        renderRooms();
      });

      actions.appendChild(open);
      actions.appendChild(rename);
      actions.appendChild(del);
      card.appendChild(main);
      card.appendChild(actions);
      $servers.appendChild(card);
    }
  }

  renderServers();
  renderRooms();

  $server.addEventListener('input', () => { renderRooms(); renderServers(); });

  $insecure.addEventListener('change', async () => {
    await window.sozvon.setConfig({ allowInsecureCerts: $insecure.checked });
  });

  async function join() {
    const serverUrl = $server.value.trim();
    // No room: open the server itself.  That is the way in for an operator,
    // whose server greets them with a dashboard rather than a call.
    const group = $group.value.trim();
    if (!serverUrl) return;
    $join.disabled = true;
    await window.sozvon.openGroup(serverUrl, group);
  }

  document.getElementById('deploy-link')
    .addEventListener('click', () => window.sozvon.openDeploy());

  $join.addEventListener('click', join);
  $group.addEventListener('keydown', e => { if (e.key === 'Enter') join(); });
  $server.addEventListener('keydown', e => { if (e.key === 'Enter') join(); });

  $group.focus();
})();
