import { describe, expect, it } from 'vitest';
import { quickCashRupees } from './tenderAmounts';

describe('quickCashRupees', () => {
  it('offers the next round notes above the bill, smallest first', () => {
    expect(quickCashRupees(123_400)).toEqual([1_300, 1_500, 2_000, 5_000]);
    expect(quickCashRupees(25_000)).toEqual([300, 500, 1_000, 5_000]);
  });

  it('rounds a bill with paisa up to whole notes', () => {
    expect(quickCashRupees(123_450)[0]).toBe(1_300);
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
  });

  it('can be asked for fewer', () => {
    expect(quickCashRupees(123_400, 2)).toEqual([1_300, 1_500]);
  });
});
