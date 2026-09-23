// Tests for which page the desktop app answers, and how far it lets one go.
// (Sozvon)
//
// Run with:  node --test desktop/test/
//
// The app puts two very different things in one window: its own launcher and
// deploy wizard, loaded from disk, and a server's web client, loaded over the
// network from an address somebody typed.  Everything here is about the line
// between them -- which page is handed the app's controls, which calls the
// main process answers, what a page may be granted without being asked, and
// where the window may be sent.  None of it shows up in ordinary use: a page
// that is given too much looks exactly like one that is not.
//
// main.js and preload.js expect Electron, which the CI job for the desktop
// does not install (only the runtime dependency is needed there), and a real
// window besides.  Both are therefore evaluated in a vm context with Electron
// stubbed, which is enough to reach the decisions -- they are plain functions
// over a URL and a configuration.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {pathToFileURL} = require('node:url');

const srcDir = path.join(__dirname, '..', 'src');
const rendererDir = path.join(srcDir, 'renderer');

const quiet = {log() {}, warn() {}, error() {}};

/** A configuration as the app would have stored it, with one known server. */
const STORED_CONFIG = {
  serverUrl: 'https://known.example',
  servers: [
    {url: 'https://known.example', name: '', rooms: []},
    {url: 'http://plain.example', name: '', rooms: []},
  ],
  pinnedCerts: {'known.example': 'aa:bb'},
  knownHosts: {'known.example:22': 'SHA256:deadbeef'},
  allowInsecureCerts: false,
};

/**
 * Evaluate main.js with Electron, the filesystem and the app's own modules
 * stubbed.  Returns the stubs, so a test can call a channel the way a page
 * would and see what the app did about it.
 */
function loadMain() {
  const invokes = new Map();   // channel -> handler registered with handle()
  const sends = new Map();     // channel -> [listener] registered with on()
  const written = [];          // what saveConfig wrote
  const opened = [];           // addresses handed to the real browser

  // What createWindow() wires up, kept where a test can call it.
  const wired = {events: new Map(), loaded: []};

  const webContents = (url) => ({
    on: (event, fn) => {
      if (!wired.events.has(event)) wired.events.set(event, []);
      wired.events.get(event).push(fn);
    },
    session: {
      setCertificateVerifyProc: (fn) => wired.certificate = fn,
      setPermissionRequestHandler: (fn) => wired.permissionRequest = fn,
      setPermissionCheckHandler: (fn) => wired.permissionCheck = fn,
    },
    setWindowOpenHandler: (fn) => wired.windowOpen = fn,
    loadFile: () => {},
    loadURL: (to) => wired.loaded.push(to),
    reload: () => {},
    getURL: () => url,
    send: () => {},
    isDestroyed: () => false,
  });

  const electron = {
    app: {
      getPath: () => '/nowhere',
      setAppUserModelId() {},
      whenReady: () => new Promise(() => {}),  // no window is ever built
      requestSingleInstanceLock: () => true,
      on() {},
      quit() {},
      relaunch() {},
      exit() {},
    },
    BrowserWindow: class {
      constructor() {
        this.webContents = webContents(OUR_LAUNCHER);
        this.contentView = {addChildView() {}};
      }
      static getAllWindows() { return []; }
      on() {}
      loadFile() {}
      getContentBounds() { return {width: 1280, height: 800}; }
      isDestroyed() { return false; }
      show() {}
      hide() {}
      focus() {}
      restore() {}
      isMinimized() { return false; }
      isVisible() { return true; }
    },
    WebContentsView: class {
      constructor() {
        this.webContents = webContents(A_SERVER_PAGE);
      }
      setBounds() {}
    },
    session: {},
    ipcMain: {
      handle: (channel, fn) => invokes.set(channel, fn),
      on: (channel, fn) => {
        if (!sends.has(channel)) sends.set(channel, []);
        sends.get(channel).push(fn);
      },
      once: (channel, fn) => {
        if (!sends.has(channel)) sends.set(channel, []);
        sends.get(channel).push(fn);
      },
      removeListener() {},
      removeAllListeners() {},
    },
    Menu: {buildFromTemplate: () => ({}), setApplicationMenu() {}},
    shell: {openExternal: (url) => opened.push(url)},
    nativeImage: {createFromPath: () => ({isEmpty: () => true})},
    nativeTheme: {on() {}, themeSource: 'system', shouldUseDarkColors: false},
  };

  const fakeFs = {
    existsSync: () => false,
    readFileSync: () => JSON.stringify(STORED_CONFIG),
    writeFileSync: (p, data) => written.push({path: p, data: data}),
    mkdirSync() {},
  };

  const ctx = vm.createContext({
    require: (name) => {
      if (name === 'electron') return electron;
      if (name === 'fs') return fakeFs;
      // The tray and the knock windows are Electron of their own and none of
      // this is about them.
      if (name === './tray') return {createTray: () => null};
      if (name === './knocks') return {createKnocks: () => ({})};
      return require(name);
    },
    __dirname: srcDir,
    console: quiet,
    process: process,
    URL: URL,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    Buffer: Buffer,
  });
  vm.runInContext(fs.readFileSync(path.join(srcDir, 'main.js'), 'utf8'), ctx);

  return {
    ctx: ctx,
    invokes: invokes,
    sends: sends,
    written: written,
    opened: opened,
    wired: wired,
    /** Build the window, so that what it wires up can be called. */
    buildWindow: () => {
      vm.runInContext('createWindow()', ctx);
      return wired;
    },
    /** Ask main.js something about its own state, by name. */
    read: (expression) => vm.runInContext(expression, ctx),
  };
}

