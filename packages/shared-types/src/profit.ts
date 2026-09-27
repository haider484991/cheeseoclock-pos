/**
 * Profit (costing spec Phase 9, profit.view): the owner's settings for what
 * a sale costs beyond its food — foodpanda's commission, card and wallet
 * fees, the rider — the menu map (menu engineering, 4.8) and What-if (4.9).
 * The Reports tab types sit with the other tabs in reports.ts.
 *
 * Money in paisa, shares in basis points (2500 = 25%), unit prices in
 * millicents (1/1000 paisa). Nothing here ever changes a price on the till.
 */
import type { FoodCostFlag } from './costing.js';
import type { ReportEngine, ReportPaymentGroup } from './reports.js';

// ------------------------------------------------------------- settings --

/**
 * What foodpanda's commission is taken on (costing spec 4.7):
 *  - 'sales_ex_tax':  the order before tax, after discounts and part refunds (the default);
 *  - 'paid_incl_tax': what the customer paid, tax included (total − refunds);
 *  - 'menu_price':    the order at menu prices, before any discount.
 */
export const COMMISSION_BASES = ['sales_ex_tax', 'paid_incl_tax', 'menu_price'] as const;
export type CommissionBase = (typeof COMMISSION_BASES)[number];

/** The owner's words for each base (Targets & fees, the Profit tab's note). */
export const COMMISSION_BASE_LABEL: Record<CommissionBase, string> = {
  sales_ex_tax: 'the order before tax, after discounts',
  paid_incl_tax: 'what the customer paid, tax included',
  menu_price: 'the order at menu prices, before discounts',
};

export interface FoodpandaFees {
  /** Commission, basis points of the base (2500 = 25%, owner question 9 not answered). */
  commissionBps: number;
  base: CommissionBase;
  /** A fixed fee per order on top, paisa (0 when there is none). */
  fixedFeeCents: number;
  /**
   * How much dearer the foodpanda menu is than the till's, basis points (0:
   * the same prices — foodpanda profit is then "at till prices"). The till
   * rings foodpanda orders at till prices; the difference is shown as its
   * own line, "foodpanda price uplift (estimated)", and the commission is
   * taken on the dearer price. Stored order totals never change.
   */
  upliftBps: number;
}

/**
 * Business setting 'channels.fees' (costing spec Phase 9): foodpanda's cut,
 * and what each way of paying costs the shop (a share of the money taken
 * that way; 0 = nothing).
 */
export interface ChannelFees {
  foodpanda: FoodpandaFees;
  paymentFeeBps: Record<ReportPaymentGroup, number>;
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
 */
export const RIDER_COST_MODES = ['zone_rate', 'fixed', 'none'] as const;
export type RiderCostMode = (typeof RIDER_COST_MODES)[number];

export interface RiderCostSetting {
  mode: RiderCostMode;
  /** Per trip, paisa ('fixed' only; kept as typed otherwise). */
  fixedCents: number;
}

/** Until the owner answers question 9: 25% of the order before tax, no fixed fee, foodpanda at till prices. */
export const DEFAULT_FOODPANDA_COMMISSION_BPS = 2500;

export const DEFAULT_CHANNEL_FEES: ChannelFees = {
  foodpanda: { commissionBps: DEFAULT_FOODPANDA_COMMISSION_BPS, base: 'sales_ex_tax', fixedFeeCents: 0, upliftBps: 0 },
  paymentFeeBps: { cash: 0, card: 0, foodpanda: 0, transfer: 0 },
};

export const DEFAULT_RIDER_COST: RiderCostSetting = { mode: 'zone_rate', fixedCents: 0 };

/** Costing → Targets & fees: the fees in force (the saved ones, or the defaults). */
export interface ChannelFeesView {
  fees: ChannelFees;
  riderCost: RiderCostSetting;
  /** Nothing saved yet: the defaults above. */
  isDefault: boolean;
  savedAt: string | null;
}

/** What Costing → Targets & fees saves (costing:setChannelFees; the owner only). */
export interface SetChannelFeesRequest {
  fees: ChannelFees;
  riderCost: RiderCostSetting;
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
