/**
 * The Buy 1 Get 1 rule both the till and the website read (shared-types buy-1-get-1.ts; the owner, 7 Oct 2026):
 * which categories are the deals, the owner's rules ('deals.buy1Get1': on or off, the hours on the Karachi clock —
 * 1 PM up to 7 PM until changed — and the website's name question), an order started inside the hours, the words,
 * and that the deals never take a % off.
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BUY_1_GET_1_DEALS,
  DEFAULT_BUY_1_GET_1_RULES,
  SHOP_SETTING_DEFAULTS,
  SHOP_SETTING_FORMAT,
  buy1Get1AllowedOn,
  buy1Get1ClosedMessage,
  buy1Get1HoursProblem,
  buy1Get1NoteLine,
  buy1Get1OpenAt,
  buy1Get1Summary,
  buy1Get1WindowWords,
  categoryNeverDiscounted,
  isBuy1Get1Category,
  karachiMinuteOfDay,
  type Buy1Get1Rules,
} from '@cheeseoclock/shared-types';

/** A moment on 7 Oct 2026, Karachi time (UTC+5). */
const karachi = (hour: number, minute: number, day = 7) => Date.UTC(2026, 9, day, hour - 5, minute);
const rules = (over: Partial<Buy1Get1Rules>): Buy1Get1Rules => ({ ...DEFAULT_BUY_1_GET_1_RULES, ...over });

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

