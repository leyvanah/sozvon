const { app, BrowserWindow, WebContentsView, session, ipcMain, Menu, shell, nativeImage, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const ICON_PATH = path.join(__dirname, '..', 'assets', 'icon.ico');
const ICON_PNG_PATH = path.join(__dirname, '..', 'assets', 'icon.png');
if (fs.existsSync(ICON_PATH)) app.setAppUserModelId('ai.sozvon.desktop');

const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');
const DEFAULT_CONFIG = {
  serverUrl: '',
  lastGroup: '',
  allowInsecureCerts: false,
  pinnedCerts: {},
  recentGroups: [],
  // Light or dark, as chosen in the web client and reported over the SozvonApp
  // bridge: 'system' (follow the desktop), 'light' or 'dark'.  Remembered so
  // the launcher, which is shown before any server page has had a chance to
  // report anything, opens in the right one.
  theme: 'system',
  // Every server this client has been to: {url, name, lastGroup, rooms[]}.
  // serverUrl/lastGroup/recentGroups are kept in step with the most recent
  // one, so a config written by an older build still opens, and one written
  // here still works if the user goes back to it.
  servers: []
};

function loadConfig() {
  let cfg;
  try {
    cfg = { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) };
  } catch {
    cfg = { ...DEFAULT_CONFIG };
  }
  if (!Array.isArray(cfg.servers)) cfg.servers = [];
  // A config from before the list existed knows one server: keep it rather
  // than starting the user off with an empty screen.
  if (!cfg.servers.length && cfg.serverUrl) {
    cfg.servers = [{
      url: cfg.serverUrl,
      name: '',
      lastGroup: cfg.lastGroup || '',
      rooms: Array.isArray(cfg.recentGroups) ? cfg.recentGroups.slice(0, 10) : [],
    }];
  }
  return cfg;
}

/** Servers are the same when they are the same address, trailing slash or not. */
function sameServer(a, b) {
  return String(a).replace(/\/+$/, '') === String(b).replace(/\/+$/, '');
}

/**
 * Record a visit: the server moves to the front of the list, keeping its name
 * and the rooms it has been used for.  Called from every path that opens a
 * server, so a server reached by the deploy wizard lands here too instead of
 * replacing whatever was stored before.
 */
function rememberServer(url, group) {
  const servers = (config.servers || []).filter(s => s && s.url);
  const i = servers.findIndex(s => sameServer(s.url, url));
  const entry = i >= 0 ? servers.splice(i, 1)[0] : { url, name: '', rooms: [] };
  entry.url = url;
  if (!Array.isArray(entry.rooms)) entry.rooms = [];
  if (group) {
    entry.lastGroup = group;
    entry.rooms = [group, ...entry.rooms.filter(r => r !== group)].slice(0, 10);
  } else {
    // Opened the server itself (an operator hub): no room to remember, and
    // the stored one must not linger as if it were where we went.
    entry.lastGroup = '';
  }
  servers.unshift(entry);
  config.servers = servers.slice(0, 20);
  config.serverUrl = url;
  config.lastGroup = entry.lastGroup || '';
  config.recentGroups = entry.rooms.slice();
}

function saveConfig(cfg) {
  try {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  } catch (e) {
    console.error('saveConfig failed:', e);
  }
}

let mainWindow = null;
// The layer below the app bar, holding whatever page the app is showing.
let contentView = null;
let config = loadConfig();

// The two window backgrounds, which are --bg from the web client's palette.
// This is the colour Electron paints before a page has rendered anything, so
// getting it wrong is a white flash on a dark theme, or the reverse.
const WINDOW_BG = { dark: '#000000', light: '#FFFFFF' };
const WINDOW_FG = { dark: '#FFFFFF', light: '#000000' };

// The height of the app bar, and so where the content layer begins.  Also the
// height the system's window controls are drawn at, so the two line up.
const TITLEBAR_H = 40;

function windowBackground() {
  return nativeTheme.shouldUseDarkColors ? WINDOW_BG.dark : WINDOW_BG.light;
}

