/**
 * The batch calculator (owner 2026-09-27: "if a user wants to see a 200 g
 * batch it should show; I want to see full costing"). A batch recipe has one
 * fixed yield; this scales it to ANY amount of the batch item — 200 g of a
 * 2,000 g sauce is a tenth of every input — and costs it exactly. The same
 * function decides what "Make this amount" takes out of stock, so the
 * preview and the stock movement never disagree.
 *
 * Stock is counted in whole base units, so each scaled input is rounded
 * (half up) to the whole grams / ml / pieces the movement takes; the cost is
 * of the exact scaled amount, rounded once to millicents.
 */

import type { PriceKind } from '@cheeseoclock/shared-types';
import { lineCostMc, mcToCents, mulDivRound, ratioRound, shareBps, unitCostMc, type Pack } from './units.js';

export interface ScaleInput {
  inputId: string;
  /** How much ONE batch uses. */
  qty: number;
  /** The input's price, or null / 'unset' when it has none. */
  pack: Pack | null;
  kind: PriceKind | 'missing';
}

export interface ScaledInput {
  inputId: string;
  perBatchQty: number;
  /** qty × amount ÷ yield in hundredths of a base unit (1250 = 12.5 g), rounded once. */
  scaledHundredths: number;
  /** Whole base units the stock movement takes: round(qty × amount ÷ yield). */
  stockQty: number;
  unitCostMc: number | null;
  /** Cost of the exact scaled amount: round(qty × amount × P × 1000 ÷ (yield × S)). */
  costMc: number;
  costCents: number;
  shareBps: number | null;
  kind: PriceKind | 'missing';
}

export interface ScaledBatch {
  amount: number;
  batchYield: number;
  lines: ScaledInput[];
  totalCostMc: number;
  totalCostCents: number;
  /** Cost of one base unit of the batch item, millicents (per gram it is also paisa per kg). */
  perUnitMc: number;
  complete: boolean;
  unpricedInputIds: string[];
  estimateInputIds: string[];
  /** Inputs that round to 0 at this amount: nothing is taken for them. */
  roundedAwayIds: string[];
}

/** The most one "Make this amount" takes: as much as 100 batches. */
export const MAX_BATCHES_AT_ONCE = 100;

export function maxBatchAmount(batchYield: number): number {
  return batchYield * MAX_BATCHES_AT_ONCE;
}

/** Scale a batch recipe (one batch makes `batchYield`) to `amount` base units and cost it. */
export function scaleBatch(batchYield: number, inputs: readonly ScaleInput[], amount: number): ScaledBatch {
  if (!Number.isSafeInteger(batchYield) || batchYield <= 0) throw new Error('This batch recipe does not say how much it makes');
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('Enter how much to make, at least 1');
  const lines: ScaledInput[] = [];
  const unpricedInputIds: string[] = [];
  const estimateInputIds: string[] = [];
  const roundedAwayIds: string[] = [];
  let totalCostMc = 0;
  for (const i of inputs) {
    const stockQty = mulDivRound(i.qty, amount, batchYield);
    if (stockQty === 0) roundedAwayIds.push(i.inputId);
    const priced = i.pack !== null && i.kind !== 'unset' && i.kind !== 'missing';
    if (!priced) unpricedInputIds.push(i.inputId);
    if (i.kind === 'estimate') estimateInputIds.push(i.inputId);
    const costMc = priced ? ratioRound([i.qty, amount, i.pack!.priceCents, 1000], [batchYield, i.pack!.size]) : 0;
    totalCostMc += costMc;
    lines.push({
      inputId: i.inputId,
      perBatchQty: i.qty,
      scaledHundredths: ratioRound([i.qty, amount, 100], [batchYield]),
      stockQty,
      unitCostMc: priced ? unitCostMc(i.pack!) : null,
      costMc,
      costCents: mcToCents(costMc),
      shareBps: null,
      kind: priced ? i.kind : i.kind === 'unset' ? 'unset' : 'missing',
    });
  }
  for (const l of lines) l.shareBps = shareBps(l.costMc, totalCostMc);
  return {
    amount,
    batchYield,
    lines,
    totalCostMc,
    totalCostCents: mcToCents(totalCostMc),
    perUnitMc: mulDivRound(totalCostMc, 1, amount),
    complete: unpricedInputIds.length === 0,
    unpricedInputIds,
    estimateInputIds,
    roundedAwayIds,
  };
}

/**
 * An amount as a share of the batch, in words, exact to 2 places: "0.1 of a
 * batch", "1 batch", "2.5 batches". Used in the stock movement's note and on
 * the calculator, so both say the same.
 */
export function batchesText(amount: number, batchYield: number): string {
  const hundredths = mulDivRound(amount, 100, batchYield);
  if (hundredths === 0) return 'under 0.01 of a batch';
  const n = new Intl.NumberFormat('en-PK', { maximumFractionDigits: 2 }).format(hundredths / 100);
  if (hundredths < 100) return `${n} of a batch`;
  return hundredths === 100 ? '1 batch' : `${n} batches`;
}

/** One batch's cost is the same whether scaled or not: a check the tests lean on. */
export function oneBatchCostMc(inputs: readonly ScaleInput[]): number {
  return inputs.reduce((s, i) => (i.pack && i.kind !== 'unset' && i.kind !== 'missing' ? s + lineCostMc(i.qty, i.pack) : s), 0);
}
