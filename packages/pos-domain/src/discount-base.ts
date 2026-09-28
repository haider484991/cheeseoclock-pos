/**
 * What an order-level discount is worked on, and how it is split over the
 * lines (owner, 28 Sep 2026: "Delivery charges is separate we don't want to
 * add discount to it"). THE maths for every place a discount meets the order's
 * lines, so the F3 screen, the main process and the readers after the fact
 * can't disagree:
 *
 *  - the base: the food only, or every line (`alsoOffDeliveryCharge`), for
 *    the amount (a % of it; a rupee amount capped at it: pos-domain
 *    computeDiscountCents), the foodpanda deal (dealAmount) and the approval
 *    limit (requiresManagerApproval);
 *  - the split: allocateDiscount over the lines by weight, a delivery-charge
 *    line weighing 0 when the discount leaves it alone. A 0-weight line always
 *    gets 0 (its share floors to 0 and it never takes a leftover paisa), and
 *    the discount never exceeds the base, so the shares still add up to the
 *    discount exactly;
 *  - the tax: per line, on what is left of it (tax-exclusive).
 *
 * Which line is a delivery charge is shared-types isDeliveryChargeLine (the
 * name it was sold under), the one test. Since Settings step 3 a caller
 * holding the areas' fee items (deliveryZoneFeeItemIds) may pass them as
 * `feeItemIds`: a line of one of those items counts too. The readers after
 * the fact pass none: a fee item's line is always sold under its
 * "Delivery Charge (Rs N)" name (addOrderItem snapshots it), so both agree
 * on every order. Whether a discount leaves it alone
 * is the RULE FROZEN ON ITS ROW (discountRuleAlsoOffDeliveryCharge), never
 * the live setting: a row with no rule (given before 0.7.26, or on an older
 * till) is read exactly as it was worked then, over every line.
 */
import { isDeliveryChargeLine, type DiscountBaseRule } from '@cheeseoclock/shared-types';
import { allocateDiscount, weightsThatCarry } from './discount.js';
import { parseFoodpandaDealRule } from './foodpanda.js';
import { computeTax } from './tax.js';

/** An order line as a discount sees it: what it came to, and the name it was sold under. */
export interface DiscountLine {
  lineTotalCents: number;
  /** order_items.menu_item_name; absent = not a delivery charge. */
  menuItemName?: string | null;
  /** order_items.menu_item_id: a delivery charge too when it is one of `feeItemIds`. */
  menuItemId?: string | null;
}

/** A line with the tax rate snapshotted on it (basis points). */
export interface TaxedDiscountLine extends DiscountLine {
  taxRateBps?: number;
}

/** Does this line take a share of the discount? Every line does, except a delivery charge when the discount leaves it alone. */
export function lineTakesDiscount(
  line: Pick<DiscountLine, 'menuItemName' | 'menuItemId'>,
  alsoOffDeliveryCharge: boolean,
  feeItemIds?: ReadonlySet<string> | null,
): boolean {
  return alsoOffDeliveryCharge || !isDeliveryChargeLine(line, feeItemIds);
}

/** Each line's weight in the split: its total, or 0 for a line the discount leaves alone. */
export function discountWeights(
  lines: ReadonlyArray<DiscountLine>,
  alsoOffDeliveryCharge: boolean,
  feeItemIds?: ReadonlySet<string> | null,
): number[] {
  return lines.map((l) => (lineTakesDiscount(l, alsoOffDeliveryCharge, feeItemIds) ? l.lineTotalCents : 0));
}

/**
 * What the discount is worked on (paisa, before tax): the food only, or —
 * `alsoOffDeliveryCharge` — every line (the whole subtotal, as before).
 */
export function discountBaseCents(
  lines: ReadonlyArray<DiscountLine>,
  alsoOffDeliveryCharge: boolean,
  feeItemIds?: ReadonlySet<string> | null,
): number {
  return discountWeights(lines, alsoOffDeliveryCharge, feeItemIds).reduce((s, w) => s + Math.max(0, w), 0);
}

/**
 * The discount split over the lines in whole paisa that add up to it
 * (allocateDiscount on the weights). A discount more than the lines it may
 * come off — only a till older than this rule stores one — is split over
 * every line, as that till split it (discount.ts weightsThatCarry).
 */
export function splitDiscount(
  lines: ReadonlyArray<DiscountLine>,
  discountCents: number,
  alsoOffDeliveryCharge: boolean,
  feeItemIds?: ReadonlySet<string> | null,
): number[] {
  const totals = lines.map((l) => l.lineTotalCents);
  return allocateDiscount(
    weightsThatCarry(totals, discountWeights(lines, alsoOffDeliveryCharge, feeItemIds), discountCents),
    discountCents,
  );
}

/**
 * The same split for readers holding the lines as numbers (Reports):
 * `takesNone[i]` = line i takes no share. Absent = every line takes its
 * share (today's allocateDiscount exactly).
 */
export function splitDiscountByMask(
  lineTotalsCents: ReadonlyArray<number>,
  discountCents: number,
  takesNone?: ReadonlyArray<boolean>,
): number[] {
  return allocateDiscount(
    takesNone ? weightsThatCarry(lineTotalsCents, lineTotalsCents.map((t, i) => (takesNone[i] ? 0 : t)), discountCents) : lineTotalsCents,
    discountCents,
  );
}

/** Which lines take no share of a discount under its rule (for splitDiscountByMask and the Reports lines). */
export function discountSkipMask(lines: ReadonlyArray<Pick<DiscountLine, 'menuItemName'>>, alsoOffDeliveryCharge: boolean): boolean[] {
  return lines.map((l) => !lineTakesDiscount(l, alsoOffDeliveryCharge));
}

