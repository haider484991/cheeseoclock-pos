/**
 * ONE quick-cash rule (quickCashRupees) for Pay and for Live Orders'
 * "Picked up / Delivered + Pay". Up to v0.7.26 the board had its own
 * (boardLogic quickCashOptions), which differed from Pay's:
 *  - it put the exact bill among the notes (Pay has its own Exact button);
 *  - on a bill that was already round (Rs 2,000) it offered only Rs 5,000,
 *    where Pay offers the next notes up (Rs 2,500, 3,000, 5,000);
 *  - its four included the exact bill, so it offered at most three notes
 *    and dropped the highest one Pay shows (Rs 1,234: no Rs 5,000).
 * The board now offers Exact and then exactly Pay's notes.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { quickCashRupees } from './tenderAmounts';

const FEATURES = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = (path: string) => readFileSync(join(FEATURES, path), 'utf8');

describe('quickCashRupees', () => {
  it('offers the next round notes above the bill, smallest first', () => {
    expect(quickCashRupees(123_400)).toEqual([1_300, 1_500, 2_000, 5_000]);
    expect(quickCashRupees(25_000)).toEqual([300, 500, 1_000, 5_000]);
  });

  it('rounds a bill with paisa up to whole notes', () => {
    expect(quickCashRupees(123_450)[0]).toBe(1_300);
    expect(quickCashRupees(185_050)).toEqual([1_900, 2_000, 5_000]);
  });

  it('never offers the bill itself (that is the Exact button)', () => {
    expect(quickCashRupees(100_000)).toEqual([1_500, 2_000, 5_000]);
    expect(quickCashRupees(500_000)).toEqual([5_500, 6_000, 10_000]);
  });

  it('near a big note, offers what is left', () => {
    expect(quickCashRupees(475_000)).toEqual([4_800, 5_000]);
    expect(quickCashRupees(480_000)).toEqual([5_000]);
  });

  it('nothing for a bill of nothing', () => {
    expect(quickCashRupees(0)).toEqual([]);
    expect(quickCashRupees(-100)).toEqual([]);
    expect(quickCashRupees(Number.NaN)).toEqual([]);
  });

  it('can be asked for fewer', () => {
    expect(quickCashRupees(123_400, 2)).toEqual([1_300, 1_500]);
  });

  it("the board's old examples, as the board now shows them: Exact, then Pay's notes", () => {
    const board = (totalCents: number) => [totalCents, ...quickCashRupees(totalCents).map((r) => r * 100)];
    // Rs 1,850: was Exact, 1,900, 2,000, 5,000 — the same notes.
    expect(board(185_000)).toEqual([185_000, 190_000, 200_000, 500_000]);
    // Rs 2,000 (round): was Exact and 5,000 only; now Pay's next notes up.
    expect(board(200_000)).toEqual([200_000, 250_000, 300_000, 500_000]);
    // Rs 1,234: was Exact, 1,300, 1,500, 2,000 (the cap dropped 5,000); now all four of Pay's.
    expect(board(123_400)).toEqual([123_400, 130_000, 150_000, 200_000, 500_000]);
  });
});

describe('one rule on both screens', () => {
  it('Pay and the board both call quickCashRupees; the board has no rule of its own', () => {
    // Pay's quick notes are for what is collected in cash: the total, or the cash part of a split sale (0052).
    expect(source('checkout/TenderDialog.tsx')).toMatch(/quickCashRupees\(cashDue\)/);
    const board = source('orders/MarkDeliveredDialog.tsx');
    expect(board).toMatch(/import \{ quickCashRupees \} from '\.\.\/checkout\/tenderAmounts';/);
    expect(board).toMatch(/quickCashRupees\(order\.totalCents\)/);
    const logic = source('orders/boardLogic.ts');
    expect(logic).not.toMatch(/quickCash/);
    expect(logic).not.toMatch(/5_000_00|500_00/);
  });
});