describe('Buy 1 Get 1: the setting', () => {
  it('is the poster’s until the owner saves one: on, 1 PM up to 7 PM, the name asked for (frozen, format 1)', () => {
    expect(DEFAULT_BUY_1_GET_1_RULES).toEqual({ on: true, opensMinute: 780, closesMinute: 1140, asksSocial: true });
    expect(DEFAULT_BUY_1_GET_1_DEALS).toEqual({ v: 1, on: true, opensMinute: 780, closesMinute: 1140, asksSocial: true });
    expect(SHOP_SETTING_DEFAULTS['deals.buy1Get1']).toBe(DEFAULT_BUY_1_GET_1_DEALS);
    expect(SHOP_SETTING_FORMAT['deals.buy1Get1']).toBe(1);
    expect(Object.isFrozen(DEFAULT_BUY_1_GET_1_RULES)).toBe(true);
    expect(Object.isFrozen(DEFAULT_BUY_1_GET_1_DEALS)).toBe(true);
  });

  it('takes any hours but the same start and end, in the owner’s words', () => {
    expect(buy1Get1HoursProblem({ opensMinute: 780, closesMinute: 1140 })).toBeNull();
    expect(buy1Get1HoursProblem({ opensMinute: 0, closesMinute: 1440 })).toBeNull();
    expect(buy1Get1HoursProblem({ opensMinute: 1320, closesMinute: 60 })).toBeNull();
    expect(buy1Get1HoursProblem({ opensMinute: 780, closesMinute: 780 })).toMatch(/same time/);
    expect(buy1Get1HoursProblem({ opensMinute: -1, closesMinute: 60 })).toMatch(/start/);
    expect(buy1Get1HoursProblem({ opensMinute: 1440, closesMinute: 60 })).toMatch(/start/);
    expect(buy1Get1HoursProblem({ opensMinute: 60.5, closesMinute: 120 })).toMatch(/start/);
    expect(buy1Get1HoursProblem({ opensMinute: 60, closesMinute: 0 })).toMatch(/end/);
    expect(buy1Get1HoursProblem({ opensMinute: 60, closesMinute: 1441 })).toMatch(/end/);
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

  it('are on from 1:00 PM up to 6:59 PM, every day, until the owner changes them', () => {
    expect(buy1Get1OpenAt(karachi(12, 59))).toBe(false);
    expect(buy1Get1OpenAt(karachi(13, 0))).toBe(true);
    expect(buy1Get1OpenAt(karachi(18, 59))).toBe(true);
    expect(buy1Get1OpenAt(karachi(19, 0))).toBe(false);
    expect(buy1Get1OpenAt(karachi(1, 0))).toBe(false);
    for (let day = 1; day <= 7; day++) expect(buy1Get1OpenAt(karachi(15, 0, day)), `day ${day}`).toBe(true);
  });

  it('follow the owner’s hours, past midnight too, and none at all while switched off', () => {
    const lunch = rules({ opensMinute: 11 * 60 + 30, closesMinute: 15 * 60 });
    expect(buy1Get1OpenAt(karachi(11, 29), lunch)).toBe(false);
    expect(buy1Get1OpenAt(karachi(11, 30), lunch)).toBe(true);
    expect(buy1Get1OpenAt(karachi(14, 59), lunch)).toBe(true);
    expect(buy1Get1OpenAt(karachi(15, 0), lunch)).toBe(false);
    // 10 PM to 1 AM: from 10 PM to the day's end, and from midnight to 12:59 AM.
    const late = rules({ opensMinute: 22 * 60, closesMinute: 60 });
    expect(buy1Get1OpenAt(karachi(21, 59), late)).toBe(false);
    expect(buy1Get1OpenAt(karachi(22, 0), late)).toBe(true);
    expect(buy1Get1OpenAt(karachi(23, 59), late)).toBe(true);
    expect(buy1Get1OpenAt(karachi(0, 0), late)).toBe(true);
    expect(buy1Get1OpenAt(karachi(0, 59), late)).toBe(true);
    expect(buy1Get1OpenAt(karachi(1, 0), late)).toBe(false);
    expect(buy1Get1OpenAt(karachi(15, 0), late)).toBe(false);
    // All day, to midnight.
    const allDay = rules({ opensMinute: 0, closesMinute: 1440 });
    for (const h of [0, 6, 12, 23]) expect(buy1Get1OpenAt(karachi(h, 30), allDay), `${h}:30`).toBe(true);
    expect(buy1Get1OpenAt(karachi(23, 59), rules({ opensMinute: 18 * 60, closesMinute: 1440 }))).toBe(true);
    // Off: never, whatever the hours.
    const off = rules({ on: false });
    expect(buy1Get1OpenAt(karachi(15, 0), off)).toBe(false);
    expect(buy1Get1OpenAt(karachi(12, 0), rules({ on: false, opensMinute: 0, closesMinute: 1440 }))).toBe(false);
  });

  it('keep a deal for an order started inside them, never one started outside — and none while switched off', () => {
    expect(buy1Get1AllowedOn(karachi(19, 2), new Date(karachi(18, 58)).toISOString())).toBe(true);
    expect(buy1Get1AllowedOn(karachi(19, 2), new Date(karachi(12, 0)).toISOString())).toBe(false);
    expect(buy1Get1AllowedOn(karachi(14, 0), new Date(karachi(12, 0)).toISOString())).toBe(true);
    expect(buy1Get1AllowedOn(karachi(20, 0), null)).toBe(false);
    expect(buy1Get1AllowedOn(karachi(20, 0), 'not a date')).toBe(false);
    const off = rules({ on: false });
    expect(buy1Get1AllowedOn(karachi(15, 0), new Date(karachi(14, 0)).toISOString(), off)).toBe(false);
    const late = rules({ opensMinute: 22 * 60, closesMinute: 60 });
    expect(buy1Get1AllowedOn(karachi(1, 5, 8), new Date(karachi(0, 58, 8)).toISOString(), late)).toBe(true);
  });
});

describe('Buy 1 Get 1: the words', () => {
  it('print the hours as the poster does', () => {
    expect(buy1Get1WindowWords()).toBe('1–7 PM');
    expect(buy1Get1WindowWords({ opensMinute: 11 * 60, closesMinute: 15 * 60 })).toBe('11 AM–3 PM');
    expect(buy1Get1WindowWords({ opensMinute: 13 * 60 + 30, closesMinute: 19 * 60 })).toBe('1:30–7 PM');
    expect(buy1Get1WindowWords({ opensMinute: 22 * 60, closesMinute: 60 })).toBe('10 PM–1 AM');
    expect(buy1Get1WindowWords({ opensMinute: 18 * 60, closesMinute: 1440 })).toBe('6 PM–12 AM');
    expect(buy1Get1WindowWords({ opensMinute: 23 * 60, closesMinute: 22 * 60 })).toBe('11 PM–10 PM');
    expect(buy1Get1WindowWords({ opensMinute: 0, closesMinute: 1440 })).toBe('all day');
  });

  it('say why a deal can’t be had: the hours, or that they are off — never "every day" (the shop’s days are its own)', () => {
    expect(buy1Get1ClosedMessage()).toBe('Buy 1 Get 1 deals are sold from 1 PM to 7 PM.');
    expect(buy1Get1ClosedMessage(rules({ opensMinute: 22 * 60, closesMinute: 60 }))).toBe('Buy 1 Get 1 deals are sold from 10 PM to 1 AM.');
    expect(buy1Get1ClosedMessage(rules({ opensMinute: 13 * 60 + 30, closesMinute: 1440 }))).toBe(
      'Buy 1 Get 1 deals are sold from 1:30 PM to 12 AM.',
    );
    expect(buy1Get1ClosedMessage(rules({ on: false }))).toBe('Buy 1 Get 1 deals are not on at the moment.');
  });

  it('sum the owner’s rules up in one line (the card, its history)', () => {
    expect(buy1Get1Summary(DEFAULT_BUY_1_GET_1_RULES)).toBe(
      'On · every day 1–7 PM · the website asks for the Instagram or Facebook name',
    );
    expect(buy1Get1Summary(rules({ asksSocial: false, opensMinute: 0, closesMinute: 1440 }))).toBe(
      'On · all day, every day · the name is optional on the website',
    );
    expect(buy1Get1Summary(rules({ on: false }))).toBe('Off: the deals are not sold, on the till or the website');
  });

  it('put whose post to check in the order notes, or to ask for it when no name was given', () => {
    expect(buy1Get1NoteLine('@ahmed_k')).toBe('Buy 1 Get 1: check the post by @ahmed_k');
    expect(buy1Get1NoteLine(null)).toBe('Buy 1 Get 1: ask to see the post');
  });
});
