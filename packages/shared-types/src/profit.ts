/**
 * Profit (costing spec Phase 9, profit.view): the owner's settings for what
 * a sale costs beyond its food — card and wallet fees, the rider — the menu
 * map (menu engineering, 4.8) and What-if (4.9). foodpanda's commission,
 * fee, tax and dearer prices are Settings → foodpanda's ('foodpanda.fees',
 * shop-settings.ts): the ONE place they live. The Reports tab types sit
 * with the other tabs in reports.ts.
 *
 * Money in paisa, shares in basis points (2500 = 25%), unit prices in
 * millicents (1/1000 paisa). Nothing here ever changes a price on the till.
 */
import type { FoodCostFlag } from './costing.js';
import type { ReportEngine, ReportPaymentGroup } from './reports.js';
import type { FoodpandaDeal, FoodpandaFees } from './shop-settings.js';

// ------------------------------------------------------------- settings --

/**
 * v0.7.20 ONLY. What v0.7.20's Costing → Targets & fees took foodpanda's
 * commission on:
 *  - 'sales_ex_tax':  the order before tax, after discounts and part refunds;
 *  - 'paid_incl_tax': what the customer paid, tax included (total − refunds);
 *  - 'menu_price':    the order at menu prices, before any discount.
 * Read only to carry a saved value over into Settings → foodpanda.
 */
export const LEGACY_COMMISSION_BASES = ['sales_ex_tax', 'paid_incl_tax', 'menu_price'] as const;
export type LegacyCommissionBase = (typeof LEGACY_COMMISSION_BASES)[number];

/**
 * v0.7.20 ONLY: the foodpanda part of 'channels.fees'. RETIRED: never
 * edited again, never used for a figure. While Settings → foodpanda
 * ('foodpanda.fees') has never been saved, the one reader of foodpanda's
 * fees carries it over (business-settings-read.ts readShopSetting,
 * pos-domain foodpandaFeesFromChannelFees): what the owner typed stays in
 * force. A save of the card fees keeps it as it was stored.
 */
export interface LegacyFoodpandaChannelFees {
  /** Commission, basis points of the base (2500 = 25%). */
  commissionBps: number;
  base: LegacyCommissionBase;
  /** A fixed fee per order on top, paisa. */
  fixedFeeCents: number;
  /** How much dearer the foodpanda menu is than the till's, basis points. */
  upliftBps: number;
}

/** What each way of paying costs the shop (a share of the money taken that way; 0 = nothing). */
export interface PaymentFees {
  paymentFeeBps: Record<ReportPaymentGroup, number>;
}

/**
 * Business setting 'channels.fees' as stored (costing spec Phase 9): the
 * payment fees, and — only when v0.7.20 saved it — its retired foodpanda
 * part, kept untouched for the carry-over (and for a till still on v0.7.20).
 */
export interface ChannelFees extends PaymentFees {
  foodpanda?: LegacyFoodpandaChannelFees;
}

/**
 * What a delivery by the shop's own rider costs (business setting
 * 'delivery.riderCost', costing spec 4.7):
 *  - 'zone_rate' (the default): the rider service's rate for the order's
 *    area (the delivery-zone fee), else the delivery charge on the bill at
 *    menu price, else nothing — and the order is listed as "delivery with no
 *    area or delivery charge";
 *  - 'fixed': the same amount for every trip;
 *  - 'none': the shop's own salaried riders, nothing per trip.
 * A delivery sent out with an outside rider (Send out, v0.7.34) is not
 * priced by this setting: it costs what he kept (orders.rider_keeps_cents,
 * the delivery charge frozen at Send out), whichever mode is chosen
 * (pos-domain riderCost, source 'kept').
 */
export const RIDER_COST_MODES = ['zone_rate', 'fixed', 'none'] as const;
export type RiderCostMode = (typeof RIDER_COST_MODES)[number];

export interface RiderCostSetting {
  mode: RiderCostMode;
  /** Per trip, paisa ('fixed' only; kept as typed otherwise). */
  fixedCents: number;
}

/** Until the owner sets them: no payment fees. */
export const DEFAULT_CHANNEL_FEES: PaymentFees = {
  paymentFeeBps: { cash: 0, card: 0, foodpanda: 0, transfer: 0 },
};

