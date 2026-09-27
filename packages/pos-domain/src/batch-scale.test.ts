import { describe, expect, it } from 'vitest';
import { batchesText, maxBatchAmount, oneBatchCostMc, scaleBatch, type ScaleInput } from './batch-scale.js';

// A made-up pizza sauce: one batch = 2,500 g tomato + 125 g garlic + 30 g salt
// + 3 bay leaves → 2,000 g. Prices made up.
const SAUCE: ScaleInput[] = [
  { inputId: 'tomato', qty: 2500, pack: { size: 5000, priceCents: 60_000 }, kind: 'set' }, // Rs 120 / kg
  { inputId: 'garlic', qty: 125, pack: { size: 1000, priceCents: 45_000 }, kind: 'set' }, // Rs 450 / kg
  { inputId: 'salt', qty: 30, pack: { size: 1, priceCents: 0 }, kind: 'free' },
  { inputId: 'bay', qty: 3, pack: { size: 100, priceCents: 5_000 }, kind: 'estimate' }, // pcs, Rs 50 per 100
];

describe('scaleBatch: any amount of a batch', () => {
  it('one whole batch costs what the batch costs', () => {
    const s = scaleBatch(2000, SAUCE, 2000);
    expect(s.totalCostMc).toBe(oneBatchCostMc(SAUCE));
    // 30,000 + 5,625 + 0 + 150 = 35,775 paisa
    expect(s.totalCostCents).toBe(35_775);
    expect(s.lines.map((l) => l.stockQty)).toEqual([2500, 125, 30, 3]);
    expect(s.perUnitMc).toBe(17_888); // 35,775,000 mc ÷ 2,000 g → Rs 178.88 / kg
  });

  it('200 g of a 2,000 g batch: a tenth of every input, exactly costed', () => {
    const s = scaleBatch(2000, SAUCE, 200);
    expect(s.lines.map((l) => l.scaledHundredths)).toEqual([25_000, 1_250, 300, 30]);
    // whole units the stock takes: 12.5 g garlic → 13 g (half up), 0.3 bay leaf → 0
    expect(s.lines.map((l) => l.stockQty)).toEqual([250, 13, 3, 0]);
    expect(s.roundedAwayIds).toEqual(['bay']);
    expect(s.lines.map((l) => l.costMc)).toEqual([3_000_000, 562_500, 0, 15_000]);
    expect(s.totalCostCents).toBe(3578); // 3,577.5 → 3,578
    // the share of each input in the batch's cost
    expect(s.lines[0]!.shareBps).toBe(8386);
    expect(s.perUnitMc).toBe(17_888);
    expect(s.estimateInputIds).toEqual(['bay']);
    expect(s.complete).toBe(true);
  });

  it('1.5 kg typed as 1,500 g: three quarters of a batch', () => {
    const s = scaleBatch(2000, SAUCE, 1500);
    expect(s.lines.map((l) => l.stockQty)).toEqual([1875, 94, 23, 2]);
    expect(s.lines.map((l) => l.scaledHundredths)).toEqual([187_500, 9_375, 2_250, 225]);
  });

  it('several batches at once scale up exactly like whole batches', () => {
    const s = scaleBatch(2000, SAUCE, 6000);
    expect(s.lines.map((l) => l.stockQty)).toEqual([7500, 375, 90, 9]);
    expect(s.totalCostMc).toBe(3 * oneBatchCostMc(SAUCE));
  });

  it('an unpriced input adds nothing and says so', () => {
    const s = scaleBatch(2000, [...SAUCE, { inputId: 'oregano', qty: 10, pack: null, kind: 'unset' }], 1000);
    expect(s.complete).toBe(false);
    expect(s.unpricedInputIds).toEqual(['oregano']);
    expect(s.lines.at(-1)).toMatchObject({ costMc: 0, unitCostMc: null, kind: 'unset', stockQty: 5 });
  });

  it('says the amount as a share of the batch, exact to 2 places', () => {
    expect(batchesText(200, 2000)).toBe('0.1 of a batch');
    expect(batchesText(2000, 2000)).toBe('1 batch');
    expect(batchesText(5000, 2000)).toBe('2.5 batches');
    expect(batchesText(1, 3)).toBe('0.33 of a batch');
    expect(batchesText(3, 2000)).toBe('under 0.01 of a batch');
  });

  it('refuses a nonsense amount', () => {
    expect(() => scaleBatch(2000, SAUCE, 0)).toThrow(/at least 1/);
    expect(() => scaleBatch(2000, SAUCE, 12.5)).toThrow();
    expect(() => scaleBatch(0, SAUCE, 100)).toThrow();
    expect(maxBatchAmount(2000)).toBe(200_000);
  });
});
