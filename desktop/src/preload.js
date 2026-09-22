const { contextBridge, ipcRenderer } = require('electron');

// Two kinds of page share the view this preload is attached to, and they are
// not owed the same things.
//
//   * Ours, loaded from disk (file://): the launcher and the deploy wizard.
//     They are the app's own interface and drive the app -- the server list,
//     the settings, the install over SSH.
//   * A server's, loaded over the network from an address the user typed.
//     That page is written by whoever runs the server, and a fault in it is
//     written by whoever found the fault.  It gets the bridge the Android app
//     offers and nothing more.
//
// The protocol is what separates them: our pages are the only ones that can
// be loaded from disk.  The main process checks the sender of every
// privileged call as well -- this decides what a page is handed, not what the
// main process is willing to answer.
const ourOwnPage = location.protocol === 'file:';
const serverPage = location.protocol === 'http:' || location.protocol === 'https:';

// Hand the app's appearance to a server's own client before its scripts run.
//
// The client keeps the preference in localStorage under its origin, and reads
// it in a blocking head script so that its first paint is already right.  We
// write ours in ahead of that, which makes the app the single source of truth:
// the button beside the window controls and the client's own Appearance
// setting then agree, whichever of the two the user last touched.  (The
// client reports its own changes back over the SozvonApp bridge, which is what
// keeps the value here current.)
//
// This is the one synchronous call in the app, and the reason is the timing:
// anything asynchronous resolves after the page has already painted.
try {
  if (serverPage) {
    const pref = ipcRenderer.sendSync('app:theme-sync');
    if (pref) localStorage.setItem('sozvon-theme', pref);
  }
} catch {
  // A page may forbid storage; the client then falls back to the system.
}

// The app's own controls, for the app's own pages only.
if (ourOwnPage) contextBridge.exposeInMainWorld('sozvon', {
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (patch) => ipcRenderer.invoke('config:set', patch),
  openGroup: (serverUrl, group) => ipcRenderer.invoke('group:open', { serverUrl, group }),
  removeServer: (url) => ipcRenderer.invoke('servers:remove', url),
  renameServer: (url, name) => ipcRenderer.invoke('servers:rename', { url, name }),
  backToLauncher: () => ipcRenderer.invoke('group:back-to-launcher'),

  // Deploying a new server.  The renderer never sees ssh2 or the filesystem;
  // it hands over a plain object and receives progress events.
  openDeploy: () => ipcRenderer.invoke('deploy:open'),
  startDeploy: (opts) => ipcRenderer.invoke('deploy:start', opts),
  onDeployProgress: (fn) => {
    ipcRenderer.removeAllListeners('deploy:progress');
    ipcRenderer.on('deploy:progress', (_e, ev) => fn(ev));
  },
  onHostKey: (fn) => {
    ipcRenderer.removeAllListeners('deploy:hostkey');
    ipcRenderer.on('deploy:hostkey', (_e, info) => fn(info));
  },
  answerHostKey: (accepted) => ipcRenderer.send('deploy:hostkey-answer', accepted),
});

// The same bridge the Android app exposes (window.SozvonApp): the web client
// looks for it and reveals an "App" section in its settings drawer, with a way
// back to the server picker and a way to drop the saved login.  Without it a
// server page is a dead end -- the window has no address bar, and the client
// has no idea it is running inside anything.
if (serverPage) contextBridge.exposeInMainWorld('SozvonApp', {
  changeServer: () => ipcRenderer.invoke('group:back-to-launcher'),
  resetLogin: () => ipcRenderer.invoke('app:reset-login'),
  // This page keeps working when it is off screen, and is meant to: the
  // window goes to the tray with the operator room still loaded, and the
  // client's own three-second poll is the only thing that would notice
  // somebody knocking.  A browser tab says nothing here, and the client
  // throttles itself there as usual.
  worksHidden: true,
  // Where duty lives on this server, learnt from the client raising the
  // operator dashboard.  Lets the tray offer it later, from a window that
  // has since gone somewhere else entirely.
  setHub: (name) => ipcRenderer.invoke('app:set-hub', name),
  // A lobby knock, offered to the app so it can raise it above whatever the
  // operator is actually looking at.  The payload is {key, text, actions} --
  // a sentence the client has already translated and the buttons that make
  // sense for this knock; the app draws them and says which was pressed,
  // without being told what any of it means.
  knock: (knock) => ipcRenderer.invoke('app:knock', knock),
  knockGone: (key) => ipcRenderer.invoke('app:knock-gone', key),
  onKnockAction: (fn) => {
    ipcRenderer.removeAllListeners('app:knock-action');
    ipcRenderer.on('app:knock-action', (_e, m) => fn(m.key, m.action));
  },
  // Light or dark, so the window and the launcher match the page rather than
  // framing a light client in a dark shell.  What arrives is the preference
  // -- 'system', 'light' or 'dark' -- not the theme it resolved to, which is
  // what lets 'system' keep following the desktop afterwards.
  setTheme: (pref) => ipcRenderer.invoke('app:set-theme', pref),
});
