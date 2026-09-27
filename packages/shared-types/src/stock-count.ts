/**
 * Stock takes and "used vs should have used" (costing spec Phase 8, §4.6,
 * migration 0038). Quantities are whole base units in the ingredient's unit
 * now (g, ml, pcs…); money in paisa; percentages in basis points; unit
 * prices in millicents (1/1000 paisa: per gram it reads as paisa per kg).
 */
import type { IngredientCategory } from './inventory.js';

// ---------------------------------------------------------------------------
// Stock takes
// ---------------------------------------------------------------------------

/**
 * What a stock take counts:
 *  - 'full':      every ingredient in use (the monthly count);
 *  - 'key_items': the key items (ingredients.count_weekly: cheese, chicken,
 *                 patties, dough, oil, boxes…), the weekly count;
 *  - 'custom':    ingredients picked by hand (the Stock button's one-line
 *                 stock take is one of these). A full stock take finished
 *                 with items left blank becomes one.
 */
export const STOCK_COUNT_SCOPES = ['full', 'key_items', 'custom'] as const;
export type StockCountScope = (typeof STOCK_COUNT_SCOPES)[number];

export const STOCK_COUNT_STATUSES = ['open', 'done', 'cancelled'] as const;
export type StockCountStatus = (typeof STOCK_COUNT_STATUSES)[number];

export function isStockCountScope(x: unknown): x is StockCountScope {
  return typeof x === 'string' && (STOCK_COUNT_SCOPES as readonly string[]).includes(x);
}

export function isStockCountStatus(x: unknown): x is StockCountStatus {
  return typeof x === 'string' && (STOCK_COUNT_STATUSES as readonly string[]).includes(x);
}

/** The owner's names for them (screen, paper and file). */
export const STOCK_COUNT_SCOPE_LABEL: Record<StockCountScope, string> = {
  full: 'Full stock take',
  key_items: 'Key items',
  custom: 'Picked items',
};

/** A stock take in the list (Inventory → Stock takes). */
export interface StockCountSummary {
  id: string;
  scope: StockCountScope;
  status: StockCountStatus;
  startedAt: string;
  /** When it was finished; null while open or once cancelled. */
  finishedAt: string | null;
  countedByName: string | null;
  notes: string | null;
  /** Ingredients on the sheet, and how many of them have a figure. */
  lineCount: number;
  countedCount: number;
  /**
   * Finished only: what was found short of what the till expected (a
   * positive number of paisa) and what was found over it, each at the price
   * when it was finished. Null before it is finished.
   */
  shortCents: number | null;
  overCents: number | null;
  /** Started on this till (a stock take from the other till can still be finished here). */
  thisTill: boolean;
}

/**
 * Where "expected" came from when a line was finished:
 *  - 'shop': the last stock take's count plus every till's stock rows since
 *    (shop stock, costing spec 4.6);
 *  - 'till': never counted before — this till's own count ("till count, no
 *    stock take yet").
 */
export type StockExpectedFrom = 'shop' | 'till';

/** One ingredient on a stock take's sheet. */
export interface StockCountLine {
  ingredientId: string;
  name: string;
  /** Its unit now; every quantity below is in it. */
  unit: string;
  /** The shelf it is counted on (the ingredient's category). */
  shelf: IngredientCategory;
  /** The pack it is bought in, for counting in packs + loose (null = none). */
  packSize: number | null;
  /** On the shelf, as counted; null = not counted (yet). */
  countedQty: number | null;
  /** Finished only (null before): what the till expected, and from where. */
  expectedQty: number | null;
  expectedFrom: StockExpectedFrom | null;
  /** Finished only: this till's own count just before the finish set it. */
  tillQty: number | null;
  /** Finished only: counted − expected (below 0 = missing). */
  differenceQty: number | null;
  /** …and what that is worth at the price when it was finished (signed like it). */
  differenceCents: number | null;
  /** Finished only: what the counted stock is worth at the price then. */
  valueCents: number | null;
  unitCostMc: number | null;
}

