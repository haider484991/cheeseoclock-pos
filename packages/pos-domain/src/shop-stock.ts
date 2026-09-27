/**
 * Shop stock (costing spec 4.6, Phase 8): what the whole shop should have
 * on its shelves, from the ledger — the last stock take's count plus every
 * till's stock rows since. Each till keeps its own running count (sync-core
 * RECEIVER_KEEPS_ON_UPDATE: a sale on the other till never moves this one),
 * so a stock take's "expected" figure, the variance's opening and the
 * forecast's on-hand come from here; low-stock warnings keep using this
 * till's count (unchanged).
 *
 * Dating: every stock row counts at d(r) = COALESCE(ref_taken_at,
 * occurred_at). A row that settles an order (its stock put back, its food
 * booked as waste, "already in the stock take") carries ref_taken_at = when
 * that order FIRST took stock, so the order's take and everything that
 * settles it land on the same side of any stock take: send, stock take,
 * cancel not-made, stock take gives nothing unexplained in either window.
 * Rows written before costing (no ref_taken_at) are dated by their order's
 * first take the same way (firstTakeOf).
 *
 * 'count' rows never move the shop's stock: they set ONE till's count to
 * what was on the shelf (a stock take's own row, an older one-off count, the
 * balancing half of "already in the stock take").
 *
 * Pure: the SQL that reads the rows is apps/pos/electron/db/stock-ledger-read.ts.
 */
import type { TillLinkState } from '@cheeseoclock/shared-types';
import { unitFactor } from './units.js';

/** A stock row as the shop's stock and the variance read it. */
export interface LedgerRow {
  ingredientId: string;
  /** Signed, in `unit`. */
  deltaQty: number;
  /** The unit the row was written in (0029); null = the ingredient's unit now. */
  unit: string | null;
  reason: string;
  detail: string | null;
  refOrderId: string | null;
  refGroupId: string | null;
  occurredAt: string;
  refTakenAt: string | null;
}

/** A row written for an order after the order took its stock (anything but the take itself). */
export function settlesAnOrder(r: Pick<LedgerRow, 'refOrderId' | 'reason' | 'deltaQty'>): boolean {
  return r.refOrderId !== null && !(r.reason === 'sale' && r.deltaQty < 0);
}

/**
 * d(r): when a stock row counts. Its ref_taken_at when it has one (a row
 * settling an order: when the order first took stock); a settle row from
 * before costing kept none, so its order's first take (`firstTakeOf`, from
 * the ledger), when that is earlier; otherwise when it happened.
 */
export function ledgerDate(
  r: Pick<LedgerRow, 'refTakenAt' | 'occurredAt' | 'refOrderId' | 'reason' | 'deltaQty'>,
  firstTakeOf?: (orderId: string) => string | undefined,
): string {
  if (r.refTakenAt) return r.refTakenAt;
  if (firstTakeOf && settlesAnOrder(r)) {
    const t = firstTakeOf(r.refOrderId!);
    if (t !== undefined && t < r.occurredAt) return t;
  }
  return r.occurredAt;
}

/** A 'count' row resets one till's count to the shelf; it never moves the shop's stock. */
export function movesShopStock(r: Pick<LedgerRow, 'reason'>): boolean {
  return r.reason !== 'count';
}

/** The stock take a shop stock figure starts from: the last one of the ingredient at or before the moment. */
export interface CountAnchor {
  countId: string;
  /** What was on the shelf, in `unit`. */
  countedQty: number;
  unit: string | null;
  finishedAt: string;
}

export interface ShopStock {
  /** In the ingredient's unit now. */
  qty: number;
  /** 'shop' from a stock take and the ledger since; 'till': never counted — this till's own count. */
  from: 'shop' | 'till';
  /** A row's unit could not be turned into the unit now (never done by the till): left out. */
  unconvertible: boolean;
}

/**
 * shop(i, t) = counted(L) + Σ delta × unitFactor over the stock rows of ANY
 * till with finished_at(L) < d(r) ≤ t and reason ≠ 'count'; before the
 * ingredient's first stock take, this till's own count (`tillQty`).
 */
