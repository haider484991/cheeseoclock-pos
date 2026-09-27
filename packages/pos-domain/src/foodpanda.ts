import type {
  FoodpandaCommissionBase,
  FoodpandaDeal,
  FoodpandaDealRule,
  FoodpandaFees,
  LegacyCommissionBase,
  LegacyFoodpandaChannelFees,
} from '@cheeseoclock/shared-types';
import { FOODPANDA_DEAL_MAX_PERCENT, FOODPANDA_TABLET_TOLERANCE_CENTS, SHOP_SETTING_FORMAT } from '@cheeseoclock/shared-types';
import { mulDivRound } from './units.js';

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

// ---------------------------------------------------------------------------
// foodpanda's dearer prices (Settings → foodpanda, "prices above the till's")
// ---------------------------------------------------------------------------

/**
 * What foodpanda's dearer menu adds to `cents`: round(cents × uplift ÷
 * 10,000), half away from zero; 0 at the till's prices (or on nothing).
 */
export function foodpandaUpliftCents(cents: number, upliftBps: number): number {
  if (!(upliftBps > 0) || !(cents > 0)) return 0;
  return mulDivRound(Math.round(cents), upliftBps, 10_000);
}

/** `cents` at foodpanda's prices: the till's price plus the uplift (the listing price, the tablet's total). */
export function atFoodpandaPrices(cents: number, upliftBps: number): number {
  return cents + foodpandaUpliftCents(cents, upliftBps);
}

// ---------------------------------------------------------------------------
// foodpanda's money on one order
// ---------------------------------------------------------------------------

/** The fee terms the money is worked out with ('foodpanda.fees' less the owner's confirmation). */
export type FoodpandaFeeTerms = Pick<FoodpandaFees, 'commissionBps' | 'base' | 'fixedFeeCents' | 'commissionTaxBps' | 'upliftBps'>;

/** foodpanda's money on one order, worked out from its fees. Never printed, never in the order's totals. */
export interface FoodpandaTerms {
  /** What the commission is worked out on (paisa, at foodpanda's prices). */
  commissionBaseCents: number;
  commissionCents: number;
  commissionTaxCents: number;
  fixedFeeCents: number;
  /** Commission + fee + tax on it. */
  foodpandaKeepsCents: number;
  /**
   * What foodpanda's dearer menu adds to the food after the shop's part of
   * the deal, before tax (0 at the till's prices): Reports' "price uplift".
   */
  upliftCents: number;
  /** The total the foodpanda tablet should show: the till's total (with tax) at foodpanda's prices. */
  expectedTabletCents: number;
  /** What foodpanda should pay the shop for the order: the tablet's total, less what it keeps. */
  expectedPayoutCents: number;
  /** The food money the shop keeps, before tax and food cost: the order's value at foodpanda's prices less what foodpanda keeps. */
  youKeepCents: number;
}

/**
 * foodpanda's commission, fee and tax on one order, from its STORED figures:
 * `subtotalCents` (till prices, before tax), `shopDiscountCents` (the
 * order's stored discount: the shop's part of the deal), `totalCents` (the
 * stored total, with tax). The till rings foodpanda at till prices; the
 * listing is `upliftBps` dearer, so the order's value on foodpanda — what
 * its vendor side shows, what the commission is on and what it pays out —
 * is the stored value at foodpanda's prices:
 *  - value = subtotal − the shop's part of the deal; uplift = round(value × m);
 *  - 'after_deal' charges the commission on value + uplift, 'before_deal'
 *    on the subtotal at foodpanda's prices;
 *  - the tablet shows the stored total at foodpanda's prices, and foodpanda
 *    pays that less its commission, the fee and the tax on the commission.
 * foodpanda's part of the deal is neither here nor in the stored total: the
 * customer saw it off and foodpanda funds it, so the shop is paid on its
 * value after ITS part only — already the stored subtotal − discount.
 */
export function foodpandaTerms(
  order: { subtotalCents: number; shopDiscountCents: number; totalCents: number },
  fees: FoodpandaFeeTerms,
): FoodpandaTerms {
  const value = Math.max(0, order.subtotalCents - order.shopDiscountCents);
  const upliftCents = foodpandaUpliftCents(value, fees.upliftBps);
  const commissionBaseCents =
    fees.base === 'before_deal' ? atFoodpandaPrices(Math.max(0, order.subtotalCents), fees.upliftBps) : value + upliftCents;
  const commissionCents = Math.round((commissionBaseCents * fees.commissionBps) / 10_000);
  const commissionTaxCents = Math.round((commissionCents * fees.commissionTaxBps) / 10_000);
  const fixedFeeCents = fees.fixedFeeCents;
  const foodpandaKeepsCents = commissionCents + commissionTaxCents + fixedFeeCents;
  const expectedTabletCents = atFoodpandaPrices(order.totalCents, fees.upliftBps);
  return {
    commissionBaseCents,
    commissionCents,
    commissionTaxCents,
    fixedFeeCents,
    foodpandaKeepsCents,
    upliftCents,
    expectedTabletCents,
    expectedPayoutCents: expectedTabletCents - foodpandaKeepsCents,
    youKeepCents: value + upliftCents - foodpandaKeepsCents,
  };
}