export const DEFAULT_RIDER_COST: RiderCostSetting = { mode: 'zone_rate', fixedCents: 0 };

/**
 * foodpanda's terms in force (Settings → foodpanda), as Costing → Targets &
 * fees shows them, read-only, with a button to Settings → foodpanda.
 */
export interface FoodpandaTermsInForce {
  /** The fees in force: saved in Settings, carried over from v0.7.20, or the suggested default. */
  fees: FoodpandaFees;
  /** Carried over from what v0.7.20's Targets & fees saved (Settings → foodpanda never saved). */
  carriedOver: boolean;
  /** Nothing saved anywhere: the suggested 25%. */
  isDefault: boolean;
  /** The deal on the listing as saved (percent 0 = none)… */
  deal: FoodpandaDeal;
  /** …and whether a foodpanda order started now gets it (its dates). */
  dealToday: boolean;
}

/** Costing → Targets & fees: the fees in force (the saved ones, or the defaults). */
export interface ChannelFeesView {
  fees: PaymentFees;
  riderCost: RiderCostSetting;
  /** Nothing saved yet: the defaults above. */
  isDefault: boolean;
  savedAt: string | null;
  /** foodpanda's terms, for the owner (profit.view); null for a manager. */
  foodpanda: FoodpandaTermsInForce | null;
}

/**
 * What Costing → Targets & fees saves (costing:setChannelFees; the owner
 * only): the payment fees and the rider cost. foodpanda's terms are saved in
 * Settings → foodpanda: a foodpanda part in the request is stripped.
 */
export interface SetChannelFeesRequest {
  fees: PaymentFees;
  riderCost: RiderCostSetting;
}

/** The fees Reports → Profit and Channels were worked with (for the notes under them). */
export interface ProfitFees extends PaymentFees {
  /** foodpanda's terms in force now (orders paid with a confirmed commission keep their own). */
  foodpanda: FoodpandaFees;
}

// ----------------------------------------------------------- menu map --

/**
 * Where a dish sits on its category's menu map (costing spec 4.8, the
 * AHLEI menu-engineering matrix), in the owner's words on screen; the
 * original term is shown small beside them.
 */
export const MENU_MAP_CLASSES = ['star', 'plowhorse', 'puzzle', 'dog'] as const;
export type MenuMapClass = (typeof MENU_MAP_CLASSES)[number];

export const MENU_MAP_WORDS: Record<MenuMapClass, { plain: string; term: string; advice: string }> = {
  star: { plain: 'Popular & profitable', term: 'Star', advice: 'Keep it. Check the portions stay right.' },
  plowhorse: { plain: 'Popular, low profit', term: 'Plowhorse', advice: 'A little more on the price, or a little less cost, brings it to your average.' },
  puzzle: { plain: 'Profitable, rarely ordered', term: 'Puzzle', advice: 'Suggest it at the counter and on the website.' },
  dog: { plain: 'Rarely ordered, low profit', term: 'Dog', advice: 'Rework it or drop it, unless a deal needs it.' },
};

export interface MenuMapItem {
  menuItemId: string;
  name: string;
  /** Units sold in the days looked at. */
  units: number;
  /** Its share of the category's units (every dish's, placed or not), basis points. */
  mixBps: number;
  /** What one sale earns at menu price (price − cost), over the sales whose cost is known. */
  profitPerSaleCents: number;
  /** The average menu price and cost of those sales. */
  priceCents: number;
  costCents: number;
  popular: boolean;
  profitable: boolean;
  class: MenuMapClass;
  /** "Popular, low profit": how far under the category's average one sale earns… */
  belowAverageCents: number | null;
  /** …and the price rise, in the owner's price steps, that brings it there. */
  raiseToAverageCents: number | null;
}

/**
 * One category's menu map. 'few_sales': fewer than 200 units sold in the
 * days looked at; 'few_dishes': fewer than 3 dishes in the category, or
 * fewer than 3 with known costs sold. Popularity is over EVERY dish of the
 * category (on the menu now, or sold), placed or not.
 */