export function shopStockOf(input: {
  unitNow: string;
  anchor: CountAnchor | null;
  tillQty: number;
  rows: readonly LedgerRow[];
  atIso: string;
  firstTakeOf?: (orderId: string) => string | undefined;
}): ShopStock {
  const { anchor } = input;
  if (anchor === null) return { qty: input.tillQty, from: 'till', unconvertible: false };
  const f = unitFactor(anchor.unit, input.unitNow);
  let unconvertible = f === null;
  let qty = f === null ? 0 : anchor.countedQty * f;
  for (const r of input.rows) {
    if (!movesShopStock(r)) continue;
    const d = ledgerDate(r, input.firstTakeOf);
    if (!(d > anchor.finishedAt && d <= input.atIso)) continue;
    const rf = unitFactor(r.unit, input.unitNow);
    if (rf === null) {
      unconvertible = true;
      continue;
    }
    qty += r.deltaQty * rf;
  }
  return { qty, from: 'shop', unconvertible };
}

/**
 * The same figure from the rows already added up per unit they were
 * written in (what the till's SQL hands over for a busy ingredient): the
 * stock take's count plus each sum, turned into the unit now.
 */
export function shopStockOfSums(input: {
  unitNow: string;
  anchor: CountAnchor | null;
  tillQty: number;
  sums: ReadonlyArray<{ unit: string | null; qty: number }>;
}): ShopStock {
  const { anchor } = input;
  if (anchor === null) return { qty: input.tillQty, from: 'till', unconvertible: false };
  const f = unitFactor(anchor.unit, input.unitNow);
  let unconvertible = f === null;
  let qty = f === null ? 0 : anchor.countedQty * f;
  for (const s of input.sums) {
    const sf = unitFactor(s.unit, input.unitNow);
    if (sf === null) {
      unconvertible = true;
      continue;
    }
    qty += s.qty * sf;
  }
  return { qty, from: 'shop', unconvertible };
}

// ---------------------------------------------------------------------------
// The second-till link, as the figures need it (costing spec D14)
// ---------------------------------------------------------------------------

/** The link not tried for this long (or paused, or failing) is "not heard from lately". */
export const LINK_QUIET_MS = 30 * 60_000;
/** This many failed tries in a row (about a minute at the usual 15 s) is "not working". */
export const LINK_FAILS_STALE = 3;

/**
 * Whether the second-till link is on, and whether it has gone quiet (shop
 * stock may then be missing the other till's latest rows). With the link
 * OFF it is never stale: there is nothing to wait for (the shop runs with
 * it off; the tills rule below covers two tills selling while it is off).
 */
export function tillLinkState(
  s: { mode: string; paused: boolean; lastAttemptAt: string | null; consecutiveFails: number },
  nowMs: number,
): TillLinkState {
  if (s.mode === 'off') return { on: false, stale: false, lastHeardAt: null };
  const tried = s.lastAttemptAt ? Date.parse(s.lastAttemptAt) : NaN;
  const working = s.consecutiveFails === 0 && Number.isFinite(tried);
  const quiet = !Number.isFinite(tried) || nowMs - tried > LINK_QUIET_MS;
  return {
    on: true,
    stale: s.paused || s.consecutiveFails >= LINK_FAILS_STALE || quiet,
    lastHeardAt: working ? s.lastAttemptAt : null,
  };
}

/** The sentence when two tills take orders and the link is off (costing spec D14). */
export const OTHER_TILL_MISSING = "The other till's sales aren't on this till";

/**
 * Two tills take orders and the link between them is off: the other till's
 * sales never reach this one, so variance, the real food cost and forecast
 * stock are switched off (costing spec D14).
 */
export function otherTillMissing(sellingTills: number, link: Pick<TillLinkState, 'on'>): boolean {
  return sellingTills === 2 && !link.on;
}

/** The warning beside figures built from every till's rows while the link has gone quiet; null when there is none. */
export function staleLinkText(link: TillLinkState): string | null {
  if (!link.on || !link.stale) return null;
  return "The link to the other till hasn't worked lately, so its latest sales and stock may be missing here.";
}
