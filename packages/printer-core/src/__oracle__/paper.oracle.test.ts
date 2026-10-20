/**
 * ORACLE: the pilot's paper must not move by one character.
 *
 * Compares the LIVE paper money and paper clock against the frozen v0.7.51
 * copies, with no shop locale set. A receipt is the customer's record and the
 * FBR's; the international edition has to be invisible on Pakistani paper.
 *
 * These pass today and must still pass after every phase. A failure means the
 * pilot's paper changed — fix the live code, never the baseline.
 */
import { describe, it, expect } from 'vitest';
import { paperMoney, paperSignedMoney, paperRupees } from '../paper-money.js';
import { paperClock, paperDayMonthClock, paperDateTime } from '@cheeseoclock/shared-types';
import {
  baselinePaperMoney,
  baselinePaperSignedMoney,
  baselinePaperRupees,
  baselinePaperClock,
  baselinePaperDayMonthClock,
  baselinePaperDateTime,
  seededRandom,
} from './baseline-v0.7.51.js';

describe('money on paper stays byte for byte', () => {
  const edges = [
    0, 1, 50, 99, 100, 750, 1000, 10_00, 360000, -172500, 25000,
    500000, 99_999_99, 100_000_00, 1, -1, 123, -123, 2_147_483_647,
  ];

  it('matches the baseline on the edge cases', () => {
    for (const c of edges) {
      expect(paperMoney(c), `paperMoney ${c}`).toBe(baselinePaperMoney(c));
      expect(paperSignedMoney(c), `paperSignedMoney ${c}`).toBe(baselinePaperSignedMoney(c));
      expect(paperRupees(c), `paperRupees ${c}`).toBe(baselinePaperRupees(c));
    }
  });

  it('matches the baseline on 100k seeded figures', () => {
    const rnd = seededRandom(0x9a_7e_40);
    for (let i = 0; i < 100_000; i++) {
      const magnitude = Math.floor(rnd() * 100_000_000);
      const c = rnd() < 0.1 ? -magnitude : magnitude;
      if (paperMoney(c) !== baselinePaperMoney(c))
        throw new Error(`paperMoney(${c}) = ${paperMoney(c)}, pilot printed ${baselinePaperMoney(c)}`);
      if (paperSignedMoney(c) !== baselinePaperSignedMoney(c))
        throw new Error(`paperSignedMoney(${c}) moved`);
      if (paperRupees(c) !== baselinePaperRupees(c))
        throw new Error(`paperRupees(${c}) = ${paperRupees(c)}, pilot printed ${baselinePaperRupees(c)}`);
    }
  });

  it('keeps the promises the paper-money comment makes', () => {
    expect(paperMoney(360000)).toBe('3,600.00');
    expect(paperMoney(-172500)).toBe('-1,725.00');
    expect(paperSignedMoney(25000)).toBe('+250.00');
    expect(paperRupees(500000)).toBe('5,000');
    expect(paperMoney(0)).toBe('0.00');
  });
});

describe('the clock on paper stays Pakistan, whatever the PC says', () => {
  const edges = [
    '2026-09-26T14:35:00.000Z', '2026-01-01T00:00:00.000Z', '2026-12-31T19:00:00.000Z',
    '2026-06-30T18:59:59.999Z', '2026-06-30T19:00:00.000Z', 0, 1_700_000_000_000,
    'not a date', '', '2026-02-29T00:00:00.000Z',
  ];

  it('matches the baseline on the edge cases', () => {
    for (const at of edges) {
      expect(paperClock(at), `paperClock ${at}`).toBe(baselinePaperClock(at));
      expect(paperDayMonthClock(at), `paperDayMonthClock ${at}`).toBe(baselinePaperDayMonthClock(at));
      expect(paperDateTime(at), `paperDateTime ${at}`).toBe(baselinePaperDateTime(at));
    }
  });

  it('matches the baseline across 100k instants over forty years', () => {
    const rnd = seededRandom(0x5_0f_f5_e7);
    for (let i = 0; i < 100_000; i++) {
      const ms = Math.floor(rnd() * 1_300_000_000_000) + 1_000_000_000_000;
      if (paperDateTime(ms) !== baselinePaperDateTime(ms))
        throw new Error(`paperDateTime(${ms}) = ${paperDateTime(ms)}, pilot printed ${baselinePaperDateTime(ms)}`);
      if (paperClock(ms) !== baselinePaperClock(ms)) throw new Error(`paperClock(${ms}) moved`);
      if (paperDayMonthClock(ms) !== baselinePaperDayMonthClock(ms))
        throw new Error(`paperDayMonthClock(${ms}) moved`);
    }
  });

  it('prints the day first, 24-hour, with no daylight saving', () => {
    // 14:35 UTC is 19:35 in Karachi, in June and in December alike.
    expect(paperDateTime('2026-06-26T14:35:00.000Z')).toBe('26/06/2026 19:35');
    expect(paperDateTime('2026-12-26T14:35:00.000Z')).toBe('26/12/2026 19:35');
    expect(paperClock('not a date')).toBe('');
  });
});
