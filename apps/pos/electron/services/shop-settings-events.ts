import { BrowserWindow } from 'electron';

/**
 * The owner's shop rules changed — saved here, or arrived from the other
 * till (sync-worker, after applyRemoteBatch). The screens re-read them
 * (Checkout's foodpanda deal and Pay's checks, the Settings cards). Main
 * process only.
 */
export const SHOP_SETTINGS_CHANGED = 'shop-settings:changed';

export function broadcastShopSettingsChanged(): void {
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send(SHOP_SETTINGS_CHANGED);
  }
}