/** An IPC event as it arrives from a page at the given address. */
function from(url) {
  return {senderFrame: {url: url}};
}

// The app's own pages are the ones in the app's own directory, so these are
// built from it rather than written out.
const OUR_LAUNCHER = pathToFileURL(path.join(rendererDir, 'launcher.html')).href;
const OUR_DEPLOY = pathToFileURL(path.join(rendererDir, 'deploy.html')).href;
// A page loaded from disk that is not ours: a downloaded file, or anything
// else a file:// address can be pointed at.
const A_LOCAL_FILE = pathToFileURL(
  path.join(srcDir, '..', '..', 'elsewhere.html')).href;
const A_SERVER_PAGE = 'https://untrusted.example/group/lobby/';

// ---- which page is handed the app's controls -------------------------------

/**
 * Evaluate preload.js as it would run on a page at the given address, and
 * return what it put on the window.
 */
function runPreload(url) {
  const exposed = {};
  const electron = {
    contextBridge: {
      exposeInMainWorld: (name, api) => exposed[name] = api,
    },
    ipcRenderer: {
      sendSync: () => 'system',
      invoke: () => Promise.resolve(),
      send() {},
      on() {},
      removeAllListeners() {},
    },
  };
  const ctx = vm.createContext({
    require: (name) => name === 'electron' ? electron : require(name),
    __dirname: srcDir,
    location: new URL(url),
    localStorage: {setItem() {}},
    console: quiet,
  });
  vm.runInContext(fs.readFileSync(path.join(srcDir, 'preload.js'), 'utf8'), ctx);
  return exposed;
}

test('a server page is not handed the app controls', () => {
  const exposed = runPreload(A_SERVER_PAGE);
  assert.strictEqual(
    exposed.sozvon, undefined,
    'a page loaded from a server was given the app\'s privileged bridge',
  );
  // What it is meant to have: the bridge the Android app offers.
  assert.strictEqual(typeof exposed.SozvonApp, 'object');
  assert.strictEqual(typeof exposed.SozvonApp.changeServer, 'function');
});

test('the app\'s own pages are handed the app controls', () => {
  for(const page of [OUR_LAUNCHER, OUR_DEPLOY]) {
    const exposed = runPreload(page);
    assert.strictEqual(typeof exposed.sozvon, 'object', page);
    for(const method of ['getConfig', 'setConfig', 'openGroup', 'startDeploy',
                         'answerHostKey'])
      assert.strictEqual(typeof exposed.sozvon[method], 'function', method);
  }
});

// Loaded from disk is not the same as ours.  What separates them is the
// directory, not the scheme: by scheme, any local file would be one of the
// app's own pages, and the fence would rest on Chromium refusing to navigate
// to file:// from the web -- which is not ours to promise.
test('a local file that is not one of our pages is not handed them', () => {
  const exposed = runPreload(A_LOCAL_FILE);
  assert.strictEqual(
    exposed.sozvon, undefined,
    "a page was given the app's privileged bridge merely for being on disk",
  );
});

// ---- which calls the main process answers ----------------------------------

