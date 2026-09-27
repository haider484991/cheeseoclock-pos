/**
 * "Used vs should have used" (costing spec 4.6, Phase 8), for one
 * ingredient between two stock takes S0 (t0) and S1 (t1), quantities in its
 * unit now, rows dated by shop-stock.ts ledgerDate and kept when
 * t0 < d(r) ≤ t1:
 *
 *   O = counted on S0, C = counted on S1;
 *   D    = Σ 'delivery' deltas                        (came in);
 *   Pin  = Σ deltas detailed batch_out                (batches of it made here);
 *   Buse = −Σ deltas detailed batch_in                (it went into batches);
 *   S    = −Σ 'sale' deltas, net of put-backs         (sales took it);
 *   W    = −Σ 'waste' deltas                          (logged as waste);
 *   Corr = typed fixes ('adjustment' rows that are not a batch) plus 'count'
 *          rows not from a stock take — LISTED next to V, not in A.
 *   A = O + D + Pin − C   what actually went;
 *   T = S + Buse          what sales and batches say should have gone;
 *   V = A − T − W         gone with nothing to explain it
 *                         (below 0 = more on the shelf than expected).
 *
 * A stock take's own 'count' row is the anchor, not a movement; a cancelled
 * order's "already in the stock take" count row balanced one till's count
 * only, so it is left out (and listed). Pure: the SQL is in
 * apps/pos/electron/services/analytics/stock-control.ts.
 */
import type { VarianceBand, VarianceBatchPair } from '@cheeseoclock/shared-types';
import { tradingDayOfMs } from './trends.js';
import { mulDivRound, shareBps } from './units.js';

/** What one stock row stands for in the variance. */
export type LedgerKind =
  | 'delivery'
  | 'made_here'
  | 'used_in_batch'
  | 'sale'
  | 'waste'
  /** A typed correction: listed next to V. */
  | 'fix'
  /** A 'count' row from before stock takes were kept (the Stock button's old count): listed next to V. */
  | 'old_count'
  /** A cancelled order's "already in the stock take": left out, listed. */
  | 'already_counted'
  /** A stock take's own row: the anchor itself, never a movement. */
  | 'stock_take';

export function ledgerKind(r: { reason: string; detail: string | null; refOrderId: string | null; refGroupId: string | null }): LedgerKind {
  switch (r.reason) {
    case 'delivery':
      return 'delivery';
    case 'sale':
      return 'sale';
    case 'waste':
      return 'waste';
    case 'count':
      // Only a stock take groups its count rows (ref_group_id = the stock take).
      if (r.refGroupId) return 'stock_take';
      if (r.refOrderId) return 'already_counted';
      return 'old_count';
    default:
      // 'adjustment' (and 'transfer', or anything newer): a batch, or a fix.
      if (r.detail === 'batch_out') return 'made_here';
      if (r.detail === 'batch_in') return 'used_in_batch';
      return 'fix';
  }
}

/** The window's rows for one ingredient, added up (each quantity positive the way the figure reads). */
export interface WindowSums {
  delivered: number;
  madeHere: number;
  usedInBatches: number;
  sold: number;
  wasted: number;
  /** Typed fixes, signed like the rows. */
  fixes: number;
  /** Older one-off counts, signed like the rows. */
  oldCounts: number;
  /** "Already in the stock take" rows, signed like the rows (left out of everything). */
  alreadyCounted: number;
}

export function emptySums(): WindowSums {
  return { delivered: 0, madeHere: 0, usedInBatches: 0, sold: 0, wasted: 0, fixes: 0, oldCounts: 0, alreadyCounted: 0 };
}

/** Add one row (its quantity already in the ingredient's unit now) to the sums. */
export function addToSums(s: WindowSums, kind: LedgerKind, qty: number): void {
  switch (kind) {
    case 'delivery':
      s.delivered += qty;
      break;
    case 'made_here':
      s.madeHere += qty;
      break;
    case 'used_in_batch':
      s.usedInBatches -= qty;
      break;
    case 'sale':
      s.sold -= qty;
      break;
    case 'waste':
      s.wasted -= qty;
      break;
    case 'fix':
      s.fixes += qty;
      break;
    case 'old_count':
      s.oldCounts += qty;
      break;
    case 'already_counted':
      s.alreadyCounted += qty;
      break;
    case 'stock_take':
      break;
  }
}

