import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ALERT_SOUND_SETTINGS,
  type AlertSoundSettings,
  type ImportFailureAlert,
  type OnlineOrderAlert,
} from '@cheeseoclock/shared-types';
import {
  EMPTY_ALERT_STATE,
  MIN_RING_GAP_MS,
  RECONCILE_MARGIN_MS,
  RING_EVERY_MS,
  RING_SLOW_AFTER_MS,
  RING_SLOW_EVERY_MS,
  RING_STOP_AFTER_MS,
  SEEN_GRACE_MS,
  SEEN_LIMIT,
  acknowledgeOrders,
  applySnapshot,
  closeFailure,
  describeFailure,
  describeNewOrders,
  dueRing,
  failureFromEvent,
  isLoud,
  markRang,
  markTicketFailed,
  receiveFailure,
  receiveOrder,
  repeatRuleText,
  ringsFor,
  seenOnScreen,
  silenceFailures,
  type AlertState,
  type RingKind,
} from './alertState';

const S: AlertSoundSettings = DEFAULT_ALERT_SOUND_SETTINGS;
const money = (c: number) => `Rs ${(c / 100).toLocaleString('en-PK')}`;

function order(id: string, extra: Partial<OnlineOrderAlert> = {}): OnlineOrderAlert {
  return {
    orderId: id,
    orderNumber: `CO-20260926-${id.padStart(4, '0')}`,
    customerName: 'Ali',
    webOrderId: `w${id}`,
    fulfilment: 'delivery',
    totalCents: 185_000,
    totalMismatch: null,
    receivedAt: '2026-09-26T10:00:00.000Z',
    ...extra,
  };
}

function failure(webOrderId: string, extra: Partial<ImportFailureAlert> = {}): ImportFailureAlert {
  return {
    webOrderId,
    customerName: 'Sara',
    customerPhone: '0300-1234567',
    message: 'gave up after 5 attempts',
    reason: 'gave_up',
    silenced: false,
    at: '2026-09-26T10:00:00.000Z',
    ...extra,
  };
}

/** Run the ringer every `stepMs` from `from` to `to`; returns when it rang, and with what. */
function ringsBetween(
  start: AlertState,
  from: number,
  to: number,
  settings: AlertSoundSettings = S,
  stepMs = 100,
): { rings: Array<{ at: number; kind: RingKind }>; state: AlertState } {
  let s = start;
  const rings: Array<{ at: number; kind: RingKind }> = [];
  for (let t = from; t <= to; t += stepMs) {
    const kind = dueRing(s, settings, t);
    if (kind) {
      rings.push({ at: t, kind });
      s = markRang(s, t);
    }
  }
  return { rings, state: s };
}

