/**
 * The shop's business rules the owner edits himself in Settings (owner,
 * 2026-09-27: "Everything should be editable for the admin — percentage and
 * other settings… it should be a complete package"). Each rule is one key of
 * business_settings (migration 0032): synced between the tills, saved through
 * business-settings-repo (row + sync + hash-chained audit, one transaction)
 * and checked by its Zod schema in shared-schemas business-settings.ts.
 *
 * Phase 1 is foodpanda: the deal on the listing, foodpanda's fees and the
 * checks at Pay. Later phases add their own keys here (approval limits and
 * discount buttons, delivery areas and fees, offers, the shop profile,
 * timings…), each with a frozen default.
 *
 * FROZEN DEFAULTS. A key never saved reads as its DEFAULT_* below, which is
 * exactly what the till did before the setting existed, so installing the
 * version changes nothing. A test pins every value (pos-domain
 * shop-settings.test.ts). They are NEVER edited after release: two tills on
 * different versions with the key unsaved would disagree. A change to how
 * the shop works is a saved setting, not a new default.
 *
 * FORMATS. Every value carries `v`, the format it was written in. This
 * version writes SHOP_SETTING_FORMAT[key]. A till that finds a higher `v`,
 * or fields it does not know, in the stored value (a newer till saved it)
 * uses the fields it knows and shows the card read-only: saving it would
 * drop what it does not understand.
 */

/** The keys the Settings cards edit (settings:getBusiness / settings:setBusiness). */
export const SHOP_SETTING_KEYS = ['foodpanda.deal', 'foodpanda.fees', 'foodpanda.checks'] as const;
export type ShopSettingKey = (typeof SHOP_SETTING_KEYS)[number];

export function isShopSettingKey(key: unknown): key is ShopSettingKey {
  return typeof key === 'string' && (SHOP_SETTING_KEYS as readonly string[]).includes(key);
}

/** The most off a foodpanda deal can be (owner bounds: a whole % from 0 to 50). */
export const FOODPANDA_DEAL_MAX_PERCENT = 50;

/**
 * The % off the shop's foodpanda listing shows, and who pays for it
 * ('foodpanda.deal'). Only the shop's part is the order's discount (what
 * foodpanda's vendor side shows as the order value); foodpanda's part is
 * money foodpanda pays on top, recorded at payment.
 */
export interface FoodpandaDeal {
  /** Format this value was written in. */
  v: number;
  /** The whole % off the listing shows, 0–50. 0 = no deal (today). */
  percent: number;
  /** The shop's part of `percent`, 0..percent: equal = "I pay all of it", 0 = "foodpanda pays it". */
  shopPercent: number;
  /** The deal applies only to orders of at least this much food (paisa, whole rupees); null = any order. */
  minOrderCents: number | null;
  /** The most the deal takes off one order (paisa, whole rupees); null = no limit. */
  maxOffCents: number | null;
  /** First trading day (YYYY-MM-DD) the deal runs; null = already running. */
  startsOn: string | null;
  /** Last trading day it runs; null = until changed. */
  endsOn: string | null;
}

/** What foodpanda's commission is worked out on. */
export type FoodpandaCommissionBase = 'after_deal' | 'before_deal';

/**
 * foodpanda's fees ('foodpanda.fees'): Reports and the owner's Costing view
 * only. Never printed, never in a stored order total. A separate key from
 * the deal: each key is one whole value decided by its last write, so a
 * commission edit on one till can't erase a deal edit on the other.
 */
export interface FoodpandaFees {
  v: number;
  /** The commission, basis points (2500 = 25%). */
  commissionBps: number;
  /** False until the owner says the commission is right: shown as "suggested". */
  confirmed: boolean;
  /** 'after_deal' (default): on the food after the shop's part of the deal, before tax. */
  base: FoodpandaCommissionBase;
  /** A fixed fee per order (paisa, whole rupees). */
  fixedFeeCents: number;
  /** Tax foodpanda adds on its commission, basis points. */
  commissionTaxBps: number;
}

export type FoodpandaCheckRule = 'optional' | 'required';

/** What Pay asks on a foodpanda order ('foodpanda.checks'). */
export interface FoodpandaChecks {
  v: number;
  /** foodpanda's order number (kept in payments.reference_no). */
  orderCode: FoodpandaCheckRule;
  /** The total the foodpanda tablet shows (kept with the order's channel terms). */
  tabletTotal: FoodpandaCheckRule;
}

export interface ShopSettingValues {
  'foodpanda.deal': FoodpandaDeal;
  'foodpanda.fees': FoodpandaFees;
  'foodpanda.checks': FoodpandaChecks;
}
export type ShopSettingValue<K extends ShopSettingKey> = ShopSettingValues[K];

/** The format this version writes each key in. */
export const SHOP_SETTING_FORMAT: Readonly<Record<ShopSettingKey, number>> = Object.freeze({
  'foodpanda.deal': 1,
  'foodpanda.fees': 1,
  'foodpanda.checks': 1,
});

/** foodpanda's commission until the owner confirms his own (costing spec 4.7): shown as "suggested". */
export const SUGGESTED_FOODPANDA_COMMISSION_BPS = 2500;

/** Today: no deal is recorded, foodpanda orders are at full till price. */
export const DEFAULT_FOODPANDA_DEAL: Readonly<FoodpandaDeal> = Object.freeze({
  v: 1,
  percent: 0,
  shopPercent: 0,
  minOrderCents: null,
  maxOffCents: null,
  startsOn: null,
  endsOn: null,
});

