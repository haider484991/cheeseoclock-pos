/**
 * The short sounds that are not the banner's chime or alarm: a printer
 * problem, running low, and orders waiting too long. Kept pure so the rules
 * (who hears what, how often, what the banner may claim) are pinned in
 * eventTones.test.ts; OrderAlerts.tsx only plays what these say.
 */
import type { AlertSoundSettings, OrderSnapshot } from '@cheeseoclock/shared-types';
import { ringsFor } from './alertState';
import { REMIND_TONE_GAP_MS, dueWaitingReminders, type WaitingOrder, type WaitingReminder } from './waitingReminders';

/** A printer that is off would otherwise beep on every sale in a rush. */
export const PRINTER_TONE_GAP_MS = 2 * 60_000;
export const LOW_STOCK_TONE_GAP_MS = 5_000;

/**
 * The Live Orders "All" list. The sidebar badge and the board share it (and
 * refresh it every 15 s); the waiting reminder reads the same cache entry and
 * fetches it itself only when nobody has for this long.
 */
export const ACTIVE_ORDERS_KEY = ['orders', 'active', 'all'] as const;
export const ACTIVE_ORDERS_FRESH_MS = 2 * 60_000;

export interface ToneContext {
  loggedIn: boolean;
  settings: AlertSoundSettings;
  now: number;
  /** When this tone last played (0: never). */
  lastToneAt: number;
}

/** The part of the spooler's printer:failed event these rules use. */
export interface PrinterFailedEvent {
  jobKind: string;
  orderId?: string;
  /** First miss: the spooler keeps trying by itself. */
  retrying?: boolean;
}

/**
 * A print job failed.
 *   - `ticketFailedOrderId`: the banner may say this website order's kitchen
 *     ticket did not print — only once the spooler has given up. On the first
 *     miss it retries by itself; "did not print" then sends someone to
 *     reprint, the retry prints too, and the kitchen gets two tickets.
 *   - `tone`: only with someone logged in (the note saying why is on that
 *     screen), never for the cash drawer (the cashier is standing at it and
 *     its note says what to do), at most once every 2 minutes.
 */
export function printerFailureEffect(
  p: PrinterFailedEvent,
  ctx: ToneContext,
): { ticketFailedOrderId: string | null; tone: boolean } {
  const ticketFailedOrderId =
    p.jobKind === 'kitchen' && typeof p.orderId === 'string' && p.orderId !== '' && p.retrying !== true
      ? p.orderId
      : null;
  const tone =
    ctx.loggedIn &&
    p.jobKind !== 'drawer' &&
    ringsFor('printerProblem', ctx.settings) &&
    ctx.now - ctx.lastToneAt >= PRINTER_TONE_GAP_MS;
  return { ticketFailedOrderId, tone };
}

/** Running low: a beep with someone logged in, not twice for one sale's items. */
export function lowStockTone(ctx: ToneContext): boolean {
  return ctx.loggedIn && ringsFor('lowStock', ctx.settings) && ctx.now - ctx.lastToneAt >= LOW_STOCK_TONE_GAP_MS;
}

export function toWaitingOrders(snaps: readonly OrderSnapshot[]): WaitingOrder[] {
  return snaps.map((snap) => ({
    id: snap.order.id,
    orderNumber: snap.order.orderNumber,
    status: snap.order.status,
    createdAt: snap.order.createdAt,
    source: snap.order.source,
  }));
}

/**
 * One round of the waiting-too-long check. `due` are the reminders to note
 * (and remember, so each fires once); `tone` whether to beep for them — at
 * most once every 5 minutes however many are late, and a note still shows
 * with the sound off. `boardUnused`: staff are not moving orders along on
 * Live Orders, so nothing is due.
 */
export function planWaitingReminders(
  list: readonly WaitingOrder[],
  opts: ToneContext & { reminded: ReadonlySet<string>; ringing: ReadonlySet<string> },
): { due: WaitingReminder[]; boardUnused: boolean; tone: boolean } {
  const { due, boardUnused } = dueWaitingReminders(list, opts.now, {
    includeCounter: opts.settings.waitingIncludesCounter,
    reminded: opts.reminded,
    ringing: opts.ringing,
  });
  const tone =
    due.length > 0 &&
    opts.loggedIn &&
    ringsFor('waitingTooLong', opts.settings) &&
    opts.now - opts.lastToneAt >= REMIND_TONE_GAP_MS;
  return { due, boardUnused, tone };
}
