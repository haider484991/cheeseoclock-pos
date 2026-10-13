/**
 * A website order's discount parts as the till bills them (v0.7.50, WEBSITE
 * DISCOUNT BY CATEGORY; shared-types website-category-discount.ts): one of
 * the owner's offers' rows per part, so the offers engine — assignOfferLines
 * over each part's own lines, the tax per line on what is left of it — works
 * them exactly as the website did. The category parts carry their category;
 * the main part is the whole-menu offer over the food they left. Never the
 * delivery charge, never a value deal. Pure.
 */
import { discountPartOfferId, type OfferRule, type WebDiscountPart } from '@cheeseoclock/shared-types';

/** An offer's name prints on one line of the bill: at most this many letters. */
export const WEBSITE_PART_NAME_MAX = 30;

/**
 * The name a part prints under: "Website pick-up 10% off" (the main %, as a
 * website discount always printed), "Website 20% off Pizza" (a category's).
 */
export function websitePartName(part: WebDiscountPart, pickup: boolean, categoryName: string | null): string {
  if (part.categoryId === null) return `Website ${pickup ? 'pick-up' : 'delivery'} ${part.percent}% off`;
  const name = `Website ${part.percent}% off ${categoryName?.trim() || 'a category'}`;
  return name.length <= WEBSITE_PART_NAME_MAX ? name : `${name.slice(0, WEBSITE_PART_NAME_MAX - 1).trimEnd()}…`;
}

/** The offer row a part is billed as (its amount and lines are the offers engine's). */
export function websitePartRule(part: WebDiscountPart, opts: { pickup: boolean; categoryName: string | null }): OfferRule {
  return {
    kind: 'discount_base',
    v: 1,
    // The food only: the website never takes its % off the delivery charge.
    alsoOffDeliveryCharge: false,
    from: 'till',
    // Never a value deal.
    skipsNoDiscountLines: true,
    offer: {
      v: 1,
      id: discountPartOfferId(part.categoryId),
      name: websitePartName(part, opts.pickup, opts.categoryName),
      type: 'percent',
      value: part.percent,
      minOrderCents: null,
      maxOffCents: null,
      cameBy: 'any',
      orderTypes: [opts.pickup ? 'takeaway' : 'delivery'],
      oncePerCustomerPerDay: false,
      settingsAt: null,
      ...(part.categoryId !== null ? { categoryIds: [part.categoryId] } : {}),
    },
  };
}
