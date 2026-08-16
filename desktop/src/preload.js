const { contextBridge, ipcRenderer } = require('electron');

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
  if (location.protocol === 'http:' || location.protocol === 'https:') {
    const pref = ipcRenderer.sendSync('app:theme-sync');
    if (pref) localStorage.setItem('sozvon-theme', pref);
  }
} catch {
  // A page may forbid storage; the client then falls back to the system.
}

contextBridge.exposeInMainWorld('sozvon', {
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
contextBridge.exposeInMainWorld('SozvonApp', {
  changeServer: () => ipcRenderer.invoke('group:back-to-launcher'),
  resetLogin: () => ipcRenderer.invoke('app:reset-login'),
  // Light or dark, so the window and the launcher match the page rather than
  // framing a light client in a dark shell.  What arrives is the preference
  // -- 'system', 'light' or 'dark' -- not the theme it resolved to, which is
  // what lets 'system' keep following the desktop afterwards.
  setTheme: (pref) => ipcRenderer.invoke('app:set-theme', pref),
});