export interface TaxAfterDiscount {
  /** Each line's share of the discount. */
  shares: number[];
  /** Σ per-line tax on (line total − its share), tax-exclusive. */
  taxCents: number;
}

/**
 * The tax of an order with its discount: split over the lines (above), then
 * each line taxed on what is left of it at its own rate — what
 * recomputeOrderTotals stores and the F3 screen previews. The lines in the
 * till's order ((created_at, id)).
 */
export function taxAfterDiscount(
  lines: ReadonlyArray<TaxedDiscountLine>,
  discountCents: number,
  alsoOffDeliveryCharge: boolean,
): TaxAfterDiscount {
  const shares = splitDiscount(lines, discountCents, alsoOffDeliveryCharge);
  let taxCents = 0;
  lines.forEach((line, i) => {
    const net = Math.max(0, line.lineTotalCents - (shares[i] ?? 0));
    taxCents += computeTax(net, line.taxRateBps ?? 0, 'exclusive').taxCents as number;
  });
  return { shares, taxCents };
}

// ------------------------------------------------------------ the rule --

/** The rule frozen on a discount a till gives now, from 'discounts.delivery'. */
export function tillDiscountRule(alsoOffDeliveryCharge: boolean): DiscountBaseRule {
  return { kind: 'discount_base', v: 1, alsoOffDeliveryCharge, from: 'till' };
}

/**
 * The website's rule, frozen on a web order's discount (the pick-up %): the
 * website prices it over every line it sent (apps/web lib/pricing
 * priceOrder), so the till takes off exactly what the customer was shown,
 * whatever the till's switch says. (The website only discounts a pick-up,
 * which never carries a delivery charge, so the owner's rule holds there.)
 */
export function websiteDiscountRule(): DiscountBaseRule {
  return { kind: 'discount_base', v: 1, alsoOffDeliveryCharge: true, from: 'website' };
}

/** A staff or website discount row's rule_json back as a rule; null when there is none this version reads. */
export function parseDiscountBaseRule(json: string | null | undefined): DiscountBaseRule | null {
  if (!json) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r['kind'] !== 'discount_base' || r['v'] !== 1 || typeof r['alsoOffDeliveryCharge'] !== 'boolean') return null;
  return {
    kind: 'discount_base',
    v: 1,
    alsoOffDeliveryCharge: r['alsoOffDeliveryCharge'],
    from: r['from'] === 'website' ? 'website' : 'till',
  };
}

/**
 * Did the discount on a row also come off the delivery charge? From the rule
 * FROZEN on that row (rule_json) alone — a staff or website rule, or the
 * foodpanda deal's — never from the live setting. A row with no rule, or one
 * this version can't read, is true: that is how every discount before 0.7.26
 * was worked, so its history reads back unchanged.
 */
export function discountRuleAlsoOffDeliveryCharge(ruleJson: string | null | undefined): boolean {
  const base = parseDiscountBaseRule(ruleJson);
  if (base) return base.alsoOffDeliveryCharge;
  const deal = parseFoodpandaDealRule(ruleJson);
  if (deal) return deal.alsoOffDeliveryCharge !== false;
  return true;
}

/**
 * Did the discount on an order's STORED bill also come off its delivery
 * charge? The rule frozen on its row (`frozen`: discountRuleAlsoOffDeliveryCharge),
 * unless the stored figures can only have been worked over every line. Only
 * a till older than this rule (0.7.25 or before) stores such a bill: while
 * the two tills are not yet on the same version, it re-works an open order's
 * food-only discount over every line on a cart change and leaves the row's
 * rule as it found it. That shows as:
 *  - a discount more than the food (one worked on the food never is), or
 *  - a stored tax that splitting it over every line gives, and the food-only
 *    split does not (`taxCents`; absent = the first check only).
 * The readers after the fact (the snapshot: the FBR sale invoice and debit
 * note, the bill's words; Reports' food cost and profit) then split it over
 * every line, as that till did, so they add up to the stored bill. Stored
 * totals are never recomputed here. `lines` in the till's order, with their
 * tax rates for the second check.
 */
export function storedDiscountAlsoOffDeliveryCharge(
  frozen: boolean,
  lines: ReadonlyArray<TaxedDiscountLine>,
  discountCents: number,
  taxCents?: number,
): boolean {
  if (frozen || !(discountCents > 0)) return frozen;
  // No delivery charge to tell apart: both splits are the same.
  if (!lines.some((l) => isDeliveryChargeLine(l) && l.lineTotalCents > 0)) return frozen;
  if (discountCents > discountBaseCents(lines, false)) return true;
  if (taxCents === undefined) return false;
  if (taxAfterDiscount(lines, discountCents, false).taxCents === taxCents) return false;
  return taxAfterDiscount(lines, discountCents, true).taxCents === taxCents;
}

/**
 * Reports' readers of an order's lines (food cost, profit): which lines took
 * none of its discount — the rule frozen on the discount row (`ruleJson`,
 * null = none), read against the stored bill (storedDiscountAlsoOffDeliveryCharge).
 * `lines` in the till's order, with the names they were sold under and their
 * tax rates.
 */
export function storedDiscountSkips(
  ruleJson: string | null | undefined,
  lines: ReadonlyArray<TaxedDiscountLine>,
  discountCents: number,
  taxCents: number,
): boolean[] {
  const alsoOff = storedDiscountAlsoOffDeliveryCharge(discountRuleAlsoOffDeliveryCharge(ruleJson), lines, discountCents, taxCents);
  return discountSkipMask(lines, alsoOff);
}