describe('a new online order', () => {
  it('rings at once', () => {
    const s = receiveOrder(EMPTY_ALERT_STATE, order('1'), 1_000);
    expect(isLoud(s)).toBe(true);
    expect(dueRing(s, S, 1_000)).toBe('newOrder');
  });

  it('the same order twice is one row and does not ring again', () => {
    let s = receiveOrder(EMPTY_ALERT_STATE, order('1'), 0);
    s = markRang(s, 0);
    const again = receiveOrder(s, order('1'), 500);
    expect(again).toBe(s);
    expect(again.orders).toHaveLength(1);
    expect(dueRing(again, S, 500)).toBeNull();
  });

  it('two orders 100 ms apart ring once, and the banner counts 2', () => {
    let s = receiveOrder(EMPTY_ALERT_STATE, order('1'), 0);
    s = receiveOrder(s, order('2'), 100);
    const { rings, state } = ringsBetween(s, 0, 8_000);
    expect(rings).toHaveLength(1);
    expect(state.orders).toHaveLength(2);
    expect(describeNewOrders(state.orders, money).title).toBe('2 new online orders');
  });

  it('orders arriving one network round trip apart join the chime instead of a burst', () => {
    let s = receiveOrder(EMPTY_ALERT_STATE, order('1'), 0);
    s = markRang(s, 0);
    s = receiveOrder(s, order('2'), 2_000);
    s = receiveOrder(s, order('3'), 4_000);
    const { rings } = ringsBetween(s, 0, 8_900);
    expect(rings).toHaveLength(0);
    expect(dueRing(s, S, RING_EVERY_MS)).toBe('newOrder');
  });

  it('with "keep ringing" off, a later order still rings once', () => {
    const once: AlertSoundSettings = { ...S, repeatUntilSeen: false };
    let s = receiveOrder(EMPTY_ALERT_STATE, order('1'), 0);
    s = markRang(s, 0);
    s = receiveOrder(s, order('2'), 2_000);
    const { rings } = ringsBetween(s, 0, 60_000, once);
    expect(rings.map((r) => r.at)).toEqual([RING_EVERY_MS]);
  });

  it('never rings for an order already seen', () => {
    let s = receiveOrder(EMPTY_ALERT_STATE, order('1'), 0);
    s = acknowledgeOrders(s, 5_000).state;
    const back = receiveOrder(s, order('1'), 6_000);
    expect(back.orders).toHaveLength(0);
    expect(isLoud(back)).toBe(false);
  });

  it('copes with an event from an older build (no total, no delivery/pick-up)', () => {
    const s = receiveOrder(EMPTY_ALERT_STATE, { orderId: 'x', orderNumber: 'CO-1-0007', customerName: 'Ali' }, 0);
    expect(s.orders[0]).toMatchObject({ fulfilment: null, totalCents: null, webOrderId: null, totalMismatch: null });
    expect(describeNewOrders(s.orders, money)).toEqual({ title: 'New online order #0007', detail: 'Ali' });
  });

  it('ignores an event with no order id', () => {
    expect(receiveOrder(EMPTY_ALERT_STATE, { orderId: '' }, 0)).toBe(EMPTY_ALERT_STATE);
  });
});

describe('keep ringing until someone looks', () => {
  const rungAt0 = () => markRang(receiveOrder(EMPTY_ALERT_STATE, order('1'), 0), 0);

  it('repeats every 9 s — not a moment before', () => {
    const s = rungAt0();
    expect(dueRing(s, S, RING_EVERY_MS - 100)).toBeNull();
    expect(dueRing(s, S, RING_EVERY_MS)).toBe('newOrder');
  });

  it('slows to every 30 s after 10 minutes, and stops after an hour (the banner stays)', () => {
    const s = rungAt0();
    const late = markRang(s, RING_SLOW_AFTER_MS);
    expect(dueRing(late, S, RING_SLOW_AFTER_MS + RING_EVERY_MS)).toBeNull();
    expect(dueRing(late, S, RING_SLOW_AFTER_MS + RING_SLOW_EVERY_MS)).toBe('newOrder');
    const hour = markRang(s, RING_STOP_AFTER_MS - 1);
    expect(dueRing(hour, S, RING_STOP_AFTER_MS + RING_SLOW_EVERY_MS)).toBeNull();
    expect(isLoud(hour)).toBe(true);
  });

  it('a new order puts the fast repeat back', () => {
    let s = markRang(rungAt0(), RING_SLOW_AFTER_MS + 5_000);
    const t = RING_SLOW_AFTER_MS + 6_000;
    s = receiveOrder(s, order('2'), t);
    s = markRang(s, t + 3_000);
    expect(dueRing(s, S, t + 3_000 + RING_EVERY_MS)).toBe('newOrder');
  });

  it('off: exactly one ring per arrival', () => {
    const once: AlertSoundSettings = { ...S, repeatUntilSeen: false };
    const s = receiveOrder(EMPTY_ALERT_STATE, order('1'), 0);
    const { rings } = ringsBetween(s, 0, 120_000, once, 500);
    expect(rings).toHaveLength(1);
  });

  it('off is the chime\'s switch only: the "did not come in" alarm still repeats', () => {
    const once: AlertSoundSettings = { ...S, repeatUntilSeen: false };
    const s = receiveFailure(EMPTY_ALERT_STATE, failure('w1'), 0);
    const { rings } = ringsBetween(s, 0, 3 * RING_EVERY_MS, once, 500);
    expect(rings.map((r) => r.at)).toEqual([0, RING_EVERY_MS, 2 * RING_EVERY_MS, 3 * RING_EVERY_MS]);
    expect(rings.every((r) => r.kind === 'importFailed')).toBe(true);
  });

  it('Settings says what the repeat does, in the numbers it uses', () => {
    expect(repeatRuleText()).toBe(
      'every 9 s, then every 30 s after 10 minutes; it stops after an hour and the note stays',
    );
    expect(RING_EVERY_MS).toBe(9_000);
    expect(RING_SLOW_EVERY_MS).toBe(30_000);
    expect(RING_SLOW_AFTER_MS).toBe(10 * 60_000);
    expect(RING_STOP_AFTER_MS).toBe(60 * 60_000);
  });
});

