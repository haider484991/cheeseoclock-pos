/**
 * The drawer counted by note at Close shift (owner, 2 Oct 2026: "when
 * closing the cash count should have 5000rs x note 1000 x 500 100 and 50 and
 * 20 and 10"), stored in shifts.counted_notes_json (migration 0050).
 *
 * The schema part: what a close may save (cashCountInputSchema, strict —
 * every refusal in its own plain words) and what a stored count may hold
 * (cashCountSchema, lenient — a newer till's extra key, row or paisa still
 * reads), and parseCashCountJson, which never throws. shared-schemas has no
 * test runner, so these live here as a plain describe that needs no
 * database. Made-up counts (the repository is public).
 */
import { describe, expect, it } from 'vitest';
import { cashCountInputSchema, cashCountSchema, parseCashCountJson } from '@cheeseoclock/shared-schemas';
import { CASH_NOTE_FACE_CENTS, type CashCount } from '@cheeseoclock/shared-types';
import { cashCountJson, cashCountTotalCents } from '@cheeseoclock/pos-domain';

/** The owner's example: 5,000 × 2, 1,000 × 3, 500 × 1, 100 × 7, 10 × 4 and Rs 35 in coins. */
const EXAMPLE: CashCount = {
  notes: [
    { faceCents: 500_000, count: 2 },
    { faceCents: 100_000, count: 3 },
    { faceCents: 50_000, count: 1 },
    { faceCents: 10_000, count: 7 },
    { faceCents: 5_000, count: 0 },
    { faceCents: 2_000, count: 0 },
    { faceCents: 1_000, count: 4 },
  ],
  otherCents: 3_500,
};
const EXAMPLE_JSON =
  '{"notes":[{"faceCents":500000,"count":2},{"faceCents":100000,"count":3},{"faceCents":50000,"count":1},' +
  '{"faceCents":10000,"count":7},{"faceCents":5000,"count":0},{"faceCents":2000,"count":0},' +
  '{"faceCents":1000,"count":4}],"otherCents":3500}';

const WHOLE = 'A count is a whole number of notes';
const BELOW_ZERO = "A count can't be below 0";
const TOO_MANY = 'At most 9,999 notes in one row';
const COINS_WHOLE = 'Coins and other is in whole rupees';
const COINS_TOO_MUCH = 'Coins and other is at most Rs 99,999';
const ROWS = 'The note rows are Rs 5,000, 1,000, 500, 100, 50, 20 and 10';

/** The example with row `i`'s count replaced (any value, as a close might send it). */
function withCount(i: number, count: unknown): unknown {
  return { ...EXAMPLE, notes: EXAMPLE.notes.map((n, j) => (j === i ? { ...n, count } : n)) };
}

/** The words the till shows for the first problem, or null when the count may be saved. */
function refusal(input: unknown): string | null {
  const r = cashCountInputSchema.safeParse(input);
  return r.success ? null : (r.error.issues[0]?.message ?? '(no message)');
}

describe('what a close may save (cashCountInputSchema, strict)', () => {
  it('takes the owner’s example as it is, and it adds up to Rs 14,275', () => {
    const r = cashCountInputSchema.safeParse(EXAMPLE);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data).toEqual(EXAMPLE);
    expect(cashCountTotalCents(r.data)).toBe(1_427_500);
    expect(cashCountJson(r.data)).toBe(EXAMPLE_JSON);
  });

  it('takes all zeros, the most notes in a row and the most coins', () => {
    const zeros = { notes: CASH_NOTE_FACE_CENTS.map((faceCents) => ({ faceCents, count: 0 })), otherCents: 0 };
    expect(refusal(zeros)).toBeNull();
    expect(refusal(withCount(0, 9_999))).toBeNull();
    expect(refusal({ ...EXAMPLE, otherCents: 9_999_900 })).toBeNull();
  });

  it('a count that is not a whole number of notes: 1.5, "2", NaN, Infinity, or none', () => {
    expect(refusal(withCount(2, 1.5))).toBe(WHOLE);
    expect(refusal(withCount(2, '2'))).toBe(WHOLE);
    expect(refusal(withCount(2, Number.NaN))).toBe(WHOLE);
    expect(refusal(withCount(2, Number.POSITIVE_INFINITY))).toBe(WHOLE);
    expect(refusal(withCount(2, null))).toBe(WHOLE);
    expect(refusal({ ...EXAMPLE, notes: EXAMPLE.notes.map((n, j) => (j === 2 ? { faceCents: n.faceCents } : n)) })).toBe(WHOLE);
  });

  it('a count below 0, and more than 9,999 notes in one row', () => {
    expect(refusal(withCount(2, -1))).toBe(BELOW_ZERO);
    expect(refusal(withCount(2, 10_000))).toBe(TOO_MANY);
  });

  it('coins and other in paisa, above Rs 99,999, below 0 or not a number', () => {
    expect(refusal({ ...EXAMPLE, otherCents: 3_550 })).toBe(COINS_WHOLE);
    expect(refusal({ ...EXAMPLE, otherCents: 10_000_000 })).toBe(COINS_TOO_MUCH);
    expect(refusal({ ...EXAMPLE, otherCents: '35' })).toBe(COINS_WHOLE);
    expect(refusal({ ...EXAMPLE, otherCents: Number.NaN })).toBe(COINS_WHOLE);
    expect(refusal({ notes: EXAMPLE.notes })).toBe(COINS_WHOLE);
    expect(refusal({ ...EXAMPLE, otherCents: -100 })).toBe("Coins and other can't be below Rs 0");
  });

  it('only the owner’s seven rows, in his order: a missing row, rows out of order, a duplicate, a Rs 75 row', () => {
    expect(refusal({ ...EXAMPLE, notes: EXAMPLE.notes.slice(0, 6) })).toBe(ROWS);
    const swapped = [...EXAMPLE.notes];
    [swapped[0], swapped[1]] = [swapped[1]!, swapped[0]!];
    expect(refusal({ ...EXAMPLE, notes: swapped })).toBe(ROWS);
    expect(refusal({ ...EXAMPLE, notes: EXAMPLE.notes.map((n, j) => (j === 1 ? { ...n, faceCents: 500_000 } : n)) })).toBe(ROWS);
    expect(refusal({ ...EXAMPLE, notes: [...EXAMPLE.notes, EXAMPLE.notes[6]!] })).toBe(ROWS);
    expect(refusal({ ...EXAMPLE, notes: [...EXAMPLE.notes, { faceCents: 7_500, count: 1 }] })).toBe(ROWS);
    expect(refusal({ ...EXAMPLE, notes: EXAMPLE.notes.map((n, j) => (j === 6 ? { faceCents: 7_500, count: 1 } : n)) })).toBe(ROWS);
    expect(refusal({ ...EXAMPLE, notes: [] })).toBe(ROWS);
    expect(refusal({ ...EXAMPLE, notes: 5 })).toBe(ROWS);
    expect(refusal({ otherCents: 3_500 })).toBe(ROWS);
    expect(refusal({ ...EXAMPLE, notes: EXAMPLE.notes.map((n, j) => (j === 0 ? { ...n, faceCents: '500000' } : n)) })).toBe(ROWS);
  });

  it('nothing else: an extra key on a row or on the count', () => {
    expect(refusal({ ...EXAMPLE, notes: EXAMPLE.notes.map((n, j) => (j === 3 ? { ...n, rupees: 100 } : n)) })).toBe(ROWS);
    expect(refusal({ ...EXAMPLE, totalCents: 1_427_500 })).toBe(ROWS);
  });

  it('a count that is not an object at all', () => {
    expect(cashCountInputSchema.safeParse(null).success).toBe(false);
    expect(cashCountInputSchema.safeParse('2').success).toBe(false);
    expect(cashCountInputSchema.safeParse([]).success).toBe(false);
  });
});

