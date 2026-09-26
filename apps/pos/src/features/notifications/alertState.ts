/**
 * The rules behind the new-order chime and the "did not come in" alarm, kept
 * pure so alertState.test.ts can pin them:
 *
 *   - a new website order rings at once; one that is already known (the same
 *     event twice, or the main process's list after a restart) never rings
 *     again, and one already seen is ignored;
 *   - orders arriving while one is ringing join it: the banner counts them
 *     and they ring with the next repeat, not as a burst of chimes;
 *   - "Keep ringing until someone looks": every 9 s for 10 minutes after
 *     the newest order, then every 30 s, then silence after an hour (the
 *     banner stays until someone looks). That switch is the chime's only:
 *     the alarm for an order that did not come in always repeats;
 *   - the alarm (an order that did not come in) wins over the chime;
 *   - Seen / Esc acts on the row the banner shows, nothing else: a ringing
 *     alarm is silenced (that one), otherwise the new orders are seen. An
 *     order or alarm that arrived under the finger (in the last 1.5 s, next
 *     to something already showing) keeps ringing;
 *   - a sound switched off in Settings never hides the banner.
 *
 * The main process keeps the same list (order-alerts.ts), so a screen that
 * starts later still rings; `applySnapshot` merges it in.
 */
import {
  fulfilmentLabel,
  orderNumberList,
  shortOrderNumber,
  type AlertSoundSettings,
  type ImportFailureAlert,
  type ImportFailureReason,
  type OnlineOrderAlert,
  type PendingAlerts,
} from '@cheeseoclock/shared-types';

export const RING_EVERY_MS = 9_000;
export const RING_SLOW_AFTER_MS = 10 * 60_000;
export const RING_SLOW_EVERY_MS = 30_000;
/** After an hour of nobody looking the chime stops; the banner stays. */
export const RING_STOP_AFTER_MS = 60 * 60_000;
/** Two different alerts never start closer together than this. */
export const MIN_RING_GAP_MS = 3_000;
/** Seen covers only what was on screen this long before the tap. */
export const SEEN_GRACE_MS = 1_500;
/** A list from the main process that is older than an alert (by this much) cannot drop it. */
export const RECONCILE_MARGIN_MS = 2_000;
export const SEEN_LIMIT = 200;

export interface OrderAlertItem extends OnlineOrderAlert {
  /** When this screen learned of it (ms). */
  localAt: number;
  /** Its kitchen ticket did not print. */
  ticketFailed: boolean;
}

export interface FailureAlertItem extends ImportFailureAlert {
  localAt: number;
}

export interface AlertState {
  orders: OrderAlertItem[];
  failures: FailureAlertItem[];
  /** Orders seen or moved along: never ring for them again. Newest last, bounded. */
  seenOrderIds: string[];
  /** Failure cards closed. Newest last, bounded. */
  closedFailureIds: string[];
  /** When the newest thing that rings arrived. */
  ringingSince: number | null;
  lastRingAt: number | null;
  /** A ring owed for something new (null: only the repeat rule applies). */
  nextRingAt: number | null;
}

export const EMPTY_ALERT_STATE: AlertState = Object.freeze({
  orders: [],
  failures: [],
  seenOrderIds: [],
  closedFailureIds: [],
  ringingSince: null,
  lastRingAt: null,
  nextRingAt: null,
}) as AlertState;

export type RingKind = 'newOrder' | 'importFailed';

function bounded(list: readonly string[], add: readonly string[], limit = SEEN_LIMIT): string[] {
  if (add.length === 0) return list as string[];
  const next = list.filter((id) => !add.includes(id)).concat(add);
  return next.length > limit ? next.slice(next.length - limit) : next;
}

/** Something should be ringing: an order nobody has seen, or an alarm nobody silenced. */
export function isLoud(s: AlertState): boolean {
  return s.orders.length > 0 || s.failures.some((f) => !f.silenced);
}

/** Nothing left to ring for: forget the ringing clock. */
function settle(s: AlertState): AlertState {
  if (isLoud(s)) return s;
  if (s.ringingSince === null && s.lastRingAt === null && s.nextRingAt === null) return s;
  return { ...s, ringingSince: null, lastRingAt: null, nextRingAt: null };
}

/** When a new arrival should ring: at once, but never on top of the last ring. */
function scheduleFor(s: AlertState, now: number, joinEpisode: boolean): number {
  let at = now;
  if (s.lastRingAt !== null) {
    // Joining a chime already ringing: the next regular repeat covers it.
    at = Math.max(now, s.lastRingAt + (joinEpisode ? RING_EVERY_MS : MIN_RING_GAP_MS));
  }
  return s.nextRingAt !== null ? Math.min(s.nextRingAt, at) : at;
}