/** Not set: Reports estimate 25%, marked "suggested" until confirmed. */
export const DEFAULT_FOODPANDA_FEES: Readonly<FoodpandaFees> = Object.freeze({
  v: 1,
  commissionBps: SUGGESTED_FOODPANDA_COMMISSION_BPS,
  confirmed: false,
  base: 'after_deal',
  fixedFeeCents: 0,
  commissionTaxBps: 0,
});

/** Shown at Pay, optional (today neither is asked). */
export const DEFAULT_FOODPANDA_CHECKS: Readonly<FoodpandaChecks> = Object.freeze({
  v: 1,
  orderCode: 'optional',
  tabletTotal: 'optional',
});

export const SHOP_SETTING_DEFAULTS: { readonly [K in ShopSettingKey]: Readonly<ShopSettingValues[K]> } = Object.freeze({
  'foodpanda.deal': DEFAULT_FOODPANDA_DEAL,
  'foodpanda.fees': DEFAULT_FOODPANDA_FEES,
  'foodpanda.checks': DEFAULT_FOODPANDA_CHECKS,
});

/** A tablet total more than this far from the till's total is a mismatch (Rs 1). */
export const FOODPANDA_TABLET_TOLERANCE_CENTS = 100;

/** The longest foodpanda order number kept (payments.reference_no). */
export const FOODPANDA_ORDER_CODE_MAX = 40;

// ---------------------------------------------------------------------------
// The deal as it is frozen onto an order
// ---------------------------------------------------------------------------

/** Where an order's discount came from: null = typed by staff (F3). */
export type DiscountSource = 'foodpanda';

/**
 * The foodpanda deal's terms, frozen onto the order's discount row
 * (order_discounts.rule_json) when the order became foodpanda. The order's
 * rupees are always re-worked from THIS, never from the live setting: a
 * Save while the order is open, or a Save still syncing to the other till,
 * can't move it.
 */
export interface FoodpandaDealRule {
  kind: 'foodpanda_deal';
  v: 1;
  /** "Foodpanda deal 20% off" (+ "(your part 10%)" when shared). */
  label: string;
  dealPercent: number;
  shopPercent: number;
  minOrderCents: number | null;
  maxOffCents: number | null;
  /** When the setting was saved (its updated_at); null = the default. */
  settingsAt: string | null;
}

/** A discount's foodpanda figures, on the order snapshot (bill, receipt, Pay). */
export interface FoodpandaDealShare {
  dealPercent: number;
  shopPercent: number;
  /** The whole deal on this order: what the customer sees off. */
  dealCents: number;
  /** foodpanda's part, paid by foodpanda on top of the bill (0 unless shared). */
  platformCents: number;
  /**
   * The deal's minimum order (food at till prices), as frozen on the order;
   * null = any order. Below it the deal takes nothing off, and the cart says
   * from how much it does.
   */
  minOrderCents?: number | null;
}

// ---------------------------------------------------------------------------
// The Settings cards (settings:getBusiness / settings:setBusiness)
// ---------------------------------------------------------------------------

/** One change to a setting, for the card's History (audit_log: this till's saves and the other till's). */
export interface ShopSettingHistoryLine<K extends ShopSettingKey = ShopSettingKey> {
  at: string;
  byName: string | null;
  /** Saved on this till, or arrived from the other one. */
  onThisTill: boolean;
  /** The value as saved (fields this version knows); null when it can't be read. */
  value: ShopSettingValues[K] | null;
}

export interface ShopSettingCard<K extends ShopSettingKey = ShopSettingKey> {
  key: K;
  /** The value in use: the saved one, or the default when nothing is saved. */
  value: ShopSettingValues[K];
  defaultValue: ShopSettingValues[K];
  /**
   * The value in use is the default's: nothing saved yet, or the default was
   * put back (which writes its values). `lastChanged` says whether it was ever saved.
   */
  isDefault: boolean;
  /** Saved by a newer version of the app: this till reads it but may not save it. */
  readOnly: boolean;
  /** Who saved it last, when, and where; null when never saved. */
  lastChanged: { at: string; byName: string | null; onThisTill: boolean | null } | null;
  /** The link to the other till is on and this till's last save has not reached it yet. */
  notOnOtherTillYet: boolean;
  /** Newest first, capped. */
  history: Array<ShopSettingHistoryLine<K>>;
}

/** settings:getBusiness answers one card; this is the union over the keys. */
export type AnyShopSettingCard = { [K in ShopSettingKey]: ShopSettingCard<K> }[ShopSettingKey];

/** settings:setBusiness: a new value for a key, or "Put back the default" (writes the default's values). */
export type SetShopSettingRequest =
  | { [K in ShopSettingKey]: { key: K; value: ShopSettingValues[K] } }[ShopSettingKey]
  | { key: ShopSettingKey; useDefault: true };

// ---------------------------------------------------------------------------
// What the counter needs (checkout:getRules): never commission or costs
// ---------------------------------------------------------------------------

export interface CheckoutRules {
  foodpanda: {
    /** The deal a foodpanda order started now gets; null when there is none today. */
    deal: {
      label: string;
      percent: number;
      shopPercent: number;
      minOrderCents: number | null;
      maxOffCents: number | null;
    } | null;
    /** What Pay asks on a foodpanda order. */
    checks: { orderCode: FoodpandaCheckRule; tabletTotal: FoodpandaCheckRule };
    /** A tablet total further than this from the till's total is a mismatch. */
    tabletToleranceCents: number;
  };
}

/** The foodpanda half of orders:tender (the order number goes on the payment's referenceNo). */
export interface FoodpandaTenderCheck {
  /** The total the foodpanda tablet shows, paisa; null when not typed. */
  tabletTotalCents?: number | null;
}