export interface VarianceFigures {
  /** A = O + D + Pin − C. */
  used: number;
  /** T = S + Buse. */
  shouldHaveUsed: number;
  /** V = A − T − W. */
  unexplained: number;
  /** Corr: typed fixes and older one-off counts (listed next to V). */
  corrections: number;
}

/** A, T, V (and the corrections listed beside them) for one ingredient. */
export function varianceOf(opening: number, closing: number, s: WindowSums): VarianceFigures {
  const used = opening + s.delivered + s.madeHere - closing;
  const shouldHaveUsed = s.sold + s.usedInBatches;
  return { used, shouldHaveUsed, unexplained: used - shouldHaveUsed - s.wasted, corrections: s.fixes + s.oldCounts };
}

/** V as a share of what should have been used (V ÷ T), basis points; null when nothing should have been. */
export function unexplainedBps(v: Pick<VarianceFigures, 'unexplained' | 'shouldHaveUsed'>): number | null {
  return shareBps(v.unexplained, v.shouldHaveUsed);
}

/**
 * The rating of the period variance (Σ V value ÷ food sales), either way:
 * under 2% good, 2–3% OK, 3–5% needs work, over 5% look at it now (meez).
 */
export function varianceBand(bps: number | null): VarianceBand | null {
  if (bps === null) return null;
  const a = Math.abs(bps);
  if (a < 200) return 'good';
  if (a <= 300) return 'ok';
  if (a <= 500) return 'needs_work';
  return 'look_now';
}

/** "Do this" lists the last stock takes' variance when more than this share of food sales went unexplained (3%). */
export const VARIANCE_DO_THIS_BPS = 300;

const WEEK_MS = 7 * 86_400_000;

/**
 * The shortest stretch between two stock takes that "Do this" turns into
 * rupees a week (6 days: a weekly count a day early still is one). A
 * shorter one would be scaled UP to a week — a recount two hours later ×84,
 * a day ×7 — so it is left to Reports, which shows it as it is.
 */
export const VARIANCE_DO_THIS_MIN_WINDOW_MS = 6 * 86_400_000;

/**
 * What went unexplained per week: the window's total spread over its
 * length (costing spec 4.17 "V value per week"). Rounded once. Only for a
 * window of VARIANCE_DO_THIS_MIN_WINDOW_MS or more (the caller's check):
 * never used to blow a short window up.
 */
export function varianceWeekCents(totalCents: number, windowMs: number): number {
  if (!(windowMs > 0)) return 0;
  return mulDivRound(totalCents, WEEK_MS, Math.round(windowMs));
}

// ---------------------------------------------------------------------------
// Which two stock takes are compared
// ---------------------------------------------------------------------------

/**
 * The kinds of stock take the till compares BY ITSELF: a whole count, or
 * the key items (the weekly one). A stock take of picked items — the Stock
 * button's one-line count is one — fixes a shelf or two; it is compared
 * only when someone picks it.
 */
export function isRegularStockTake(scope: string): boolean {
  return scope === 'full' || scope === 'key_items';
}

export interface StockTakeRef {
  id: string;
  scope: string;
  finishedAt: string | null;
}

/**
 * The two stock takes to compare (costing spec 4.6), from the finished ones
 * newest first — ONE rule for the till (stock-control.ts: Reports, "Do this",
 * the weekly sheet) and the screen (Reports → Between stock takes):
 *  - what was picked, as far as it will do (the earlier one must finish
 *    before the later one);
 *  - otherwise the later one is the latest full or key-items stock take;
 *  - and the earlier one is the latest full one, or one of the same kind,
 *    finished on an EARLIER trading day (a recount the same day stands in
 *    for the first count, it is not a stretch to compare); else the latest
 *    full or key-items one on an earlier day.
 * `regularOnly` ("Do this", the weekly sheet): nothing else. Otherwise
 * (Reports, where the owner can see and change the pair), with no such pair
 * it falls back to any: the latest, and the one before it.
 */
