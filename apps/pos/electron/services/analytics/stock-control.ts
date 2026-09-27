/**
 * "Used vs should have used" between two stock takes (costing spec 4.6,
 * Phase 8), and the real food cost between two full ones — worked out in
 * the Reports worker thread (the main process works it out itself only when
 * the worker is not running, for a window of 31 days or less).
 *
 * For every ingredient counted on BOTH stock takes, from the whole shop's
 * ledger (every till's stock rows; stock-ledger-read.ts), each row dated by
 * when its order first took stock (pos-domain shop-stock ledgerDate):
 * what actually went (A = O + D + Pin − C) against what sales and batches
 * say should have gone (T = S + Buse), less logged waste: V = A − T − W,
 * valued at the price when the later stock take was finished. Typed
 * corrections and older one-off counts are listed beside V, not in it; a
 * cancelled order's "already in the stock take" rows are left out and
 * listed. Batches are shown with what they are made from, warning when a
 * batch's stock rose with no batch logged.
 *
 * Switched off, with a sentence, when two tills take orders and the link
 * between them is off (costing spec D14: the other till's sales aren't on
 * this till). The stale-link note shows only while the link is ON.
 *
 * Read-only; never loads Electron (the worker loads it). The link's state
 * comes from the main process with the job (services/till-link.ts).
 */
import type {
  ActualCogs,
  ReportVariance,
  StockCountScope,
  TillLinkState,
  VarianceAlreadyCounted,
  VarianceCorrection,
  VarianceEnd,
  VarianceLine,
  VarianceBand,
  VarianceRequest,
  StockRules,
} from '@cheeseoclock/shared-types';
import { isStockCountScope } from '@cheeseoclock/shared-types';
import {
  OTHER_TILL_MISSING,
  actualCogsFigures,
  addToSums,
  batchPairs,
  emptySums,
  isRegularStockTake,
  ledgerDate,
  ledgerKind,
  otherTillMissing,
  packInUnit,
  pickStockTakePair,
  shareBps,
  stockValueAt,
  tradingDayOfMs,
  unexplainedBps,
  unitFactor,
  varianceBand,
  varianceDoThisRules,
  varianceOf,
  type BatchRecipeOf,
  type PriceOf,
  type WindowSums,
} from '@cheeseoclock/pos-domain';
import type { AppDatabase } from '../../db/connection.js';
import { getBusinessSetting, readStockRules } from '../../db/business-settings-read.js';
import { loadPriceBook, priceOfBook } from '../../db/price-book.js';
import { loadPriceHistory } from '../../db/price-history-read.js';
import { firstTakesOf, ledgerRowsToDate, ledgerSumsForWindow, type LedgerDbRow } from '../../db/stock-ledger-read.js';
import { getFoodSales } from '../business-report.js';

/** What the main process asks for: the two stock takes (or the latest two) and the link as it is now. */
export interface VarianceJob extends VarianceRequest {
  link: TillLinkState;
}

/** The longest window the main process works out itself when the worker is not running. */
export const VARIANCE_MAIN_THREAD_MAX_DAYS = 31;

type DoneCount = VarianceEnd;

/** Every finished stock take, newest first. */
export function doneStockCounts(db: AppDatabase): DoneCount[] {
  return (
    db
      .prepare(
        `SELECT c.id, c.scope, c.finished_at AS finishedAt, u.full_name AS countedByName
           FROM stock_counts c LEFT JOIN users u ON u.id = c.counted_by_user_id
          WHERE c.status = 'done' AND c.deleted_at IS NULL AND c.finished_at IS NOT NULL
          ORDER BY c.finished_at DESC, c.id DESC`,
      )
      .all() as Array<{ id: string; scope: string; finishedAt: string; countedByName: string | null }>
  ).map((c) => ({ id: c.id, scope: (isStockCountScope(c.scope) ? c.scope : 'custom') as StockCountScope, finishedAt: c.finishedAt, countedByName: c.countedByName }));
}

/**
 * The two stock takes to compare (pos-domain pickStockTakePair, the rule the
 * screen uses too): those asked for, as far as they will do; otherwise the
 * latest full or key-items stock take and, before it on an earlier trading
 * day, the latest full one or one of the same kind (a key-items count
 * against last week's, a full one against last month's). A stock take of
 * picked items (the Stock button's one-line count) is compared only when
 * asked for — or, in Reports, when there is nothing else. `regularOnly`
 * ("Do this", the weekly sheet): never one of those. `to` alone: only one
 * stock take to go on so far.
 */
