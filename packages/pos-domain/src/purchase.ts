/**
 * Buying stock at the real bill (costing spec Phase 5, D1, 4.1). Pure, so
 * the Receive screen, "Record a purchase" and the main process all work a
 * bill out the same way:
 *
 *  - a purchase order line keeps the price it was ordered at EXACTLY, as the
 *    pack it was typed in ("Rs 375 per kg" = 1,000 g for Rs 375); lines from
 *    before this phase are priced per unit;
 *  - a bill of B for q units is kept exactly as (q, B) in the price history;
 *    the ingredient keeps its usual pack S, at round(B × S ÷ q), and its
 *    pack is never cleared;
 *  - D1's guard: a bill whose price is more than 10% from the usual one is
 *    asked about ("Use Rs 187 / kg as the new price?"). The answer when
 *    nobody says otherwise is YES for a purchase order delivered (the price
 *    was agreed) and NO for a quick purchase (a market top-up at a dear
 *    stall should not reprice the menu). Within 10% the bill's price is
 *    simply used. The same defaults hold for a price marked as a guess and
 *    for one marked free: outside the band (a free one always is), yes for
 *    a purchase order, no for a quick purchase. The bill is always what the
 *    stock came in at.
 */
import type { PriceKind, PurchaseKind } from '@cheeseoclock/shared-types';
import { mulDivRound, thousandSize, unitCostMc, valueCents, type Pack } from './units.js';
import { priceChangeBps } from './ingredient-price.js';

/**
 * How far a bill's price may be from the usual price before the till asks
 * (costing spec D1): 10%, in basis points. The default only: D1 calls it
 * "the alert threshold", so from costing Phase 6 the owner sets it with the
 * price alerts ('costing.alerts' jumpBps, whose default this is), and the
 * main process and the purchase screens pass it in as `thresholdBps`.
 */
export const PRICE_GUARD_BPS = 1_000;

/** A purchase order line's price: its ordered pack, or — a line from before costing Phase 5 — (1, its price per unit). */
export function orderedPack(line: { orderedPackSize: number | null; orderedPackPriceCents: number | null; unitCostCents: number }): Pack {
  if (line.orderedPackSize !== null && line.orderedPackSize > 0 && line.orderedPackPriceCents !== null) {
    return { size: line.orderedPackSize, priceCents: line.orderedPackPriceCents };
  }
  return { size: 1, priceCents: line.unitCostCents };
}

/** What `qty` comes to at a line's ordered price, rounded once: the bill the Receive screen fills in. */
export function orderedValueCents(
  qty: number,
  line: { orderedPackSize: number | null; orderedPackPriceCents: number | null; unitCostCents: number },
): number {
  return valueCents(qty, orderedPack(line));
}

/**
 * The pack an ingredient's price is usually kept in: its own pack when it
 * has one ("6,000 g for Rs 2,250" keeps 6,000 g); else per kg / litre for
 * something weighed (never a price per gram in whole paisa, D1); else one
 * piece.
 */
export function usualPackSize(i: { unit: string; packSize: number | null; packPriceCents: number | null }): number {
  if (i.packSize !== null && i.packSize > 0 && i.packPriceCents !== null) return i.packSize;
  return thousandSize(i.unit) ?? 1;
}

/** The ingredient's price from a bill of `billCents` for `qty` units: its usual pack S at round(B × S ÷ q). */
export function priceFromBill(qty: number, billCents: number, usualSize: number): Pack {
  assertBill(qty, billCents);
  if (!Number.isSafeInteger(usualSize) || usualSize < 1) throw new Error('The pack must hold at least 1 unit');
  return { size: usualSize, priceCents: mulDivRound(billCents, usualSize, qty) };
}

/** A bill exactly as it is: `qty` units for `billCents` (the price history's row, a quick purchase line's pack). */
export function billPack(qty: number, billCents: number): Pack {
  assertBill(qty, billCents);
  return { size: qty, priceCents: billCents };
}

function assertBill(qty: number, billCents: number): void {
  if (!Number.isSafeInteger(qty) || qty < 1) throw new Error('Say how much came, at least 1 whole unit');
  if (!Number.isSafeInteger(billCents) || billCents < 0) throw new Error('The bill must be Rs 0 or more, in whole paisa');
}

