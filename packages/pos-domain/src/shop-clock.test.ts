/**
 * The shop's clock. Two promises, tested separately:
 *   - Pakistan: exactly the arithmetic the till has always used — the UTC
 *     date as the trading day, UTC+5 as the hour — over 100k seeded instants;
 *   - everywhere else: the shop's own wall clock, through its zone, with the
 *     trading day running 05:00 to 05:00 local across daylight saving.
 */
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SHOP_LOCALE,
  US_SHOP_LOCALE,
  resolveShopLocale,
  shopHourOf,
  shopTradingDay,
  shopTradingDayIndex,
  shopTradingDayStart,
  shopTradingDayStartOf,
} from '@cheeseoclock/shared-types';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const PKT = 18_000_000; // UTC+5, written as a number so it reads as the old code's offset
const at = (iso: string) => Date.parse(iso);
const NY = US_SHOP_LOCALE; // America/New_York
const phoenix = resolveShopLocale({ v: 1, country: 'US', timeZone: 'America/Phoenix' });

function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('Pakistan keeps the arithmetic it has always used', () => {
  it('matches the old trading day, hour, day index and day start over 100k instants', () => {
    const rnd = seeded(0x5c_10_c4);
    for (let i = 0; i < 100_000; i++) {
      const ms = Math.floor(rnd() * 1_300_000_000_000) + 1_000_000_000_000;
      const oldDay = new Date(ms).toISOString().slice(0, 10); // order numbers, sql.ts tradingDayOf
      const oldHour = new Date(ms + PKT).getUTCHours(); // sql.ts pakistanHourOf, trends.ts
      if (shopTradingDay(ms, DEFAULT_SHOP_LOCALE) !== oldDay) throw new Error(`day moved at ${ms}`);
      if (shopHourOf(ms, DEFAULT_SHOP_LOCALE) !== oldHour) throw new Error(`hour moved at ${ms}`);
      if (shopTradingDayIndex(ms, DEFAULT_SHOP_LOCALE) !== Math.floor(ms / DAY)) throw new Error(`index moved at ${ms}`);
      if (shopTradingDayStart(ms, DEFAULT_SHOP_LOCALE) !== Math.floor(ms / DAY) * DAY) throw new Error(`start moved at ${ms}`);
    }
  });

  it('is what a till with no locale set uses', () => {
    const ms = at('2026-10-20T21:30:00Z'); // 02:30 in Karachi: still the 20th's trading day
    expect(shopTradingDay(ms)).toBe('2026-10-20');
    expect(shopHourOf(ms)).toBe(2);
  });
});

describe('a New York shop runs on New York time', () => {
  it('keeps the evening rush on the same trading day (the 7 pm bug)', () => {
    // 20:30 on 20 Oct in New York is 00:30 UTC on the 21st: the UTC date had
    // already moved on, and the order numbers with it.
    expect(shopTradingDay(at('2026-10-21T00:30:00Z'), NY)).toBe('2026-10-20');
  });

  it('puts a 3 a.m. order on the night before, and 5 a.m. on the new day', () => {
    expect(shopTradingDay(at('2026-10-21T07:00:00Z'), NY)).toBe('2026-10-20'); // 03:00 EDT
    expect(shopTradingDay(at('2026-10-21T08:59:59Z'), NY)).toBe('2026-10-20'); // 04:59:59 EDT
    expect(shopTradingDay(at('2026-10-21T09:00:00Z'), NY)).toBe('2026-10-21'); // 05:00 EDT
  });

  it('reads the hour off the wall clock in summer and in winter', () => {
    expect(shopHourOf(at('2026-07-01T16:00:00Z'), NY)).toBe(12); // EDT, UTC-4
    expect(shopHourOf(at('2026-01-15T17:00:00Z'), NY)).toBe(12); // EST, UTC-5
    expect(shopHourOf(at('2026-07-01T19:00:00Z'), phoenix)).toBe(12); // MST all year
  });

  it('starts each day at 05:00 local, so the clock-change days are 23 and 25 hours', () => {
    expect(new Date(shopTradingDayStartOf('2026-03-07', NY)).toISOString()).toBe('2026-03-07T10:00:00.000Z'); // EST
    expect(new Date(shopTradingDayStartOf('2026-03-08', NY)).toISOString()).toBe('2026-03-08T09:00:00.000Z'); // EDT
    expect(shopTradingDayStartOf('2026-03-08', NY) - shopTradingDayStartOf('2026-03-07', NY)).toBe(23 * HOUR);
    expect(shopTradingDayStartOf('2026-11-01', NY) - shopTradingDayStartOf('2026-10-31', NY)).toBe(25 * HOUR);
  });

  it('puts every instant inside the trading day it belongs to, across two years', () => {
    const rnd = seeded(0x0e_57);
    for (let i = 0; i < 20_000; i++) {
      const ms = at('2026-01-01T00:00:00Z') + Math.floor(rnd() * 730 * DAY);
      for (const l of [NY, phoenix]) {
        const day = shopTradingDay(ms, l);
        const start = shopTradingDayStartOf(day, l);
        const next = shopTradingDayStartOf(new Date(Date.parse(`${day}T00:00:00Z`) + DAY).toISOString().slice(0, 10), l);
        if (!(start <= ms && ms < next)) throw new Error(`${new Date(ms).toISOString()} is outside ${day} in ${l.timeZone}`);
        if (shopTradingDayStart(ms, l) !== start) throw new Error(`today's start disagrees at ${ms}`);
      }
    }
  });
});
