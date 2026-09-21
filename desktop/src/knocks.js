// Knock notifications: small windows that sit above everything else.
//
// Why not the system's own notifications.  Windows puts those in the Action
// Centre, behind a toast that is gone in five seconds and a setting the user
// may have turned off years ago for some other program.  A knock is somebody
// standing at a door waiting to be let in -- it is worth a window of our own,
// one that stays until it is answered or the person gives up, and that can
// carry the two buttons that answer it.
//
// What this module deliberately does not know: what a knock means, whether it
// can be denied, or what happens when a button is pressed.  It is handed a
// sentence and a list of buttons by the page that understands all of that
// (see hostKnock in static/galene.js), and hands back which button was
// pressed.  Everything here is placement and lifetime.
//
// SOZVON is a fork of Galène (MIT); see LICENCE.

const { BrowserWindow, screen } = require('electron');
const path = require('path');

const WIDTH = 384;
// Enough for one line of text and the buttons; the page measures itself and
// corrects this as soon as it has rendered, which matters for a long name.
const INITIAL_HEIGHT = 116;
const GAP = 10;
const MARGIN = 16;

/** @type {Array<{key: string, win: Electron.BrowserWindow, height: number}>} */
let stack = [];

/**
 * @typedef {Object} Knock
 * @property {string} key
 * @property {string} text
 * @property {Array<{id: string, label: string, primary?: boolean}>} actions
 */

/**
 * Where the notifications go: the bottom-right of the work area of whichever
 * screen the app's own window is on.
 *
 * The work area, not the screen: below the taskbar is not "above everything
 * else", it is underneath the one bar that is always there.
 *
 * @param {Electron.BrowserWindow} [near]
 */
function workArea(near) {
  try {
    if (near && !near.isDestroyed()) {
      const b = near.getBounds();
      return screen.getDisplayNearestPoint({
        x: Math.round(b.x + b.width / 2),
        y: Math.round(b.y + b.height / 2),
      }).workArea;
    }
  } catch { /* fall through to the primary display */ }
  return screen.getPrimaryDisplay().workArea;
}

/** Restack: newest at the bottom, older ones pushed up out of its way. */
function reflow(near) {
  const area = workArea(near);
  let y = area.y + area.height - MARGIN;
  // Walked backwards so the newest knock -- the last one pushed -- takes the
  // corner, which is where the eye already is.
  for (let i = stack.length - 1; i >= 0; i--) {
    const item = stack[i];
    y -= item.height;
    if (!item.win.isDestroyed()) {
      item.win.setBounds({
        x: area.x + area.width - WIDTH - MARGIN,
        y: Math.max(area.y + MARGIN, Math.round(y)),
        width: WIDTH,
        height: item.height,
      });
    }
    y -= GAP;
  }
}

/**
 * @param {Object} ctx
 * @param {string} ctx.preload - path to the toast window's preload
 * @param {string} ctx.page - path to the toast window's html
 * @param {() => Electron.BrowserWindow|null} ctx.anchor - the app's own window
 * @param {(key: string, action: string) => void} ctx.onAction
 * @param {(key: string) => void} ctx.onDismiss
 */
function createKnocks(ctx) {
  /**
   * Put a knock on screen, or refresh the one already there under this key --
   * a second person joining the same queue changes the sentence, not the
   * number of windows.
   *
   * @param {Knock} knock
   */
  function show(knock) {
    if (!knock || !knock.key) return;
    const existing = stack.find(i => i.key === knock.key);
    if (existing) {
      if (!existing.win.isDestroyed())
        existing.win.webContents.send('knock:show', knock);
      return;
    }

    const win = new BrowserWindow({
      width: WIDTH,
      height: INITIAL_HEIGHT,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: true,
      webPreferences: {
        preload: ctx.preload,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });

    // 'screen-saver' is the level above full-screen video and above other
    // programs' own always-on-top windows.  Anything lower and the one case
    // this is for -- the operator is watching something else in full screen
    // -- is the case it fails.
    win.setAlwaysOnTop(true, 'screen-saver');
    try {
      win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    } catch { /* not a platform with workspaces */ }

    const item = { key: knock.key, win, height: INITIAL_HEIGHT };
    stack.push(item);

    win.once('ready-to-show', () => {
      win.webContents.send('knock:show', knock);
      reflow(ctx.anchor());
      // Inactive: the operator may be typing in something else, and a window
      // that grabs the keyboard to tell you somebody is at the door is worse
      // than the door.
      win.showInactive();
    });

    win.on('closed', () => {
      stack = stack.filter(i => i !== item);
      reflow(ctx.anchor());
    });

    win.webContents.on('ipc-message', (_e, channel, payload) => {
      if (channel === 'knock:height') {
        const h = Math.max(72, Math.min(260, Math.round(payload) || 0));
        if (h !== item.height) {
          item.height = h;
          reflow(ctx.anchor());
        }
      } else if (channel === 'knock:action') {
        ctx.onAction(item.key, String(payload));
        dismiss(item.key);
      } else if (channel === 'knock:dismiss') {
        ctx.onDismiss(item.key);
        dismiss(item.key);
      }
    });

    win.loadFile(ctx.page);
  }

  /** Take a knock down: answered here, answered elsewhere, or withdrawn. */
  function dismiss(key) {
    const item = stack.find(i => i.key === key);
    if (!item) return;
    stack = stack.filter(i => i !== item);
    if (!item.win.isDestroyed()) item.win.destroy();
    reflow(ctx.anchor());
  }

  function dismissAll() {
    for (const item of stack.slice())
      dismiss(item.key);
  }

  return { show, dismiss, dismissAll, count: () => stack.length };
}

module.exports = { createKnocks };