/** Why a bill's price is or is not used, for the screen's words. */
export type PriceCheckWhy =
  /** Nothing would change: the bill is at the usual price. */
  | 'same'
  /** The ingredient has no price yet: this becomes its price. */
  | 'no_price'
  /** Within 10% of the usual price: used. */
  | 'within'
  /** More than 10% dearer than usual: asked. */
  | 'higher'
  /** More than 10% cheaper than usual: asked. */
  | 'lower'
  /** It was marked free (costs nothing): asked; D1's default (yes for a purchase order, no for a quick purchase). */
  | 'was_free'
  /** Its price was a guess: used within 10%; outside it asked, with D1's default. */
  | 'guess'
  /** Made here from a batch recipe: its price comes from the recipe, never a bill. */
  | 'made_here'
  /** A bill of Rs 0 is not a price (samples, a gift): the price stays. */
  | 'zero_bill';

export interface PriceCheck {
  /** The ingredient's price if the bill is used: its usual pack at the bill's price. */
  newPack: Pack;
  /** One base unit on this bill, exactly (millicents). */
  billUnitMc: number;
  /** One base unit at the price now; null when it has none. */
  currentUnitMc: number | null;
  /** The bill against the price now, in basis points (+2,500 = 25% dearer); null when there is nothing to compare with. */
  changeBps: number | null;
  /** The bill's price may become the ingredient's price at all. */
  adoptable: boolean;
  /** The screen asks "Use Rs X as the new price?" (outside the 10% band, or it was free). */
  ask: boolean;
  /** The answer when nobody says otherwise (costing spec D1). */
  adoptByDefault: boolean;
  why: PriceCheckWhy;
}

export interface PriceCheckInput {
  /** 'order': a purchase order delivered; 'quick': a purchase recorded on the spot. */
  kind: PurchaseKind;
  /** The price costing uses now (its effective pack and kind); `madeHere` when it comes from a batch recipe. */
  current: { pack: Pack; kind: PriceKind; madeHere?: boolean };
  /** The pack the ingredient's price is kept in (usualPackSize). */
  usualSize: number;
  qty: number;
  billCents: number;
  /** The band, default PRICE_GUARD_BPS (10%). */
  thresholdBps?: number;
}

/**
 * D1's guard for one line of a bill: what the ingredient's price would
 * become, how far that is from the price now, and whether it is used by
 * default. A purchase order delivered: yes (asked when outside 10%); a quick
 * purchase: yes within 10%, asked and NO by default outside it. The default
 * depends only on the kind of purchase, as D1 says — a guessed price and a
 * free one follow the same rule (free is always outside the band). No price
 * yet: the bill's is used. Made here, or a bill of Rs 0: never used.
 */
export function checkBillPrice(input: PriceCheckInput): PriceCheck {
  const { kind, current, usualSize, qty, billCents } = input;
  const threshold = input.thresholdBps ?? PRICE_GUARD_BPS;
  const newPack = priceFromBill(qty, billCents, usualSize);
  const billUnitMc = unitCostMc(billPack(qty, billCents));
  const priced = current.kind === 'set' || current.kind === 'estimate';
  const currentUnitMc = priced ? unitCostMc(current.pack) : current.kind === 'free' ? 0 : null;
  const changeBps = currentUnitMc !== null && currentUnitMc > 0 ? priceChangeBps(currentUnitMc, billUnitMc) : null;
  const out = (why: PriceCheckWhy, adoptable: boolean, ask: boolean, adoptByDefault: boolean): PriceCheck => ({
    newPack,
    billUnitMc,
    currentUnitMc,
    changeBps,
    adoptable,
    ask,
    adoptByDefault: adoptable && adoptByDefault,
    why,
  });

  if (current.madeHere) return out('made_here', false, false, false);
  if (billCents === 0) return out('zero_bill', false, false, false);
  if (current.kind === 'unset' || (priced && currentUnitMc === 0)) return out('no_price', true, false, true);
  // D1: outside the band, yes for a purchase order delivered, no for a quick purchase.
  const byKind = kind === 'order';
  if (current.kind === 'free') return out('was_free', true, true, byKind);
  // The same price, kept the same way: nothing to change.
  if (current.kind === 'set' && valueCents(usualSize, current.pack) === newPack.priceCents) return out('same', true, false, true);
  const outside = changeBps === null || Math.abs(changeBps) > threshold;
  if (current.kind === 'estimate') return out('guess', true, outside, outside ? byKind : true);
  if (!outside) return out('within', true, false, true);
  return out(changeBps! > 0 ? 'higher' : 'lower', true, true, byKind);
}

/** Whether a line's bill becomes the ingredient's price: the answer given on screen, else the guard's default. Never when it can't be. */
export function usesBillPrice(check: Pick<PriceCheck, 'adoptable' | 'adoptByDefault'>, answer?: boolean): boolean {
  if (!check.adoptable) return false;
  return answer ?? check.adoptByDefault;
}
