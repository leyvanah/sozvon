// The bridge for a knock notification (renderer/knock.html).
//
// As narrow as the window is: it is told what to say, and it reports which
// button was pressed and how tall it turned out to be.  It has no idea what a
// knock is, and no reach into anything else.
//
// SOZVON is a fork of Galène (MIT); see LICENCE.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sozvonKnock', {
  onShow: (fn) => {
    ipcRenderer.removeAllListeners('knock:show');
    ipcRenderer.on('knock:show', (_e, knock) => fn(knock));
  },
  act: (id) => ipcRenderer.send('knock:action', String(id)),
  dismiss: () => ipcRenderer.send('knock:dismiss'),
  // Measured after rendering, so a long name wraps into a taller window
  // instead of being cut off by a height guessed before there was any text.
  height: (px) => ipcRenderer.send('knock:height', px),
});