function toOrderAlert(p: Partial<OnlineOrderAlert> & { orderId: string }, now: number): OrderAlertItem {
  return {
    orderId: p.orderId,
    orderNumber: typeof p.orderNumber === 'string' && p.orderNumber ? p.orderNumber : p.orderId,
    customerName: typeof p.customerName === 'string' ? p.customerName : '',
    webOrderId: typeof p.webOrderId === 'string' ? p.webOrderId : null,
    fulfilment: p.fulfilment === 'pickup' || p.fulfilment === 'delivery' ? p.fulfilment : null,
    totalCents: typeof p.totalCents === 'number' && Number.isFinite(p.totalCents) ? p.totalCents : null,
    totalMismatch: p.totalMismatch ?? null,
    receivedAt: typeof p.receivedAt === 'string' ? p.receivedAt : new Date(now).toISOString(),
    localAt: now,
    ticketFailed: false,
  };
}

/** A new website order is on the board (event from the bridge, or the main process's list). */
export function receiveOrder(
  s: AlertState,
  p: Partial<OnlineOrderAlert> & { orderId: string },
  now: number,
): AlertState {
  if (!p || typeof p.orderId !== 'string' || !p.orderId) return s;
  if (s.seenOrderIds.includes(p.orderId) || s.orders.some((o) => o.orderId === p.orderId)) return s;
  const alert = toOrderAlert(p, now);
  const joinEpisode = s.orders.length > 0;
  return {
    ...s,
    orders: [...s.orders, alert],
    // A retry that worked: the order did come in after all.
    failures: alert.webOrderId ? s.failures.filter((f) => f.webOrderId !== alert.webOrderId) : s.failures,
    ringingSince: now,
    nextRingAt: scheduleFor(s, now, joinEpisode),
  };
}

/** The bridge's import-failed event → a failure card, or null while the till is still retrying. */
export function failureFromEvent(
  p: {
    webOrderId: string;
    customerName: string;
    message: string;
    customerPhone?: string | null;
    final?: boolean;
    reason?: ImportFailureReason;
  },
  now: number,
): ImportFailureAlert | null {
  if (!p || typeof p.webOrderId !== 'string' || !p.webOrderId) return null;
  const message = typeof p.message === 'string' ? p.message : '';
  // Builds before `final` said "gave up after 5 attempts" on the last one.
  const final = p.final ?? /^gave up/i.test(message);
  if (!final) return null;
  const reason: ImportFailureReason = p.reason === 'stale' || p.reason === 'gave_up' ? p.reason : 'error';
  return {
    webOrderId: p.webOrderId,
    customerName: typeof p.customerName === 'string' ? p.customerName : '',
    customerPhone: typeof p.customerPhone === 'string' && p.customerPhone.trim() ? p.customerPhone.trim() : null,
    message,
    reason,
    silenced: reason === 'stale',
    at: new Date(now).toISOString(),
  };
}

/** A website order did not come in (final only: one card, one alarm, per order). */
export function receiveFailure(s: AlertState, f: ImportFailureAlert, now: number): AlertState {
  if (!f || !f.webOrderId) return s;
  if (s.closedFailureIds.includes(f.webOrderId)) return s;
  const existing = s.failures.find((x) => x.webOrderId === f.webOrderId);
  if (existing) {
    // Known already: keep what it said, and keep it silenced if someone did.
    const merged: FailureAlertItem = {
      ...existing,
      customerPhone: existing.customerPhone ?? f.customerPhone,
      silenced: existing.silenced || f.silenced,
    };
    return { ...s, failures: s.failures.map((x) => (x === existing ? merged : x)) };
  }
  const item: FailureAlertItem = { ...f, localAt: now };
  const next: AlertState = { ...s, failures: [...s.failures, item] };
  if (item.silenced) return next;
  return { ...next, ringingSince: now, nextRingAt: scheduleFor(s, now, false) };
}

/**
 * Merge the main process's list (asked for at `requestedAt`). New entries are
 * added (and ring); entries it no longer has are dropped — unless this screen
 * learned of them after the list was made.
 */
export function applySnapshot(s: AlertState, pending: PendingAlerts, requestedAt: number, now: number): AlertState {
  let next = s;
  const cutoff = requestedAt - RECONCILE_MARGIN_MS;
  const snapOrders = new Set(pending.orders.map((o) => o.orderId));
  const gone = next.orders.filter((o) => !snapOrders.has(o.orderId) && o.localAt < cutoff);
  if (gone.length > 0) {
    next = {
      ...next,
      orders: next.orders.filter((o) => !gone.includes(o)),
      seenOrderIds: bounded(next.seenOrderIds, gone.map((o) => o.orderId)),
    };
  }
  for (const o of pending.orders) next = receiveOrder(next, o, now);

  const snapFailures = new Set(pending.failures.map((f) => f.webOrderId));
  const goneF = next.failures.filter((f) => !snapFailures.has(f.webOrderId) && f.localAt < cutoff);
  if (goneF.length > 0) next = { ...next, failures: next.failures.filter((f) => !goneF.includes(f)) };
  for (const f of pending.failures) next = receiveFailure(next, f, now);
  return settle(next);
}

