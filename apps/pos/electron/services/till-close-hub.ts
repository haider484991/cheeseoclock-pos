import { randomUUID } from 'node:crypto';
import type { BrowserWindow } from 'electron';
import log from 'electron-log/main';
import type { CloseTillAsk } from '@cheeseoclock/shared-types';
import { TillCloseGuard, type CloseAllowReason } from './till-close.js';
import { webOrdersBridge } from './web-orders-bridge.js';

/**
 * The real wiring for TillCloseGuard (till-close.ts): the till's window, the
 * screen's question (system:close-requested), and the website bridge.
 *
 * Only this file may hook WM_QUERYENDSESSION and WM_ENDSESSION on the till's
 * window: Electron keeps one callback per message per window, so a second
 * hook elsewhere would silently replace this one. The hooks only listen;
 * Windows' own handling goes on, so a shutdown is never held up. (Electron
 * 32 has no 'query-session-end' event; switch to it after an upgrade.)
 */

/** Windows asks every window whether the session may end (shutdown, restart, sign-out). */
const WM_QUERYENDSESSION = 0x0011;
/** …and then says whether it does: wParam FALSE (all zero) = called off. */
const WM_ENDSESSION = 0x0016;

let win: BrowserWindow | null = null;
let unresponsive = false;

export const tillClose = new TillCloseGuard({
  impact: () => {
    const i = webOrdersBridge.closeImpact();
    return i.takingOrders ? { openWebOrders: i.openWebOrders } : null;
  },
  screenCanAsk: () => !!win && !win.isDestroyed() && !win.webContents.isCrashed() && !unresponsive,
  ask: (req: CloseTillAsk) => {
    const w = win;
    if (!w || w.isDestroyed()) return false;
    try {
      if (w.isMinimized()) w.restore();
      w.show();
      w.focus();
      w.webContents.send('system:close-requested', req);
      return true;
    } catch (e) {
      log.warn('Till window: could not put the close question on screen', e);
      return false;
    }
  },
  closeWindow: () => {
    if (win && !win.isDestroyed()) win.close();
  },
  sayClosing: () => webOrdersBridge.sayTillClosing(),
  newId: () => randomUUID(),
  info: (m, d) => (d === undefined ? log.info(m) : log.info(m, d)),
  warn: (m, d) => (d === undefined ? log.warn(m) : log.warn(m, d)),
  schedule: (fn, ms) => setTimeout(fn, ms),
  cancel: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
});

/** Called once the till's window is built (index.ts createMainWindow). */
export function attachTillWindow(w: BrowserWindow): void {
  win = w;
  unresponsive = false;
  // The only listener on 'close' that cancels it. After "Close the till" the
  // website bridge has stopped its poll, so nothing else may keep the window.
  w.on('close', (e) => {
    if (tillClose.onCloseRequested() === 'keep-open') e.preventDefault();
  });
  w.on('unresponsive', () => {
    unresponsive = true;
  });
  w.on('responsive', () => {
    unresponsive = false;
  });
  w.webContents.on('render-process-gone', () => tillClose.screenGone());
  w.on('session-end', () => tillClose.allowClose('session-end'));
  if (process.platform === 'win32') {
    w.hookWindowMessage(WM_QUERYENDSESSION, () => tillClose.allowClose('session-end'));
    w.hookWindowMessage(WM_ENDSESSION, (wParam) => {
      if (wParam.every((b) => b === 0)) tillClose.sessionEndCancelled();
    });
  }
}

/** The app is quitting (before-quit: an update's "Restart now" too): close without asking. */
export function allowTillToClose(why: CloseAllowReason): void {
  tillClose.allowClose(why);
}