export function resolveStockTakePair(
  db: AppDatabase,
  req: VarianceRequest,
  opts: { regularOnly?: boolean } = {},
): { from: DoneCount | null; to: DoneCount | null } {
  const counts = doneStockCounts(db);
  const pair = pickStockTakePair(counts, req, opts);
  if (pair) return pair;
  const to = (req.toCountId ? counts.find((c) => c.id === req.toCountId) : undefined) ?? counts.find((c) => isRegularStockTake(c.scope)) ?? (opts.regularOnly ? undefined : counts[0]);
  return { from: null, to: to ?? null };
}

/** The window's length in days (for the main-thread limit), 0 without a pair. */
export function varianceWindowDays(db: AppDatabase, req: VarianceRequest): number {
  const { from, to } = resolveStockTakePair(db, req);
  if (!from || !to) return 0;
  return Math.ceil((Date.parse(to.finishedAt) - Date.parse(from.finishedAt)) / 86_400_000);
}

interface CountedLine {
  qty: number;
  unit: string | null;
  valueCents: number | null;
}

function countedLines(db: AppDatabase, countId: string): Map<string, CountedLine> {
  return new Map(
    (
      db
        .prepare(
          `SELECT ingredient_id AS id, counted_qty AS qty, unit, value_cents AS valueCents
             FROM stock_count_lines WHERE stock_count_id = ? AND deleted_at IS NULL AND counted_qty IS NOT NULL`,
        )
        .all(countId) as Array<{ id: string; qty: number; unit: string | null; valueCents: number | null }>
    ).map((l) => [l.id, { qty: Number(l.qty), unit: l.unit, valueCents: l.valueCents === null ? null : Number(l.valueCents) }]),
  );
}

interface IngredientMeta {
  id: string;
  name: string;
  unit: string;
  madeInHouse: boolean;
}

function ingredientMeta(db: AppDatabase, ids: Iterable<string>): Map<string, IngredientMeta> {
  const list = [...new Set(ids)];
  if (list.length === 0) return new Map();
  return new Map(
    (
      db
        .prepare(`SELECT id, name, unit, batch_yield FROM ingredients WHERE id IN (SELECT value FROM json_each(?))`)
        .all(JSON.stringify(list)) as Array<{ id: string; name: string; unit: string; batch_yield: number | null }>
    ).map((i) => [i.id, { id: i.id, name: i.name, unit: i.unit, madeInHouse: i.batch_yield !== null }]),
  );
}

/** Every batch recipe with what goes into it. */
function batchRecipes(db: AppDatabase): BatchRecipeOf[] {
  const rows = db
    .prepare(
      `SELECT l.ingredient_id AS batchId, b.name AS batchName, l.input_ingredient_id AS inputId, i.name AS inputName
         FROM batch_recipe_lines l
         JOIN ingredients b ON b.id = l.ingredient_id AND b.deleted_at IS NULL
         JOIN ingredients i ON i.id = l.input_ingredient_id
        WHERE l.deleted_at IS NULL
        ORDER BY l.ingredient_id, l.sort_order, l.rowid`,
    )
    .all() as Array<{ batchId: string; batchName: string; inputId: string; inputName: string }>;
  const byBatch = new Map<string, BatchRecipeOf>();
  for (const r of rows) {
    let b = byBatch.get(r.batchId);
    if (!b) byBatch.set(r.batchId, (b = { batchId: r.batchId, batchName: r.batchName, inputs: [] }));
    if (!b.inputs.some((x) => x.ingredientId === r.inputId)) b.inputs.push({ ingredientId: r.inputId, name: r.inputName });
  }
  return [...byBatch.values()];
}

/** The ingredients any recipe or batch uses: what the real food cost is limited to. */
function recipeIngredients(db: AppDatabase): Set<string> {
  return new Set(
    (
      db
        .prepare(
          `SELECT ingredient_id AS id FROM recipes WHERE deleted_at IS NULL
           UNION SELECT input_ingredient_id FROM batch_recipe_lines WHERE deleted_at IS NULL
           UNION SELECT ingredient_id FROM batch_recipe_lines WHERE deleted_at IS NULL`,
        )
        .all() as Array<{ id: string }>
    ).map((r) => r.id),
  );
}