/** A stock take with its sheet. */
export interface StockCountDetail extends StockCountSummary {
  lines: StockCountLine[];
}

/**
 * The second-till link as the figures need it (costing spec D14): shop stock
 * counts every till's stock rows, so when the link is on but has not been
 * heard from lately, the other till's latest rows may be missing.
 */
export interface TillLinkState {
  /** The link is switched on (Settings → Sync is not off). */
  on: boolean;
  /** On, but paused, failing or not tried lately: say so beside the figures. Never true when off. */
  stale: boolean;
  /** When it last worked (ISO), when known. */
  lastHeardAt: string | null;
}

/**
 * How many tills take orders at the shop (business setting
 * 'analytics.tills', owner question 3; default 1). Two, with the link off:
 * the other till's sales are not on this till, so "used vs should have
 * used" and the real food cost are switched off, with a sentence.
 */
export interface TillsSetting {
  sellingTills: 1 | 2;
}

export interface TillsSettingView extends TillsSetting {
  /** Nothing saved: one till (the default). */
  isDefault: boolean;
  savedAt: string | null;
  link: TillLinkState;
}

/** What finishing a stock take (or a one-line stock take) answers. */
export interface StockCountFinish {
  count: StockCountDetail;
  /** It had been finished already: nothing was written this time. */
  alreadyFinished: boolean;
  /**
   * A sentence to show beside "expected" when it may be short of the other
   * till's rows: the link is on but not working lately, or two tills take
   * orders while it is off. Null when there is nothing to say.
   */
  expectedNote: string | null;
}

// ---------------------------------------------------------------------------
// "Used vs should have used" (costing spec 4.6)
// ---------------------------------------------------------------------------

/**
 * The rating of what went unexplained, as a share of food sales over the
 * same stretch: under 2% good, 2–3% OK, 3–5% needs work, over 5% look at it
 * now (either way: stock found over what the till expected is a sign too).
 */
export const VARIANCE_BANDS = ['good', 'ok', 'needs_work', 'look_now'] as const;
export type VarianceBand = (typeof VARIANCE_BANDS)[number];

/** One ingredient between two stock takes. Quantities in its unit now. */
export interface VarianceLine {
  ingredientId: string;
  name: string;
  unit: string;
  /** O and C: counted on the earlier and the later stock take. */
  opening: number;
  closing: number;
  /** D: came in (deliveries and purchases, every till). */
  delivered: number;
  /** Pin: made here (batches of it). */
  madeHere: number;
  /** Buse: used to make batches of something else. */
  usedInBatches: number;
  /** S: taken by sales, less what was put back. */
  sold: number;
  /** W: logged as waste (by hand, and food made for cancelled orders). */
  wasted: number;
  /** A = O + D + Pin − C: what actually went. */
  used: number;
  /** T = S + Buse: what sales and batches say should have gone. */
  shouldHaveUsed: number;
  /** V = A − T − W: gone with nothing to explain it (below 0 = more on the shelf than expected). */
  unexplained: number;
  /** V at the price when the later stock take was finished (signed like V). */
  unexplainedCents: number;
  /** V ÷ T; null when nothing should have been used. */
  unexplainedBps: number | null;
  /** Typed fixes and old one-off counts in the window (listed, not in A). */
  corrections: number;
  /** It has no price: its rupees are 0 and not known. */
  priced: boolean;
  /** Made here (it has a batch recipe). */
  madeInHouse: boolean;
}

/** A batch and what it is made from, shown as a linked pair. */
export interface VarianceBatchPair {
  batchId: string;
  batchName: string;
  inputs: Array<{ ingredientId: string; name: string }>;
  /** Its counted stock rose between the stock takes with no batch logged. */
  noBatchLogged: boolean;
  /** "Cheese Mix went up but no batch was logged: the mozzarella difference is probably that batch." */
  warning: string | null;
}

