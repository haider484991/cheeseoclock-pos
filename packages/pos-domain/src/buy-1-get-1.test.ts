/**
 * The Buy 1 Get 1 rule both the till and the website read (shared-types buy-1-get-1.ts; the owner, 7 Oct 2026):
 * which categories are the deals, the hours on the Karachi clock (1 PM up to 7 PM, every day), an order started
 * inside them, and that the deals never take a % off.
 */
import { describe, expect, it } from 'vitest';
import {
  BUY_1_GET_1_HOURS,
  buy1Get1AllowedOn,
  buy1Get1NoteLine,
  buy1Get1OpenAt,
  categoryNeverDiscounted,
  isBuy1Get1Category,
  karachiMinuteOfDay,
} from '@cheeseoclock/shared-types';

/** A moment on 7 Oct 2026, Karachi time (UTC+5). */
const karachi = (hour: number, minute: number, day = 7) => Date.UTC(2026, 9, day, hour - 5, minute);

describe('Buy 1 Get 1: which categories', () => {
  it('knows the deals by their name, however they are spelled', () => {
    for (const name of ['Buy 1 Get 1 Deals', 'Buy 1 Get 1', 'BUY ONE GET ONE FREE', 'buy1 get1', 'Buy One Get 1 Offer']) {
      expect(isBuy1Get1Category(name), name).toBe(true);
    }
    for (const name of ['Value Deals', 'Pizza', 'Burgers', 'Buy now', 'Get 1 free side', 'Buy 12 Get 1']) {
      expect(isBuy1Get1Category(name), name).toBe(false);
    }
  });

  it('never takes a % off them, with or without "Deals" in the name (the owner can still decide otherwise)', () => {
    expect(categoryNeverDiscounted({ name: 'Buy 1 Get 1 Deals' })).toBe(true);
    expect(categoryNeverDiscounted({ name: 'Buy 1 Get 1' })).toBe(true);
    expect(categoryNeverDiscounted({ name: 'Buy 1 Get 1', noDiscount: false })).toBe(false);
    // Unchanged for everything else.
    expect(categoryNeverDiscounted({ name: 'Pizza' })).toBe(false);
    expect(categoryNeverDiscounted({ name: 'Value Deals' })).toBe(true);
  });
});

describe('Buy 1 Get 1: the hours', () => {
  it('reads the Karachi clock (UTC+5, no daylight saving)', () => {
    expect(karachiMinuteOfDay(karachi(0, 0))).toBe(0);
    expect(karachiMinuteOfDay(karachi(13, 0))).toBe(13 * 60);
    expect(karachiMinuteOfDay(karachi(23, 59))).toBe(23 * 60 + 59);
    // Midnight UTC is 5 AM in Karachi; a moment before 1970 still lands inside the day.
    expect(karachiMinuteOfDay(Date.UTC(2026, 0, 1, 0, 0))).toBe(5 * 60);
    expect(karachiMinuteOfDay(-60_000)).toBe(5 * 60 - 1);
  });

  it('are on from 1:00 PM up to 6:59 PM, every day', () => {
    expect(BUY_1_GET_1_HOURS).toEqual({ opensMinute: 780, closesMinute: 1140 });
    expect(buy1Get1OpenAt(karachi(12, 59))).toBe(false);
    expect(buy1Get1OpenAt(karachi(13, 0))).toBe(true);
    expect(buy1Get1OpenAt(karachi(18, 59))).toBe(true);
    expect(buy1Get1OpenAt(karachi(19, 0))).toBe(false);
    expect(buy1Get1OpenAt(karachi(1, 0))).toBe(false);
    for (let day = 1; day <= 7; day++) expect(buy1Get1OpenAt(karachi(15, 0, day)), `day ${day}`).toBe(true);
  });

  it('keep a deal for an order started inside them, never one started outside', () => {
    expect(buy1Get1AllowedOn(karachi(19, 2), new Date(karachi(18, 58)).toISOString())).toBe(true);
    expect(buy1Get1AllowedOn(karachi(19, 2), new Date(karachi(12, 0)).toISOString())).toBe(false);
    expect(buy1Get1AllowedOn(karachi(14, 0), new Date(karachi(12, 0)).toISOString())).toBe(true);
    expect(buy1Get1AllowedOn(karachi(20, 0), null)).toBe(false);
    expect(buy1Get1AllowedOn(karachi(20, 0), 'not a date')).toBe(false);
  });
});

describe('Buy 1 Get 1: the order notes', () => {
  it('say whose post the cashier checks', () => {
    expect(buy1Get1NoteLine('@ahmed_k')).toBe('Buy 1 Get 1: check the post by @ahmed_k');
  });
});