/**
 * The price an ingredient is valued at when the later stock take was
 * finished, as a pack in its unit now: the price history's price in force
 * then (Phase 4), else today's effective price. Undefined when it has none.
 */
function pricesAt(db: AppDatabase, atIso: string): (id: string, unitNow: string) => ReturnType<PriceOf> {
  const history = loadPriceHistory(db);
  const today = priceOfBook(loadPriceBook(db));
  return (id, unitNow) => {
    const then = history.priceAt(id, atIso);
    if (then) {
      const pack = packInUnit(then.pack, then.unit, unitNow);
      if (pack) return { pack, kind: then.kind };
    }
    return today(id);
  };
}

/** A variance with nothing worked out (switched off, or not two stock takes yet). */
function emptyVariance(link: TillLinkState, sellingTills: 1 | 2, state: ReportVariance['state'], message: string): ReportVariance {
  return {
    state,
    message,
    from: null,
    to: null,
    sinceIso: null,
    untilIso: null,
    foodSalesCents: 0,
    lines: [],
    notOnBoth: [],
    totalCents: 0,
    varianceBps: null,
    band: null,
    pairs: [],
    corrections: [],
    alreadyCounted: [],
    actualCogs: null,
    actualCogsWhyNot: null,
    link,
    staleSync: link.on && link.stale,
    sellingTills,
  };
}

export function sellingTillsOf(db: AppDatabase): 1 | 2 {
  return getBusinessSetting(db, 'analytics.tills')?.value.sellingTills ?? 1;
}

/** One instant after `iso` (Reports' periods start inclusive; the window starts just after the earlier stock take). */
function justAfter(iso: string): string {
  return new Date(Date.parse(iso) + 1).toISOString();
}