/**
 * The terms an order kept when it was paid (order_channel_terms): what the
 * reports read of them. The row has no uplift column; its expected payout
 * was the tablet's total less what foodpanda keeps, which gives it back.
 */
export interface KeptFoodpandaTerms {
  /** The owner had confirmed the commission when the order was paid: the kept figures are final. */
  confirmed: boolean;
  commissionCents: number;
  fixedFeeCents: number;
  commissionTaxCents: number;
  /** Null on a row that has none: worked out again with today's uplift. */
  expectedPayoutCents: number | null;
}

/** One foodpanda order's money as Reports count it (Channels' foodpanda block AND the Profit tab). */
export interface FoodpandaOrderMoney extends Omit<FoodpandaTerms, 'commissionBaseCents'> {
  /** Worked out with the fees in force now (no confirmed commission kept at payment): "estimated". */
  estimated: boolean;
}

/**
 * THE per-order rule for foodpanda's money, for every report — Reports →
 * Channels' foodpanda block (business-report getFoodpanda) and Reports →
 * Profit's commission and uplift (analytics/profit readOrderCosts) — so they
 * agree to the rupee:
 *  - kept at payment with a CONFIRMED commission: the kept commission, fee,
 *    tax and payout, final (next month's commission never rewrites this
 *    month's orders). The uplift kept with them: kept payout + what
 *    foodpanda keeps is the tablet total expected at payment; its extra over
 *    the stored total is the uplift with tax, and the food's part of it is
 *    round(extra × value ÷ total) — exact with no tax or no uplift;
 *  - anything else (paid before terms were kept, or while the commission
 *    was only suggested): foodpandaTerms with today's 'foodpanda.fees', so
 *    confirming the real commission later corrects them.
 * The order's figures are its STORED ones, as paid: a part refund later
 * changes neither (the kept terms could not know of it either). foodpanda's
 * part of the deal never enters: it is inside the stored value the shop is
 * paid on (subtotal − the shop's part), so it is neither added nor lost.
 */
export function foodpandaOrderMoney(
  order: { subtotalCents: number; discountCents: number; totalCents: number },
  kept: KeptFoodpandaTerms | null,
  feesNow: FoodpandaFeeTerms,
): FoodpandaOrderMoney {
  if (kept === null || !kept.confirmed) {
    const { commissionBaseCents: _base, ...t } = foodpandaTerms(
      { subtotalCents: order.subtotalCents, shopDiscountCents: order.discountCents, totalCents: order.totalCents },
      feesNow,
    );
    return { ...t, estimated: true };
  }
  const value = Math.max(0, order.subtotalCents - order.discountCents);
  const foodpandaKeepsCents = kept.commissionCents + kept.fixedFeeCents + kept.commissionTaxCents;
  const expectedTabletCents =
    kept.expectedPayoutCents === null
      ? atFoodpandaPrices(order.totalCents, feesNow.upliftBps)
      : kept.expectedPayoutCents + foodpandaKeepsCents;
  const extra = expectedTabletCents - order.totalCents;
  const upliftCents = extra > 0 && order.totalCents > 0 ? mulDivRound(extra, value, order.totalCents) : 0;
  return {
    estimated: false,
    commissionCents: kept.commissionCents,
    commissionTaxCents: kept.commissionTaxCents,
    fixedFeeCents: kept.fixedFeeCents,
    foodpandaKeepsCents,
    upliftCents,
    expectedTabletCents,
    expectedPayoutCents: expectedTabletCents - foodpandaKeepsCents,
    youKeepCents: value + upliftCents - foodpandaKeepsCents,
  };
}

// ---------------------------------------------------------------------------
// v0.7.20's foodpanda terms (Costing → Targets & fees), carried over
// ---------------------------------------------------------------------------

/**
 * v0.7.20's commission bases in Settings → foodpanda's two:
 *  - 'sales_ex_tax'  (the order before tax, after discounts)    → 'after_deal';
 *  - 'menu_price'    (the order at menu prices, before discounts) → 'before_deal';
 *  - 'paid_incl_tax' (what the customer paid, tax included)     → 'after_deal':
 *    Settings → foodpanda has no "with tax" base; the food after the deal is
 *    the nearest (the commission comes out lower by the commission on the tax).
 */
