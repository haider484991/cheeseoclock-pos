import { describe, expect, it } from 'vitest';
import {
  VARIANCE_DO_THIS_BPS,
  VARIANCE_DO_THIS_MIN_WINDOW_MS,
  actualCogsFigures,
  addToSums,
  batchPairs,
  emptySums,
  isRegularStockTake,
  ledgerKind,
  pickStockTakePair,
  unexplainedBps,
  varianceBand,
  varianceOf,
  varianceWeekCents,
  type LedgerKind,
} from './variance.js';

/** Sum rows (kind, signed qty) the way the report does. */
function sums(rows: Array<[LedgerKind, number]>) {
  const s = emptySums();
  for (const [k, q] of rows) addToSums(s, k, q);
  return s;
}

describe('used vs should have used (costing spec 4.6)', () => {
  it('reads every kind of stock row', () => {
    const row = (reason: string, detail: string | null = null, refs: { order?: boolean; group?: boolean } = {}) =>
      ledgerKind({ reason, detail, refOrderId: refs.order ? 'o1' : null, refGroupId: refs.group ? 'g1' : null });
    expect(row('delivery')).toBe('delivery');
    expect(row('sale', null, { order: true })).toBe('sale');
    expect(row('waste', 'waste:burnt')).toBe('waste');
    expect(row('waste', 'cancel_made', { order: true })).toBe('waste');
    expect(row('adjustment', 'batch_out', { group: true })).toBe('made_here');
    expect(row('adjustment', 'batch_in', { group: true })).toBe('used_in_batch');
    expect(row('adjustment', 'correction')).toBe('fix');
    expect(row('adjustment')).toBe('fix');
    expect(row('transfer')).toBe('fix');
    // A stock take's own row is the anchor; "already in the stock take" balanced one till's count; an older count is a fix.
    expect(row('count', 'stock_take', { group: true })).toBe('stock_take');
    expect(row('count', null, { order: true })).toBe('already_counted');
    expect(row('count', 'stock_take')).toBe('old_count');
  });

  it('V = A − T − W for a bought-in ingredient (made-up figures)', () => {
    // 10 kg counted, 5 kg delivered, sales took 8 kg (less 300 g put back), 400 g logged waste, 6.1 kg counted.
    const s = sums([
      ['delivery', 5_000],
      ['sale', -8_000],
      ['sale', 300],
      ['waste', -400],
      ['fix', 250],
      ['already_counted', -120],
      ['stock_take', 777],
    ]);
    const v = varianceOf(10_000, 6_100, s);
    expect(v).toEqual({ used: 10_000 + 5_000 - 6_100, shouldHaveUsed: 7_700, unexplained: 8_900 - 7_700 - 400, corrections: 250 });
    expect(v.unexplained).toBe(v.used - v.shouldHaveUsed - s.wasted);
    // Left out of everything, listed on its own.
    expect(s.alreadyCounted).toBe(-120);
    expect(unexplainedBps(v)).toBe(Math.round((800 * 10_000) / 7_700));
  });

  it('V = A − T − W for a batch and a sub-batch (sauce base → pizza sauce)', () => {
    // Tomato (raw): 5 kg into two batches of sauce base.
    const tomato = varianceOf(8_000, 3_000, sums([['used_in_batch', -2_500], ['used_in_batch', -2_500]]));
    expect(tomato).toMatchObject({ used: 5_000, shouldHaveUsed: 5_000, unexplained: 0 });
    // Sauce base (a sub-batch): 4 kg made, 3.2 kg went into pizza sauce, 100 g wasted.
    const base = varianceOf(500, 1_200, sums([['made_here', 2_000], ['made_here', 2_000], ['used_in_batch', -3_200], ['waste', -100]]));
    expect(base).toMatchObject({ used: 500 + 4_000 - 1_200, shouldHaveUsed: 3_200, unexplained: 3_300 - 3_200 - 100 });
    expect(base.unexplained).toBe(0);
    // Pizza sauce (the batch the menu uses): 3.5 kg made, sales took 3.1 kg; 200 g short on the shelf.
    const sauce = varianceOf(400, 600, sums([['made_here', 3_500], ['sale', -3_100]]));
    expect(sauce).toMatchObject({ used: 3_300, shouldHaveUsed: 3_100, unexplained: 200 });
  });

  it('rates the share of food sales either way: under 2% good, to 3% OK, to 5% needs work, over it look now', () => {
    expect(varianceBand(null)).toBeNull();
    expect(varianceBand(0)).toBe('good');
    expect(varianceBand(199)).toBe('good');
    expect(varianceBand(200)).toBe('ok');
    expect(varianceBand(300)).toBe('ok');
    expect(varianceBand(301)).toBe('needs_work');
    expect(varianceBand(500)).toBe('needs_work');
    expect(varianceBand(501)).toBe('look_now');
    // More on the shelves than expected is a sign too (a delivery not booked in, a miscount).
    expect(varianceBand(-650)).toBe('look_now');
    expect(VARIANCE_DO_THIS_BPS).toBe(300);
  });

  it('spreads what went unexplained over the weeks between the stock takes, rounded once', () => {
    const DAY = 86_400_000;
    expect(varianceWeekCents(10_000, 14 * DAY)).toBe(5_000);
    expect(varianceWeekCents(10_000, 7 * DAY)).toBe(10_000);
    expect(varianceWeekCents(10_000, 3 * DAY)).toBe(23_333);
    expect(varianceWeekCents(-10_001, 14 * DAY)).toBe(-5_001);
    expect(varianceWeekCents(10_000, 0)).toBe(0);
    // "Do this" only turns a stretch of about a week or more into rupees a week.
    expect(VARIANCE_DO_THIS_MIN_WINDOW_MS).toBe(6 * DAY);
  });

  describe('which two stock takes are compared (one rule for the till and the screen)', () => {
    // Trading days start at 05:00 Pakistan time (00:00 UTC). Made-up stock takes, newest first.
    const c = (id: string, scope: string, finishedAt: string | null) => ({ id, scope, finishedAt });
    const K3 = c('k3', 'key_items', '2026-09-28T06:00:00.000Z');
    const ONE = c('one', 'custom', '2026-09-25T06:00:00.000Z');
    const K2 = c('k2', 'key_items', '2026-09-21T06:00:00.000Z');
    const F1 = c('f1', 'full', '2026-09-14T06:00:00.000Z');

    it('the latest full or key-items stock take, and before it a full one or one of the same kind', () => {
      const done = [K3, ONE, K2, F1];
      expect(pickStockTakePair(done, null)).toMatchObject({ from: { id: 'k2' }, to: { id: 'k3' } });
      expect(pickStockTakePair(done, { toCountId: 'k2' })).toMatchObject({ from: { id: 'f1' }, to: { id: 'k2' } });
      // What was picked, when it will do; the earlier one must be earlier.
      expect(pickStockTakePair(done, { fromCountId: 'one', toCountId: 'k3' })).toMatchObject({ from: { id: 'one' }, to: { id: 'k3' } });
      expect(pickStockTakePair(done, { fromCountId: 'k3', toCountId: 'k2' })).toMatchObject({ from: { id: 'f1' }, to: { id: 'k2' } });
      // A full one is compared with the last full one, else the key items.
      expect(pickStockTakePair([c('f2', 'full', '2026-09-29T06:00:00.000Z'), ...done], null)).toMatchObject({ from: { id: 'f1' }, to: { id: 'f2' } });
      expect(pickStockTakePair([c('f2', 'full', '2026-09-29T06:00:00.000Z'), K3, ONE], null)).toMatchObject({ from: { id: 'k3' }, to: { id: 'f2' } });
      expect(pickStockTakePair([K3], null)).toBeNull();
      expect(isRegularStockTake('full') && isRegularStockTake('key_items') && !isRegularStockTake('custom')).toBe(true);
    });

    it("the Stock button's one-line stock take, finished last, never becomes the pair by itself", () => {
      // Tuesday: a one-line count of the oil, after Monday's key items.
      const oil = c('oil', 'custom', '2026-09-29T08:00:00.000Z');
      const dough = c('dough', 'custom', '2026-09-24T08:00:00.000Z');
      expect(pickStockTakePair([oil, K3, dough, K2], null)).toMatchObject({ from: { id: 'k2' }, to: { id: 'k3' } });
      expect(pickStockTakePair([oil, K3, dough, K2], null, { regularOnly: true })).toMatchObject({ from: { id: 'k2' }, to: { id: 'k3' } });
      // …but picked, it is compared (with the last full or key-items count before it).
      expect(pickStockTakePair([oil, K3, dough, K2], { toCountId: 'oil' })).toMatchObject({ from: { id: 'k3' }, to: { id: 'oil' } });
    });

    it('a recount the same trading day stands in for the first count: the stretch runs from the one before', () => {
      const recount = c('k3b', 'key_items', '2026-09-28T08:00:00.000Z');
      expect(pickStockTakePair([recount, K3, K2], null)).toMatchObject({ from: { id: 'k2' }, to: { id: 'k3b' } });
      expect(pickStockTakePair([recount, K3, K2], null, { regularOnly: true })).toMatchObject({ from: { id: 'k2' }, to: { id: 'k3b' } });
      // Nothing on an earlier day: none for "Do this"; Reports still opens on the two (the owner sees the times).
      expect(pickStockTakePair([recount, K3], null, { regularOnly: true })).toBeNull();
      expect(pickStockTakePair([recount, K3], null)).toMatchObject({ from: { id: 'k3' }, to: { id: 'k3b' } });
    });

    it('only picked-items stock takes: Reports opens on the latest two, "Do this" has none', () => {
      const p2 = c('p2', 'custom', '2026-09-28T06:00:00.000Z');
      const p1 = c('p1', 'custom', '2026-09-21T06:00:00.000Z');
      expect(pickStockTakePair([p2, p1], null)).toMatchObject({ from: { id: 'p1' }, to: { id: 'p2' } });
      expect(pickStockTakePair([p2, p1], null, { regularOnly: true })).toBeNull();
      // Not finished (no time): never a pair.
      expect(pickStockTakePair([c('open', 'key_items', null), p2, p1], null)).toMatchObject({ from: { id: 'p1' }, to: { id: 'p2' } });
    });
  });

  it('shows a batch with what it is made from, and warns when its stock rose with no batch logged', () => {
    const recipes = [
      { batchId: 'mix', batchName: 'Test cheese mix', inputs: [{ ingredientId: 'mozz', name: 'Test mozzarella' }, { ingredientId: 'ched', name: 'Test cheddar' }] },
      { batchId: 'sauce', batchName: 'Test sauce', inputs: [{ ingredientId: 'tom', name: 'Test tomato' }] },
      { batchId: 'dough', batchName: 'Test dough', inputs: [{ ingredientId: 'flour', name: 'Test flour' }] },
    ];
    const lines = new Map([
      // Cheese mix went up 2 kg with no batch logged; mozzarella is 1.6 kg short.
      ['mix', { opening: 1_000, closing: 3_000, delivered: 0, madeHere: 0, unexplained: -2_000 }],
      ['mozz', { opening: 9_000, closing: 5_000, delivered: 0, madeHere: 0, unexplained: 1_600 }],
      ['ched', { opening: 2_000, closing: 1_600, delivered: 0, madeHere: 0, unexplained: 0 }],
      // Sauce went up, but a batch was logged: no warning.
      ['sauce', { opening: 500, closing: 900, delivered: 0, madeHere: 2_000, unexplained: 0 }],
      ['tom', { opening: 5_000, closing: 2_500, delivered: 0, madeHere: 0, unexplained: 0 }],
      // Dough's flour was not counted on both: no pair.
      ['dough', { opening: 100, closing: 200, delivered: 0, madeHere: 0, unexplained: -100 }],
    ]);
    const pairs = batchPairs(recipes, lines);
    expect(pairs.map((p) => p.batchId)).toEqual(['mix', 'sauce']);
    expect(pairs[0]).toMatchObject({
      noBatchLogged: true,
      inputs: [{ ingredientId: 'mozz' }, { ingredientId: 'ched' }],
      warning: 'Test cheese mix went up but no batch was logged: the Test mozzarella difference is probably that batch.',
    });
    expect(pairs[1]).toMatchObject({ noBatchLogged: false, warning: null });
    // Rose with no batch logged, and nothing it is made from short: still said, in general words.
    const quiet = batchPairs([recipes[1]!], new Map([
      ['sauce', { opening: 500, closing: 900, delivered: 0, madeHere: 0, unexplained: -400 }],
      ['tom', { opening: 5_000, closing: 5_000, delivered: 0, madeHere: 0, unexplained: 0 }],
    ]));
    expect(quiet[0]!.warning).toMatch(/^Test sauce went up but no batch was logged\. Log each batch/);
  });

  it('a batch bought in when it ran short went up by its delivery, not by a batch: no warning', () => {
    const recipes = [{ batchId: 'sauce', batchName: 'Test sauce', inputs: [{ ingredientId: 'tom', name: 'Test tomato' }] }];
    // 2 kg of sauce bought from a supplier, none made here; tomato is 300 g short for a reason of its own.
    const bought = batchPairs(recipes, new Map([
      ['sauce', { opening: 500, closing: 1_900, delivered: 2_000, madeHere: 0, unexplained: 0 }],
      ['tom', { opening: 5_000, closing: 4_700, delivered: 0, madeHere: 0, unexplained: 300 }],
    ]));
    expect(bought[0]).toMatchObject({ noBatchLogged: false, warning: null });
    // Up by more than was bought in, nothing made here: that is a batch nobody logged.
    const more = batchPairs(recipes, new Map([
      ['sauce', { opening: 500, closing: 3_000, delivered: 2_000, madeHere: 0, unexplained: -500 }],
      ['tom', { opening: 5_000, closing: 4_700, delivered: 0, madeHere: 0, unexplained: 300 }],
    ]));
    expect(more[0]).toMatchObject({ noBatchLogged: true, warning: 'Test sauce went up but no batch was logged: the Test tomato difference is probably that batch.' });
  });

  it('the real food cost: held at the start + bought − held at the end, against food sales', () => {
    const a = actualCogsFigures({ openingCents: 500_000, purchasesCents: 1_200_000, closingCents: 450_000, foodSalesCents: 4_000_000, shouldHaveCents: 1_100_000 });
    expect(a).toEqual({ costCents: 1_250_000, actualBps: 3_125, shouldHaveBps: 2_750, gapBps: 375 });
    expect(actualCogsFigures({ openingCents: 1, purchasesCents: 0, closingCents: 0, foodSalesCents: 0, shouldHaveCents: 0 })).toEqual({
      costCents: 1,
      actualBps: null,
      shouldHaveBps: null,
      gapBps: null,
    });
  });
});