/** "Used vs should have used" between two stock takes (costing spec 4.6). The figures do not depend on the clock. */
export function buildVariance(db: AppDatabase, job: VarianceJob): ReportVariance {
  const link = job.link;
  const sellingTills = sellingTillsOf(db);
  if (otherTillMissing(sellingTills, link)) {
    return emptyVariance(
      link,
      sellingTills,
      'other_till_missing',
      `${OTHER_TILL_MISSING}, so what was used can't be set against what was sold. Switch the link between the tills on (Settings → Sync) to see it.`,
    );
  }
  const { from, to } = resolveStockTakePair(db, job);
  if (!to || !from) {
    return emptyVariance(
      link,
      sellingTills,
      'no_counts',
      to
        ? 'Only one stock take is finished so far. After the next one, this shows what was used against what should have been.'
        : 'No stock take is finished yet. Count the key items (Inventory → Stock takes), and again a week later: this then shows what was used against what should have been.',
    );
  }
  const t0 = from.finishedAt;
  const t1 = to.finishedAt;
  const opening = countedLines(db, from.id);
  const closing = countedLines(db, to.id);
  const both = [...closing.keys()].filter((id) => opening.has(id));
  const meta = ingredientMeta(db, [...opening.keys(), ...closing.keys()]);

  // The shop's ledger for the window, dated by when each order first took
  // stock (costing spec 4.6). The bulk — sales, deliveries and waste written
  // in the window — added up in SQL; every other row (batches, fixes,
  // counts, later cancels, rows from before costing) dated and classified
  // one by one by pos-domain itself (ledgerDate, ledgerKind). Each figure in
  // the ingredient's unit now.
  const wanted = new Set(both);
  const sums = new Map<string, WindowSums>(both.map((id) => [id, emptySums()]));
  const factorOf = (id: string, unit: string | null): number | null => {
    const m = meta.get(id);
    return m ? unitFactor(unit, m.unit) : null;
  };
  for (const r of ledgerSumsForWindow(db, t0, t1)) {
    if (!wanted.has(r.ingredientId)) continue;
    const f = factorOf(r.ingredientId, r.unit);
    if (f === null) continue;
    const s = sums.get(r.ingredientId)!;
    addToSums(s, 'delivery', r.delivery * f);
    addToSums(s, 'sale', r.sale * f);
    addToSums(s, 'waste', r.waste * f);
  }
  const corrections: VarianceCorrection[] = [];
  const alreadyRows: Array<{ row: LedgerDbRow; qty: number }> = [];
  const rest = ledgerRowsToDate(db, t0, t1);
  const firstTake = firstTakesOf(db, rest);
  for (const r of rest) {
    if (!wanted.has(r.ingredientId)) continue;
    const d = ledgerDate(r, firstTake);
    if (!(d > t0 && d <= t1)) continue;
    const f = factorOf(r.ingredientId, r.unit);
    if (f === null) continue;
    const m = meta.get(r.ingredientId)!;
    const qty = r.deltaQty * f;
    const kind = ledgerKind(r);
    addToSums(sums.get(r.ingredientId)!, kind, qty);
    // Listed beside the figures: typed fixes and older one-off counts; "already in the stock take" left out and listed.
    if (kind === 'fix' || kind === 'old_count') {
      corrections.push({ ingredientId: r.ingredientId, name: m.name, unit: m.unit, qty, at: r.occurredAt, kind: kind === 'fix' ? 'fix' : 'old_count', notes: r.notes });
    } else if (kind === 'already_counted') {
      alreadyRows.push({ row: r, qty });
    }
  }

  const priceAt = pricesAt(db, t1);
  const lines: VarianceLine[] = [];
  for (const id of both) {
    const m = meta.get(id);
    if (!m) continue;
    const o = opening.get(id)!;
    const c = closing.get(id)!;
    const fo = unitFactor(o.unit, m.unit);
    const fc = unitFactor(c.unit, m.unit);
    if (fo === null || fc === null) continue;
    const s = sums.get(id)!;
    const fig = varianceOf(o.qty * fo, c.qty * fc, s);
    const price = priceAt(id, m.unit);
    const value = stockValueAt(fig.unexplained, price);
    lines.push({
      ingredientId: id,
      name: m.name,
      unit: m.unit,
      opening: o.qty * fo,
      closing: c.qty * fc,
      delivered: s.delivered,
      madeHere: s.madeHere,
      usedInBatches: s.usedInBatches,
      sold: s.sold,
      wasted: s.wasted,
      used: fig.used,
      shouldHaveUsed: fig.shouldHaveUsed,
      unexplained: fig.unexplained,
      unexplainedCents: value.valueCents,
      unexplainedBps: unexplainedBps(fig),
      corrections: fig.corrections,
      priced: value.basis === 'price',
      madeInHouse: m.madeInHouse,
    });
  }
  lines.sort((a, b) => Math.abs(b.unexplainedCents) - Math.abs(a.unexplainedCents) || a.name.localeCompare(b.name));

  const range = { sinceIso: justAfter(t0), untilIso: justAfter(t1) };
  const food = getFoodSales(db, range);
  const totalCents = lines.reduce((sum, l) => sum + l.unexplainedCents, 0);
  // Nothing counted on both: nothing was compared, so no share and no rating (never "Good").
  const varianceBps = lines.length === 0 ? null : shareBps(totalCents, food.foodSalesCents);
  const { goodUnderBps, okUpToBps, needsWorkUpToBps } = readStockRules(db).bands;
  const bands = { goodUnderBps, okUpToBps, needsWorkUpToBps };

  const byId = new Map(lines.map((l) => [l.ingredientId, l]));
  const pairs = batchPairs(batchRecipes(db), byId);

  // Cancelled orders' "already in the stock take" rows, with their order numbers.
  const orderNumbers = new Map(
    alreadyRows.length === 0
      ? []
      : (
          db
            .prepare(`SELECT id, order_number AS n FROM orders WHERE id IN (SELECT value FROM json_each(?))`)
            .all(JSON.stringify([...new Set(alreadyRows.map((a) => a.row.refOrderId!))])) as Array<{ id: string; n: string | null }>
        ).map((o) => [o.id, o.n]),
  );
  const alreadyCounted: VarianceAlreadyCounted[] = alreadyRows.map(({ row, qty }) => ({
    ingredientId: row.ingredientId,
    name: meta.get(row.ingredientId)?.name ?? 'Deleted ingredient',
    unit: meta.get(row.ingredientId)?.unit ?? '',
    qty,
    orderId: row.refOrderId!,
    orderNumber: orderNumbers.get(row.refOrderId!) ?? null,
    at: row.occurredAt,
  }));

  let actualCogs: ActualCogs | null = null;
  let actualCogsWhyNot: string | null = null;
  if (from.scope === 'full' && to.scope === 'full') {
    actualCogs = realFoodCost(db, { opening, closing, t0, t1, foodSalesCents: food.foodSalesCents, shouldHaveCents: food.costOfSalesCents });
  } else {
    actualCogsWhyNot = 'The real food cost needs a full stock take at both ends.';
  }

  return {
    state: 'ok',
    message: null,
    from,
    to,
    sinceIso: t0,
    untilIso: t1,
    foodSalesCents: food.foodSalesCents,
    lines,
    notOnBoth: [...closing.keys()]
      .filter((id) => !opening.has(id))
      .map((id) => ({ ingredientId: id, name: meta.get(id)?.name ?? 'Deleted ingredient' }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    totalCents,
    varianceBps,
    // Rated with the owner's bands (Settings → Kitchen & stock), which the screen says as they are.
    band: varianceBand(varianceBps, bands),
    bands,
    pairs,
    corrections: corrections.sort((a, b) => a.at.localeCompare(b.at)),
    alreadyCounted,
    actualCogs,
    actualCogsWhyNot,
    link,
    staleSync: link.on && link.stale,
    sellingTills,
  };
}

/**
 * The real food cost between two full stock takes (costing spec 4.6),
 * limited to ingredients a recipe or a batch uses: held at the start (each
 * line at the price of its own stock take) + bought in the window (every
 * till's deliveries, at their bills) − held at the end. Purchases of
 * anything else are listed apart.
 */
function realFoodCost(
  db: AppDatabase,
  x: { opening: Map<string, CountedLine>; closing: Map<string, CountedLine>; t0: string; t1: string; foodSalesCents: number; shouldHaveCents: number },
): ActualCogs {
  const used = recipeIngredients(db);
  const held = (lines: Map<string, CountedLine>) => [...lines].reduce((s, [id, l]) => (used.has(id) ? s + (l.valueCents ?? 0) : s), 0);
  const openingCents = held(x.opening);
  const closingCents = held(x.closing);

  // Deliveries and purchases in the window, at their bills (a row from before costing at the price then).
  const rows = db
    .prepare(
      `SELECT ingredient_id AS id, delta_qty AS qty, unit, value_cents AS value, occurred_at AS at
         FROM stock_movements INDEXED BY idx_movements_reason_time
        WHERE reason = 'delivery' AND occurred_at > ? AND occurred_at <= ? AND deleted_at IS NULL`,
    )
    .all(x.t0, x.t1) as Array<{ id: string; qty: number; unit: string | null; value: number | null; at: string }>;
  const history = loadPriceHistory(db);
  const today = priceOfBook(loadPriceBook(db));
  let purchasesCents = 0;
  const other = new Map<string, number>();
  for (const r of rows) {
    let value = r.value === null ? null : Number(r.value);
    if (value === null) {
      const then = history.priceAt(r.id, r.at);
      const pack = then ? packInUnit(then.pack, then.unit, r.unit ?? then.unit) : null;
      const price = then ? (pack ? { pack, kind: then.kind } : undefined) : today(r.id);
      value = stockValueAt(Number(r.qty), price).valueCents;
    }
    if (used.has(r.id)) purchasesCents += value;
    else other.set(r.id, (other.get(r.id) ?? 0) + value);
  }
  const names = ingredientMeta(db, other.keys());
  const otherPurchases = [...other]
    .map(([id, spendCents]) => ({ ingredientId: id, name: names.get(id)?.name ?? 'Deleted ingredient', spendCents }))
    .sort((a, b) => b.spendCents - a.spendCents || a.name.localeCompare(b.name));
  const fig = actualCogsFigures({ openingCents, purchasesCents, closingCents, foodSalesCents: x.foodSalesCents, shouldHaveCents: x.shouldHaveCents });
  return {
    openingCents,
    purchasesCents,
    closingCents,
    costCents: fig.costCents,
    foodSalesCents: x.foodSalesCents,
    actualBps: fig.actualBps,
    shouldHaveBps: fig.shouldHaveBps,
    gapBps: fig.gapBps,
    otherPurchases,
    otherPurchasesCents: otherPurchases.reduce((s, p) => s + p.spendCents, 0),
  };
}

// ---------------------------------------------------------------------------
// The Dashboard's "Do this": the latest two stock takes, kept for the day
// ---------------------------------------------------------------------------

/** The latest comparison as "Do this" needs it; null when there is none (or it is switched off). */
export interface LatestVariance {
  fromCountId: string;
  toCountId: string;
  /** When the earlier stock take was finished. */
  sinceIso: string;
  countedAt: string;
  windowMs: number;
  /** Ingredients counted on both (0: nothing was compared — no figure, no rating). */
  compared: number;
  totalCents: number;
  varianceBps: number | null;
  band: VarianceBand | null;
  topIngredient: string | null;
}

/**
 * Whether the latest comparison is a "Do this" line (costing spec 4.17):
 * something was compared, over the owner's shortest stretch or more (6
 * days by default: a shorter stretch would be blown up to a week), and more
 * than his share of the food sales between the two (3% by default) went
 * unexplained. `rules`: 'stock.rules' (Settings → Kitchen & stock); the
 * released ones when not given.
 */
export function isVarianceDoThis(
  v: LatestVariance | null,
  rules?: Pick<StockRules, 'varianceDoThisBps' | 'varianceMinWindowDays'>,
): v is LatestVariance & { varianceBps: number } {
  const r = varianceDoThisRules(rules);
  return (
    v !== null &&
    v.compared > 0 &&
    v.windowMs >= r.minWindowMs &&
    v.varianceBps !== null &&
    v.varianceBps > r.minBps &&
    v.totalCents > 0
  );
}

const latestKept = new WeakMap<AppDatabase, { key: string; value: LatestVariance | null }>();

/**
 * The latest two stock takes' variance — the till's own pair, full or key
 * items only (the Stock button's one-line counts are fixes, not the week's
 * count) — worked out once per trading day and per pair (the card is asked
 * often and must come back fast; a new stock take is a new pair, so it
 * shows at once; the worker works it out as soon as one is finished,
 * warmLatestVariance). With `longReads` false (the main process, no worker)
 * a window over 31 days is skipped.
 */
export function latestVariance(db: AppDatabase, link: TillLinkState, now: Date, opts: { longReads: boolean } = { longReads: true }): LatestVariance | null {
  const sellingTills = sellingTillsOf(db);
  if (otherTillMissing(sellingTills, link)) return null;
  const { from, to } = resolveStockTakePair(db, {}, { regularOnly: true });
  if (!from || !to) return null;
  const windowMs = Date.parse(to.finishedAt) - Date.parse(from.finishedAt);
  if (!opts.longReads && windowMs > VARIANCE_MAIN_THREAD_MAX_DAYS * 86_400_000) return null;
  // The owner's bands rate it: a Save (here or from the other till) is a new key, so it shows at once.
  const b = readStockRules(db).bands;
  const key = `${from.id}|${to.id}|${link.on}|${sellingTills}|${tradingDayOfMs(now.getTime())}|${b.goodUnderBps}/${b.okUpToBps}/${b.needsWorkUpToBps}`;
  const kept = latestKept.get(db);
  if (kept && kept.key === key) return kept.value;
  const v = buildVariance(db, { fromCountId: from.id, toCountId: to.id, link });
  const value: LatestVariance | null =
    v.state === 'ok'
      ? {
          fromCountId: from.id,
          toCountId: to.id,
          sinceIso: from.finishedAt,
          countedAt: to.finishedAt,
          windowMs,
          compared: v.lines.length,
          totalCents: v.totalCents,
          varianceBps: v.varianceBps,
          band: v.band,
          topIngredient: v.lines.find((l) => l.unexplainedCents > 0)?.name ?? null,
        }
      : null;
  latestKept.set(db, { key, value });
  return value;
}

/**
 * Work the latest comparison out ahead of the Dashboard's next ask (the
 * worker, told a stock take was just finished): the first tap after the
 * monthly count then does not wait for a month of the ledger. Read-only.
 */
export function warmLatestVariance(db: AppDatabase, link: TillLinkState, now: Date): void {
  db.transaction(() => latestVariance(db, link, now))();
}