/**
 * Seen on the new-order row. Orders shown at least SEEN_GRACE_MS before `now`
 * are acknowledged; one that joined the banner in that last moment keeps
 * ringing (the tap was for the others). When every order on it is that new,
 * they are all it has shown, so they all go. `all`: every order — View,
 * opening Live Orders. Returns their ids for the main process.
 */
export function acknowledgeOrders(
  s: AlertState,
  now: number,
  opts: { all?: boolean } = {},
): { state: AlertState; orderIds: string[] } {
  const settled = s.orders.filter((o) => now - o.localAt >= SEEN_GRACE_MS);
  const done = opts.all || settled.length === 0 ? s.orders : settled;
  if (done.length === 0) return { state: s, orderIds: [] };
  const ids = done.map((o) => o.orderId);
  const state = settle({
    ...s,
    orders: s.orders.filter((o) => !done.includes(o)),
    seenOrderIds: bounded(s.seenOrderIds, ids),
  });
  return { state, orderIds: ids };
}

/** Stop the alarm for these failures (all when `ids` is left out). The cards stay. */
export function silenceFailures(s: AlertState, ids?: readonly string[]): { state: AlertState; ids: string[] } {
  const hit = s.failures.filter((f) => !f.silenced && (!ids || ids.includes(f.webOrderId)));
  if (hit.length === 0) return { state: s, ids: [] };
  let next: AlertState = {
    ...s,
    failures: s.failures.map((f) => (hit.includes(f) ? { ...f, silenced: true } : f)),
  };
  // New orders waited behind the alarm ("+N more"): their green row shows
  // now, with a chime of its own (not on top of the alarm's last one) — even
  // with "keep ringing" off, when the alarm took their only chime.
  const alarmLeft = next.failures.some((f) => !f.silenced);
  if (!alarmLeft && next.orders.length > 0 && next.nextRingAt === null && next.lastRingAt !== null) {
    next = { ...next, nextRingAt: next.lastRingAt + MIN_RING_GAP_MS };
  }
  return { state: settle(next), ids: hit.map((f) => f.webOrderId) };
}

/**
 * Seen (any row's button, the small pill) and Esc: act on the row the banner
 * shows, and only on it.
 *   - A ringing "did not come in" alarm is shown first: only that alarm is
 *     silenced. New orders waiting behind it ("+N more") keep their green row
 *     and their chime for when it goes — nobody has seen them yet.
 *   - An alarm that took the new-order row's place a moment ago (under the
 *     finger) is spared: the tap was for the orders, which are seen instead.
 *   - Otherwise the new orders are seen (acknowledgeOrders).
 */
export function seenOnScreen(
  s: AlertState,
  now: number,
): { state: AlertState; orderIds: string[]; failureIds: string[] } {
  const shown = s.failures.find((f) => !f.silenced);
  const underTheFinger = shown !== undefined && s.orders.length > 0 && now - shown.localAt < SEEN_GRACE_MS;
  if (shown && !underTheFinger) {
    const r = silenceFailures(s, [shown.webOrderId]);
    return { state: r.state, orderIds: [], failureIds: r.ids };
  }
  const a = acknowledgeOrders(s, now);
  return { state: a.state, orderIds: a.orderIds, failureIds: [] };
}

/** Take a failure card away (someone logged in has dealt with it). */
export function closeFailure(s: AlertState, webOrderId: string): AlertState {
  if (!s.failures.some((f) => f.webOrderId === webOrderId)) return s;
  return settle({
    ...s,
    failures: s.failures.filter((f) => f.webOrderId !== webOrderId),
    closedFailureIds: bounded(s.closedFailureIds, [webOrderId]),
  });
}

/** The kitchen ticket for a pending website order did not print: say so on its banner. */
export function markTicketFailed(s: AlertState, orderId: string): AlertState {
  if (!s.orders.some((o) => o.orderId === orderId && !o.ticketFailed)) return s;
  return { ...s, orders: s.orders.map((o) => (o.orderId === orderId ? { ...o, ticketFailed: true } : o)) };
}

/** Does this till make a sound for this event at all? */
export function ringsFor(event: keyof AlertSoundSettings['events'], settings: AlertSoundSettings): boolean {
  return settings.enabled && settings.volume > 0 && settings.events[event];
}

