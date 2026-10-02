/**
 * What an order-level discount is worked on, and how it is split over the
 * lines (owner, 28 Sep 2026: "Delivery charges is separate we don't want to
 * add discount to it"; 2 Oct 2026: value deals never get any discount). THE
 * maths for every place a discount meets the order's lines, so the F3 screen,
 * the main process and the readers after the fact can't disagree:
 *
 *  - the base: the lines its `scope` lets it come off — the food only, or
 *    every line (`alsoOffDeliveryCharge`), and never a value-deal line when
 *    the frozen rule says so (`skipsNoDiscountLines`) — for the amount (a %
 *    of it; a rupee amount capped at it: pos-domain computeDiscountCents),
 *    the foodpanda deal (dealAmount) and the approval limit
 *    (requiresManagerApproval);
 *  - the split: allocateDiscount over the lines by weight, a line the
 *    discount leaves alone (a delivery charge, and a value-deal line when the
 *    frozen rule says so) weighing 0. A 0-weight line always gets 0 (its
 *    share floors to 0 and it never takes a leftover paisa), and the discount
 *    never exceeds the base, so the shares still add up to the discount
 *    exactly;
 *  - the tax: per line, on what is left of it (tax-exclusive).
 *
 * Which line is a delivery charge is shared-types isDeliveryChargeLine (the
 * name it was sold under), the one test. Since Settings step 3 a caller
 * holding the areas' fee items (deliveryZoneFeeItemIds) may pass them as
 * `feeItemIds`: a line of one of those items counts too. The readers after
 * the fact pass none: a fee item's line is always sold under its
 * "Delivery Charge (Rs N)" name (addOrderItem snapshots it), so both agree
 * on every order. Which line is a value deal is its own snapshot
 * (order_items.no_discount: `noDiscount`), never its category's name now.
 * Whether a discount leaves either alone is the RULE FROZEN ON ITS ROW
 * (discountRuleScope), never the live setting: a row with no rule (given
 * before 0.7.26, or on an older till) is read exactly as it was worked then,
 * over every line.
 */
import { isDeliveryChargeLine, type DiscountBaseRule } from '@cheeseoclock/shared-types';
import { allocateDiscount, computeDiscountCents, weightsThatCarry, type ApprovalRuleBasis } from './discount.js';
import { dealAmount, parseFoodpandaDealRule } from './foodpanda.js';
import { offerAmount, parseOfferRule } from './offers.js';
import { computeTax } from './tax.js';

/** An order line as a discount sees it: what it came to, the name it was sold under, and its never-discounted mark. */
export interface DiscountLine {
  lineTotalCents: number;
  /** order_items.menu_item_name; absent = not a delivery charge. */
  menuItemName?: string | null;
  /** order_items.menu_item_id: a delivery charge too when it is one of `feeItemIds`. */
  menuItemId?: string | null;
  /** order_items.no_discount (a value deal), frozen when the line was added; absent = false. */
  noDiscount?: boolean;
}

/** A line with the tax rate snapshotted on it (basis points). */
export interface TaxedDiscountLine extends DiscountLine {
  taxRateBps?: number;
}

/**
 * Which lines a discount may come off, as its rule froze it:
 *  - `alsoOffDeliveryCharge` false = a delivery-charge line takes none of it;
 *  - `skipsNoDiscountLines` true = a value-deal line (`noDiscount`) takes
 *    none of it.
 * Every caller says both, so none can go on discounting value deals by
 * leaving one out.
 */
export type DiscountScope = { alsoOffDeliveryCharge: boolean; skipsNoDiscountLines: boolean };

/** Every line, as every discount before 0.7.26 (and a row with no rule) was worked. A new object each time. */
const everyLine = (): DiscountScope => ({ alsoOffDeliveryCharge: true, skipsNoDiscountLines: false });

/**
 * Does this line take a share of the discount? Every line does, except a
 * value deal when the scope skips them and a delivery charge when the scope
 * leaves it alone.
 */
