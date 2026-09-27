import { describe, expect, it } from 'vitest';
import {
  LINK_QUIET_MS,
  OTHER_TILL_MISSING,
  ledgerDate,
  movesShopStock,
  otherTillMissing,
  settlesAnOrder,
  shopStockOf,
  shopStockOfSums,
  staleLinkText,
  tillLinkState,
  type LedgerRow,
} from './shop-stock.js';

const T = (hhmm: string) => `2026-09-21T${hhmm}:00.000Z`;

function row(over: Partial<LedgerRow>): LedgerRow {
  return {
    ingredientId: 'cheese',
    deltaQty: 0,
    unit: 'g',
    reason: 'sale',
    detail: null,
    refOrderId: null,
    refGroupId: null,
    occurredAt: T('10:00'),
    refTakenAt: null,
    ...over,
  };
}

describe('shop stock (costing spec 4.6)', () => {
  it("dates an order's settle rows by when the order first took stock", () => {
    const take = row({ deltaQty: -90, refOrderId: 'o1', occurredAt: T('10:00') });
    const putBack = row({ deltaQty: 90, refOrderId: 'o1', occurredAt: T('14:00'), refTakenAt: T('10:00'), detail: 'cancel_put_back' });
    expect(settlesAnOrder(take)).toBe(false);
    expect(settlesAnOrder(putBack)).toBe(true);
    expect(ledgerDate(take)).toBe(T('10:00'));
    expect(ledgerDate(putBack)).toBe(T('10:00'));
    // Written before costing (no ref_taken_at): its order's first take, looked up.
    const old = row({ deltaQty: -90, reason: 'waste', refOrderId: 'o2', occurredAt: T('15:00') });
    expect(ledgerDate(old, (id) => (id === 'o2' ? T('09:30') : undefined))).toBe(T('09:30'));
    expect(ledgerDate(old)).toBe(T('15:00'));
    // A row with no order is dated when it happened.
    expect(ledgerDate(row({ reason: 'delivery', deltaQty: 5_000, occurredAt: T('11:00') }), () => T('01:00'))).toBe(T('11:00'));
  });

  it("is the last stock take plus every till's rows since, 'count' rows left out", () => {
    const anchor = { countId: 's0', countedQty: 10_000, unit: 'g', finishedAt: T('08:00') };
    const rows: LedgerRow[] = [
      row({ reason: 'delivery', deltaQty: 5_000, occurredAt: T('09:00') }),
      row({ deltaQty: -300, refOrderId: 'o1', occurredAt: T('12:00') }),
      // The other till's sale: shop stock too.
      row({ deltaQty: -200, refOrderId: 'o9', occurredAt: T('12:30') }),
      // Sets one till's count; never the shelf.
      row({ reason: 'count', deltaQty: 4_000, occurredAt: T('13:00'), detail: 'stock_take' }),
      // An order taken before the stock take and put back after it: already in the count.
      row({ deltaQty: 60, refOrderId: 'o0', occurredAt: T('13:30'), refTakenAt: T('07:00') }),
      // After the moment asked about.
      row({ reason: 'waste', deltaQty: -50, occurredAt: T('20:00') }),
    ];
    expect(movesShopStock(rows[3]!)).toBe(false);
    expect(shopStockOf({ unitNow: 'g', anchor, tillQty: 999, rows, atIso: T('18:00') })).toEqual({ qty: 10_000 + 5_000 - 300 - 200, from: 'shop', unconvertible: false });
    // Never counted: this till's own count, said so.
    expect(shopStockOf({ unitNow: 'g', anchor: null, tillQty: 7_777, rows, atIso: T('18:00') })).toEqual({ qty: 7_777, from: 'till', unconvertible: false });
  });

  it('the same figure from sums per unit (what the till adds up in SQL)', () => {
    const anchor = { countId: 's0', countedQty: 12, unit: 'kg', finishedAt: T('08:00') };
    expect(shopStockOfSums({ unitNow: 'g', anchor, tillQty: 0, sums: [{ unit: 'kg', qty: 3 }, { unit: 'g', qty: -450 }] })).toEqual({ qty: 14_550, from: 'shop', unconvertible: false });
    expect(shopStockOfSums({ unitNow: 'g', anchor, tillQty: 0, sums: [{ unit: 'pcs', qty: 3 }] })).toEqual({ qty: 12_000, from: 'shop', unconvertible: true });
    expect(shopStockOfSums({ unitNow: 'g', anchor: null, tillQty: 42, sums: [{ unit: 'g', qty: 3 }] })).toEqual({ qty: 42, from: 'till', unconvertible: false });
  });

  it('scales a Convert (kg → g) between the stock take and now', () => {
    const anchor = { countId: 's0', countedQty: 12, unit: 'kg', finishedAt: T('08:00') };
    const rows = [row({ unit: 'kg', reason: 'delivery', deltaQty: 3, occurredAt: T('09:00') }), row({ unit: 'g', deltaQty: -450, refOrderId: 'o1', occurredAt: T('12:00') })];
    expect(shopStockOf({ unitNow: 'g', anchor, tillQty: 0, rows, atIso: T('18:00') })).toEqual({ qty: 12_000 + 3_000 - 450, from: 'shop', unconvertible: false });
    // A unit no Convert makes: left out, and said.
    expect(shopStockOf({ unitNow: 'g', anchor, tillQty: 0, rows: [row({ unit: 'pcs', deltaQty: 5, reason: 'delivery', occurredAt: T('09:00') })], atIso: T('18:00') })).toMatchObject({
      qty: 12_000,
      unconvertible: true,
    });
  });

  it("the critic's case: send, stock take, cancel not made, stock take — nothing moves between the two stock takes", () => {
    // Sent at 10:00 (90 g taken). The 11:00 stock take found 1,000 g on the shelf (the food was never made).
    // Cancelled "not made" at 12:00: put back (+90 sale) and, as the stock take had seen it, held (−90 count).
    const rows = [
      row({ deltaQty: -90, refOrderId: 'o1', occurredAt: T('10:00') }),
      row({ reason: 'count', deltaQty: 90, refGroupId: 's1', detail: 'stock_take', occurredAt: T('11:00') }),
      row({ deltaQty: 90, refOrderId: 'o1', occurredAt: T('12:00'), refTakenAt: T('10:00') }),
      row({ reason: 'count', deltaQty: -90, refOrderId: 'o1', occurredAt: T('12:00'), refTakenAt: T('10:00') }),
    ];
    const s1 = { countId: 's1', countedQty: 1_000, unit: 'g', finishedAt: T('11:00') };
    // At the next stock take the till expects what was counted: nothing to explain.
    expect(shopStockOf({ unitNow: 'g', anchor: s1, tillQty: 1_000, rows, atIso: T('16:00') }).qty).toBe(1_000);
  });
});