/** A correction in the window, listed beside V (not in A). */
export interface VarianceCorrection {
  ingredientId: string;
  name: string;
  unit: string;
  /** Signed like the stock row. */
  qty: number;
  at: string;
  /** 'fix': a typed correction; 'old_count': a stock take from before stock takes were kept. */
  kind: 'fix' | 'old_count';
  notes: string | null;
}

/**
 * A cancelled order's "already in the stock take" row: the order's stock was
 * put back after a stock take had seen it on the shelf, so this till's count
 * was held where the stock take set it. Left out of the figures, listed.
 */
export interface VarianceAlreadyCounted {
  ingredientId: string;
  name: string;
  unit: string;
  qty: number;
  orderId: string;
  orderNumber: string | null;
  at: string;
}

/**
 * The real food cost between two FULL stock takes (costing spec 4.6),
 * limited to ingredients a recipe or a batch uses: what was held at the
 * start, plus what was bought, less what was held at the end — "includes
 * price changes on stock you held".
 */
export interface ActualCogs {
  openingCents: number;
  purchasesCents: number;
  closingCents: number;
  /** opening + purchases − closing. */
  costCents: number;
  foodSalesCents: number;
  /** costCents ÷ food sales. */
  actualBps: number | null;
  /** What sales should have cost (the cost each sale kept, and estimates) ÷ food sales. */
  shouldHaveBps: number | null;
  /** actual − should have (points × 100). */
  gapBps: number | null;
  /** Bought in the window but in no recipe or batch (cleaning things, gas…): not in the figure. */
  otherPurchases: Array<{ ingredientId: string; name: string; spendCents: number }>;
  otherPurchasesCents: number;
}

/** A stock take as the window's ends name it. */
export interface VarianceEnd {
  id: string;
  scope: StockCountScope;
  finishedAt: string;
  countedByName: string | null;
}

/**
 * "Used vs should have used" between two stock takes (costing spec 4.6):
 * for every ingredient counted on both, what actually went against what
 * sales, batches and logged waste say should have gone, in rupees. For the
 * whole shop's stock (every till's stock rows); dated by when each order
 * first took its stock, so a cancel after a stock take lands in the right
 * window.
 */
export interface ReportVariance {
  /**
   * 'ok': worked out;
   * 'no_counts': fewer than two stock takes finished;
   * 'other_till_missing': two tills take orders and the link is off (the
   *   other till's sales aren't on this till): switched off.
   */
  state: 'ok' | 'no_counts' | 'other_till_missing';
  /** Why it is not shown, in a sentence (null when ok). */
  message: string | null;
  from: VarianceEnd | null;
  to: VarianceEnd | null;
  /** (from.finishedAt, to.finishedAt]. */
  sinceIso: string | null;
  untilIso: string | null;
  /** Food sales (this till's orders) over the window, before tax, after discounts. */
  foodSalesCents: number;
  /** Most rupees unexplained first. */
  lines: VarianceLine[];
  /** Counted on the later stock take but not on the earlier one: no comparison. */
  notOnBoth: Array<{ ingredientId: string; name: string }>;
  /** Σ unexplainedCents. */
  totalCents: number;
  /** Σ unexplainedCents ÷ food sales; null with no food sales, or nothing counted on both (then no rating either). */
  varianceBps: number | null;
  band: VarianceBand | null;
  pairs: VarianceBatchPair[];
  corrections: VarianceCorrection[];
  alreadyCounted: VarianceAlreadyCounted[];
  /** Only when both stock takes were full. */
  actualCogs: ActualCogs | null;
  /** Why there is no real food cost (a sentence), when there is none. */
  actualCogsWhyNot: string | null;
  link: TillLinkState;
  /** The link is on but not working lately: the other till's latest rows may be missing. Never with the link off. */
  staleSync: boolean;
  sellingTills: 1 | 2;
}

/**
 * reports:variance: the two stock takes. Omitted: the latest full or
 * key-items stock take, and before it (on an earlier trading day) the last
 * full one or one of the same kind (pos-domain pickStockTakePair).
 */
export interface VarianceRequest {
  fromCountId?: string | null;
  toCountId?: string | null;
}
