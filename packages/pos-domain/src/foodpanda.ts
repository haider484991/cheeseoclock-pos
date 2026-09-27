import type {
  FoodpandaCommissionBase,
  FoodpandaDeal,
  FoodpandaDealRule,
  FoodpandaFees,
} from '@cheeseoclock/shared-types';
import { FOODPANDA_DEAL_MAX_PERCENT, FOODPANDA_TABLET_TOLERANCE_CENTS } from '@cheeseoclock/shared-types';

/**
 * The foodpanda deal, fees and checks as pure rules (Settings → foodpanda,
 * shared-types shop-settings.ts). The values come in as parameters; nothing
 * here reads a setting or a constant of the shop's, so the tests pin the
 * maths and the defaults reproduce today's numbers (no deal, full price).
 *
 * The deal is applied when an order BECOMES foodpanda (order-repo createOrder
 * / setOrderMode): its terms are frozen onto the order's discount row
 * (foodpandaDealRule → order_discounts.rule_json), and every later cart
 * change re-works the rupees from that frozen rule (dealAmount), never from
 * the live setting.
 */

/** The trading day (YYYY-MM-DD) an instant belongs to: 05:00 PKT = 00:00 UTC, so its UTC date. */
export function tradingDayOfInstant(iso: string): string | null {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
}

/**
 * The deal an order started at `orderStartedAt` gets: the saved deal when it
 * takes something off (percent above 0) and that trading day is inside its
 * from / until dates; otherwise null (no deal — today's behaviour).
 */
export function activeFoodpandaDeal(deal: FoodpandaDeal, orderStartedAt: string): FoodpandaDeal | null {
  if (!(deal.percent > 0)) return null;
  const day = tradingDayOfInstant(orderStartedAt);
  if (day === null) return null;
  if (deal.startsOn && day < deal.startsOn) return null;
  if (deal.endsOn && day > deal.endsOn) return null;
  return deal;
}

/** "Foodpanda deal 20% off", with "(your part 10%)" when shared and "(foodpanda pays it)" when not the shop's. */
export function foodpandaDealLabel(dealPercent: number, shopPercent: number): string {
  const base = `Foodpanda deal ${dealPercent}% off`;
  if (shopPercent >= dealPercent) return base;
  if (shopPercent <= 0) return `${base} (foodpanda pays it)`;
  return `${base} (your part ${shopPercent}%)`;
}

/** The terms frozen onto an order's discount row when it becomes foodpanda. */
export function foodpandaDealRule(deal: FoodpandaDeal, settingsAt: string | null): FoodpandaDealRule {
  const shop = Math.min(deal.shopPercent, deal.percent);
  return {
    kind: 'foodpanda_deal',
    v: 1,
    label: foodpandaDealLabel(deal.percent, shop),
    dealPercent: deal.percent,
    shopPercent: shop,
    minOrderCents: deal.minOrderCents,
    maxOffCents: deal.maxOffCents,
    settingsAt,
  };
}

const isWholeIn = (n: unknown, lo: number, hi: number): n is number =>
  typeof n === 'number' && Number.isInteger(n) && n >= lo && n <= hi;
const isRupeesOrNull = (n: unknown): n is number | null => n === null || isWholeIn(n, 0, Number.MAX_SAFE_INTEGER);

/**
 * A discount row's rule_json back as a rule, or null when it is not a
 * foodpanda deal this version understands (the caller then falls back to the
 * row's own type and value, as an older till does).
 */