/**
 * Minimise, maximise and close, painted in the palette.
 *
 * They stay the *system's* buttons, drawn over the right end of our bar,
 * rather than becoming three more HTML buttons on it.  Windows 11's snap
 * layouts come with them when maximise is hovered, and that is not something
 * to reimplement for the sake of owning the pixels.  All we own is the
 * colour.
 */
function overlayColors() {
  const dark = nativeTheme.shouldUseDarkColors;
  return {
    color: dark ? WINDOW_BG.dark : WINDOW_BG.light,
    symbolColor: dark ? WINDOW_FG.dark : WINDOW_FG.light,
    height: TITLEBAR_H,
  };
}

/**
 * Follow the appearance the user chose in the web client.
 *
 * themeSource does the work: Electron resolves 'system' against the desktop
 * itself and hands the result to every renderer as prefers-color-scheme, so
 * the launcher and the deploy window follow without being told, and keep
 * following when the desktop's own setting changes later.
 *
 * @param {string} pref - 'system', 'light' or 'dark'
 */
function applyTheme(pref) {
  nativeTheme.themeSource =
    (pref === 'light' || pref === 'dark') ? pref : 'system';
  repaintChrome();
  pushThemeToContent(pref);
}

/**
 * Hand the choice to a server's client, which is the one page in the app that
 * does not follow prefers-color-scheme.
 *
 * It cannot: a browser tab has no themeSource, so the client keeps its own
 * preference and decides for itself, reading it in a blocking script before
 * first paint.  The preload writes ours in at load time, which is why the
 * theme was right on arrival and then only changed on a refresh.  This is the
 * same call the client's own settings make, so the page switches live.
 *
 * No loop: the client reports the change straight back over the bridge, and
 * its own set() returns early when the preference is the one already in force.
 *
 * @param {string} pref - 'system', 'light' or 'dark'
 */
function pushThemeToContent(pref) {
  if (!contentView) return;
  let url = '';
  try {
    url = contentView.webContents.getURL();
  } catch {
    return;
  }
  // Our own pages are file:// and follow the desktop through nativeTheme.
  if (!/^https?:/.test(url)) return;
  contentView.webContents.executeJavaScript(
    `window.Sozvon && window.Sozvon.theme && window.Sozvon.theme.set(${JSON.stringify(pref)});`
  ).catch(() => { /* a page that has no client on it, or is still loading */ });
}

/** The parts of the window we paint ourselves, for the theme now in force. */
function repaintChrome() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.setBackgroundColor(windowBackground());
  try {
    mainWindow.setTitleBarOverlay(overlayColors());
  } catch {
    // Not a platform with a window-controls overlay (macOS draws its own
    // traffic lights); the rest of the theming still applies.
  }
}

// The desktop's own light/dark setting can change while we run; with
// themeSource at 'system' that moves our chrome too.
nativeTheme.on('updated', () => {
  repaintChrome();
  sendBarState();
});

/** The content layer fills the window below the bar. */
function layoutContent() {
  if (!mainWindow || mainWindow.isDestroyed() || !contentView) return;
  const { width, height } = mainWindow.getContentBounds();
  contentView.setBounds({
    x: 0,
    y: TITLEBAR_H,
    width,
    height: Math.max(0, height - TITLEBAR_H),
  });
}

/**
 * What the bar needs to draw itself: whether it is looking at a server, and
 * which way the theme is resolved.  A file:// URL is one of our own pages --
 * the launcher or the deploy wizard -- where "back to the servers", "reload"
 * and "the operator room" have nothing to act on.
 */
function barState() {
  let onServer = false;
  try {
    const url = contentView ? contentView.webContents.getURL() : '';
    onServer = /^https?:/.test(url);
  } catch { /* the layer may be gone */ }
  return { onServer, dark: nativeTheme.shouldUseDarkColors };
}

function sendBarState() {
  if (mainWindow && !mainWindow.isDestroyed())
    mainWindow.webContents.send('bar:state', barState());
}

/**
 * SHA-256 over a certificate's DER encoding, lower-case hex -- the same value
 * `openssl x509 -fingerprint -sha256` prints, which is what the installer
 * writes into result.json.
 *
 * Electron hands the certificate over as PEM in `.data`; its own
 * `.fingerprint` is base64 in Chromium's format, so it is not comparable to
 * the installer's value without converting anyway.
 */