export const LEGACY_COMMISSION_BASE_MAP: Readonly<Record<LegacyCommissionBase, FoodpandaCommissionBase>> = Object.freeze({
  sales_ex_tax: 'after_deal',
  menu_price: 'before_deal',
  paid_incl_tax: 'after_deal',
});

/**
 * What v0.7.20 saved as foodpanda's terms ('channels.fees' → foodpanda), as
 * the 'foodpanda.fees' in force while Settings → foodpanda has never been
 * saved: its commission and fixed fee, CONFIRMED (the owner typed them), the
 * base mapped (LEGACY_COMMISSION_BASE_MAP), its uplift; no tax on the
 * commission (v0.7.20 had none). Read time only: nothing is rewritten.
 */
export function foodpandaFeesFromChannelFees(legacy: LegacyFoodpandaChannelFees): FoodpandaFees {
  return {
    v: SHOP_SETTING_FORMAT['foodpanda.fees'],
    commissionBps: legacy.commissionBps,
    confirmed: true,
    base: LEGACY_COMMISSION_BASE_MAP[legacy.base],
    fixedFeeCents: legacy.fixedFeeCents,
    commissionTaxBps: 0,
    upliftBps: legacy.upliftBps,
  };
}

/**
 * The total the foodpanda tablet should show for a till total: the till's
 * total at foodpanda's prices (Settings → foodpanda "prices above the
 * till's"; the till's own total at 0). Pay and Reports compare with THIS,
 * so a dearer listing does not flag every order.
 */
export function expectedTabletCents(tillTotalCents: number, upliftBps: number): number {
  return atFoodpandaPrices(tillTotalCents, upliftBps);
}

/** The tablet total less the one expected (positive: the tablet says more). */
export function tabletDifferenceCents(expectedCents: number, tabletTotalCents: number): number {
  return tabletTotalCents - expectedCents;
}

/** More than Rs 1 apart: the till says so at Pay and Reports lists the order. */
export function tabletDiffers(expectedCents: number, tabletTotalCents: number, toleranceCents = FOODPANDA_TABLET_TOLERANCE_CENTS): boolean {
  return Math.abs(tabletDifferenceCents(expectedCents, tabletTotalCents)) > toleranceCents;
}

/**
 * The worked example under the foodpanda card, from the owner's own values:
 * "A Rs 2,000 foodpanda order with 20% off that you pay: the bill shows
 * Rs 1,600 + tax; foodpanda keeps 25% of Rs 1,600 = Rs 400; you keep
 * Rs 1,200 before food cost." The screen builds the words from these
 * numbers, so the text never repeats a figure by hand.
 */
export interface FoodpandaExample {
  /** The order at till prices. */
  orderCents: number;
  /** How much above the till's prices the listing is, and the order at those prices. */
  upliftBps: number;
  listingOrderCents: number;
  dealPercent: number;
  shopPercent: number;
  /** Off the bill: the shop's part of the deal. */
  shopCents: number;
  /** foodpanda's part, paid on top (0 unless shared). */
  platformCents: number;
  /** The bill before tax (till prices). */
  billCents: number;
  /** The same bill at foodpanda's prices (= billCents with no uplift): what the shop is paid on. */
  billAtFoodpandaCents: number;
  commissionBps: number;
  commissionBaseCents: number;
  commissionCents: number;
  commissionTaxCents: number;
  fixedFeeCents: number;
  youKeepCents: number;
}

export function foodpandaExample(
  deal: Pick<FoodpandaDeal, 'percent' | 'shopPercent' | 'minOrderCents' | 'maxOffCents'>,
  fees: FoodpandaFeeTerms,
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
    upliftBps: fees.upliftBps,
    listingOrderCents: atFoodpandaPrices(orderCents, fees.upliftBps),
    dealPercent: amount.dealCents > 0 ? percent : 0,
    shopPercent: amount.dealCents > 0 ? Math.min(deal.shopPercent, percent) : 0,
    shopCents: amount.shopCents,
    platformCents: amount.platformCents,
    billCents,
    billAtFoodpandaCents: billCents + t.upliftCents,
    commissionBps: fees.commissionBps,
    commissionBaseCents: t.commissionBaseCents,
    commissionCents: t.commissionCents,
    commissionTaxCents: t.commissionTaxCents,
    fixedFeeCents: t.fixedFeeCents,
    youKeepCents: t.youKeepCents,
  };
}