describe('sound settings never hide the banner', () => {
  it('master off or the order sound off: nothing rings, the banner stays', () => {
    const s = receiveOrder(EMPTY_ALERT_STATE, order('1'), 0);
    expect(dueRing(s, { ...S, enabled: false }, 0)).toBeNull();
    expect(dueRing(s, { ...S, events: { ...S.events, newOnlineOrder: false } }, 0)).toBeNull();
    expect(dueRing(s, { ...S, volume: 0 }, 0)).toBeNull();
    expect(s.orders).toHaveLength(1);
    expect(isLoud(s)).toBe(true);
  });

  it('with the order sound off, a failed order still rings', () => {
    const noChime: AlertSoundSettings = { ...S, events: { ...S.events, newOnlineOrder: false } };
    let s = receiveOrder(EMPTY_ALERT_STATE, order('1'), 0);
    s = receiveFailure(s, failure('w9'), 0);
    expect(dueRing(s, noChime, 0)).toBe('importFailed');
  });

  it('ringsFor needs the master switch, some volume and the event', () => {
    expect(ringsFor('lowStock', S)).toBe(true);
    expect(ringsFor('lowStock', { ...S, enabled: false })).toBe(false);
    expect(ringsFor('lowStock', { ...S, volume: 0 })).toBe(false);
    expect(ringsFor('lowStock', { ...S, events: { ...S.events, lowStock: false } })).toBe(false);
  });
});