// The privileged channels, as the preload lists them, plus the bar's own.
const OURS_ONLY = [
  'config:get', 'config:set', 'group:open', 'servers:remove',
  'servers:rename', 'deploy:open', 'deploy:start',
  'bar:open-hub', 'bar:reload', 'bar:state',
];

test('the app\'s own channels are refused to a server page', async () => {
  const app = loadMain();
  for(const channel of OURS_ONLY) {
    const handler = app.invokes.get(channel);
    assert.ok(handler, `${channel} is not registered`);
    await assert.rejects(
      async () => handler(from(A_SERVER_PAGE), {}),
      `${channel} answered a page loaded from a server`,
    );
  }
});

test('a server page cannot rewrite what the app trusts', async () => {
  const app = loadMain();
  await assert.rejects(async () => app.invokes.get('config:set')(
    from(A_SERVER_PAGE),
    {allowInsecureCerts: true, pinnedCerts: {'known.example': 'theirs'}},
  ));
  assert.deepStrictEqual(
    app.written, [], 'the configuration was written for a server page',
  );
  assert.strictEqual(app.read('config.allowInsecureCerts'), false);
  assert.strictEqual(app.read('config.pinnedCerts["known.example"]'), 'aa:bb');
});

test('the app\'s own pages are answered', async () => {
  const app = loadMain();
  const cfg = await app.invokes.get('config:get')(from(OUR_LAUNCHER));
  assert.strictEqual(cfg.serverUrl, 'https://known.example');
});

// A call whose frame has gone -- the page navigated away while it was in
// flight -- cannot be shown to be ours, so it is not treated as ours.
test('a local file that is not one of our pages is not answered', async () => {
  const app = loadMain();
  await assert.rejects(
    async () => app.invokes.get('config:get')(from(A_LOCAL_FILE)),
    'a page was answered merely for being on disk',
  );
});

test('a call from a frame that is gone is refused', async () => {
  const app = loadMain();
  const vanished = {get senderFrame() {
    throw new Error('frame disposed');
  }};
  await assert.rejects(async () => app.invokes.get('config:get')(vanished));
  await assert.rejects(async () => app.invokes.get('config:get')({senderFrame: null}));
});

test('only the settings a page is meant to set are taken', async () => {
  const app = loadMain();
  const cfg = await app.invokes.get('config:set')(from(OUR_LAUNCHER), {
    allowInsecureCerts: true,
    pinnedCerts: {'known.example': 'theirs'},
    knownHosts: {'known.example:22': 'SHA256:theirs'},
    servers: [{url: 'https://theirs.example'}],
  });
  assert.strictEqual(cfg.allowInsecureCerts, true, 'the one settable key was dropped');
  assert.strictEqual(
    cfg.pinnedCerts['known.example'], 'aa:bb',
    'a page rewrote a certificate pin',
  );
  assert.strictEqual(
    cfg.knownHosts['known.example:22'], 'SHA256:deadbeef',
    'a page rewrote an SSH host key',
  );
  assert.strictEqual(
    cfg.servers[0].url, 'https://known.example',
    'a page rewrote the server list',
  );
});

// ---- what a page may be granted, and where the window may go ---------------

test('the camera goes to the user\'s own servers and nowhere else', () => {
  const app = loadMain();
  const may = (permission, url) =>
    app.read(`permissionFor(${JSON.stringify(permission)}, ${JSON.stringify(url)})`);

  for(const permission of ['media', 'display-capture', 'clipboard-read'])
    assert.strictEqual(
      may(permission, 'https://untrusted.example/'), false,
      `${permission} was granted to a page nobody asked for`,
    );

  for(const permission of ['media', 'display-capture', 'clipboard-read',
                           'notifications', 'fullscreen'])
    assert.strictEqual(
      may(permission, 'https://known.example/group/x/'), true,
      `${permission} was refused to the user's own server`,
    );

  // Not on the list at all, whoever is asking.
  for(const permission of ['midi-sysex', 'geolocation', 'openExternal'])
    assert.strictEqual(may(permission, 'https://known.example/'), false, permission);

  // Our own pages do not ask for any of this.
  assert.strictEqual(may('media', OUR_LAUNCHER), false);
});

test('a server remembered without TLS counts when it answers with TLS', () => {
  const app = loadMain();
  const may = (url) => app.read(`permissionFor("media", ${JSON.stringify(url)})`);
  assert.strictEqual(may('http://plain.example/'), true);
  assert.strictEqual(
    may('https://plain.example/'), true,
    'the same server on https was treated as a stranger',
  );
  // and not the other way round: a known https server does not vouch for
  // the same name over http
  assert.strictEqual(may('http://known.example/'), false);
});

