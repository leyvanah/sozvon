const { app, BrowserWindow, WebContentsView, session, ipcMain, Menu, shell, nativeImage, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { createTray } = require('./tray');
const { createKnocks } = require('./knocks');

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
  // Closing the window puts the app in the tray instead of ending it, so a
  // knock still reaches the operator afterwards.  Off, and the app behaves
  // like any other window -- and hears nothing once it is shut.
  minimizeToTray: true,
  // Start with Windows, in the tray.  Off by default: an app that adds
  // itself to your startup unasked is a liberty, and the tray menu is where
  // it gets asked.
  autoStart: false,
  // Whether the "it is still running down here" balloon has been shown.  It
  // is an explanation, and an explanation repeated is a nag.
  trayHintShown: false,
  // Every server this client has been to: {url, name, hub, lastGroup, rooms[]}.
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
let tray = null;

// Set once the user has actually asked to leave, so the close button can mean
// "put it away" without making the app impossible to end.
let quitting = false;

/**
 * Whether anyone would hear a knock right now.
 *
 * Duty is not a mode the app enters; it is a fact about the page in the
 * window -- the operator room is open, so its three-second poll is running
 * and knocks are arriving.  Derived from what the page reports rather than
 * remembered here, because a state kept in parallel with the truth is a
 * state that eventually disagrees with it, and this one would disagree by
 * claiming to be watching when it is not.
 */
let duty = { onDuty: false, hub: null, knocks: 0 };

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

// ------------------------------------------------------------------ duty ---

/** Bring the window back from wherever it went: the tray, or behind things. */
function showWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/**
 * The server whose operator room we know about, most recent first.
 *
 * The name is learnt by going there once: the client reports it over the
 * bridge when it puts up the dashboard.  Nothing here guesses -- a server
 * with no operator room must not be offered as a place to stand watch.
 */
function hubEntry() {
  return (config.servers || []).find(s => s && s.url && s.hub) || null;
}

/** Open the operator room, from the tray or from a window that is elsewhere. */
function openHub() {
  const entry = hubEntry();
  if (!entry || !contentView) return;
  const base = String(entry.url).replace(/\/+$/, '');
  rememberServer(base, '');
  saveConfig(config);
  contentView.webContents.loadURL(
    `${base}/group/${encodeURIComponent(entry.hub)}/`);
  showWindow();
}

/**
 * Remember which page is the operator room, and that we are on it.
 *
 * Called from the bridge when the client raises the dashboard, which is also
 * the moment its poll starts -- so this is duty beginning, reported by the
 * only party that can tell.
 *
 * @param {string} name - the hub's group name
 */
function setHub(name) {
  const hub = String(name || '').trim();
  if (!hub) return;
  let origin;
  try {
    origin = new URL(contentView.webContents.getURL()).origin;
  } catch {
    return;
  }
  const entry = (config.servers || []).find(s => sameServer(s.url, origin));
  if (entry && entry.hub !== hub) {
    entry.hub = hub;
    saveConfig(config);
  }
  duty = { ...duty, onDuty: true, hub };
  refreshTray();
}

/**
 * Duty ends with the page that was doing it.  Any navigation of the content
 * layer drops it; the next dashboard to load reports itself and sets it
 * again.  The hub's *name* survives, because it is a fact about the server
 * rather than about this moment.
 */
function clearDuty() {
  if (!duty.onDuty) return;
  duty = { ...duty, onDuty: false };
  refreshTray();
}

function refreshTray() {
  if (tray) tray.refresh();
}

// --------------------------------------------------------------- knocks ---

/**
 * Everyone currently waiting to be let in, as the page told us about them.
 *
 * Kept here rather than in the notification windows because a notification is
 * a view of a knock, not the knock itself: it is taken down when the operator
 * looks at the app and put back when they look away, and neither of those is
 * the person at the door giving up.
 *
 * @type {Map<string, {knock: Object, dismissed: boolean}>}
 */
const outstanding = new Map();
let knocks = null;

/** Is the app the window the user is actually looking at? */
function appHasTheirAttention() {
  return !!(mainWindow && !mainWindow.isDestroyed() &&
            mainWindow.isVisible() && mainWindow.isFocused());
}

/**
 * Show or take down the notifications, according to whether the app is the
 * window in front.
 *
 * A notification above other windows is for when Sozvon is not the window in
 * front.  When it is, the client's own toast is already on screen, an inch
 * from the cursor, and a second copy of it floating over the app would be
 * noise -- so they go away on focus and come back on blur, for as long as
 * the person is still waiting.
 *
 * One that was closed by hand stays closed: it was not answered, but it was
 * seen, and showing it again every time the operator glances at another
 * window is nagging rather than notifying.
 */
function syncKnockWindows() {
  if (!knocks) return;
  if (appHasTheirAttention()) {
    knocks.dismissAll();
    return;
  }
  for (const entry of outstanding.values()) {
    if (!entry.dismissed) knocks.show(entry.knock);
  }
}

/** A knock the client is offering us. */
function knockArrived(knock) {
  if (!knock || !knock.key) return;
  const before = outstanding.get(knock.key);
  outstanding.set(knock.key, {
    knock,
    // A refreshed knock -- another name joining the same queue -- is new
    // information, so a notification closed before this is owed again.
    dismissed: before ? before.dismissed && before.knock.text === knock.text
                      : false,
  });
  duty = { ...duty, knocks: outstanding.size };
  syncKnockWindows();
  refreshTray();
}

/** Admitted, denied, or the person gave up: it is over wherever it happened. */
function knockGone(key) {
  if (!key) return;
  outstanding.delete(key);
  if (knocks) knocks.dismiss(key);
  duty = { ...duty, knocks: outstanding.size };
  refreshTray();
}

/** Nobody is knocking at a page we have navigated away from. */
function knocksClear() {
  outstanding.clear();
  if (knocks) knocks.dismissAll();
  duty = { ...duty, knocks: 0 };
  refreshTray();
}

/**
 * Start with Windows, or stop doing so.
 *
 * The extra argument is what makes it bearable: started by the system, the
 * app goes straight to the tray instead of throwing a window at somebody who
 * was trying to log in.
 *
 * @param {boolean} on
 */
function setAutoStart(on) {
  config = { ...config, autoStart: !!on };
  saveConfig(config);
  try {
    app.setLoginItemSettings({
      openAtLogin: !!on,
      args: ['--hidden'],
    });
  } catch (e) {
    console.error('setLoginItemSettings failed:', e);
  }
}

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
  // The event carries its details on itself since Electron 35; the old
  // positional (level, message) arguments are deprecated.
  mainWindow.webContents.on('console-message', (e) => {
    if (e.level === 'warning' || e.level === 'error')
      console.error('bar:', e.message);
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
      sandbox: false,
      // Chromium slows a hidden window's timers to one tick a minute, which
      // is the right default and ruinous here: the operator room polls every
      // three seconds, and the whole point of the tray is that the window is
      // hidden while it does.  Throttled, a knock would surface up to a
      // minute late -- long after the person gave up.
      backgroundThrottling: false,
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

  // Duty belongs to the page doing it, so it ends when that page goes.  Only
  // a real navigation counts: an in-page one is the dashboard still being the
  // dashboard.
  contentView.webContents.on('did-start-navigation', (e) => {
    if (e.isMainFrame && !e.isSameDocument) {
      clearDuty();
      // The page that knew about these knocks is gone, and with it any
      // chance of acting on them: a live Admit button for a room we have
      // left is worse than no button.
      knocksClear();
    }
  });

  // The notifications exist for the time the app is not the window in front,
  // so they follow that exactly -- including the window being put away in
  // the tray, which fires neither focus nor blur.
  for (const event of ['focus', 'blur', 'show', 'hide', 'minimize', 'restore'])
    mainWindow.on(event, syncKnockWindows);

  // The close button puts the app away rather than ending it, so that the
  // operator room it is holding open keeps being held open.  "Away" has to
  // be somewhere findable: the tray icon is the app's only remaining face,
  // and the first time this happens it says so out loud.
  mainWindow.on('close', (e) => {
    if (quitting || config.minimizeToTray === false || !tray) return;
    e.preventDefault();
    mainWindow.hide();
    if (!config.trayHintShown) {
      config = { ...config, trayHintShown: true };
      saveConfig(config);
      tray.hint('SOZVON продолжает работать',
                'Приложение свернулось в трей и покажет, когда кто-то ' +
                'постучится. Выйти совсем — правая кнопка по значку.');
    }
  });

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

// An app that lives in the tray must be one app.  Started a second time --
// from the Start menu, from a shortcut, by the system at login while it is
// already running -- the newcomer hands the window over to the copy that is
// already on duty and leaves, rather than raising a second one whose idea of
// who is knocking disagrees with the first.
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());

  app.whenReady().then(() => {
    // Before the window exists, so its very first paint is the right colour.
    applyTheme(config.theme);
    Menu.setApplicationMenu(buildMenu());
    createWindow();

    knocks = createKnocks({
      preload: path.join(__dirname, 'knock-preload.js'),
      page: path.join(__dirname, 'renderer', 'knock.html'),
      anchor: () => mainWindow,
      onAction: (key, action) => {
        if (contentView && !contentView.webContents.isDestroyed())
          contentView.webContents.send('app:knock-action', { key, action });
        // Admitting is joining: the operator has just decided to be in this
        // call, so put them in front of it.  Denying is not -- they stay
        // where they were.
        if (action === 'admit') showWindow();
      },
      onDismiss: (key) => {
        const entry = outstanding.get(key);
        if (entry) entry.dismissed = true;
      },
    });

    tray = createTray({
      iconPath: ICON_PATH,
      getConfig: () => config,
      setConfig: (patch) => {
        config = { ...config, ...patch };
        saveConfig(config);
      },
      getDuty: () => duty,
      showWindow,
      openHub,
      setAutoStart,
      quit: () => {
        quitting = true;
        app.quit();
      },
    });

    // Keep the system's idea of our startup entry in step with ours: the
    // shortcut can be removed from Task Manager's Startup tab, and a
    // checkbox that then still claims to be on is a lie about the one thing
    // this setting is for.
    try {
      const live = app.getLoginItemSettings({ args: ['--hidden'] }).openAtLogin;
      if (live !== !!config.autoStart) {
        config = { ...config, autoStart: live };
        saveConfig(config);
        refreshTray();
      }
    } catch { /* not a platform with login items */ }

    // Debug aid: SOZVON_KNOCK_DEMO=1 puts a knock on screen a few seconds in,
    // so the notification's placement, wrapping and buttons can be worked on
    // without a server, an operator account and somebody to knock.  Its
    // buttons go nowhere -- there is no page to act on.
    if (process.env.SOZVON_KNOCK_DEMO) {
      setTimeout(() => {
        knockArrived({
          key: 'demo',
          text: 'Иван Петров стучится — приём',
          actions: [{ id: 'admit', label: 'Впустить и присоединиться',
                      primary: true },
                    { id: 'deny', label: 'Отклонить' }],
        });
      }, 3000);
    }

    // Started by the system at login: go to the tray, and let the operator
    // get on with logging in.
    if (process.argv.includes('--hidden') && config.minimizeToTray !== false)
      mainWindow.hide();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('before-quit', () => { quitting = true; });

app.on('window-all-closed', () => {
  // With the tray holding the app open there is no window left to close it:
  // quitting here would undo the hiding we just did.
  if (tray && config.minimizeToTray !== false && !quitting) return;
  if (process.platform !== 'darwin') app.quit();
});

// --------------------------------------------------------- IPC spheres ---
//
// The view below the bar carries our own pages, loaded from disk, and a
// server's page, loaded over the network.  preload.js hands the app's
// controls only to the first kind; this is the other half of the same fence,
// and it is not redundant: a preload decides what a page is given, and this
// decides what the main process is willing to answer.  Either one alone is a
// single point of failure, and one of them is a file that is easy to extend
// without noticing what it is for.

/**
 * Whether a call came from one of the app's own pages.
 *
 * @param {Electron.IpcMainEvent|Electron.IpcMainInvokeEvent} event
 * @returns {boolean}
 */
function fromOurOwnPage(event) {
  let frame;
  try {
    // Accessing the frame of a navigation that has already gone throws.
    frame = event.senderFrame;
  } catch {
    return false;
  }
  if (!frame) return false;
  try {
    return new URL(frame.url).protocol === 'file:';
  } catch {
    return false;
  }
}

/**
 * Register a handler for a channel only the app's own pages may use.
 *
 * @param {string} channel
 * @param {(event: Electron.IpcMainInvokeEvent, ...args: any[]) => any} fn
 */
function handleOurs(channel, fn) {
  ipcMain.handle(channel, (event, ...args) => {
    if (!fromOurOwnPage(event)) {
      console.error(`refused ${channel}: not from one of our own pages`);
      throw new Error(`${channel} is not available to this page`);
    }
    return fn(event, ...args);
  });
}

handleOurs('config:get', () => config);
handleOurs('config:set', (_e, patch) => {
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
handleOurs('group:open', (_e, { serverUrl, group }) => {
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
handleOurs('bar:open-hub', () => {
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

handleOurs('bar:reload', () => contentView && contentView.webContents.reload());

handleOurs('bar:state', () => barState());

handleOurs('servers:remove', (_e, url) => {
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

handleOurs('servers:rename', (_e, { url, name }) => {
  const s = (config.servers || []).find(s => sameServer(s.url, url));
  if (s) s.name = String(name || '').trim().slice(0, 60);
  saveConfig(config);
  return config;
});

ipcMain.handle('group:back-to-launcher', () => showLauncher());

// The client saying "this page is an operator room".  It is the only way the
// app can know: a hub is an ordinary group as far as the address goes, and
// only the server decides which groups are hubs.
ipcMain.handle('app:set-hub', (_e, name) => setHub(name));

// Somebody is waiting in a lobby.  What the knock says and what may be done
// about it were decided by the client, which is the side that knows; all we
// are given is a sentence and the buttons to put under it.
ipcMain.handle('app:knock', (_e, knock) => knockArrived(knock));
ipcMain.handle('app:knock-gone', (_e, key) => knockGone(key));

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

handleOurs('deploy:open', () => {
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
    // Answering this is accepting a host key, so it is for the deploy page
    // and nobody else.  A call from anywhere else is ignored rather than
    // taken as "no": the prompt stays up, and the person still decides.
    const onAnswer = (e, accepted) => {
      if (!fromOurOwnPage(e)) {
        console.error('refused deploy:hostkey-answer: not from one of our own pages');
        return;
      }
      ipcMain.removeListener('deploy:hostkey-answer', onAnswer);
      clearTimeout(timer);
      if (accepted) {
        config.knownHosts = { ...(config.knownHosts || {}) };
        config.knownHosts[`${info.host}:${info.port}`] = info.fingerprint;
        saveConfig(config);
      }
      resolve(!!accepted);
    };

    const timer = setTimeout(() => {
      ipcMain.removeListener('deploy:hostkey-answer', onAnswer);
      resolve(false);
    }, 5 * 60 * 1000);

    ipcMain.on('deploy:hostkey-answer', onAnswer);

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

handleOurs('deploy:start', async (_e, opts) => {
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