function certFingerprint(certificate) {
  try {
    const pem = certificate && certificate.data;
    if (!pem) return null;
    const body = pem
      .replace(/-----BEGIN CERTIFICATE-----/, '')
      .replace(/-----END CERTIFICATE-----/, '')
      .replace(/\s+/g, '');
    const der = Buffer.from(body, 'base64');
    if (!der.length) return null;
    return crypto.createHash('sha256').update(der).digest('hex');
  } catch {
    return null;
  }
}

function createWindow() {
  const winIcon = fs.existsSync(ICON_PATH) ? nativeImage.createFromPath(ICON_PATH) : null;
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 500,
    title: 'SOZVON',
    backgroundColor: windowBackground(),
    icon: winIcon && !winIcon.isEmpty() ? ICON_PATH : undefined,
    autoHideMenuBar: true,
    // No system title bar.  What sits along the top instead is our own bar --
    // this window's own page, renderer/titlebar.html -- with the system's
    // minimise/maximise/close drawn over its right end in our colours.
    titleBarStyle: 'hidden',
    titleBarOverlay: overlayColors(),
    webPreferences: {
      preload: path.join(__dirname, 'titlebar-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'titlebar.html'));

  // A renderer that throws does it silently: nothing reaches the terminal,
  // and a bar whose script died looks exactly like a bar whose buttons are
  // not wired up.  Both are worth seeing while the app is run from source.
  for (const wc of [mainWindow.webContents, ...(contentView ? [contentView.webContents] : [])]) {
    wc.on('preload-error', (_e, file, err) =>
      console.error('preload failed:', file, err));
  }
  mainWindow.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) console.error('bar:', message);
  });

  // Everything the app shows goes in a layer of its own, below the bar.
  //
  // The bar was tried the other way first -- drawn over the page, with an
  // invisible region for dragging -- and a page we do not own cannot afford
  // it: a draggable region takes the click before the page is asked, so it
  // swallowed whatever it covered, and each control it hid had to be dug out
  // by hand.  Two layers mean the question never arises.  Nothing overlaps,
  // so no page has to be told the app bar is there, and a server's client
  // needs no special case at all.
  contentView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  mainWindow.contentView.addChildView(contentView);
  layoutContent();
  mainWindow.on('resize', layoutContent);
  mainWindow.on('maximize', layoutContent);
  mainWindow.on('unmaximize', layoutContent);

  // The bar greys out what makes no sense on the launcher, so it has to hear
  // about every move between our own pages and a server.
  for (const event of ['did-navigate', 'did-navigate-in-page', 'did-finish-load'])
    contentView.webContents.on(event, sendBarState);
  mainWindow.webContents.on('did-finish-load', sendBarState);

  // A server installed with the self-signed TLS mode presents a certificate
  // no authority vouches for.  We accept exactly the certificate whose
  // fingerprint the installer reported over our own SSH session -- and
  // nothing else.
  //
  // The previous behaviour here accepted *any* certificate whenever
  // allowInsecureCerts was set, which is not what the documentation promised
  // and left the connection open to whoever can answer for the address.
  // That switch now only relaxes things for hosts we have no pin for.
  contentView.webContents.session.setCertificateVerifyProc((req, cb) => {
    // 0 = trust this certificate, -2 = reject it, -3 = use Chromium's own
    // verification result (the normal path for a real CA-signed cert).
    const pinned = (config.pinnedCerts || {})[req.hostname];
    if (pinned) {
      const actual = certFingerprint(req.certificate);
      cb(actual && actual === pinned ? 0 : -2);
      return;
    }
    if (config.allowInsecureCerts) {
      cb(0);
      return;
    }
    cb(-3);
  });

  contentView.webContents.session.setPermissionRequestHandler((wc, permission, cb) => {
    const allowed = ['media', 'display-capture', 'notifications', 'fullscreen', 'clipboard-read', 'clipboard-sanitized-write'];
    cb(allowed.includes(permission));
  });

  contentView.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // A server page that fails to load leaves Chromium's own error page in the
  // window, which has no way out either.  Come back to the launcher and say
  // what happened, rather than stranding the user in a dead end.  -3 is
  // ABORTED, which every ordinary redirect and in-page navigation produces.
  contentView.webContents.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return;
    if (url.startsWith('file://')) return;   // our own pages
    showLauncher(description || `Ошибка загрузки (${code})`);
  });

  showLauncher();

  // Debug aid: SOZVON_SHOT=<dir> saves what each layer is actually painting, a
  // couple of seconds in.  There is no other way to look at the two layers
  // from outside the app.
  if (process.env.SOZVON_SHOT) {
    setTimeout(async () => {
      const dir = process.env.SOZVON_SHOT;
      try {
        // Geometry first: a capture comes back empty when the window is not
        // compositing (minimised, or behind something), and the layout is
        // what actually matters here.
        const geom = await mainWindow.webContents.executeJavaScript(`
          JSON.stringify({
            body: document.body.getBoundingClientRect().toJSON(),
            servers: document.getElementById('servers').getBoundingClientRect().toJSON(),
            theme: document.getElementById('theme').getBoundingClientRect().toJSON(),
            bridge: !!window.sozvonBar,
          })`);
        console.log('bar geometry:', geom);
        const bar = await mainWindow.webContents.capturePage();
        fs.writeFileSync(path.join(dir, 'bar.png'), bar.toPNG());
        const body = await contentView.webContents.capturePage();
        fs.writeFileSync(path.join(dir, 'content.png'), body.toPNG());
        console.log('shot: bar', bar.getSize(), 'content', body.getSize(),
                    'bounds', JSON.stringify(contentView.getBounds()),
                    'url', contentView.webContents.getURL());
      } catch (e) {
        console.error('shot failed:', e);
      }
    }, 2500);
  }
}