export function lineTakesDiscount(
  line: Pick<DiscountLine, 'menuItemName' | 'menuItemId' | 'noDiscount'>,
  scope: DiscountScope,
  feeItemIds?: ReadonlySet<string> | null,
): boolean {
  if (scope.skipsNoDiscountLines && line.noDiscount === true) return false;
  return scope.alsoOffDeliveryCharge || !isDeliveryChargeLine(line, feeItemIds);
}

/** Each line's weight in the split: its total, or 0 for a line the discount leaves alone. */
export function discountWeights(
  lines: ReadonlyArray<DiscountLine>,
  scope: DiscountScope,
  feeItemIds?: ReadonlySet<string> | null,
): number[] {
  return lines.map((l) => (lineTakesDiscount(l, scope, feeItemIds) ? l.lineTotalCents : 0));
}

/**
 * What the discount is worked on (paisa, before tax): the lines its scope
 * lets it come off — the food only, or every line (the whole subtotal, as
 * before), value deals left out when it skips them.
 */
export function discountBaseCents(
  lines: ReadonlyArray<DiscountLine>,
  scope: DiscountScope,
  feeItemIds?: ReadonlySet<string> | null,
): number {
  return discountWeights(lines, scope, feeItemIds).reduce((s, w) => s + Math.max(0, w), 0);
}

/**
 * What the approval limit's words (approvalRuleText) say it is checked on,
 * for a discount worked on `scope` over these lines — the same base as
 * discountBaseCents, so the F3 screen's limit line and the main process's
 * refusal name what the lock measured:
 *  - 'food_no_deals': value deals on the order are left out (and a delivery
 *    charge too, or there is none);
 *  - 'food_and_charge_no_deals': value deals are left out, and a delivery
 *    charge on the order is counted in (the owner's switch on);
 *  - 'food': only a delivery charge is left out;
 *  - 'order': every line.
 * A line worth Rs 0 changes nothing, so it is not counted.
 */
export function approvalRuleBasis(
  lines: ReadonlyArray<DiscountLine>,
  scope: DiscountScope,
  feeItemIds?: ReadonlySet<string> | null,
): ApprovalRuleBasis {
  const skipped = (l: DiscountLine) => scope.skipsNoDiscountLines && l.noDiscount === true;
  const leavesDeals = lines.some((l) => skipped(l) && l.lineTotalCents > 0);
  const charge = lines.some((l) => !skipped(l) && l.lineTotalCents > 0 && isDeliveryChargeLine(l, feeItemIds));
  if (leavesDeals) return scope.alsoOffDeliveryCharge && charge ? 'food_and_charge_no_deals' : 'food_no_deals';
  return !scope.alsoOffDeliveryCharge && charge ? 'food' : 'order';
}

/**
 * The discount split over the lines in whole paisa that add up to it
 * (allocateDiscount on the weights). A discount more than the lines it may
 * come off — only a till older than its rule stores one — is split over
 * every line, as that till split it (discount.ts weightsThatCarry).
 */