describe('the alarm (a website order did not come in)', () => {
  it('wins over the chime', () => {
    let s = receiveOrder(EMPTY_ALERT_STATE, order('1'), 0);
    s = receiveFailure(s, failure('w9'), 0);
    expect(dueRing(s, S, 0)).toBe('importFailed');
  });

  it('only a final failure raises it; the first failed try (still retrying) does not', () => {
    expect(failureFromEvent({ webOrderId: 'w1', customerName: 'Sara', message: 'Item gone', final: false }, 0)).toBeNull();
    expect(failureFromEvent({ webOrderId: 'w1', customerName: 'Sara', message: 'Item gone' }, 0)).toBeNull();
    const f = failureFromEvent({ webOrderId: 'w1', customerName: 'Sara', message: 'gave up after 5 attempts', customerPhone: ' 0300 ', final: true, reason: 'gave_up' }, 0);
    expect(f).toMatchObject({ webOrderId: 'w1', reason: 'gave_up', silenced: false, customerPhone: '0300' });
    // An older build: its give-up said so in the message.
    expect(failureFromEvent({ webOrderId: 'w2', customerName: 'Sara', message: 'gave up after 5 attempts' }, 0)).not.toBeNull();
  });

  it('an order that came in while the till was off is a card, not an alarm', () => {
    const f = failureFromEvent({ webOrderId: 'w1', customerName: 'Sara', message: 'stale', final: true, reason: 'stale' }, 0)!;
    const s = receiveFailure(EMPTY_ALERT_STATE, f, 0);
    expect(s.failures).toHaveLength(1);
    expect(isLoud(s)).toBe(false);
    expect(dueRing(s, S, 0)).toBeNull();
  });

  it('one card and one alarm per website order', () => {
    let s = receiveFailure(EMPTY_ALERT_STATE, failure('w1'), 0);
    s = markRang(s, 0);
    const again = receiveFailure(s, failure('w1'), 1_000);
    expect(again.failures).toHaveLength(1);
    expect(dueRing(again, S, 1_000)).toBeNull();
  });

  it('never starts right on top of the chime', () => {
    let s = markRang(receiveOrder(EMPTY_ALERT_STATE, order('1'), 0), 0);
    s = receiveFailure(s, failure('w1'), 1_000);
    expect(dueRing(s, S, 1_000)).toBeNull();
    expect(dueRing(s, S, MIN_RING_GAP_MS)).toBe('importFailed');
  });

  it('a later successful import takes the failure away', () => {
    let s = receiveFailure(EMPTY_ALERT_STATE, failure('w5'), 0);
    s = receiveOrder(s, order('5', { webOrderId: 'w5' }), 1_000);
    expect(s.failures).toHaveLength(0);
    expect(s.orders).toHaveLength(1);
  });

  it('Seen silences the alarm, but the card (with the number) stays until closed', () => {
    let s = receiveFailure(EMPTY_ALERT_STATE, failure('w1'), 0);
    const r = silenceFailures(s);
    s = r.state;
    expect(r.ids).toEqual(['w1']);
    expect(isLoud(s)).toBe(false);
    expect(s.failures).toHaveLength(1);
    expect(s.lastRingAt).toBeNull();
    s = closeFailure(s, 'w1');
    expect(s.failures).toHaveLength(0);
    // Closed means closed: the main process's list cannot bring it back.
    expect(receiveFailure(s, failure('w1'), 5_000).failures).toHaveLength(0);
  });
});