/**
 * Back to the server picker.  Everything that gets the user out of a loaded
 * server goes through here: the app bar, the menu, the accelerator, the web
 * client's "App" section over the SozvonApp bridge, and a failed load.
 */
function showLauncher(error) {
  if (!contentView) return;
  const file = path.join(__dirname, 'renderer', 'launcher.html');
  contentView.webContents.loadFile(file, error ? { query: { error: String(error) } } : undefined);
}

/** Drop the saved web login (a token in the page's own storage) and reload. */
async function resetLogin() {
  if (!contentView) return;
  const url = contentView.webContents.getURL();
  try {
    await contentView.webContents.session.clearStorageData({
      origin: new URL(url).origin,
    });
  } catch (e) {
    console.error('resetLogin failed:', e);
  }
  contentView.webContents.reload();
}

/**
 * The application menu exists so that a loaded server is never a trap: it
 * carries the way back, and it works even when the page in the window is a
 * browser error page that knows nothing about us.
 */
function buildMenu() {
  return Menu.buildFromTemplate([
    {
      label: 'Сервер',
      submenu: [
        {
          label: 'Сменить сервер',
          accelerator: 'CmdOrCtrl+Shift+S',
          click: () => showLauncher(),
        },
        {
          label: 'Сбросить вход на этом устройстве',
          click: () => resetLogin(),
        },
        { type: 'separator' },
        { label: 'Обновить', accelerator: 'CmdOrCtrl+R', role: 'reload' },
        // The key people actually press to reload a page.  Hidden so the menu
        // does not list the same action twice; the accelerator still works.
        { accelerator: 'F5', role: 'reload', visible: false },
        { type: 'separator' },
        { label: 'Выход', role: 'quit' },
      ],
    },
    {
      label: 'Вид',
      submenu: [
        { label: 'Во весь экран', role: 'togglefullscreen' },
        { type: 'separator' },
        { label: 'Крупнее', role: 'zoomIn' },
        { label: 'Мельче', role: 'zoomOut' },
        { label: 'Обычный масштаб', role: 'resetZoom' },
        { type: 'separator' },
        { label: 'Инструменты разработчика', role: 'toggleDevTools' },
      ],
    },
  ]);
}