export function pickStockTakePair<T extends StockTakeRef>(
  doneNewestFirst: readonly T[],
  picked: { fromCountId?: string | null; toCountId?: string | null } | null,
  opts: { regularOnly?: boolean } = {},
): { from: T; to: T } | null {
  const regularOnly = opts.regularOnly === true;
  const done = doneNewestFirst.filter((c): c is T & { finishedAt: string } => c.finishedAt !== null && Number.isFinite(Date.parse(c.finishedAt)));
  const pickedTo = picked?.toCountId ? done.find((c) => c.id === picked.toCountId) : undefined;
  const to = pickedTo ?? done.find((c) => isRegularStockTake(c.scope)) ?? (regularOnly ? undefined : done[0]);
  if (!to) return null;
  const earlier = done.filter((c) => c.finishedAt < to.finishedAt);
  const pickedFrom = picked?.fromCountId ? earlier.find((c) => c.id === picked.fromCountId) : undefined;
  if (pickedFrom) return { from: pickedFrom, to };
  const toDay = tradingDayOfMs(Date.parse(to.finishedAt));
  const dayBefore = (c: { finishedAt: string }) => tradingDayOfMs(Date.parse(c.finishedAt)) < toDay;
  const sameKind = (c: T) => c.scope === 'full' || (isRegularStockTake(to.scope) && c.scope === to.scope);
  const rules: Array<(c: T & { finishedAt: string }) => boolean> = [(c) => dayBefore(c) && sameKind(c), (c) => dayBefore(c) && isRegularStockTake(c.scope)];
  if (!regularOnly) rules.push(dayBefore, sameKind, () => true);
  for (const rule of rules) {
    const from = earlier.find(rule);
    if (from) return { from, to };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Batches and what they are made from, as linked pairs
// ---------------------------------------------------------------------------

export interface BatchRecipeOf {
  batchId: string;
  batchName: string;
  inputs: Array<{ ingredientId: string; name: string }>;
}

/**
 * Each batch shown with what it is made from, when both are counted at both
 * stock takes. A batch whose counted stock ROSE with no batch logged in the
 * window — more than any of it bought in explains — is warned about: its
 * ingredients look short by exactly the batch nobody logged ("Cheese Mix
 * went up but no batch was logged: the mozzarella difference is probably
 * that batch"). A batch bought in when it ran short went up by its
 * delivery, not by a batch.
 */
export function batchPairs(
  recipes: readonly BatchRecipeOf[],
  lines: ReadonlyMap<string, { opening: number; closing: number; delivered: number; madeHere: number; unexplained: number }>,
): VarianceBatchPair[] {
  const out: VarianceBatchPair[] = [];
  for (const b of recipes) {
    const batch = lines.get(b.batchId);
    const inputs = b.inputs.filter((i) => lines.has(i.ingredientId));
    if (!batch || inputs.length === 0) continue;
    const noBatchLogged = batch.madeHere === 0 && batch.closing > batch.opening + batch.delivered;
    let warning: string | null = null;
    if (noBatchLogged) {
      const short = inputs.filter((i) => (lines.get(i.ingredientId)?.unexplained ?? 0) > 0).map((i) => i.name);
      warning =
        short.length > 0
          ? `${b.batchName} went up but no batch was logged: the ${joinNames(short)} difference is probably that batch.`
          : `${b.batchName} went up but no batch was logged. Log each batch when it is made, or what goes into it will look short.`;
    }
    out.push({ batchId: b.batchId, batchName: b.batchName, inputs, noBatchLogged, warning });
  }
  return out.sort((a, b) => Number(b.noBatchLogged) - Number(a.noBatchLogged) || a.batchName.localeCompare(b.batchName));
}

/** "a", "a and b", "a, b and c". */
function joinNames(names: string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

// ---------------------------------------------------------------------------
// The real food cost between two full stock takes
// ---------------------------------------------------------------------------

/**
 * ACOGS = what was held at S0 + what was bought − what was held at S1, all
 * limited to ingredients a recipe or a batch uses (costing spec 4.6). The
 * stock held is valued at each stock take's own prices, so it "includes
 * price changes on stock you held". Actual food cost = ACOGS ÷ food sales;
 * the gap is against what the sales should have cost.
 */
export function actualCogsFigures(x: {
  openingCents: number;
  purchasesCents: number;
  closingCents: number;
  foodSalesCents: number;
  shouldHaveCents: number;
}): { costCents: number; actualBps: number | null; shouldHaveBps: number | null; gapBps: number | null } {
  const costCents = x.openingCents + x.purchasesCents - x.closingCents;
  const actualBps = shareBps(costCents, x.foodSalesCents);
  const shouldHaveBps = shareBps(x.shouldHaveCents, x.foodSalesCents);
  return { costCents, actualBps, shouldHaveBps, gapBps: actualBps !== null && shouldHaveBps !== null ? actualBps - shouldHaveBps : null };
}
