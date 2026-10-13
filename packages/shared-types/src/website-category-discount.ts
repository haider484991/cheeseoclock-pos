/**
 * WEBSITE DISCOUNT BY CATEGORY (v0.7.50; the owner, 13 Oct 2026: "20% off
 * regular pizzas everywhere", beside the 10% off website orders). The
 * website offer card ('discounts.websitePickup', Settings → Money &
 * discounts) can give some menu categories their own % instead of the main
 * one: Pizza 20%, the rest 10%. Wherever the website's % applies — a pick-up,
 * and a delivery when "Also on delivery orders" is ticked — and never on a
 * value deal or the delivery charge.
 *
 * THE MATHS, the same on the website (cart, server) and the till (the
 * offers engine: pos-domain assignOfferLines, recomputeSeveralOffers):
 *  - each category with its own % is a PART over its category's lines (not
 *    a value deal, not the delivery charge): the % is rounded once on their
 *    sum (computeDiscountCents) and split over them by weight;
 *  - a part that takes nothing off (none of its lines in the order) leaves
 *    nothing taken;
 *  - the main % is the last part, over the food the category parts left;
 *  - each line is taxed on what is left of it.
 * An order with no line in such a category is priced exactly as before (one
 * %, one discount row on the till).
 *
 * Pure, so both sides run the same code and the tests run it beside the
 * till's own engine.
 */

/** A menu category with its own % off website orders. */
export interface WebsiteCategoryPercent {
  /** The till's category id (the published menu's posCategoryId). */
  categoryId: string;
  /** A whole %, 1–50, on this category's items instead of the main %. */
  percent: number;
}

/** At most this many categories with a % of their own. */
export const WEBSITE_CATEGORY_PERCENTS_MAX = 10;

/**
 * One part of a website order's discount as the order carries it to the
 * till (WebOrder.discountParts): its % and the category it is for (null =
 * the main %, over the food the categories left).
 */
export interface WebDiscountPart {
  percent: number;
  categoryId: string | null;
}

/** A priced line as the parts see it. */
export interface DiscountPartLine {
  lineTotalCents: number;
  /** A value deal, or the delivery charge: no part comes off it. */
  noDiscount?: boolean;
  /** Its menu item's category (posCategoryId); absent = none. */
  categoryId?: string | null;
}

/** One part worked out on an order. */
export interface DiscountPartPlan extends WebDiscountPart {
  /** The lines it comes off (their indexes); none when it takes nothing off. */
  lineIndexes: number[];
  /** What it is worked on (the sum of its lines). */
  baseCents: number;
  /** What it takes off (paisa). */
  amountCents: number;
}

/** The till's computeDiscountCents, percent form: rounded once, never more than the base. */
export function partAmountCents(baseCents: number, percent: number): number {
  if (!(baseCents > 0)) return 0;
  const pct = Math.max(0, Math.min(100, percent));
  return Math.min(Math.round((baseCents * pct) / 100), baseCents);
}

/** The offer id the till gives a part's row (the order of two parts on one category follows it). */
export function discountPartOfferId(categoryId: string | null): string {
  return categoryId === null ? 'website' : `website-category-${categoryId}`;
}

/**
 * The categories that count: each once (the first), with a whole % from 1
 * to 50; anything else is left out (a value saved wrong never prices).
 */
export function cleanCategoryPercents(list: ReadonlyArray<WebsiteCategoryPercent> | null | undefined): WebsiteCategoryPercent[] {
  const out: WebsiteCategoryPercent[] = [];
  const seen = new Set<string>();
  for (const c of list ?? []) {
    if (!c || typeof c.categoryId !== 'string' || c.categoryId === '' || seen.has(c.categoryId)) continue;
    if (!Number.isInteger(c.percent) || c.percent < 1 || c.percent > 50) continue;
    seen.add(c.categoryId);
    out.push({ categoryId: c.categoryId, percent: c.percent });
    if (out.length >= WEBSITE_CATEGORY_PERCENTS_MAX) break;
  }
  return out;
}

/**
 * The parts of an order's website discount, as the till's offers engine
 * works them (pos-domain assignOfferLines): the category parts first — the
 * one that takes more off first, then its id — each over its category's
 * lines not yet taken; then the main % over the food left. A line taken by
 * a part that took something off is no other part's.
 */
export function websiteDiscountParts(
  lines: ReadonlyArray<DiscountPartLine>,
  mainPercent: number,
  categoryPercents: ReadonlyArray<WebsiteCategoryPercent>,
): DiscountPartPlan[] {
  const taken = new Set<number>();
  const fits = (l: DiscountPartLine) => l.noDiscount !== true;
  const linesOf = (categoryId: string | null) =>
    lines
      .map((l, i) => ({ l, i }))
      .filter(({ l, i }) => !taken.has(i) && fits(l) && (categoryId === null || (l.categoryId ?? null) === categoryId))
      .map(({ i }) => i);
  const sumOf = (idx: readonly number[]) => idx.reduce((s, i) => s + Math.max(0, lines[i]!.lineTotalCents), 0);
  const cats = cleanCategoryPercents(categoryPercents)
    .map((c) => ({ c, rank: partAmountCents(sumOf(linesOf(c.categoryId)), c.percent), id: discountPartOfferId(c.categoryId) }))
    .sort((a, b) => b.rank - a.rank || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const out: DiscountPartPlan[] = [];
  for (const { c } of cats) {
    const idx = linesOf(c.categoryId);
    const baseCents = sumOf(idx);
    const amountCents = partAmountCents(baseCents, c.percent);
    if (amountCents > 0) for (const i of idx) taken.add(i);
    out.push({ percent: c.percent, categoryId: c.categoryId, lineIndexes: amountCents > 0 ? idx : [], baseCents, amountCents });
  }
  const rest = linesOf(null);
  const baseCents = sumOf(rest);
  const amountCents = partAmountCents(baseCents, mainPercent);
  out.push({ percent: mainPercent, categoryId: null, lineIndexes: amountCents > 0 ? rest : [], baseCents, amountCents });
  return out;
}

/**
 * What a web order carries to the till: its parts that take something off,
 * but only when a category part does — otherwise null, and the order goes
 * as before (one %, read back by the till from its discount).
 */
export function discountPartsToSend(plans: ReadonlyArray<DiscountPartPlan>): WebDiscountPart[] | null {
  if (!plans.some((p) => p.categoryId !== null && p.amountCents > 0)) return null;
  return plans.filter((p) => p.amountCents > 0).map((p) => ({ percent: p.percent, categoryId: p.categoryId }));
}

/**
 * The parts a web order carries, read back by the till: each a whole % from
 * 1 to 50 with a category id or null, at most one main part and each
 * category once; null when there are none or any is not one (then the order
 * is read as before).
 */
export function readDiscountParts(raw: unknown): WebDiscountPart[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > WEBSITE_CATEGORY_PERCENTS_MAX + 1) return null;
  const out: WebDiscountPart[] = [];
  const seen = new Set<string>();
  for (const p of raw) {
    if (!p || typeof p !== 'object') return null;
    const { percent, categoryId } = p as { percent?: unknown; categoryId?: unknown };
    if (typeof percent !== 'number' || !Number.isInteger(percent) || percent < 1 || percent > 50) return null;
    if (categoryId !== null && (typeof categoryId !== 'string' || categoryId === '' || categoryId.length > 64)) return null;
    const key = categoryId ?? '';
    if (seen.has(key)) return null;
    seen.add(key);
    out.push({ percent, categoryId });
  }
  return out.some((p) => p.categoryId !== null) ? out : null;
}
