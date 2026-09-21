// The tray icon: what turns the app from a window into something that keeps
// watch.
//
// An operator on duty is not looking at Sozvon -- that is the whole point of
// being on duty -- so the app has to survive being got out of the way.  The
// close button putting it here instead of ending it is the one behaviour that
// makes the knock notification worth building at all: an app that quits when
// its window is closed cannot tell you anything afterwards.
//
// The menu is small on purpose.  It says whether duty is actually running,
// offers the one navigation that matters (the operator room), and carries the
// two switches that decide whether the app is allowed to stay -- kept here,
// beside the behaviour they govern, rather than buried in a settings page the
// operator would have to remember exists.
//
// SOZVON is a fork of Galène (MIT); see LICENCE.

const { Tray, Menu, nativeImage } = require('electron');

/**
 * @typedef {Object} DutyState
 * @property {boolean} onDuty - the operator room is open and polling
 * @property {string} [hub] - the operator room's name, when one is known
 * @property {number} knocks - how many people are waiting right now
 */

/**
 * @param {Object} ctx
 * @param {string} ctx.iconPath
 * @param {() => Object} ctx.getConfig
 * @param {(patch: Object) => void} ctx.setConfig
 * @param {() => DutyState} ctx.getDuty
 * @param {() => void} ctx.showWindow
 * @param {() => void} ctx.openHub
 * @param {(on: boolean) => void} ctx.setAutoStart
 * @param {() => void} ctx.quit
 */
function createTray(ctx) {
  const image = nativeImage.createFromPath(ctx.iconPath);
  const tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image);

  // Left click is the way back to the window on Windows; the menu is the
  // right button.  Both are what people already try.
  tray.on('click', () => ctx.showWindow());
  tray.on('double-click', () => ctx.showWindow());

  function build() {
    const cfg = ctx.getConfig();
    const duty = ctx.getDuty();
    return Menu.buildFromTemplate([
      { label: statusLine(duty), enabled: false },
      {
        // Standing watch is exactly "have the operator room open", so this is
        // the same navigation as the app bar's -- named for what it achieves
        // rather than for where it goes.
        label: duty.onDuty ? 'Операторская' : 'Заступить на дежурство',
        enabled: !!duty.hub && !duty.onDuty,
        click: () => ctx.openHub(),
      },
      { label: 'Показать окно', click: () => ctx.showWindow() },
      { type: 'separator' },
      {
        label: 'Сворачивать в трей, а не закрывать',
        type: 'checkbox',
        checked: cfg.minimizeToTray !== false,
        click: (item) => {
          ctx.setConfig({ minimizeToTray: item.checked });
          refresh();
        },
      },
      {
        label: 'Запускать вместе с Windows',
        type: 'checkbox',
        checked: !!cfg.autoStart,
        click: (item) => {
          ctx.setAutoStart(item.checked);
          refresh();
        },
      },
      { type: 'separator' },
      { label: 'Выйти из Sozvon', click: () => ctx.quit() },
    ]);
  }

  /**
   * One line that answers the only question the tray is asked: would I hear
   * about it if somebody knocked right now?
   *
   * It says no when the answer is no.  An icon that sits there looking the
   * same whether or not it is watching is worse than no icon, because it is
   * the thing being trusted to interrupt.
   *
   * @param {DutyState} duty
   */
  function statusLine(duty) {
    if (duty.knocks > 0)
      return duty.knocks === 1 ? 'Стучится один человек'
                               : `Стучатся: ${duty.knocks}`;
    if (duty.onDuty) return 'На дежурстве';
    if (duty.hub) return 'Не на дежурстве';
    return 'Операторская не открывалась';
  }

  function refresh() {
    const duty = ctx.getDuty();
    tray.setToolTip('SOZVON — ' + statusLine(duty));
    tray.setContextMenu(build());
  }

  refresh();

  return {
    refresh,
    /**
     * Say something from the tray itself -- used once, to explain where the
     * window went the first time the close button did not close it.
     *
     * @param {string} title
     * @param {string} content
     */
    hint: (title, content) => {
      try {
        tray.displayBalloon({ title, content, iconType: 'info' });
      } catch {
        // Not a platform with balloons: the app is no worse off than before,
        // it has just failed to explain itself.
      }
    },
    destroy: () => tray.destroy(),
  };
}

module.exports = { createTray };