describe('the second-till link (costing spec D14)', () => {
  const now = Date.parse(T('12:00'));
  const recent = new Date(now - 60_000).toISOString();
  it('off: never "stale" — the shop runs with it off', () => {
    expect(tillLinkState({ mode: 'off', paused: true, lastAttemptAt: null, consecutiveFails: 9 }, now)).toEqual({ on: false, stale: false, lastHeardAt: null });
    expect(staleLinkText({ on: false, stale: true, lastHeardAt: null })).toBeNull();
  });
  it('on: stale when paused, failing, not tried lately, or never tried', () => {
    expect(tillLinkState({ mode: 'http', paused: false, lastAttemptAt: recent, consecutiveFails: 0 }, now)).toEqual({ on: true, stale: false, lastHeardAt: recent });
    expect(tillLinkState({ mode: 'http', paused: true, lastAttemptAt: recent, consecutiveFails: 0 }, now).stale).toBe(true);
    expect(tillLinkState({ mode: 'http', paused: false, lastAttemptAt: recent, consecutiveFails: 3 }, now)).toMatchObject({ stale: true, lastHeardAt: null });
    expect(tillLinkState({ mode: 'http', paused: false, lastAttemptAt: recent, consecutiveFails: 2 }, now).stale).toBe(false);
    expect(tillLinkState({ mode: 'http', paused: false, lastAttemptAt: new Date(now - LINK_QUIET_MS - 1).toISOString(), consecutiveFails: 0 }, now).stale).toBe(true);
    expect(tillLinkState({ mode: 'mock', paused: false, lastAttemptAt: null, consecutiveFails: 0 }, now).stale).toBe(true);
    expect(staleLinkText({ on: true, stale: true, lastHeardAt: null })).toMatch(/other till/);
    expect(staleLinkText({ on: true, stale: false, lastHeardAt: recent })).toBeNull();
  });
  it("two tills taking orders with the link off: the other till's sales aren't here", () => {
    expect(otherTillMissing(2, { on: false })).toBe(true);
    expect(otherTillMissing(2, { on: true })).toBe(false);
    expect(otherTillMissing(1, { on: false })).toBe(false);
    expect(OTHER_TILL_MISSING).toBe("The other till's sales aren't on this till");
  });
});
