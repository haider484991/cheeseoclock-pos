import type {
  FoodpandaCommissionBase,
  FoodpandaDeal,
  FoodpandaDealRule,
  FoodpandaFees,
  LegacyCommissionBase,
  LegacyFoodpandaChannelFees,
  ReportPaymentGroup,
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

/**
 * The terms frozen onto an order's discount row when it becomes foodpanda:
 * the deal, and how much dearer the listing is then (`upliftBps`, from
 * 'foodpanda.fees'), since foodpanda's minimum and most-off are in its prices.
 */
export function foodpandaDealRule(deal: FoodpandaDeal, settingsAt: string | null, upliftBps = 0): FoodpandaDealRule {
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
    upliftBps: upliftBps > 0 ? upliftBps : 0,
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
  // A rule written without the uplift was frozen at the till's prices.
  const upliftBps = r['upliftBps'] ?? 0;
  if (!isWholeIn(upliftBps, 0, 10_000)) return null;
  return { kind: 'foodpanda_deal', v: 1, label, dealPercent, shopPercent, minOrderCents, maxOffCents, settingsAt, upliftBps };
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
 * before tax), from the frozen rule. foodpanda applies the deal to the order
 * at ITS prices (the listing, `upliftBps` dearer), so the minimum and the
 * most-off — typed as foodpanda shows them — are compared there, and the
 * rupees come back at the till's prices; the shop's part at foodpanda's
 * prices is then foodpanda's own (to the paisa). At the till's prices (0,
 * the default) nothing is converted:
 *  - below the minimum order the deal is Rs 0 (the row stays on the order
 *    and works again when items are added, so the result never depends on
 *    the order of edits);
 *  - the whole deal is the % of the food, capped at the most-off;
 *  - the shop's part is its share of that (shopPercent / dealPercent), to
 *    the paisa; foodpanda's part is the rest.
 */
export function dealAmount(
  rule: Pick<FoodpandaDealRule, 'dealPercent' | 'shopPercent' | 'minOrderCents' | 'maxOffCents'> & { upliftBps?: number },
  subtotalCents: number,
): DealAmount {
  const none = { dealCents: 0, shopCents: 0, platformCents: 0 };
  if (!(subtotalCents > 0) || !(rule.dealPercent > 0)) return none;
  const upliftBps = rule.upliftBps ?? 0;
  if (rule.minOrderCents !== null && atFoodpandaPrices(subtotalCents, upliftBps) < rule.minOrderCents) return none;
  let dealCents = Math.round((subtotalCents * Math.min(rule.dealPercent, 100)) / 100);
  if (rule.maxOffCents !== null) dealCents = Math.min(dealCents, atTillPrices(rule.maxOffCents, upliftBps));
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

/** A figure at foodpanda's prices back at the till's: round(cents ÷ (1 + uplift)); unchanged at the till's prices. */
export function atTillPrices(cents: number, upliftBps: number): number {
  if (!(upliftBps > 0)) return cents;
  return mulDivRound(Math.round(cents), 10_000, 10_000 + upliftBps);
}

/**
 * The food at TILL prices from which a frozen deal takes something off: the
 * smallest subtotal that is at least the minimum at foodpanda's prices (the
 * cart says "Takes off from …"). Null = any order.
 */
export function dealMinTillCents(rule: Pick<FoodpandaDealRule, 'minOrderCents'> & { upliftBps?: number }): number | null {
  if (rule.minOrderCents === null) return null;
  const upliftBps = rule.upliftBps ?? 0;
  if (!(upliftBps > 0)) return rule.minOrderCents;
  let s = atTillPrices(rule.minOrderCents, upliftBps);
  while (s > 0 && atFoodpandaPrices(s - 1, upliftBps) >= rule.minOrderCents) s -= 1;
  while (atFoodpandaPrices(s, upliftBps) < rule.minOrderCents) s += 1;
  return s;
}

// ---------------------------------------------------------------------------
// foodpanda's money on one order
// ---------------------------------------------------------------------------

/** The fee terms the money is worked out with ('foodpanda.fees' less the owner's confirmation). */
export type FoodpandaFeeTerms = Pick<
  FoodpandaFees,
  'commissionBps' | 'base' | 'fixedFeeCents' | 'commissionTaxBps' | 'upliftBps' | 'paymentFeeBps'
>;

/** foodpanda's money on one order, worked out from its fees. Never printed, never in the order's totals. */
export interface FoodpandaTerms {
  /** What the commission is worked out on (paisa, at foodpanda's prices). */
  commissionBaseCents: number;
  commissionCents: number;
  commissionTaxCents: number;
  fixedFeeCents: number;
  /** foodpanda's % of the order's total (the tablet's, tax included): 0 unless the owner set one. */
  paymentFeeCents: number;
  /** Commission + tax on it + the fee per order + the % of the total. */
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

type FoodpandaKeeps = Pick<FoodpandaTerms, 'commissionCents' | 'commissionTaxCents' | 'fixedFeeCents' | 'paymentFeeCents'>;

/** What foodpanda keeps of an order at given prices: the commission on its base, the tax on it, the fee, the % of the total. */
function keepsAt(fees: FoodpandaFeeTerms, prices: { commissionBaseCents: number; tabletCents: number }): FoodpandaKeeps {
  const commissionCents = Math.round((prices.commissionBaseCents * fees.commissionBps) / 10_000);
  return {
    commissionCents,
    commissionTaxCents: Math.round((commissionCents * fees.commissionTaxBps) / 10_000),
    fixedFeeCents: fees.fixedFeeCents,
    paymentFeeCents: fees.paymentFeeBps > 0 && prices.tabletCents > 0 ? mulDivRound(prices.tabletCents, fees.paymentFeeBps, 10_000) : 0,
  };
}

const keepsTotal = (k: FoodpandaKeeps) => k.commissionCents + k.commissionTaxCents + k.fixedFeeCents + k.paymentFeeCents;

/**
 * foodpanda's commission, fees and tax on one order, from its STORED
 * figures: `subtotalCents` (till prices, before tax), `shopDiscountCents`
 * (the order's stored discount: the shop's part of the deal), `totalCents`
 * (the stored total, with tax). The till rings foodpanda at till prices; the
 * listing is `upliftBps` dearer, so the order's value on foodpanda — what
 * its vendor side shows, what the commission is on and what it pays out —
 * is the stored value at foodpanda's prices:
 *  - value = subtotal − the shop's part of the deal; uplift = round(value × m);
 *  - 'after_deal' charges the commission on value + uplift, 'before_deal'
 *    on the subtotal at foodpanda's prices;
 *  - the tablet shows the stored total at foodpanda's prices; foodpanda
 *    keeps its % of that (paymentFeeBps) beside the commission, and pays
 *    the tablet's total less its commission, the fee, its % and the tax on
 *    the commission.
 * foodpanda's part of the deal is neither here nor in the stored total: the
 * customer saw it off and foodpanda funds it, so the shop is paid on its
 * value after ITS part only — already the stored subtotal − discount.
 * (An order as paid: foodpandaOrderMoney is the same rule, with the terms
 * kept at payment and part refunds.)
 */
export function foodpandaTerms(
  order: { subtotalCents: number; shopDiscountCents: number; totalCents: number },
  fees: FoodpandaFeeTerms,
): FoodpandaTerms {
  const value = Math.max(0, order.subtotalCents - order.shopDiscountCents);
  const upliftCents = foodpandaUpliftCents(value, fees.upliftBps);
  const commissionBaseCents =
    fees.base === 'before_deal' ? atFoodpandaPrices(Math.max(0, order.subtotalCents), fees.upliftBps) : value + upliftCents;
  const expectedTabletCents = atFoodpandaPrices(order.totalCents, fees.upliftBps);
  const k = keepsAt(fees, { commissionBaseCents, tabletCents: expectedTabletCents });
  const foodpandaKeepsCents = keepsTotal(k);
  return {
    commissionBaseCents,
    ...k,
    foodpandaKeepsCents,
    upliftCents,
    expectedTabletCents,
    expectedPayoutCents: expectedTabletCents - foodpandaKeepsCents,
    youKeepCents: value + upliftCents - foodpandaKeepsCents,
  };
}

/**
 * The terms an order kept when it was paid (order_channel_terms), as the
 * reports read them. Its expected payout was the tablet's total less what
 * foodpanda keeps, so the tablet total expected at payment comes back from
 * the row whatever the commission was.
 */
export interface KeptFoodpandaTerms {
  /** The owner had confirmed the commission when the order was paid: the kept commission, fees and tax are final. */
  confirmed: boolean;
  commissionCents: number;
  fixedFeeCents: number;
  commissionTaxCents: number;
  /** foodpanda's % of the total as kept (0 on a row kept without it). */
  paymentFeeCents: number;
  /** Null on a row that has none. */
  expectedPayoutCents: number | null;
  /** How much dearer the listing was at payment; null on a row kept without it (it comes back from the payout). */
  upliftBps: number | null;
}

/** One foodpanda order's money as Reports count it (Channels' foodpanda block AND the Profit tab). */
export interface FoodpandaOrderMoney extends Omit<FoodpandaTerms, 'commissionBaseCents'> {
  /** Commission, fees and tax worked out with the fees in force now (no confirmed commission kept at payment): "estimated". */
  estimated: boolean;
}

/**
 * THE per-order rule for foodpanda's money, for every report — Reports →
 * Channels' foodpanda block (business-report getFoodpanda) and Reports →
 * Profit's commission and uplift (analytics/profit readOrderCosts) — so they
 * agree to the paisa. `order` is the order's STORED money, with the money
 * handed back on it since (`refundedCents`, tax included).
 *
 *  1. The prices the order was paid at, from its kept terms (a paid order
 *     never moves with a later change of the uplift): the tablet total Pay
 *     expected, and the uplift on the food — at the kept uplift, else worked
 *     back from the kept payout (+ what foodpanda kept: the tablet total to
 *     the paisa; the food's share of its extra within a paisa); with no
 *     terms kept (paid before they were), the uplift in force now.
 *  2. What foodpanda keeps: with a commission CONFIRMED at payment, the kept
 *     commission, fees and tax, final (next month's commission never
 *     rewrites this month's orders); otherwise ("estimated": paid while the
 *     commission was only suggested, or before terms were kept) the fees in
 *     force now, on the order at the prices of step 1 — so confirming the
 *     real commission later corrects them, and only them.
 *  3. Part refunds: the food handed back leaves foodpanda's order too. Its
 *     share of the total comes off the commission, the tax on it, the % of
 *     the total, the uplift and the payout (the fee per order stays); the
 *     food the shop keeps is after them, as Profit's sales are.
 *
 * foodpanda's part of the deal never enters: it is inside the stored value
 * the shop is paid on (subtotal − the shop's part), so it is neither added
 * nor lost.
 */
export function foodpandaOrderMoney(
  order: { subtotalCents: number; discountCents: number; totalCents: number; refundedCents?: number },
  kept: KeptFoodpandaTerms | null,
  feesNow: FoodpandaFeeTerms,
): FoodpandaOrderMoney {
  const sub = Math.max(0, order.subtotalCents);
  const value = Math.max(0, sub - order.discountCents);
  const total = Math.max(0, order.totalCents);

  // 1) The prices it was paid at.
  let expectedTabletCents: number;
  let upliftOf: (cents: number) => number;
  if (kept !== null && kept.upliftBps === null && kept.expectedPayoutCents !== null) {
    expectedTabletCents = kept.expectedPayoutCents + keepsTotal(kept);
    const extra = expectedTabletCents - total;
    upliftOf = (cents) => (extra > 0 && total > 0 && cents > 0 ? mulDivRound(extra, cents, total) : 0);
  } else {
    const upliftBps = kept?.upliftBps ?? feesNow.upliftBps;
    expectedTabletCents = atFoodpandaPrices(total, upliftBps);
    upliftOf = (cents) => foodpandaUpliftCents(cents, upliftBps);
  }
  let upliftCents = upliftOf(value);

  // 2) What foodpanda keeps.
  const confirmed = kept !== null && kept.confirmed;
  let k: FoodpandaKeeps = confirmed
    ? {
        commissionCents: kept.commissionCents,
        commissionTaxCents: kept.commissionTaxCents,
        fixedFeeCents: kept.fixedFeeCents,
        paymentFeeCents: kept.paymentFeeCents,
      }
    : keepsAt(feesNow, {
        commissionBaseCents: feesNow.base === 'before_deal' ? sub + upliftOf(sub) : value + upliftCents,
        tabletCents: expectedTabletCents,
      });

  // 3) Part refunds: their share of the total leaves the order.
  const refunded = Math.min(Math.max(0, order.refundedCents ?? 0), total);
  let tabletLeftCents = expectedTabletCents;
  let foodLeftCents = value;
  if (refunded > 0) {
    const left = (cents: number) => cents - mulDivRound(cents, refunded, total);
    k = {
      commissionCents: left(k.commissionCents),
      commissionTaxCents: left(k.commissionTaxCents),
      fixedFeeCents: k.fixedFeeCents,
      paymentFeeCents: left(k.paymentFeeCents),
    };
    upliftCents = left(upliftCents);
    tabletLeftCents = left(expectedTabletCents);
    foodLeftCents = value - Math.min(mulDivRound(refunded, value, total), value);
  }
  const foodpandaKeepsCents = keepsTotal(k);
  return {
    estimated: !confirmed,
    ...k,
    foodpandaKeepsCents,
    upliftCents,
    expectedTabletCents,
    expectedPayoutCents: tabletLeftCents - foodpandaKeepsCents,
    youKeepCents: foodLeftCents + upliftCents - foodpandaKeepsCents,
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
 * v0.7.20's own foodpanda part (its DEFAULT_CHANNEL_FEES): v0.7.20 saved it
 * with every save of the card fees, whether or not the owner touched it.
 */
export const LEGACY_DEFAULT_FOODPANDA_CHANNEL_FEES: Readonly<LegacyFoodpandaChannelFees> = Object.freeze({
  commissionBps: 2_500,
  base: 'sales_ex_tax',
  fixedFeeCents: 0,
  upliftBps: 0,
});

/**
 * What v0.7.20's Costing → Targets & fees saved ('channels.fees': its
 * foodpanda part and its "Foodpanda" payment fee), as the 'foodpanda.fees'
 * in force while Settings → foodpanda has never been saved. Read time only:
 * nothing is rewritten.
 *  - the commission, fixed fee and uplift as saved, the base mapped
 *    (LEGACY_COMMISSION_BASE_MAP); no tax on the commission (v0.7.20 had none);
 *  - its "Foodpanda" payment fee as foodpanda's % of the total (Costing no
 *    longer charges it: it is foodpanda's, so Settings → foodpanda's);
 *  - CONFIRMED only when the owner can have meant it — the foodpanda part
 *    differs from v0.7.20's own default, and its base maps exactly
 *    ('paid_incl_tax' does not: the commission on the tax is lost).
 *    Otherwise "not confirmed": orders paid meanwhile stay estimated and
 *    are corrected when he confirms the commission in Settings → foodpanda,
 *    instead of being frozen at a figure he never chose.
 * Null when it carries nothing over (no foodpanda part and no payment fee,
 * or no more than v0.7.20's default): the suggested default applies.
 */
export function foodpandaFeesFromChannelFees(legacy: {
  foodpanda?: LegacyFoodpandaChannelFees | undefined;
  paymentFeeBps?: Partial<Record<ReportPaymentGroup, number>> | undefined;
}): FoodpandaFees | null {
  const fp = legacy.foodpanda ?? LEGACY_DEFAULT_FOODPANDA_CHANNEL_FEES;
  const paymentFeeBps = Math.max(0, legacy.paymentFeeBps?.foodpanda ?? 0);
  const typed =
    legacy.foodpanda !== undefined &&
    (fp.commissionBps !== LEGACY_DEFAULT_FOODPANDA_CHANNEL_FEES.commissionBps ||
      fp.base !== LEGACY_DEFAULT_FOODPANDA_CHANNEL_FEES.base ||
      fp.fixedFeeCents !== LEGACY_DEFAULT_FOODPANDA_CHANNEL_FEES.fixedFeeCents ||
      fp.upliftBps !== LEGACY_DEFAULT_FOODPANDA_CHANNEL_FEES.upliftBps);
  if (!typed && paymentFeeBps === 0) return null;
  return {
    v: SHOP_SETTING_FORMAT['foodpanda.fees'],
    commissionBps: fp.commissionBps,
    confirmed: typed && fp.base !== 'paid_incl_tax',
    base: LEGACY_COMMISSION_BASE_MAP[fp.base],
    fixedFeeCents: fp.fixedFeeCents,
    commissionTaxBps: 0,
    upliftBps: fp.upliftBps,
    paymentFeeBps,
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
  /** The deal's most-off held it back (compared at foodpanda's prices, as foodpanda does). */
  capped: boolean;
  /** The bill before tax (till prices). */
  billCents: number;
  /** The same bill at foodpanda's prices (= billCents with no uplift): what the shop is paid on. */
  billAtFoodpandaCents: number;
  commissionBps: number;
  commissionBaseCents: number;
  commissionCents: number;
  commissionTaxCents: number;
  fixedFeeCents: number;
  /** foodpanda's % of the total (the example has no tax: of the bill at foodpanda's prices). */
  paymentFeeBps: number;
  paymentFeeCents: number;
  youKeepCents: number;
}

export function foodpandaExample(
  deal: Pick<FoodpandaDeal, 'percent' | 'shopPercent' | 'minOrderCents' | 'maxOffCents'>,
  fees: FoodpandaFeeTerms,
  orderCents = 200_000,
): FoodpandaExample {
  const percent = Math.max(0, Math.min(deal.percent, FOODPANDA_DEAL_MAX_PERCENT));
  // The deal as an order gets it: at foodpanda's prices (the rule frozen on an order carries the uplift).
  const rule = {
    dealPercent: percent,
    shopPercent: deal.shopPercent,
    minOrderCents: deal.minOrderCents,
    maxOffCents: deal.maxOffCents,
    upliftBps: fees.upliftBps,
  };
  const amount = dealAmount(rule, orderCents);
  const uncapped = dealAmount({ ...rule, maxOffCents: null }, orderCents);
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
    capped: amount.dealCents < uncapped.dealCents,
    billCents,
    billAtFoodpandaCents: billCents + t.upliftCents,
    commissionBps: fees.commissionBps,
    commissionBaseCents: t.commissionBaseCents,
    commissionCents: t.commissionCents,
    commissionTaxCents: t.commissionTaxCents,
    fixedFeeCents: t.fixedFeeCents,
    paymentFeeBps: fees.paymentFeeBps,
    paymentFeeCents: t.paymentFeeCents,
    youKeepCents: t.youKeepCents,
  };
}