export function splitDiscount(
  lines: ReadonlyArray<DiscountLine>,
  discountCents: number,
  scope: DiscountScope,
  feeItemIds?: ReadonlySet<string> | null,
): number[] {
  const totals = lines.map((l) => l.lineTotalCents);
  return allocateDiscount(
    weightsThatCarry(totals, discountWeights(lines, scope, feeItemIds), discountCents),
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

/** Which lines take no share of a discount under its scope (for splitDiscountByMask and the Reports lines). */
export function discountSkipMask(lines: ReadonlyArray<Pick<DiscountLine, 'menuItemName' | 'noDiscount'>>, scope: DiscountScope): boolean[] {
  return lines.map((l) => !lineTakesDiscount(l, scope));
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
  scope: DiscountScope,
): TaxAfterDiscount {
  const shares = splitDiscount(lines, discountCents, scope);
  let taxCents = 0;
  lines.forEach((line, i) => {
    const net = Math.max(0, line.lineTotalCents - (shares[i] ?? 0));
    taxCents += computeTax(net, line.taxRateBps ?? 0, 'exclusive').taxCents as number;
  });
  return { shares, taxCents };
}

// ------------------------------------------------------------ the rule --

/** Only a true is written: a rule that does not skip keeps the JSON it had before 0.7.34. */
const skipsField = (skips: boolean): { skipsNoDiscountLines?: true } => (skips ? { skipsNoDiscountLines: true } : {});

/**
 * The rule frozen on a discount a till gives now: 'discounts.delivery' for
 * the delivery charge; `skipsNoDiscountLines` whether value deals are left
 * out (every till discount, but not one on a foodpanda order, which must
 * match the tablet).
 */
export function tillDiscountRule(alsoOffDeliveryCharge: boolean, skipsNoDiscountLines: boolean): DiscountBaseRule {
  return { kind: 'discount_base', v: 1, alsoOffDeliveryCharge, from: 'till', ...skipsField(skipsNoDiscountLines) };
}

/**
 * The rule frozen on a Free order (v0.7.36): every line, the value deals and
 * the delivery charge included, marked `freeOrder` so the screens and papers
 * can say so. Given at 100% with a manager's PIN and a reason only. An older
 * till reads it as "every line, delivery charge included" — the same bill.
 */
export function freeOrderRule(): DiscountBaseRule {
  return { ...tillDiscountRule(true, false), freeOrder: true };
}

/** Is the rule frozen on a discount row a Free order's (freeOrderRule)? */
export function isFreeOrderRule(ruleJson: string | null | undefined): boolean {
  return parseDiscountBaseRule(ruleJson)?.freeOrder === true;
}

/**
 * The website's rule, frozen on a web order's discount (the pick-up %): the
 * website prices it over the lines it sent (apps/web lib/pricing
 * priceOrder), so the till takes off exactly what the customer was shown,
 * whatever the till's switch says. `skipsNoDiscountLines`: the order carries
 * the website's never-discounted flags, so it left those lines out; an
 * older website sends none and priced every line. (The website only
 * discounts a pick-up, which never carries a delivery charge, so the owner's
 * rule holds there.)
 */
export function websiteDiscountRule(skipsNoDiscountLines: boolean): DiscountBaseRule {
  return { kind: 'discount_base', v: 1, alsoOffDeliveryCharge: true, from: 'website', ...skipsField(skipsNoDiscountLines) };
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
    // Kept only when it is exactly true: anything else is a rule from before 0.7.34.
    ...skipsField(r['skipsNoDiscountLines'] === true),
    // A Free order's mark (v0.7.36), kept only when exactly true; a till's own rule only.
    ...(r['freeOrder'] === true && r['from'] !== 'website' ? { freeOrder: true as const } : {}),
  };
}

/**
 * Which lines the discount on a row came off: from the rule FROZEN on that
 * row (rule_json) alone, never from the live setting.
 *  - A staff, website or offer rule: its delivery-charge answer, and whether
 *    it skipped value deals (absent = no, as before 0.7.34).
 *  - The foodpanda deal's rule: its delivery-charge answer (absent = yes, as
 *    before 0.7.26); it never skips value deals (it must match the tablet).
 *  - No rule, or one this version can't read: every line — that is how every
 *    discount before 0.7.26 was worked, so its history reads back unchanged.
 */
export function discountRuleScope(ruleJson: string | null | undefined): DiscountScope {
  const base = parseDiscountBaseRule(ruleJson);
  if (base) return { alsoOffDeliveryCharge: base.alsoOffDeliveryCharge, skipsNoDiscountLines: base.skipsNoDiscountLines === true };
  const deal = parseFoodpandaDealRule(ruleJson);
  if (deal) return { alsoOffDeliveryCharge: deal.alsoOffDeliveryCharge !== false, skipsNoDiscountLines: false };
  return everyLine();
}

/** Did the discount on a row also come off the delivery charge? discountRuleScope's first answer. */
export function discountRuleAlsoOffDeliveryCharge(ruleJson: string | null | undefined): boolean {
  return discountRuleScope(ruleJson).alsoOffDeliveryCharge;
}

/**
 * A discount row's own terms, as stored (order_discounts): what a till works
 * its rupees out of again at every cart change (recomputeOrderTotals). The
 * readers after the fact pass them so the stored bill can be read by its
 * AMOUNT (storedDiscountScope), not only by its tax: the shop has one tax
 * rate, so the tax alone can't tell the splits apart.
 */
export interface StoredDiscountTerms {
  /** order_discounts.discount_type: a % of the base, or rupees (capped at the base). */
  discountType: 'percent' | 'flat';
  /** order_discounts.value: the % (0-100), or the rupees in paisa. */
  value: number;
  /** order_discounts.source: 'foodpanda' (the deal), 'offer' (an automatic offer), else null (staff or website). */
  source: string | null;
  /** order_discounts.rule_json: the foodpanda deal's or the offer's frozen terms (their rupees come from these). */
  ruleJson: string | null;
}

/**
 * The rupees a till works out of a discount row's terms over these lines
 * when the discount comes off the lines of `scope` — recomputeOrderTotals'
 * maths, one scope at a time:
 *  - the foodpanda deal: its frozen terms on the base (dealAmount, the
 *    shop's part);
 *  - an automatic offer: its frozen terms on the base, its minimum measured
 *    on the food (without the value deals when the scope skips them); one
 *    the cashier took off is Rs 0;
 *  - a staff or website discount, or a rule this version can't read: its %
 *    of the base, or its rupees capped at the base (computeDiscountCents).
 */
export function reworkedDiscountCents(
  terms: StoredDiscountTerms,
  lines: ReadonlyArray<DiscountLine>,
  scope: DiscountScope,
): number {
  const base = discountBaseCents(lines, scope);
  if (terms.source === 'foodpanda') {
    const deal = parseFoodpandaDealRule(terms.ruleJson);
    if (deal) return dealAmount(deal, base).shopCents;
  } else if (terms.source === 'offer') {
    const offer = parseOfferRule(terms.ruleJson);
    if (offer) {
      if (offer.offer.declined) return 0;
      return offerAmount(offer.offer, base, discountBaseCents(lines, { alsoOffDeliveryCharge: false, skipsNoDiscountLines: scope.skipsNoDiscountLines }));
    }
  }
  return computeDiscountCents(base, { type: terms.discountType, value: terms.value }) as number;
}

/**
 * Which lines the discount on an order's STORED bill came off: the scope
 * frozen on its row (`frozen`: discountRuleScope), unless the stored figures
 * can only have been worked over more lines. Only a till older than the rule
 * stores such a bill: while the two tills are not yet on the same version,
 * it re-works an open order's discount on a cart change by the rule it
 * knows — over every line (0.7.25 or before), or over the value deals too
 * (0.7.33 or before) — and leaves the row's rule as it found it. That shows
 * as:
 *  - a discount more than the lines the frozen scope lets it come off (one
 *    worked on them never is);
 *  - a stored discount that the row's own terms (`terms`: its type and
 *    value, the deal's or the offer's frozen terms) give over wider lines,
 *    and not over the frozen ones (reworkedDiscountCents). It tells a 10%
 *    re-worked over the deals (Rs 510) from one worked without them
 *    (Rs 150) whatever the tax rates — the shop has one rate, 15%, so the
 *    tax check below alone can't;
 *  - a stored tax that a wider split gives, and the frozen one does not
 *    (`taxCents`; absent = not checked). It decides between scopes the
 *    amount can't tell apart (a rupee amount is the same over any lines that
 *    carry it), and is the only check when no `terms` are passed.
 * The scopes are tried narrowest first — as frozen; the value deals in too;
 * the delivery charge in too; every line — and two that split these lines
 * alike count once (the first): an order with no delivery charge, or no
 * value deal, can't tell them apart, so the frozen answer stands. Of those
 * that carry the discount: the first whose re-worked amount is the stored
 * one and that gives the stored tax wins, else the first whose re-worked
 * amount is the stored one; when none is (an older till's maths this
 * version doesn't know), the first that gives the stored tax; else the first
 * that carries it; else every line (weightsThatCarry splits it so anyway).
 * The readers after the fact (the snapshot: the FBR sale invoice and debit
 * note, the bill's words; Reports' food cost and profit) then split it as
 * that till did, so they add up to the stored bill. Stored totals are never
 * recomputed here. `lines` in the till's order, with their tax rates for the
 * tax check.
 */
export function storedDiscountScope(
  frozen: DiscountScope,
  lines: ReadonlyArray<TaxedDiscountLine>,
  discountCents: number,
  taxCents?: number,
  terms?: StoredDiscountTerms | null,
): DiscountScope {
  if (!(discountCents > 0)) return frozen;
  const candidates: DiscountScope[] = [];
  const splits = new Set<string>();
  for (const scope of [
    frozen,
    { alsoOffDeliveryCharge: frozen.alsoOffDeliveryCharge, skipsNoDiscountLines: false },
    { alsoOffDeliveryCharge: true, skipsNoDiscountLines: frozen.skipsNoDiscountLines },
    everyLine(),
  ]) {
    // allocateDiscount and the base count a line below 0 as 0: alike when these are.
    const split = discountWeights(lines, scope)
      .map((w) => Math.max(0, w))
      .join(',');
    if (splits.has(split)) continue;
    splits.add(split);
    candidates.push(scope);
  }
  const carrying = candidates.filter((scope) => discountCents <= discountBaseCents(lines, scope));
  const givesTax = (scope: DiscountScope): boolean =>
    taxCents === undefined || taxAfterDiscount(lines, discountCents, scope).taxCents === taxCents;
  if (terms) {
    const reworked = carrying.filter((scope) => reworkedDiscountCents(terms, lines, scope) === discountCents);
    const byAmount = reworked.find(givesTax) ?? reworked[0];
    if (byAmount) return byAmount;
  }
  return carrying.find(givesTax) ?? carrying[0] ?? candidates[candidates.length - 1] ?? everyLine();
}

/**
 * Did the discount on an order's STORED bill also come off its delivery
 * charge? storedDiscountScope's answer for a rule that does not skip value
 * deals (the delivery-charge readers since 0.7.26: the foodpanda deal's
 * base, Reports' foodpanda money). Without `terms`, the same answer, case
 * for case, as before 0.7.34; with the row's terms the stored amount
 * decides first (storedDiscountScope), so one tax rate on the food and the
 * charge no longer hides an older till's re-work over every line.
 */
export function storedDiscountAlsoOffDeliveryCharge(
  frozen: boolean,
  lines: ReadonlyArray<TaxedDiscountLine>,
  discountCents: number,
  taxCents?: number,
  terms?: StoredDiscountTerms | null,
): boolean {
  return storedDiscountScope({ alsoOffDeliveryCharge: frozen, skipsNoDiscountLines: false }, lines, discountCents, taxCents, terms)
    .alsoOffDeliveryCharge;
}

/**
 * Reports' readers of an order's lines (food cost, profit): which lines took
 * none of its discount — the rule frozen on the discount row (`ruleJson`,
 * null = none), read against the stored bill (storedDiscountScope, by the
 * row's `terms` — its type, value and source — when the reader has them).
 * `lines` in the till's order, with the names they were sold under, their
 * never-discounted marks and their tax rates.
 */
export function storedDiscountSkips(
  ruleJson: string | null | undefined,
  lines: ReadonlyArray<TaxedDiscountLine>,
  discountCents: number,
  taxCents: number,
  terms?: Omit<StoredDiscountTerms, 'ruleJson'> | null,
): boolean[] {
  const rowTerms = terms ? { ...terms, ruleJson: ruleJson ?? null } : null;
  return discountSkipMask(lines, storedDiscountScope(discountRuleScope(ruleJson), lines, discountCents, taxCents, rowTerms));
}
