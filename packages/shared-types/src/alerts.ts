/**
 * Order alerts and the till's sounds (Settings → Sounds).
 *
 * The sound settings are stored per till in the settings table under
 * `alerts.sounds`. They are checked by hand here rather than with a Zod schema
 * in shared-schemas so that the main process (which saves them) and the screen
 * (which falls back to the defaults while they load) share one rule. Anything
 * missing or broken falls back to its default, field by field, and nothing
 * here ever throws.
 */

/** The moments the till can make a sound for. */
export type AlertSoundEvent =
  | 'newOnlineOrder'
  | 'importFailed'
  | 'waitingTooLong'
  | 'printerProblem'
  | 'lowStock';

export const ALERT_SOUND_EVENTS: readonly AlertSoundEvent[] = [
  'newOnlineOrder',
  'importFailed',
  'waitingTooLong',
  'printerProblem',
  'lowStock',
];

/** The chime for a new online order. */
export type NewOrderTone = 'bell' | 'rising' | 'counterBell';

export const NEW_ORDER_TONES: readonly NewOrderTone[] = ['bell', 'rising', 'counterBell'];

export interface AlertSoundSettings {
  /** Every sound on this till. Off never hides a message on screen. */
  enabled: boolean;
  /** 0–100, whole numbers. */
  volume: number;
  newOrderTone: NewOrderTone;
  /** Keep chiming for a new online order until someone looks. */
  repeatUntilSeen: boolean;
  /**
   * "Order waiting too long" also covers orders rung up at the counter, not
   * only website orders. Off by default: a shop that cooks from the printed
   * ticket and never taps "Start preparing" would hear it for every order.
   */
  waitingIncludesCounter: boolean;
  events: Record<AlertSoundEvent, boolean>;
}

export const DEFAULT_ALERT_SOUND_VOLUME = 80;

/** Below this the new-order chime counts as "off" for the warning on screen. */
export const QUIET_ALERT_VOLUME = 20;

export const DEFAULT_ALERT_SOUND_SETTINGS: AlertSoundSettings = Object.freeze({
  enabled: true,
  volume: DEFAULT_ALERT_SOUND_VOLUME,
  newOrderTone: 'bell',
  repeatUntilSeen: true,
  waitingIncludesCounter: false,
  events: Object.freeze({
    newOnlineOrder: true,
    importFailed: true,
    waitingTooLong: true,
    printerProblem: true,
    lowStock: true,
  }),
}) as AlertSoundSettings;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

/** Whole number 0–100; anything that is not a finite number gets the default. */
export function clampAlertVolume(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return DEFAULT_ALERT_SOUND_VOLUME;
  return Math.min(100, Math.max(0, Math.round(v)));
}

/**
 * Stored or submitted settings → valid settings. Each field is checked on its
 * own, so one bad value never resets the rest; unknown keys are dropped.
 */
export function normalizeAlertSoundSettings(raw: unknown): AlertSoundSettings {
  const d = DEFAULT_ALERT_SOUND_SETTINGS;
  const r = isRecord(raw) ? raw : {};
  const ev = isRecord(r['events']) ? r['events'] : {};
  const tone = r['newOrderTone'];
  const events = {} as Record<AlertSoundEvent, boolean>;
  for (const e of ALERT_SOUND_EVENTS) events[e] = bool(ev[e], d.events[e]);
  return {
    enabled: bool(r['enabled'], d.enabled),
    volume: clampAlertVolume(r['volume']),
    newOrderTone:
      typeof tone === 'string' && (NEW_ORDER_TONES as readonly string[]).includes(tone)
        ? (tone as NewOrderTone)
        : d.newOrderTone,
    repeatUntilSeen: bool(r['repeatUntilSeen'], d.repeatUntilSeen),
    waitingIncludesCounter: bool(r['waitingIncludesCounter'], d.waitingIncludesCounter),
    events,
  };
}

/** True when this till will not chime (loud enough to hear) for a new online order. */
export function newOrderSoundIsOff(s: AlertSoundSettings): boolean {
  return !s.enabled || !s.events.newOnlineOrder || s.volume < QUIET_ALERT_VOLUME;
}

// ---------------------------------------------------------------------------
// Pending order alerts (kept by the main process, shown by every screen)

/** A website order that is on the board and nobody has looked at yet. */
export interface OnlineOrderAlert {
  orderId: string;
  orderNumber: string;
  customerName: string;
  webOrderId: string | null;
  fulfilment: 'delivery' | 'pickup' | null;
  /** What the till bills, when known. */
  totalCents: number | null;
  /** The website showed the customer a different total. */
  totalMismatch: { webTotalCents: number; tillTotalCents: number } | null;
  /** ISO time the till took it in. */
  receivedAt: string;
}

/**
 * Why a website order is not on the board.
 *   gave_up — the till tried five times and cancelled it on the website;
 *   stale   — it reached the till too late to cook (the till was off);
 *   error   — a failure reported without a reason (older builds).
 */
export type ImportFailureReason = 'gave_up' | 'stale' | 'error';

/** A website order that did not come in: someone has to call the customer. */
export interface ImportFailureAlert {
  webOrderId: string;
  customerName: string;
  customerPhone: string | null;
  /** The technical reason, for the tooltip — never the headline. */
  message: string;
  reason: ImportFailureReason;
  /** The alarm was silenced (Seen); the card stays until a logged-in user closes it. */
  silenced: boolean;
  at: string;
}

export interface PendingAlerts {
  orders: OnlineOrderAlert[];
  failures: ImportFailureAlert[];
}

export interface AcknowledgeAlertsRequest {
  /** New online orders someone has seen. */
  orderIds?: string[];
  /** Stop the alarm for these failures; the cards stay. */
  silenceFailureIds?: string[];
  /** Take these failure cards away (needs a login). */
  closeFailureIds?: string[];
}

/** What a click on the till's Windows notice asks the screen to do. */
export interface AlertOpenPayload {
  kind: 'newOrder' | 'importFailed' | 'test';
}

/** "CO-20260926-0042" → "#0042", the way the Live Orders board shows it. */
export function shortOrderNumber(orderNumber: string): string {
  const tail = String(orderNumber ?? '').split('-').pop();
  return `#${tail || orderNumber || '?'}`;
}

/** "#0042, #0043, #0044 +2 more" — "+N more" only when some are left out. */
export function orderNumberList(orderNumbers: readonly string[], max = 3): string {
  const shown = orderNumbers.slice(0, Math.max(1, max)).map(shortOrderNumber).join(', ');
  const more = orderNumbers.length - Math.min(orderNumbers.length, Math.max(1, max));
  return more > 0 ? `${shown} +${more} more` : shown;
}

/** "Delivery" / "Pick-up"; null when the order did not say. */
export function fulfilmentLabel(f: OnlineOrderAlert['fulfilment']): string | null {
  if (f === 'pickup') return 'Pick-up';
  if (f === 'delivery') return 'Delivery';
  return null;
}