export function parseFoodpandaDealRule(json: string | null | undefined): FoodpandaDealRule | null {
  if (!json) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r['kind'] !== 'foodpanda_deal' || r['v'] !== 1) return null;
  const dealPercent = r['dealPercent'];
  const shopPercent = r['shopPercent'];
  const minOrderCents = r['minOrderCents'] ?? null;
  const maxOffCents = r['maxOffCents'] ?? null;
  if (!isWholeIn(dealPercent, 0, 100) || !isWholeIn(shopPercent, 0, dealPercent)) return null;
  if (!isRupeesOrNull(minOrderCents) || !isRupeesOrNull(maxOffCents)) return null;
  const settingsAt = typeof r['settingsAt'] === 'string' ? r['settingsAt'] : null;
  const label = typeof r['label'] === 'string' && r['label'].trim() ? r['label'] : foodpandaDealLabel(dealPercent, shopPercent);
  return { kind: 'foodpanda_deal', v: 1, label, dealPercent, shopPercent, minOrderCents, maxOffCents, settingsAt };
}

export interface DealAmount {
  /** The whole deal on this order: what the customer sees taken off. */
  dealCents: number;
  /** The shop's part: the order's discount. */
  shopCents: number;
  /** foodpanda's part, paid by foodpanda on top of the bill. */
  platformCents: number;
}

/**
 * The deal's rupees on an order of `subtotalCents` of food (till prices,
 * before tax), from the frozen rule:
 *  - below the minimum order the deal is Rs 0 (the row stays on the order
 *    and works again when items are added, so the result never depends on
 *    the order of edits);
 *  - the whole deal is the % of the food, capped at the most-off;
 *  - the shop's part is its share of that (shopPercent / dealPercent), to
 *    the paisa; foodpanda's part is the rest.
 */
export function dealAmount(
  rule: Pick<FoodpandaDealRule, 'dealPercent' | 'shopPercent' | 'minOrderCents' | 'maxOffCents'>,
  subtotalCents: number,
): DealAmount {
  const none = { dealCents: 0, shopCents: 0, platformCents: 0 };
  if (!(subtotalCents > 0) || !(rule.dealPercent > 0)) return none;
  if (rule.minOrderCents !== null && subtotalCents < rule.minOrderCents) return none;
  let dealCents = Math.round((subtotalCents * Math.min(rule.dealPercent, 100)) / 100);
  if (rule.maxOffCents !== null) dealCents = Math.min(dealCents, rule.maxOffCents);
  dealCents = Math.max(0, Math.min(dealCents, subtotalCents));
  const shopPercent = Math.max(0, Math.min(rule.shopPercent, rule.dealPercent));
  const shopCents = shopPercent === rule.dealPercent ? dealCents : Math.round((dealCents * shopPercent) / rule.dealPercent);
  return { dealCents, shopCents, platformCents: dealCents - shopCents };
}

/** foodpanda's money on one order, worked out from its fees. Never printed, never in the order's totals. */
export interface FoodpandaTerms {
  /** What the commission is worked out on (paisa). */
  commissionBaseCents: number;
  commissionCents: number;
  commissionTaxCents: number;
  fixedFeeCents: number;
  /** Commission + fee + tax on it. */
  foodpandaKeepsCents: number;
  /** What foodpanda should pay the shop for the order: the till's total (with tax), less what it keeps. */
  expectedPayoutCents: number;
  /** The food money the shop keeps, before tax and food cost: the order's value less what foodpanda keeps. */
  youKeepCents: number;
}

/**
 * foodpanda's commission, fee and tax on one order, from its STORED figures:
 * `subtotalCents` (till prices, before tax), `shopDiscountCents` (the
 * order's stored discount: the shop's part of the deal), `totalCents` (the
 * stored total, with tax). 'after_deal' charges the commission on the food
 * after the shop's part of the deal (the order value foodpanda's vendor side
 * shows), 'before_deal' on the food at till prices.
 */
