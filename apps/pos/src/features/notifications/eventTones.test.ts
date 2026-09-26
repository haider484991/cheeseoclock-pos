import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ALERT_SOUND_SETTINGS,
  type AlertSoundSettings,
  type OrderSnapshot,
  type OrderStatus,
} from '@cheeseoclock/shared-types';
import {
  ACTIVE_ORDERS_KEY,
  LOW_STOCK_TONE_GAP_MS,
  PRINTER_TONE_GAP_MS,
  lowStockTone,
  planWaitingReminders,
  printerFailureEffect,
  toWaitingOrders,
  type ToneContext,
} from './eventTones';
import { NOT_STARTED_MIN, REMIND_TONE_GAP_MS, type WaitingOrder } from './waitingReminders';

const S: AlertSoundSettings = DEFAULT_ALERT_SOUND_SETTINGS;
const NOW = Date.parse('2026-09-26T14:00:00.000Z');
const ctx = (extra: Partial<ToneContext> = {}): ToneContext => ({
  loggedIn: true,
  settings: S,
  now: NOW,
  lastToneAt: 0,
  ...extra,
});

describe('printer problem', () => {
  it('the first miss (the spooler is retrying by itself) never marks the ticket as not printed', () => {
    // Saying "did not print" here sends someone to reprint; the retry prints
    // too, and the kitchen cooks the order twice.
    const r = printerFailureEffect({ jobKind: 'kitchen', orderId: 'o1', retrying: true }, ctx());
    expect(r.ticketFailedOrderId).toBeNull();
    expect(r.tone).toBe(true); // a beep: the printer is not answering
  });

  it('once the spooler gives up, the website order\'s banner says its ticket did not print', () => {
    expect(printerFailureEffect({ jobKind: 'kitchen', orderId: 'o1', retrying: false }, ctx()).ticketFailedOrderId).toBe('o1');
    // An older main process sent no `retrying` on the final failure.
    expect(printerFailureEffect({ jobKind: 'kitchen', orderId: 'o1' }, ctx()).ticketFailedOrderId).toBe('o1');
  });

  it('a receipt or a job with no order never marks a ticket', () => {
    expect(printerFailureEffect({ jobKind: 'receipt', orderId: 'o1' }, ctx()).ticketFailedOrderId).toBeNull();
    expect(printerFailureEffect({ jobKind: 'kitchen' }, ctx()).ticketFailedOrderId).toBeNull();
  });

  it('marks the ticket logged out too (the banner is the only place that says so), but beeps only logged in', () => {
    const r = printerFailureEffect({ jobKind: 'kitchen', orderId: 'o1' }, ctx({ loggedIn: false }));
    expect(r.ticketFailedOrderId).toBe('o1');
    expect(r.tone).toBe(false);
  });

  it('never beeps for the cash drawer (its own note says what to do)', () => {
    expect(printerFailureEffect({ jobKind: 'drawer', orderId: 'o1' }, ctx()).tone).toBe(false);
    expect(printerFailureEffect({ jobKind: 'drawer', retrying: true }, ctx()).tone).toBe(false);
  });

  it('at most one beep every 2 minutes', () => {
    const last = NOW - PRINTER_TONE_GAP_MS + 1;
    expect(printerFailureEffect({ jobKind: 'receipt' }, ctx({ lastToneAt: last })).tone).toBe(false);
    expect(printerFailureEffect({ jobKind: 'receipt' }, ctx({ lastToneAt: NOW - PRINTER_TONE_GAP_MS })).tone).toBe(true);
  });

  it('follows Settings → Sounds', () => {
    const off = { ...S, events: { ...S.events, printerProblem: false } };
    expect(printerFailureEffect({ jobKind: 'receipt' }, ctx({ settings: off })).tone).toBe(false);
    expect(printerFailureEffect({ jobKind: 'receipt' }, ctx({ settings: { ...S, enabled: false } })).tone).toBe(false);
  });
});

describe('running low', () => {
  it('beeps logged in, not twice for one sale, and follows the settings', () => {
    expect(lowStockTone(ctx())).toBe(true);
    expect(lowStockTone(ctx({ loggedIn: false }))).toBe(false);
    expect(lowStockTone(ctx({ lastToneAt: NOW - LOW_STOCK_TONE_GAP_MS + 1 }))).toBe(false);
    expect(lowStockTone(ctx({ settings: { ...S, events: { ...S.events, lowStock: false } } }))).toBe(false);
  });
});

describe('waiting too long', () => {
  const late = (id: string, status: OrderStatus = 'sent_to_kitchen'): WaitingOrder => ({
    id,
    orderNumber: `CO-20260926-${id.padStart(4, '0')}`,
    status,
    createdAt: new Date(NOW - (NOT_STARTED_MIN + 1) * 60_000).toISOString(),
    source: 'web',
  });
  const plan = (list: WaitingOrder[], extra: Partial<ToneContext> = {}, reminded = new Set<string>()) =>
    planWaitingReminders(list, { ...ctx(extra), reminded, ringing: new Set() });

  it('a late order: a note and one beep', () => {
    const r = plan([late('1')]);
    expect(r.due.map((d) => d.key)).toEqual([`1:${NOT_STARTED_MIN}`]);
    expect(r.tone).toBe(true);
  });

  it('at most one beep every 5 minutes; the note still shows', () => {
    const r = plan([late('1')], { lastToneAt: NOW - REMIND_TONE_GAP_MS + 1 });
    expect(r.due).toHaveLength(1);
    expect(r.tone).toBe(false);
  });

  it('with the sound off the note still shows, silently', () => {
    const r = plan([late('1')], { settings: { ...S, events: { ...S.events, waitingTooLong: false } } });
    expect(r.due).toHaveLength(1);
    expect(r.tone).toBe(false);
  });

  it('once per order', () => {
    expect(plan([late('1')], {}, new Set([`1:${NOT_STARTED_MIN}`])).due).toEqual([]);
  });

  it('nothing due: no beep', () => {
    expect(plan([]).tone).toBe(false);
  });

  it('counter orders only when Settings says so', () => {
    const counter = { ...late('1'), source: 'pos' as const };
    expect(plan([counter]).due).toEqual([]);
    expect(plan([counter], { settings: { ...S, waitingIncludesCounter: true } }).due).toHaveLength(1);
  });

  it('reads the order list Live Orders and the sidebar share', () => {
    // The sidebar badge and the board's "All" tab use this key (Sidebar.tsx,
    // OrdersBoardPage.tsx); reading it adds no polling of its own.
    expect(ACTIVE_ORDERS_KEY).toEqual(['orders', 'active', 'all']);
    const snap = {
      order: { id: 'o9', orderNumber: 'CO-20260926-0009', status: 'preparing', createdAt: '2026-09-26T13:00:00.000Z', source: 'web' },
    } as unknown as OrderSnapshot;
    expect(toWaitingOrders([snap])).toEqual([
      { id: 'o9', orderNumber: 'CO-20260926-0009', status: 'preparing', createdAt: '2026-09-26T13:00:00.000Z', source: 'web' },
    ]);
  });
});
