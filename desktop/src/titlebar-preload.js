// The bridge for the app bar (renderer/titlebar.html).
//
// Deliberately narrow: the bar can ask the main process to move the content
// below it around and to change the appearance, and it is told when either
// changes.  It has no reach into the page below -- that page may be a server
// we do not control, and the bar is the one piece of chrome that is always
// ours.
//
// SOZVON is a fork of Galène (MIT); see LICENCE.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sozvonBar', {
  showLauncher: () => ipcRenderer.invoke('group:back-to-launcher'),
  reload: () => ipcRenderer.invoke('bar:reload'),
  openHub: () => ipcRenderer.invoke('bar:open-hub'),
  setTheme: (pref) => ipcRenderer.invoke('app:set-theme', pref),
  getState: () => ipcRenderer.invoke('bar:state'),
  onState: (fn) => {
    ipcRenderer.removeAllListeners('bar:state');
    ipcRenderer.on('bar:state', (_e, state) => fn(state));
  },
});