describe('what a stored count may hold (cashCountSchema, lenient)', () => {
  it('reads the owner’s example', () => {
    expect(cashCountSchema.parse(EXAMPLE)).toEqual(EXAMPLE);
  });

  it('reads a row the list lacks (a Rs 75 note), keeping it in place', () => {
    const stored = {
      notes: [EXAMPLE.notes[0]!, { faceCents: 7_500, count: 1 }, ...EXAMPLE.notes.slice(1)],
      otherCents: 0,
    };
    expect(cashCountSchema.parse(stored)).toEqual(stored);
  });

  it('drops an extra key from a newer till instead of refusing the count', () => {
    const newer = {
      ...EXAMPLE,
      countedBy: 'Sara',
      notes: EXAMPLE.notes.map((n) => ({ ...n, bundle: false })),
    };
    expect(cashCountSchema.parse(newer)).toEqual(EXAMPLE);
  });

  it('reads coins and other in paisa', () => {
    expect(cashCountSchema.parse({ ...EXAMPLE, otherCents: 3_550 })).toEqual({ ...EXAMPLE, otherCents: 3_550 });
  });

  it('refuses no rows, the same note twice, a part note or a count below 0', () => {
    expect(cashCountSchema.safeParse({ notes: [], otherCents: 0 }).success).toBe(false);
    expect(cashCountSchema.safeParse({ ...EXAMPLE, notes: [...EXAMPLE.notes, EXAMPLE.notes[0]!] }).success).toBe(false);
    expect(cashCountSchema.safeParse(withCount(1, 0.5)).success).toBe(false);
    expect(cashCountSchema.safeParse(withCount(1, -1)).success).toBe(false);
  });
});

describe('parseCashCountJson (reads the stored text, never throws)', () => {
  it('nothing, empty, not JSON, or a shape it cannot read: null', () => {
    expect(parseCashCountJson(null)).toBeNull();
    expect(parseCashCountJson(undefined)).toBeNull();
    expect(parseCashCountJson('')).toBeNull();
    expect(parseCashCountJson('not json')).toBeNull();
    expect(parseCashCountJson('{"notes":5}')).toBeNull();
    expect(parseCashCountJson('{"notes":[]}')).toBeNull();
    expect(parseCashCountJson('{"notes":[],"otherCents":0}')).toBeNull();
    expect(parseCashCountJson('null')).toBeNull();
    expect(parseCashCountJson('[]')).toBeNull();
  });

  it('the canonical text reads as the count, and writes back as the same text', () => {
    const read = parseCashCountJson(EXAMPLE_JSON);
    expect(read).toEqual(EXAMPLE);
    expect(read && cashCountJson(read)).toBe(EXAMPLE_JSON);
  });

  it('a newer till’s text with an extra key and a Rs 75 row still reads', () => {
    const text = '{"notes":[{"faceCents":7500,"count":1,"x":1}],"otherCents":3550,"by":"Sara"}';
    expect(parseCashCountJson(text)).toEqual({ notes: [{ faceCents: 7_500, count: 1 }], otherCents: 3_550 });
  });
});