/** Which sound the ringing alert makes now, if any (the alarm wins). */
export function ringingKind(s: AlertState, settings: AlertSoundSettings): RingKind | null {
  if (s.failures.some((f) => !f.silenced) && ringsFor('importFailed', settings)) return 'importFailed';
  if (s.orders.length > 0 && ringsFor('newOnlineOrder', settings)) return 'newOrder';
  return null;
}

/** How long between repeats, this long after the newest arrival; null: stop repeating. */
export function repeatEvery(elapsedMs: number): number | null {
  if (elapsedMs < RING_SLOW_AFTER_MS) return RING_EVERY_MS;
  if (elapsedMs < RING_STOP_AFTER_MS) return RING_SLOW_EVERY_MS;
  return null;
}

/** The repeat rule in words, for Settings → Sounds (kept next to the numbers it describes). */
export function repeatRuleText(): string {
  const hours = RING_STOP_AFTER_MS / 3_600_000;
  return `every ${RING_EVERY_MS / 1000} s, then every ${RING_SLOW_EVERY_MS / 1000} s after ${RING_SLOW_AFTER_MS / 60_000} minutes; it stops after ${hours === 1 ? 'an hour' : `${hours} hours`} and the note stays`;
}

/** Should the till ring now, and with which sound? */
export function dueRing(s: AlertState, settings: AlertSoundSettings, now: number): RingKind | null {
  const kind = ringingKind(s, settings);
  if (!kind) return null;
  if (s.nextRingAt !== null) return now >= s.nextRingAt ? kind : null;
  // "Keep ringing" is the new-order chime's switch (it sits under New online
  // order). The alarm for an order that did not come in always repeats: one
  // second of alarm in a noisy kitchen is easily missed, and then nobody
  // calls the customer.
  if (kind === 'newOrder' && !settings.repeatUntilSeen) return null;
  if (s.lastRingAt === null || s.ringingSince === null) return null;
  const every = repeatEvery(now - s.ringingSince);
  if (every === null) return null;
  return now - s.lastRingAt >= every ? kind : null;
}

export function markRang(s: AlertState, now: number): AlertState {
  return { ...s, lastRingAt: now, nextRingAt: null };
}

// ---------------------------------------------------------------------------
// Words on the banner

export interface BannerText {
  title: string;
  detail: string;
  /** The technical reason, for a tooltip — never the headline. */
  tooltip?: string;
}

/** "New online order #0042" / "Delivery · Rs 1,850 · Ali"; several orders are counted. */
export function describeNewOrders(
  orders: readonly OrderAlertItem[],
  formatMoney: (cents: number) => string,
): BannerText {
  if (orders.length === 0) return { title: '', detail: '' };
  if (orders.length === 1) {
    const o = orders[0]!;
    const name = o.customerName || 'the customer';
    const parts = [fulfilmentLabel(o.fulfilment), o.totalCents !== null ? formatMoney(o.totalCents) : null, o.customerName || null]
      .filter((x): x is string => !!x);
    let detail = parts.join(' · ');
    if (o.totalMismatch) {
      detail = `Total changed: website ${formatMoney(o.totalMismatch.webTotalCents)}, till ${formatMoney(o.totalMismatch.tillTotalCents)} — call ${name} before it goes out`;
    }
    if (o.ticketFailed) detail = detail ? `${detail} · kitchen ticket did not print` : 'Kitchen ticket did not print';
    return { title: `New online order ${shortOrderNumber(o.orderNumber)}`, detail };
  }
  const notes: string[] = [];
  if (orders.some((o) => o.totalMismatch)) notes.push('a total changed — see Live Orders');
  if (orders.some((o) => o.ticketFailed)) notes.push('a kitchen ticket did not print');
  const list = orderNumberList(orders.map((o) => o.orderNumber));
  return {
    title: `${orders.length} new online orders`,
    detail: notes.length > 0 ? `${list} · ${notes.join(' · ')}` : list,
  };
}

/** "Website order from Ali did not come in" / "Call 0300-1234567 and take it by phone." */
export function describeFailure(f: ImportFailureAlert, loggedIn: boolean): BannerText {
  const name = f.customerName || 'a customer';
  const tooltip = f.message ? `Reason: ${f.message}` : undefined;
  if (f.reason === 'stale') {
    return {
      title: `Website order from ${name} came in while the till was off`,
      detail: !loggedIn
        ? 'It was cancelled on the website. Log in to see the phone number.'
        : f.customerPhone
          ? `It was cancelled on the website. Call ${f.customerPhone} to say sorry, or take it by phone.`
          : 'It was cancelled on the website. Take it by phone if they call.',
      tooltip,
    };
  }
  return {
    title: `Website order from ${name} did not come in`,
    detail: !loggedIn
      ? 'Log in to see the phone number, then call and take the order by phone.'
      : f.customerPhone
        ? `Call ${f.customerPhone} and take the order by phone.`
        : 'Take the order by phone when they call.',
    tooltip,
  };
}