test('the window stays on our own pages and the user\'s own servers', () => {
  const app = loadMain();
  const mayStay = (url) => app.read(`mayStayInWindow(${JSON.stringify(url)})`);

  assert.strictEqual(mayStay(OUR_LAUNCHER), true);
  assert.strictEqual(mayStay(OUR_DEPLOY), true);
  assert.strictEqual(
    mayStay(A_LOCAL_FILE), false,
    'the window could be sent to any file on the machine',
  );
  assert.strictEqual(mayStay('https://known.example/group/x/'), true);
  assert.strictEqual(
    mayStay('https://untrusted.example/'), false,
    'the window could be sent to a site the user never chose',
  );
  assert.strictEqual(mayStay('https://known.example.evil.test/'), false);
  assert.strictEqual(mayStay('about:blank'), false);
  assert.strictEqual(mayStay('not a url at all'), false);
});

// The rules above are only worth as much as their being asked.  These two go
// through the window the app actually builds, and call what it handed
// Chromium.

// Who asked matters, and the window's own address is not the answer when the
// asking is done from inside an iframe.
test('a permission asked for from an embedded page is judged by that page', () => {
  const app = loadMain();
  const wired = app.buildWindow();
  const onKnownServer = {getURL: () => 'https://known.example/group/x/'};
  const ask = (details) => {
    let answer;
    wired.permissionRequest(onKnownServer, 'media', (ok) => answer = ok, details);
    return answer;
  };

  assert.strictEqual(
    ask({requestingUrl: 'https://untrusted.example/frame.html',
         isMainFrame: false}),
    false,
    'an embedded stranger was granted what the page around it is allowed',
  );
  // Electron names it differently for media; either name is the frame's.
  assert.strictEqual(
    ask({securityOrigin: 'https://untrusted.example', isMainFrame: false}),
    false,
  );
  // Nothing names the asking frame, and it is not the main one: there is
  // nothing to check, so nothing is granted.
  assert.strictEqual(
    ask({isMainFrame: false}), false,
    "a request that named no address was granted the window's own",
  );
  // The main frame of a server the user chose is still the ordinary case.
  assert.strictEqual(ask({isMainFrame: true}), true);
});

test('the permission handler the window installs asks who is calling', () => {
  const app = loadMain();
  const wired = app.buildWindow();
  assert.ok(wired.permissionRequest, 'no permission handler was installed');

  const ask = (permission, url) => {
    let answer;
    wired.permissionRequest(
      {getURL: () => url}, permission, (ok) => answer = ok,
      {requestingUrl: url, isMainFrame: true},
    );
    return answer;
  };

  assert.strictEqual(
    ask('media', 'https://untrusted.example/'), false,
    'the camera was granted to a page the user never chose',
  );
  assert.strictEqual(
    ask('clipboard-read', 'https://untrusted.example/'), false,
    'the clipboard was read by a page the user never chose',
  );
  assert.strictEqual(ask('media', 'https://known.example/group/x/'), true);

  assert.ok(wired.permissionCheck, 'no permission check handler was installed');
  assert.strictEqual(
    wired.permissionCheck({getURL: () => 'https://untrusted.example/'},
                          'media', 'https://untrusted.example/'),
    false,
  );
});

test('the window the app builds does not follow a page anywhere', () => {
  const app = loadMain();
  const wired = app.buildWindow();
  const leaving = wired.events.get('will-navigate');
  assert.ok(leaving && leaving.length, 'nothing watches where the view goes');

  let prevented = false;
  leaving[0]({preventDefault: () => prevented = true}, 'https://phish.example/');
  assert.strictEqual(
    prevented, true,
    'a page could send the app window to a site of its choosing',
  );
  assert.deepStrictEqual(app.opened, ['https://phish.example/'],
                         'the address did not go to the browser instead');

  prevented = false;
  leaving[0]({preventDefault: () => prevented = true},
             'https://known.example/group/x/');
  assert.strictEqual(prevented, false, 'the user\'s own server was refused');

  // A redirect is a navigation the page did not have to ask for, so it is
  // held to the same rule.
  const redirected = wired.events.get('will-redirect');
  assert.ok(redirected && redirected.length, 'redirects are not checked');
});
