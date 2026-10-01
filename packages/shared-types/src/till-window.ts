/**
 * Closing the till window by mistake (v0.7.33): while this till takes
 * website orders, X, Alt+F4 or the taskbar's Close asks on screen first
 * (apps/pos electron/services/till-close.ts). Closing it stops website
 * orders until the till is opened again.
 */

/** system:close-requested — main → renderer: someone pressed X while website orders come in through this till. */
export interface CloseTillAsk {
  /** One question. A second X while it is up sends the same id again. */
  requestId: string;
  /** Website orders on Live Orders not yet delivered or cancelled. */
  openWebOrders: number;
}
