import { BrowserWindow } from 'electron';
import log from 'electron-log/main';
import type { SystemPrinterInfo } from '@cheeseoclock/shared-types';
import { rankSystemPrinters } from '../adapters/printer/system-printer-ranking.js';

/** The USB transport rides the OS print queue, which we only drive on Windows. */
export function isSystemPrintingSupported(): boolean {
  return process.platform === 'win32';
}

/**
 * Printer queues installed in the OS, best receipt-printer candidates first.
 * Chromium enumerates them for us through any live window; there is nothing
 * to list before the first window exists.
 */
export async function listSystemPrinters(): Promise<SystemPrinterInfo[]> {
  if (!isSystemPrintingSupported()) return [];
  const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed());
  if (!win) return [];
  try {
    const printers = await win.webContents.getPrintersAsync();
    return rankSystemPrinters(printers);
  } catch (err) {
    log.warn('Could not list system printers', {
      err: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}