describe('Seen', () => {
  it('acknowledges what was on screen; an order that arrived under the finger keeps ringing', () => {
    let s = receiveOrder(EMPTY_ALERT_STATE, order('1'), 0);
    s = markRang(s, 0);
    s = receiveOrder(s, order('2'), 10_000);
    const r = acknowledgeOrders(s, 10_000 + SEEN_GRACE_MS - 1);
    expect(r.orderIds).toEqual(['1']);
    expect(r.state.orders.map((o) => o.orderId)).toEqual(['2']);
    expect(isLoud(r.state)).toBe(true);
  });

  it('one order, Seen 1 s after it came in: it is all the banner showed, so it goes for good', () => {
    let s = receiveOrder(EMPTY_ALERT_STATE, order('1'), 0);
    s = markRang(s, 0);
    const r = acknowledgeOrders(s, 1_000);
    expect(r.orderIds).toEqual(['1']);
    expect(isLoud(r.state)).toBe(false);
    expect(ringsBetween(r.state, 1_000, 60_000).rings).toHaveLength(0);
    // Esc does the same.
    expect(seenOnScreen(s, 1_000).orderIds).toEqual(['1']);
  });

  it('View / opening Live Orders acknowledges every order at once', () => {
    let s = receiveOrder(EMPTY_ALERT_STATE, order('1'), 0);
    s = receiveOrder(s, order('2'), 100);
    const r = acknowledgeOrders(s, 100, { all: true });
    expect(r.orderIds).toEqual(['1', '2']);
    expect(isLoud(r.state)).toBe(false);
    expect(r.state.ringingSince).toBeNull();
    expect(r.state.nextRingAt).toBeNull();
  });

  it('acknowledging orders leaves a failed-order alarm ringing', () => {
    let s = receiveOrder(EMPTY_ALERT_STATE, order('1'), 0);
    s = receiveFailure(s, failure('w9'), 0);
    s = acknowledgeOrders(s, 5_000, { all: true }).state;
    expect(isLoud(s)).toBe(true);
    expect(dueRing(markRang(s, 5_000), S, 5_000 + RING_EVERY_MS)).toBe('importFailed');
  });

  it('Seen / Esc while the alarm shows: only that alarm — the order behind it keeps its row and gets its chime', () => {
    let s = receiveFailure(EMPTY_ALERT_STATE, failure('w1'), 0);
    s = markRang(s, 0);
    s = receiveOrder(s, order('43'), 5_000); // "+1 more" on the red row
    s = markRang(s, RING_EVERY_MS); // the alarm took the ring
    const r = seenOnScreen(s, 12_000);
    expect(r.failureIds).toEqual(['w1']);
    expect(r.orderIds).toEqual([]);
    expect(r.state.orders.map((o) => o.orderId)).toEqual(['43']);
    expect(r.state.failures[0]!.silenced).toBe(true);
    // The green row now rings for it — with "keep ringing" off too.
    const once: AlertSoundSettings = { ...S, repeatUntilSeen: false };
    const after = ringsBetween(r.state, 12_000, 60_000, once);
    expect(after.rings).toEqual([{ at: RING_EVERY_MS + MIN_RING_GAP_MS, kind: 'newOrder' }]);
  });

  it('two alarms: each Seen silences the one shown, and the next one rings on', () => {
    let s = receiveFailure(EMPTY_ALERT_STATE, failure('w1'), 0);
    s = receiveFailure(s, failure('w2'), 100);
    s = markRang(s, 0);
    const first = seenOnScreen(s, 5_000);
    expect(first.failureIds).toEqual(['w1']);
    expect(isLoud(first.state)).toBe(true);
    const second = seenOnScreen(first.state, 6_000);
    expect(second.failureIds).toEqual(['w2']);
    expect(isLoud(second.state)).toBe(false);
    expect(second.state.failures).toHaveLength(2); // the cards, with the numbers, stay
  });

  it('an alarm that arrived under the finger is spared: the orders on screen are what was seen', () => {
    let s = receiveOrder(EMPTY_ALERT_STATE, order('1'), 0);
    s = markRang(s, 0);
    s = receiveFailure(s, failure('w1'), 10_000);
    const r = seenOnScreen(s, 10_000 + SEEN_GRACE_MS - 1);
    expect(r.orderIds).toEqual(['1']);
    expect(r.failureIds).toEqual([]);
    expect(dueRing(r.state, S, 10_000 + SEEN_GRACE_MS)).toBe('importFailed');
  });

  it('with only an alarm on screen, Seen at once silences it', () => {
    const s = markRang(receiveFailure(EMPTY_ALERT_STATE, failure('w1'), 0), 0);
    expect(seenOnScreen(s, 500).failureIds).toEqual(['w1']);
  });

  it('keeps the seen list bounded', () => {
    let s = EMPTY_ALERT_STATE;
    for (let i = 0; i < SEEN_LIMIT + 50; i += 1) {
      s = receiveOrder(s, order(String(i)), i);
      s = acknowledgeOrders(s, i, { all: true }).state;
    }
    expect(s.seenOrderIds).toHaveLength(SEEN_LIMIT);
    expect(s.seenOrderIds[s.seenOrderIds.length - 1]).toBe(String(SEEN_LIMIT + 49));
  });
});