export interface MenuMapCategory {
  categoryId: string;
  name: string;
  state: 'ok' | 'few_sales' | 'few_dishes';
  /** Units of the category sold in the days looked at (every dish). */
  units: number;
  /** Placed dishes (state 'ok' only), most sold first. */
  items: MenuMapItem[];
  /** Sold, but under 90% of their units had a fully known cost: "can't place yet". */
  cantPlace: Array<{ menuItemId: string; name: string; units: number; costedShareBps: number }>;
  /** On the menu and not sold in these days. */
  notSold: Array<{ menuItemId: string; name: string }>;
  /** The popularity line: 70% of an equal share (1 ÷ every dish of the category), basis points. Null unless 'ok'. */
  popularLineBps: number | null;
  /** The category's average profit per sale (weighted by units): the profit line. Null unless 'ok'. */
  averageProfitCents: number | null;
}

/** Reports → Menu, the menu map (reports:menuMap; profit.view). Omitted dates: the last 28 days. */
export interface MenuMapRequest {
  sinceIso?: string;
  untilIso?: string;
}

export interface ReportMenuMap {
  sinceIso: string;
  untilIso: string;
  /** The default: the last 28 days, not the period picked. */
  lastDays: boolean;
  engine: ReportEngine;
  priceStepCents: number;
  categories: MenuMapCategory[];
  /** When this till first kept a sale's cost (item costs start then); null before any. */
  costingStartedAt: string | null;
}

// ------------------------------------------------------------- what-if --

/**
 * Costing → What-if (costing spec 4.9; profit.view): try ingredient prices
 * and menu prices and see what they do per week. NOTHING is saved or
 * changed on the till: the answer is a "price change list" to hand to
 * whoever keeps the costing sheet, the printed menu and the website.
 */
export interface WhatIfRequest {
  /** New prices to try: a pack of `packSize` base units for `packPriceCents`. */
  ingredients: Array<{ ingredientId: string; packSize: number; packPriceCents: number }>;
  /** New menu prices to try (the item's own price, before tax, as on the menu). */
  items: Array<{ menuItemId: string; priceCents: number }>;
}

/** An ingredient whose price moves in the what-if (typed, or a batch made from one). */
export interface WhatIfIngredient {
  ingredientId: string;
  name: string;
  unit: string;
  /** One base unit before and after, millicents; null when there is no price. */
  beforeUnitCostMc: number | null;
  afterUnitCostMc: number | null;
  changeBps: number | null;
  /** Made in-house (a batch): it moved because something it is made from did. */
  batch: boolean;
}

export interface WhatIfRow {
  menuItemId: string;
  name: string;
  categoryId: string;
  categoryName: string;
  /** The item's own price now, and as tried (before tax). */
  basePriceCents: number;
  newBasePriceCents: number;
  /** The typical price (with the usual paid picks), before and after. */
  priceCents: number;
  newPriceCents: number;
  /** A typical plate's cost, before and after. */
  costCents: number;
  newCostCents: number;
  foodCostBps: number | null;
  newFoodCostBps: number | null;
  flag: FoodCostFlag;
  newFlag: FoodCostFlag;
  /** What one sale earns (price − cost), before and after. */
  profitCents: number;
  newProfitCents: number;
  soldLast28: number;
  /** Units a week (the last 4 weeks' average), in tenths: 12.5 a week = 125. */
  weeklyUnitsTenths: number;
  /** What the change does per week at the same sales: above 0 the shop keeps more. */
  weekCents: number;
  /**
   * A price change only: how much sales could fall (below 0) before a rise
   * earns less than now, or must grow (above 0) before a cut earns as much —
   * basis points. Null when no volume makes up for it.
   */
  breakEvenBps: number | null;
  /** The item's own price that brings it to its target at the new costs (price steps); null when it can't be worked out. */
  priceToHitCents: number | null;
  targetBps: number;
  targetConfirmed: boolean;
  /** Its price or its cost moves in this what-if. */
  changed: boolean;
}

export interface WhatIfResult {
  /** Every food dish on the menu; the changed ones first, most per week first. */
  rows: WhatIfRow[];
  /** The ingredients as tried, and the batches that moved with them. */
  ingredients: WhatIfIngredient[];
  /** Σ weekCents over every dish. */
  totalWeekCents: number;
  priceStepCents: number;
  engine: ReportEngine;
}