app.whenReady().then(() => {
  // Before the window exists, so its very first paint is the right colour.
  applyTheme(config.theme);
  Menu.setApplicationMenu(buildMenu());
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('config:get', () => config);
ipcMain.handle('config:set', (_e, patch) => {
  const before = config.allowInsecureCerts;
  config = { ...config, ...patch };
  saveConfig(config);

  // Chromium remembers how it verified a host, so our certificate check only
  // sees the new setting in a fresh session: tick the box and the very next
  // connection still fails, with the same message as before.  The checkbox
  // used to admit this by saying a restart was needed, which is a chore to
  // hand to somebody when the app can do it itself.  Deferred a moment so
  // this call's reply and the write above both land first.
  if (patch && 'allowInsecureCerts' in patch &&
      before !== config.allowInsecureCerts) {
    setTimeout(() => {
      app.relaunch();
      app.exit(0);
    }, 200);
  }
  return config;
});

// An empty group means the server's front page.  On a server whose group is an
// operator hub that page is the operator's dashboard, which is where the person
// who owns the server belongs -- not in a call.  There is no room to remember
// in that case, so the recent list is left alone.
ipcMain.handle('group:open', (_e, { serverUrl, group }) => {
  if (!mainWindow) return;
  const base = serverUrl.replace(/\/+$/, '');
  const url = group
    ? `${base}/group/${encodeURIComponent(group)}/`
    : `${base}/`;
  rememberServer(base, group);
  saveConfig(config);
  // The menu bar used to be pinned open from here, because a server's page
  // has no way back of its own and the menu was the only one.  The app bar is
  // that way out now, on every page and without a strip of native menu on top
  // of the call; the menu stays under Alt as the backstop it was meant to be.
  contentView.webContents.loadURL(url);
});

// The operator room is the server's front page: on a server whose group is an
// operator hub, that is the dashboard.  Same address the launcher opens when
// the room field is left empty.
ipcMain.handle('bar:open-hub', () => {
  if (!contentView) return;
  let origin;
  try {
    origin = new URL(contentView.webContents.getURL()).origin;
  } catch {
    return;
  }
  rememberServer(origin, '');
  saveConfig(config);
  contentView.webContents.loadURL(`${origin}/`);
});

ipcMain.handle('bar:reload', () => contentView && contentView.webContents.reload());

ipcMain.handle('bar:state', () => barState());

ipcMain.handle('servers:remove', (_e, url) => {
  config.servers = (config.servers || []).filter(s => !sameServer(s.url, url));
  if (sameServer(config.serverUrl, url)) {
    const next = config.servers[0];
    config.serverUrl = next ? next.url : '';
    config.lastGroup = next ? (next.lastGroup || '') : '';
    config.recentGroups = next && Array.isArray(next.rooms) ? next.rooms.slice() : [];
  }
  saveConfig(config);
  return config;
});

ipcMain.handle('servers:rename', (_e, { url, name }) => {
  const s = (config.servers || []).find(s => sameServer(s.url, url));
  if (s) s.name = String(name || '').trim().slice(0, 60);
  saveConfig(config);
  return config;
});

ipcMain.handle('group:back-to-launcher', () => showLauncher());

ipcMain.handle('app:reset-login', () => resetLogin());

// The loaded server page telling us which appearance the user chose, or our
// own launcher doing the same from the button beside the window controls.  It
// is remembered as well as applied: the launcher opens before any page can
// report, and it should not open in the theme the user just left behind.
ipcMain.handle('app:set-theme', (_e, pref) => {
  const known = (pref === 'light' || pref === 'dark') ? pref : 'system';
  const changed = config.theme !== known;
  if (changed) {
    config = { ...config, theme: known };
    saveConfig(config);
  }
  // A report that tells us what we already knew needs nothing done about it:
  // no themeSource to set, and above all nothing to push back at the page
  // that just told us.
  if (changed || nativeTheme.themeSource !== known)
    applyTheme(known);
  // The bar draws a moon or a sun for the theme in force, so it has to hear
  // about this whether the change came from its own button or from the
  // client's settings.
  sendBarState();
  return { pref: known, dark: nativeTheme.shouldUseDarkColors };
});

// Synchronous on purpose, and the only such call in the app.  The preload
// hands this to the page before its own scripts run, so that a server's
// client starts in the appearance the app is already showing instead of
// painting its own and correcting itself a frame later.  An invoke() would
// resolve too late to be of any use there.
ipcMain.on('app:theme-sync', (e) => {
  e.returnValue = config.theme || 'system';
});

// ---------------------------------------------------------------- deploy ---

ipcMain.handle('deploy:open', () => {
  if (!contentView) return;
  contentView.webContents.loadFile(path.join(__dirname, 'renderer', 'deploy.html'));
});

/**
 * Ask the renderer whether to trust a host key, and wait for the answer.
 *
 * Accepting a host key silently would hand root on the target server to
 * anyone able to sit between us and it, so this is a real prompt with a real
 * fingerprint -- not a formality.
 */
function askHostKey(info) {
  return new Promise((resolve) => {
    if (!mainWindow) { resolve(false); return; }
    const known = (config.knownHosts || {})[`${info.host}:${info.port}`];
    const timer = setTimeout(() => {
      ipcMain.removeAllListeners('deploy:hostkey-answer');
      resolve(false);
    }, 5 * 60 * 1000);

    ipcMain.once('deploy:hostkey-answer', (_e, accepted) => {
      clearTimeout(timer);
      if (accepted) {
        config.knownHosts = { ...(config.knownHosts || {}) };
        config.knownHosts[`${info.host}:${info.port}`] = info.fingerprint;
        saveConfig(config);
      }
      resolve(!!accepted);
    });

    // A key that changed is not the same question as a key never seen: one
    // is routine, the other means the server was replaced -- or someone is
    // impersonating it.
    contentView.webContents.send('deploy:hostkey', {
      ...info,
      status: !known ? 'new' : (known === info.fingerprint ? 'known' : 'changed'),
      previous: known && known !== info.fingerprint ? known : undefined,
    });
  });
}

ipcMain.handle('deploy:start', async (_e, opts) => {
  const { Deployer, originOf } = require('./deploy/deployer');
  const send = (channel, payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      contentView.webContents.send(channel, payload);
    }
  };

  const d = new Deployer({
    host: opts.host,
    port: opts.port,
    username: opts.username,
    password: opts.password,
    privateKey: opts.privateKeyPath
      ? fs.readFileSync(opts.privateKeyPath)
      : undefined,
    passphrase: opts.passphrase,
    // No explicit scriptPath: the deployer resolves the packaged copy under
    // resources/ and falls back to contrib/install.sh when running from a
    // checkout, where that copy has not been generated yet.
    verifyHostKey: async (info) => {
      const stored = (config.knownHosts || {})[`${info.host}:${info.port}`];
      if (stored && stored === info.fingerprint) return true;
      return await askHostKey(info);
    },
    onEvent: (ev) => send('deploy:progress', ev),
  });

  try {
    await d.connect();
    const result = await d.deploy({
      tlsMode: opts.tlsMode,
      domain: opts.domain,
      // The address we reached the server at is, by definition, one that
      // works from here.  Left to guess, the installer asks an outside
      // service for "your public IP" and gets whatever the server's traffic
      // exits through -- a VPN endpoint, a NAT gateway -- which is not where
      // this server answers.
      ip: opts.ip || opts.host,
      group: opts.group,
      adminUser: opts.adminUser,
      version: opts.version,
      mirror: opts.mirror,
    });
    // Remember the server so the launcher is ready to connect to it, but
    // never the SSH credentials: once the server is up, this app talks to it
    // over HTTPS and has no further use for shell access.  It joins the list
    // rather than replacing it: installing a second server must not cost the
    // user the first one.
    rememberServer(originOf(result), result.hub ? '' : (result.group || ''));
    const installed = (config.servers || [])[0];
    if (installed && !installed.name) {
      try {
        installed.name = new URL(originOf(result)).hostname;
      } catch { /* leave it unnamed */ }
    }
    // Pin the certificate the installer just generated, rather than
    // switching off verification for everything.
    if (result.tls_mode === 'self-signed' && result.cert_sha256) {
      config.pinnedCerts = { ...(config.pinnedCerts || {}) };
      config.pinnedCerts[result.hostname] = String(result.cert_sha256).toLowerCase();
    }
    saveConfig(config);
    return { ok: true, result };
  } catch (e) {
    return {
      ok: false,
      code: e.code || 'error',
      message: e.message || String(e),
      detail: e.detail,
    };
  } finally {
    d.disconnect();
  }
});