describe('the main process list (restart, reload, the other till)', () => {
  it('orders it kept ring on a screen that just started', () => {
    const s = applySnapshot(EMPTY_ALERT_STATE, { orders: [order('1')], failures: [failure('w9')] }, 0, 0);
    expect(s.orders).toHaveLength(1);
    expect(s.failures).toHaveLength(1);
    expect(dueRing(s, S, 0)).toBe('importFailed');
  });

  it('drops an order it no longer has (someone started it)', () => {
    const s = receiveOrder(EMPTY_ALERT_STATE, order('1'), 0);
    const next = applySnapshot(s, { orders: [], failures: [] }, 10_000, 10_050);
    expect(next.orders).toHaveLength(0);
    expect(isLoud(next)).toBe(false);
    expect(next.seenOrderIds).toContain('1');
  });

  it('an older list never silences a brand-new order', () => {
    const s = receiveOrder(EMPTY_ALERT_STATE, order('1'), 10_000);
    const next = applySnapshot(s, { orders: [], failures: [] }, 10_000 + RECONCILE_MARGIN_MS - 1, 10_100);
    expect(next.orders).toHaveLength(1);
  });

  it('an order acknowledged here is not brought back by a list made before the main process heard', () => {
    let s = receiveOrder(EMPTY_ALERT_STATE, order('1'), 0);
    s = acknowledgeOrders(s, 5_000, { all: true }).state;
    const next = applySnapshot(s, { orders: [order('1')], failures: [] }, 4_000, 5_100);
    expect(next.orders).toHaveLength(0);
  });

  it('keeps a silenced alarm silenced', () => {
    let s = receiveFailure(EMPTY_ALERT_STATE, failure('w1'), 0);
    s = silenceFailures(s).state;
    const next = applySnapshot(s, { orders: [], failures: [failure('w1')] }, 1_000, 1_000);
    expect(next.failures[0]!.silenced).toBe(true);
    expect(isLoud(next)).toBe(false);
  });

  it('a card closed on another screen goes', () => {
    const s = receiveFailure(EMPTY_ALERT_STATE, failure('w1'), 0);
    const next = applySnapshot(s, { orders: [], failures: [] }, 10_000, 10_000);
    expect(next.failures).toHaveLength(0);
  });
});

describe('the words on the banner', () => {
  it('one order: number, delivery or pick-up, total, name', () => {
    const s = receiveOrder(EMPTY_ALERT_STATE, order('42'), 0);
    expect(describeNewOrders(s.orders, money)).toEqual({
      title: 'New online order #0042',
      detail: 'Delivery · Rs 1,850 · Ali',
    });
    const p = receiveOrder(EMPTY_ALERT_STATE, order('43', { fulfilment: 'pickup' }), 0);
    expect(describeNewOrders(p.orders, money).detail).toBe('Pick-up · Rs 1,850 · Ali');
  });

  it('says when the total changed, and when the kitchen ticket did not print', () => {
    let s = receiveOrder(
      EMPTY_ALERT_STATE,
      order('42', { totalMismatch: { webTotalCents: 170_000, tillTotalCents: 185_000 } }),
      0,
    );
    expect(describeNewOrders(s.orders, money).detail).toBe(
      'Total changed: website Rs 1,700, till Rs 1,850 — call Ali before it goes out',
    );
    s = markTicketFailed(s, '42');
    expect(describeNewOrders(s.orders, money).detail).toMatch(/kitchen ticket did not print$/);
    expect(markTicketFailed(s, 'nope')).toBe(s);
  });

  it('several orders: counted, numbers listed, "+N more" only when some are left out', () => {
    let s = EMPTY_ALERT_STATE;
    for (const id of ['42', '43', '44', '45']) s = receiveOrder(s, order(id), 0);
    expect(describeNewOrders(s.orders, money)).toEqual({
      title: '4 new online orders',
      detail: '#0042, #0043, #0044 +1 more',
    });
  });

  it('a failed order: the number only for someone logged in, the reason only in the tooltip', () => {
    const f = failure('w1', { message: 'SqliteError: FOREIGN KEY constraint failed' });
    expect(describeFailure(f, true)).toEqual({
      title: 'Website order from Sara did not come in',
      detail: 'Call 0300-1234567 and take the order by phone.',
      tooltip: 'Reason: SqliteError: FOREIGN KEY constraint failed',
    });
    expect(describeFailure(f, false).detail).toBe('Log in to see the phone number, then call and take the order by phone.');
    expect(describeFailure(f, false).detail).not.toContain('0300');
  });

  it('came in while the till was off: cancelled on the website, call to say sorry', () => {
    const f = failure('w1', { reason: 'stale', silenced: true });
    expect(describeFailure(f, true).title).toBe('Website order from Sara came in while the till was off');
    expect(describeFailure(f, true).detail).toContain('Call 0300-1234567');
  });
});