export function foodpandaTerms(
  order: { subtotalCents: number; shopDiscountCents: number; totalCents: number },
  fees: Pick<FoodpandaFees, 'commissionBps' | 'base' | 'fixedFeeCents' | 'commissionTaxBps'>,
): FoodpandaTerms {
  const value = Math.max(0, order.subtotalCents - order.shopDiscountCents);
  const commissionBaseCents = commissionBase(fees.base, order.subtotalCents, value);
  const commissionCents = Math.round((commissionBaseCents * fees.commissionBps) / 10_000);
  const commissionTaxCents = Math.round((commissionCents * fees.commissionTaxBps) / 10_000);
  const fixedFeeCents = fees.fixedFeeCents;
  const foodpandaKeepsCents = commissionCents + commissionTaxCents + fixedFeeCents;
  return {
    commissionBaseCents,
    commissionCents,
    commissionTaxCents,
    fixedFeeCents,
    foodpandaKeepsCents,
    expectedPayoutCents: order.totalCents - foodpandaKeepsCents,
    youKeepCents: value - foodpandaKeepsCents,
  };
}

function commissionBase(base: FoodpandaCommissionBase, subtotalCents: number, valueCents: number): number {
  return base === 'before_deal' ? Math.max(0, subtotalCents) : valueCents;
}

/** The tablet total less the till's total (positive: the tablet says more). */
export function tabletDifferenceCents(tillTotalCents: number, tabletTotalCents: number): number {
  return tabletTotalCents - tillTotalCents;
}

/** More than Rs 1 apart: the till says so at Pay and Reports lists the order. */
export function tabletDiffers(tillTotalCents: number, tabletTotalCents: number, toleranceCents = FOODPANDA_TABLET_TOLERANCE_CENTS): boolean {
  return Math.abs(tabletDifferenceCents(tillTotalCents, tabletTotalCents)) > toleranceCents;
}

/**
 * The worked example under the foodpanda card, from the owner's own values:
 * "A Rs 2,000 foodpanda order with 20% off that you pay: the bill shows
 * Rs 1,600 + tax; foodpanda keeps 25% of Rs 1,600 = Rs 400; you keep
 * Rs 1,200 before food cost." The screen builds the words from these
 * numbers, so the text never repeats a figure by hand.
 */
export interface FoodpandaExample {
  orderCents: number;
  dealPercent: number;
  shopPercent: number;
  /** Off the bill: the shop's part of the deal. */
  shopCents: number;
  /** foodpanda's part, paid on top (0 unless shared). */
  platformCents: number;
  /** The bill before tax. */
  billCents: number;
  commissionBps: number;
  commissionBaseCents: number;
  commissionCents: number;
  commissionTaxCents: number;
  fixedFeeCents: number;
  youKeepCents: number;
}

export function foodpandaExample(
  deal: Pick<FoodpandaDeal, 'percent' | 'shopPercent' | 'minOrderCents' | 'maxOffCents'>,
  fees: Pick<FoodpandaFees, 'commissionBps' | 'base' | 'fixedFeeCents' | 'commissionTaxBps'>,
  orderCents = 200_000,
): FoodpandaExample {
  const percent = Math.max(0, Math.min(deal.percent, FOODPANDA_DEAL_MAX_PERCENT));
  const amount = dealAmount(
    { dealPercent: percent, shopPercent: deal.shopPercent, minOrderCents: deal.minOrderCents, maxOffCents: deal.maxOffCents },
    orderCents,
  );
  const billCents = orderCents - amount.shopCents;
  // The example has no tax: the total is the bill before tax, like the sentence.
  const t = foodpandaTerms({ subtotalCents: orderCents, shopDiscountCents: amount.shopCents, totalCents: billCents }, fees);
  return {
    orderCents,
    dealPercent: amount.dealCents > 0 ? percent : 0,
    shopPercent: amount.dealCents > 0 ? Math.min(deal.shopPercent, percent) : 0,
    shopCents: amount.shopCents,
    platformCents: amount.platformCents,
    billCents,
    commissionBps: fees.commissionBps,
    commissionBaseCents: t.commissionBaseCents,
    commissionCents: t.commissionCents,
    commissionTaxCents: t.commissionTaxCents,
    fixedFeeCents: t.fixedFeeCents,
    youKeepCents: t.youKeepCents,
  };
}
