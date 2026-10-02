import { describe, expect, it } from 'vitest';
import {
  CASH_COUNT_OTHER_MAX_CENTS,
  CASH_NOTE_COUNT_MAX,
  CASH_NOTE_FACE_CENTS,
  type CashCount,
} from '@cheeseoclock/shared-types';
import { cashCountJson, cashCountText, cashCountTotalCents } from './cash-count.js';

/**
 * The drawer counted by note at Close shift (owner, 2 Oct 2026): the sum,
 * the one writer of the stored text, and the one-line text the screens
 * show. Made-up counts (the repository is public).
 */

/** A count in the owner's row order from seven counts and the coins. */
function countOf(counts: readonly number[], otherCents = 0): CashCount {
  return { notes: CASH_NOTE_FACE_CENTS.map((faceCents, i) => ({ faceCents, count: counts[i] ?? 0 })), otherCents };
}

/** The owner's example: 5,000 × 2, 1,000 × 3, 500 × 1, 100 × 7, 10 × 4 and Rs 35 in coins. */
const EXAMPLE = countOf([2, 3, 1, 7, 0, 0, 4], 3_500);
const EXAMPLE_JSON =
  '{"notes":[{"faceCents":500000,"count":2},{"faceCents":100000,"count":3},{"faceCents":50000,"count":1},' +
  '{"faceCents":10000,"count":7},{"faceCents":5000,"count":0},{"faceCents":2000,"count":0},' +
  '{"faceCents":1000,"count":4}],"otherCents":3500}';

describe('the note rows', () => {
  it('are the owner’s seven notes in his order, in cents, and the limits', () => {
    expect(CASH_NOTE_FACE_CENTS).toEqual([500_000, 100_000, 50_000, 10_000, 5_000, 2_000, 1_000]);
    expect(CASH_NOTE_COUNT_MAX).toBe(9_999);
    expect(CASH_COUNT_OTHER_MAX_CENTS).toBe(9_999_900);
  });
});

describe('cashCountTotalCents', () => {
  it('the owner’s example adds up to Rs 14,275', () => {
    expect(cashCountTotalCents(EXAMPLE)).toBe(1_427_500);
  });

  it('all zero is 0; coins only is the coins; notes only has no coins', () => {
    expect(cashCountTotalCents(countOf([0, 0, 0, 0, 0, 0, 0]))).toBe(0);
    expect(cashCountTotalCents(countOf([0, 0, 0, 0, 0, 0, 0], 3_500))).toBe(3_500);
    expect(cashCountTotalCents(countOf([1, 0, 0, 0, 0, 0, 1]))).toBe(501_000);
  });

  it('every row at 9,999 and the most coins is still a safe whole number', () => {
    const most = countOf(CASH_NOTE_FACE_CENTS.map(() => CASH_NOTE_COUNT_MAX), CASH_COUNT_OTHER_MAX_CENTS);
    const total = cashCountTotalCents(most);
    expect(total).toBe(6_689_331_900);
    expect(Number.isSafeInteger(total)).toBe(true);
  });
});

describe('cashCountJson (the only writer of shifts.counted_notes_json)', () => {
  it('writes the owner’s example as the canonical text', () => {
    expect(cashCountJson(EXAMPLE)).toBe(EXAMPLE_JSON);
  });

  it('the same text whatever order the keys came in and whatever else they carried', () => {
    const shuffled = {
      extra: 'dropped',
      otherCents: 3_500,
      notes: EXAMPLE.notes.map((n) => ({ note: 'dropped', count: n.count, faceCents: n.faceCents })),
    } as unknown as CashCount;
    expect(cashCountJson(shuffled)).toBe(EXAMPLE_JSON);
  });

  it('zeros are kept as rows', () => {
    expect(cashCountJson(countOf([0, 0, 0, 0, 0, 0, 0]))).toBe(
      '{"notes":[{"faceCents":500000,"count":0},{"faceCents":100000,"count":0},{"faceCents":50000,"count":0},' +
        '{"faceCents":10000,"count":0},{"faceCents":5000,"count":0},{"faceCents":2000,"count":0},' +
        '{"faceCents":1000,"count":0}],"otherCents":0}',
    );
  });

  it('reads back as the same count', () => {
    expect(JSON.parse(cashCountJson(EXAMPLE))).toEqual(EXAMPLE);
  });
});

describe('cashCountText (the one line on the screens)', () => {
  it('the owner’s example', () => {
    expect(cashCountText(EXAMPLE)).toBe('5,000 × 2 · 1,000 × 3 · 500 × 1 · 100 × 7 · 10 × 4 · coins and other Rs 35');
  });

  it('nothing above 0 is null; coins only; notes only has no coins part', () => {
    expect(cashCountText(countOf([0, 0, 0, 0, 0, 0, 0]))).toBeNull();
    expect(cashCountText(countOf([0, 0, 0, 0, 0, 0, 0], 3_500))).toBe('coins and other Rs 35');
    expect(cashCountText(countOf([0, 0, 0, 0, 2, 0, 0]))).toBe('50 × 2');
    expect(cashCountText(countOf([0, 0, 0, 0, 0, 3, 1]))).toBe('20 × 3 · 10 × 1');
  });

  it('a stored row the list lacks (a Rs 75 note) prints in its place', () => {
    const stored: CashCount = {
      notes: [
        { faceCents: 100_000, count: 1 },
        { faceCents: 7_500, count: 1 },
        { faceCents: 1_000, count: 2 },
      ],
      otherCents: 0,
    };
    expect(cashCountText(stored)).toBe('1,000 × 1 · 75 × 1 · 10 × 2');
    expect(cashCountTotalCents(stored)).toBe(109_500);
  });

  it('a large count of one note keeps the value grouped', () => {
    expect(cashCountText(countOf([0, 9_999, 0, 0, 0, 0, 0]))).toBe('1,000 × 9999');
  });
});

describe('500 seeded counts', () => {
  it('the sum is the hand sum, a safe whole number, and the text lists exactly the rows above 0', () => {
    let seed = 20261002;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let run = 0; run < 500; run++) {
      // About a third of the rows are 0, so the text skips some.
      const counts = CASH_NOTE_FACE_CENTS.map(() => (rnd() < 0.35 ? 0 : Math.floor(rnd() * (CASH_NOTE_COUNT_MAX + 1))));
      const otherCents = rnd() < 0.5 ? 0 : Math.floor(rnd() * 100_000) * 100;
      const c = countOf(counts, otherCents);

      let hand = otherCents;
      counts.forEach((n, i) => {
        hand += (CASH_NOTE_FACE_CENTS[i] ?? 0) * n;
      });
      const total = cashCountTotalCents(c);
      expect(total).toBe(hand);
      expect(Number.isSafeInteger(total)).toBe(true);
      expect(total).toBeGreaterThanOrEqual(0);

      const text = cashCountText(c);
      const wanted = [
        ...CASH_NOTE_FACE_CENTS.flatMap((face, i) =>
          (counts[i] ?? 0) > 0 ? [`${(face / 100).toLocaleString('en-US')} × ${counts[i]}`] : [],
        ),
        ...(otherCents > 0 ? [`coins and other Rs ${(otherCents / 100).toLocaleString('en-US')}`] : []),
      ];
      expect(text).toBe(wanted.length > 0 ? wanted.join(' · ') : null);
      expect(JSON.parse(cashCountJson(c))).toEqual(c);
    }
  });
});
