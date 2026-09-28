/**
 * The shop's business rules the owner edits himself in Settings (owner,
 * 2026-09-27: "Everything should be editable for the admin — percentage and
 * other settings… it should be a complete package"). Each rule is one key of
 * business_settings (migration 0032): synced between the tills, saved through
 * business-settings-repo (row + sync + hash-chained audit, one transaction)
 * and checked by its Zod schema in shared-schemas business-settings.ts.
 *
 * Phase 1 is foodpanda: the deal on the listing, foodpanda's fees and the
 * checks at Pay. Phase 2 the approval limit and the discount buttons (Money
 * & discounts); phase 6 the staff and kitchen timings; phase 7 the stock
 * rules and what a menu file import may change (Kitchen & stock); then the
 * Cancel, Refund and Cash out reason buttons (Staff & kitchen). Later phases add
 * their own keys here (delivery areas and fees, offers, the shop profile…),
 * each with a frozen default.
 *
 * FROZEN DEFAULTS. A key never saved reads as its DEFAULT_* below, which is
 * exactly what the till did before the setting existed, so installing the
 * version changes nothing — with ONE owner-decided exception,
 * 'discounts.delivery' (see DEFAULT_DISCOUNT_DELIVERY). A test pins every value (pos-domain
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

import { WASTE_REASONS, WASTE_REASON_DEFAULT_LABEL, type WasteReasonId } from './inventory.js';

/** The keys the Settings cards edit (settings:getBusiness / settings:setBusiness). */
export const SHOP_SETTING_KEYS = [
  'foodpanda.deal',
  'foodpanda.fees',
  'foodpanda.checks',
  'discounts.approval',
  'discounts.presets',
  'discounts.delivery',
  'staff.timing',
  'kitchen.timing',
  'stock.rules',
  'menu.importPolicy',
  'orders.reasons',
] as const;
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
 *
 * The ONE place foodpanda's money terms live (owner, 2026-09-27: foodpanda is
 * its own Settings section). v0.7.20 kept a commission in 'channels.fees'
 * (Costing → Targets & fees): retired, and read only while this key has
 * never been saved (business-settings-read.ts readShopSetting carries it
 * over).
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
  /**
   * How much above the till's prices the foodpanda menu is, basis points
   * (1000 = the listing is 10% dearer; 0 = the till's prices, the default).
   * The till still rings foodpanda orders at till prices (the FBR invoice
   * and every stored total are the till's); the listing price, the
   * commission's base, the tablet total Pay expects, the expected payout and
   * Reports' "price uplift" are worked out at the dearer prices.
   */
  upliftBps: number;
  /**
   * foodpanda's fee on each order's total, basis points (0 = none, the
   * default): a share of the total the foodpanda tablet shows (tax included,
   * at foodpanda's prices) that foodpanda keeps for taking the money. In
   * what foodpanda keeps, beside the commission. v0.7.20 kept it as the
   * "Foodpanda" payment fee in Costing → Targets & fees ('channels.fees'
   * paymentFeeBps.foodpanda): carried over with the rest, never charged there.
   */
  paymentFeeBps: number;
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

// ---------------------------------------------------------------------------
// Money & discounts (phase 2)
// ---------------------------------------------------------------------------

/**
 * How much a cashier can take off an order without a manager's PIN or
 * password ('discounts.approval'). The ONE rule is pos-domain
 * requiresManagerApproval(d, subtotal, limits): the F3 screen's locks (from
 * checkout:getRules), the IPC check and the repository's save and cart
 * re-check (both read the live setting in the main process) all call it.
 */
export interface DiscountApproval {
  v: number;
  /** A % discount over this needs a manager (whole %, 0–50). 0 = every discount needs one. */
  percentOver: number;
  /**
   * A discount in rupees over this needs a manager (paisa, whole rupees,
   * Rs 0–5,000). A rupee amount is also held to `percentOver` of the order,
   * as before (Rs 499 off a Rs 600 order is 83% off). 0 = every rupee
   * discount needs one.
   */
  flatOverCents: number;
}

/** The limits requiresManagerApproval works with (the setting without its format). */
export type ApprovalLimits = Pick<DiscountApproval, 'percentOver' | 'flatOverCents'>;

/** The owner's bounds on the approval limit: a whole % from 0 to 50, Rs 0 to Rs 5,000. */
export const APPROVAL_MAX_PERCENT = 50;
export const APPROVAL_MAX_FLAT_CENTS = 500_000;

/**
 * The F3 discount screen's one-tap buttons ('discounts.presets'). A button
 * above the approval limit shows the lock; typing any other amount or
 * reason still works.
 */
export interface DiscountPresets {
  v: number;
  /** One-tap % buttons, whole % 1–100: one to five of them. */
  percents: number[];
  /** One-tap rupee buttons (paisa, whole rupees, Rs 1–5,000): one to three. */
  flatCents: number[];
  /** One-tap reasons, printed on the bill and grouped in Team & leakage: one to eight, 30 letters at most. */
  reasons: string[];
}

/**
 * Whether an order's discount also comes off its delivery charge
 * ('discounts.delivery'). The owner, 28 Sep 2026: "Delivery charges is
 * separate we don't want to add discount to it" — so by default NO: a staff
 * discount (a % or rupees, F3) and the foodpanda deal are worked on the food
 * only (pos-domain discountBaseCents), a rupee amount is at most the food,
 * 100% off leaves the delivery charge to pay, and the split for tax, the FBR
 * invoice and profit gives the delivery charge none of it. The approval
 * limit is checked on the same food-only amount.
 *
 * The rule in force is FROZEN onto each discount row when it is given
 * (order_discounts.rule_json, DiscountBaseRule below, or the foodpanda
 * deal's rule), and every reader after the fact follows the row, never this
 * setting: turning it on or off changes discounts given from then on, never
 * one already on an order, never a paid order. A website order follows the
 * website's own pricing, never this switch.
 */
export interface DiscountDelivery {
  v: number;
  /** true = a discount comes off the whole bill, delivery charge too (the till before 0.7.26). */
  alsoOffDeliveryCharge: boolean;
}

export const PRESET_PERCENTS_MAX = 5;
export const PRESET_FLATS_MAX = 3;
export const PRESET_FLAT_MAX_CENTS = 500_000;
export const PRESET_REASONS_MAX = 8;
export const PRESET_REASON_MAX_LENGTH = 30;

// ---------------------------------------------------------------------------
// Staff & kitchen timing (phase 6). Only timings: who can do what stays in
// the role table (auth.ts ROLE_CAPABILITIES), never a switch here.
// ---------------------------------------------------------------------------

/**
 * How long logins last and how many free reprints a cashier gets
 * ('staff.timing'). auth-service reads it on both tills (login expiry,
 * restart recovery, the startup clean-up); reprint-policy.ts and the
 * step-in hold too. Cashiers are still never signed out for being idle.
 * The DUPLICATE marks and the print log never change.
 */
export interface StaffTiming {
  v: number;
  /** An owner or manager login with nobody touching the till ends after this many minutes (5–60; never off). */
  idleLogoutMin: number;
  /** Any login ends after this many hours (8–24). */
  maxLoginHours: number;
  /** A manager or the owner stepping in on a cashier's till is held after this many minutes (5–30). */
  stepInMin: number;
  /** Papers of a paid receipt a cashier may print by hand for the order in front of them (0–3). */
  freeReprints: number;
  /** How long after the sale an order still counts as in front of the counter, minutes (10–120). */
  reprintWindowMin: number;
}

/** The owner's bounds on each staff timing (whole numbers, inclusive). */
export const STAFF_TIMING_BOUNDS: Readonly<Record<Exclude<keyof StaffTiming, 'v'>, readonly [number, number]>> = Object.freeze({
  idleLogoutMin: [5, 60] as const,
  maxLoginHours: [8, 24] as const,
  stepInMin: [5, 30] as const,
  freeReprints: [0, 3] as const,
  reprintWindowMin: [10, 120] as const,
});

/**
 * The Live Orders board's colours and the "order waiting too long"
 * reminders ('kitchen.timing'). The Sounds and board wording is built from
 * these values.
 */
export interface KitchenTiming {
  v: number;
  /** A card turns amber this many minutes after the order came in. */
  amberMin: number;
  /** …and red after this many (more than amberMin). */
  redMin: number;
  /** A reminder when an order is still in New this many minutes after it came in. */
  notStartedMin: number;
  /** …and when it is still not done after this many (more than notStartedMin). */
  notDoneMin: number;
}

/** The owner's bounds on each kitchen timing (whole minutes, inclusive). */
export const KITCHEN_TIMING_BOUNDS: Readonly<Record<Exclude<keyof KitchenTiming, 'v'>, readonly [number, number]>> = Object.freeze({
  amberMin: [5, 60] as const,
  redMin: [10, 120] as const,
  notStartedMin: [5, 60] as const,
  notDoneMin: [10, 120] as const,
});

// ---------------------------------------------------------------------------
// Kitchen & stock (phase 7)
// ---------------------------------------------------------------------------

/**
 * The rating of "used vs should have used" (what went unexplained ÷ food
 * sales, either way), basis points: under `goodUnderBps` Good; up to
 * `okUpToBps` OK; up to `needsWorkUpToBps` Needs work; above it Look at it
 * now. Today 2% / 3% / 5% (meez).
 */
export interface VarianceBands {
  goodUnderBps: number;
  okUpToBps: number;
  needsWorkUpToBps: number;
}

/**
 * The Dashboard's "Do this" reminds the owner to take stock: the key items
 * (a key-items or full stock take counts) and a full stock take, each when
 * the last one was finished this many trading days ago or more (or never).
 * Null: no reminder (today: both off).
 */
export interface StockTakeReminders {
  keyItemsEveryDays: number | null;
  fullEveryDays: number | null;
}

/**
 * One reason on the Waste screen. The id is FIXED: waste rows keep
 * 'waste:<id>' and Reports group by it, so a new name shows on every old
 * row too. A saved reason can be hidden (off the Waste screen, still named
 * in Reports and the history) but not removed: either till may have waste
 * rows with it, and the other till's may not have arrived yet. Only one
 * added since the last Save can come off. The seven the till was released
 * with (WASTE_REASONS) are never removed.
 */
export interface WasteReasonSetting {
  id: WasteReasonId;
  /** The name on the Waste screen, in Reports and the stock history (30 letters at most). */
  label: string;
  /** Not offered on the Waste screen any more. */
  hidden: boolean;
}

/**
 * The stock rules ('stock.rules'): when "used vs should have used" is a
 * "Do this" line and how it is rated (Dashboard, the weekly sheet, Reports →
 * Between stock takes), the stock-take reminders, the stock bar's and a
 * purchase order's multiple of the low level, and the waste reasons.
 */
export interface StockRules {
  v: number;
  /**
   * "Do this" lists the latest two stock takes when more than this share of
   * the food sales between them went unexplained (basis points; 300 = 3%).
   */
  varianceDoThisBps: number;
  bands: VarianceBands;
  /**
   * The shortest stretch between two stock takes that "Do this" turns into
   * rupees a week (days; a shorter one would be scaled UP to a week, so it
   * is left to Reports, which shows it as it is).
   */
  varianceMinWindowDays: number;
  reminders: StockTakeReminders;
  /**
   * A full stock bar is this many times the low level (the low mark sits at
   * 1 ÷ this of the bar), and "Add low stock" on a purchase order fills up
   * to it.
   */
  reorderMultiple: number;
  /** In the order the Waste screen and Reports list them. */
  wasteReasons: WasteReasonSetting[];
}

/** The owner's bounds on the stock rules (whole numbers, inclusive; basis points in steps of 0.1%). */
export const STOCK_RULE_BOUNDS = Object.freeze({
  varianceDoThisBps: [50, 2_000] as const,
  bandBps: [50, 2_000] as const,
  varianceMinWindowDays: [1, 28] as const,
  keyItemsEveryDays: [1, 31] as const,
  fullEveryDays: [7, 92] as const,
  reorderMultiple: [2, 10] as const,
});
/** A share in the stock rules is a whole number of tenths of a % (10 basis points). */
export const STOCK_RULE_BPS_STEP = 10;
/** At most this many waste reasons, hidden ones included. */
export const WASTE_REASONS_MAX = 16;
/** A waste reason's name is printed on reports: one line, this many letters at most. */
export const WASTE_REASON_LABEL_MAX = 30;

/** Which side wins on a menu file import: the file's value, or the one on the till. */
export type ImportSide = 'file' | 'till';

/**
 * What a menu file import may change on things the till ALREADY has
 * ('menu.importPolicy'). New items, choices, ingredients and recipes always
 * come in; nothing is ever deleted, renamed or re-categorised; ingredient
 * prices stay the till's (v0.7.14, costing spec Phase 6: the sheet prices
 * only a new ingredient or one with none). Each 'till' is shown in the
 * import preview as "kept on the till".
 */
export interface MenuImportPolicy {
  v: number;
  /** A menu item's selling price. */
  itemPrices: ImportSide;
  /** A choice's extra charge, which option is picked first, what it leaves out, and how many to pick. New options still come in (with 'till': not picked first). */
  choices: ImportSide;
  /** A dish's recipe, and a batch recipe (what the kitchen makes), where the till has one. */
  recipes: ImportSide;
  /** Moving items onto the file's tax rate. */
  tax: ImportSide;
}

// ---------------------------------------------------------------------------
// Reason buttons (Settings → Staff & kitchen)
// ---------------------------------------------------------------------------

/**
 * What a reason button says about "Was the food made?": 'made', 'not_made',
 * or 'ask' (nothing: staff tap Made or Not made).
 */
export type ReasonFoodAnswer = 'made' | 'not_made' | 'ask';

/**
 * One button on the Cancel or Refund box. What is SAVED is the label's text
 * (the order's cancel reason, the refund's reason), exactly as before the
 * buttons were editable: Team & leakage lists every row by the words it was
 * saved with, so renaming a button never changes an old row. The id only
 * lets the Settings card follow a button while it is renamed or moved.
 *
 * `food` fills "Was the food made?" only while nobody has answered it: never
 * over a tap, never over the "Made" the till starts on once cooking was
 * marked, and never once the food has left the shop (then there is no
 * question: the till counts it as waste whatever is tapped, and refuses
 * "not made" — pos-domain FOOD_LEFT_SHOP).
 */
export interface OrderReasonButton {
  id: string;
  /** On the button, and saved as the reason (30 letters at most). */
  label: string;
  food: ReasonFoodAnswer;
}

/**
 * The reason buttons ('orders.reasons'): the Cancel box's and the Refund
 * box's, and the drawer's "Cash out" ones. A reason and the manager's PIN
 * are still needed for every cancel and refund (the main process checks),
 * and any other reason can still be typed. Nothing here changes who may do
 * what.
 */
export interface OrderReasons {
  v: number;
  /** The Cancel box's buttons, in order: one to eight. */
  cancel: OrderReasonButton[];
  /** The Refund box's buttons: one to eight. */
  refund: OrderReasonButton[];
  /**
   * What cash taken out of the drawer was for (Drawer cash in / out → Cash
   * out): none to eight buttons that fill the "What was it for?" box. None
   * (today): it is typed.
   */
  cashOut: string[];
}

export const ORDER_REASONS_MAX = 8;
export const CASH_OUT_REASONS_MAX = 8;
/** A reason button's words: one line, this many letters at most (a cash-out reason is kept to 80). */
export const ORDER_REASON_LABEL_MAX = 30;
/** A reason button's id: lower-case letters, digits and "_". */
export const ORDER_REASON_ID_RE = /^[a-z0-9_]{1,40}$/;

export interface ShopSettingValues {
  'foodpanda.deal': FoodpandaDeal;
  'foodpanda.fees': FoodpandaFees;
  'foodpanda.checks': FoodpandaChecks;
  'discounts.approval': DiscountApproval;
  'discounts.presets': DiscountPresets;
  'discounts.delivery': DiscountDelivery;
  'staff.timing': StaffTiming;
  'kitchen.timing': KitchenTiming;
  'stock.rules': StockRules;
  'menu.importPolicy': MenuImportPolicy;
  'orders.reasons': OrderReasons;
}
export type ShopSettingValue<K extends ShopSettingKey> = ShopSettingValues[K];

/** The format this version writes each key in. */
export const SHOP_SETTING_FORMAT: Readonly<Record<ShopSettingKey, number>> = Object.freeze({
  'foodpanda.deal': 1,
  'foodpanda.fees': 1,
  'foodpanda.checks': 1,
  'discounts.approval': 1,
  'discounts.presets': 1,
  'discounts.delivery': 1,
  'staff.timing': 1,
  'kitchen.timing': 1,
  'stock.rules': 1,
  'menu.importPolicy': 1,
  'orders.reasons': 1,
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
  upliftBps: 0,
  paymentFeeBps: 0,
});

/** Shown at Pay, optional (today neither is asked). */
export const DEFAULT_FOODPANDA_CHECKS: Readonly<FoodpandaChecks> = Object.freeze({
  v: 1,
  orderCode: 'optional',
  tabletTotal: 'optional',
});

/**
 * Today: over 10%, or over Rs 500 (or over 10% of the order), needs a
 * manager (was MANAGER_APPROVAL_PERCENT_THRESHOLD / _FLAT_CENTS_THRESHOLD).
 */
export const DEFAULT_DISCOUNT_APPROVAL: Readonly<DiscountApproval> = Object.freeze({
  v: 1,
  percentOver: 10,
  flatOverCents: 50_000,
});

/** Today's buttons (owner, 2026-09-26): 10 / 20 / 25 / 50 / 100 %, Rs 100 / 200 / 500, four reasons. */
export const DEFAULT_DISCOUNT_PRESETS: Readonly<DiscountPresets> = Object.freeze({
  v: 1,
  percents: Object.freeze([10, 20, 25, 50, 100]) as number[],
  flatCents: Object.freeze([10_000, 20_000, 50_000]) as number[],
  reasons: Object.freeze(['Staff', 'Friends & family', 'Regular customer', 'Complaint']) as string[],
});

/**
 * NO: a discount leaves the delivery charge alone (the owner's answer, 28 Sep
 * 2026). THE ONE DEFAULT THAT IS NOT "what the till did before": until
 * 0.7.26 a discount came off the delivery charge too. Installing this
 * version therefore changes discounts given from then on, by the owner's
 * decision; nothing already on an order or paid moves (each discount row
 * carries its own frozen rule, and a row with none is read the old way).
 * An older till (0.7.25 or before) still spreads a discount over every line
 * (when it gives one, re-works one on a cart change, invoices or refunds
 * one): update both tills the same day, before anyone gives a discount. Frozen from release like the
 * others: never edit it.
 */
export const DEFAULT_DISCOUNT_DELIVERY: Readonly<DiscountDelivery> = Object.freeze({
  v: 1,
  alsoOffDeliveryCharge: false,
});

/** Today: 15 minutes idle (owner / manager), 12 hours a login, a 10-minute step-in, one free reprint within 30 minutes. */
export const DEFAULT_STAFF_TIMING: Readonly<StaffTiming> = Object.freeze({
  v: 1,
  idleLogoutMin: 15,
  maxLoginHours: 12,
  stepInMin: 10,
  freeReprints: 1,
  reprintWindowMin: 30,
});

/** Today: amber at 15 minutes, red at 30; reminders when not started after 10, not done after 30. */
export const DEFAULT_KITCHEN_TIMING: Readonly<KitchenTiming> = Object.freeze({
  v: 1,
  amberMin: 15,
  redMin: 30,
  notStartedMin: 10,
  notDoneMin: 30,
});

/** Today: good under 2%, OK up to 3%, needs work up to 5%, look at it now above (was pos-domain varianceBand's numbers). */
export const DEFAULT_VARIANCE_BANDS: Readonly<VarianceBands> = Object.freeze({
  goodUnderBps: 200,
  okUpToBps: 300,
  needsWorkUpToBps: 500,
});

/**
 * Today: "Do this" over 3% of food sales, between stock takes 6 days or
 * more apart (was VARIANCE_DO_THIS_BPS / _MIN_WINDOW_MS); no stock-take
 * reminders; a full stock bar and "Add low stock" at 3 × the low level (was
 * stockFill / suggestReorderQty); the seven waste reasons with their names.
 */
export const DEFAULT_STOCK_RULES: Readonly<StockRules> = Object.freeze({
  v: 1,
  varianceDoThisBps: 300,
  bands: DEFAULT_VARIANCE_BANDS,
  varianceMinWindowDays: 6,
  reminders: Object.freeze({ keyItemsEveryDays: null, fullEveryDays: null }) as StockTakeReminders,
  reorderMultiple: 3,
  wasteReasons: Object.freeze(
    WASTE_REASONS.map((id) => Object.freeze({ id, label: WASTE_REASON_DEFAULT_LABEL[id], hidden: false })),
  ) as WasteReasonSetting[],
}) as Readonly<StockRules>;

/** Today: the file wins on everything but ingredient prices (the till keeps those since v0.7.14). */
export const DEFAULT_MENU_IMPORT_POLICY: Readonly<MenuImportPolicy> = Object.freeze({
  v: 1,
  itemPrices: 'file',
  choices: 'file',
  recipes: 'file',
  tax: 'file',
});

const reasonButton = (id: string, label: string, food: ReasonFoodAnswer): OrderReasonButton => Object.freeze({ id, label, food });

/**
 * Today's buttons, in today's order (they were typed into the Cancel and
 * Refund boxes: stockCopy.ts CANCEL_REASONS / REFUND_REASONS), and no
 * cash-out buttons.
 */
export const DEFAULT_ORDER_REASONS: Readonly<OrderReasons> = Object.freeze({
  v: 1,
  cancel: Object.freeze([
    reasonButton('customer_cancelled', 'Customer cancelled', 'ask'),
    reasonButton('refused_at_door', 'Refused at the door', 'made'),
    reasonButton('not_collected', 'Not collected', 'made'),
    reasonButton('wrong_order_duplicate', 'Wrong order / duplicate', 'not_made'),
    reasonButton('out_of_stock', 'Out of stock', 'not_made'),
  ]) as OrderReasonButton[],
  refund: Object.freeze([
    reasonButton('customer_unhappy', 'Customer unhappy', 'ask'),
    reasonButton('wrong_order', 'Wrong order', 'ask'),
    reasonButton('cancelled_by_foodpanda', 'Cancelled by Foodpanda', 'ask'),
    reasonButton('out_of_stock', 'Out of stock', 'not_made'),
  ]) as OrderReasonButton[],
  cashOut: Object.freeze([] as string[]) as string[],
}) as Readonly<OrderReasons>;

export const SHOP_SETTING_DEFAULTS: { readonly [K in ShopSettingKey]: Readonly<ShopSettingValues[K]> } = Object.freeze({
  'foodpanda.deal': DEFAULT_FOODPANDA_DEAL,
  'foodpanda.fees': DEFAULT_FOODPANDA_FEES,
  'foodpanda.checks': DEFAULT_FOODPANDA_CHECKS,
  'discounts.approval': DEFAULT_DISCOUNT_APPROVAL,
  'discounts.presets': DEFAULT_DISCOUNT_PRESETS,
  'discounts.delivery': DEFAULT_DISCOUNT_DELIVERY,
  'staff.timing': DEFAULT_STAFF_TIMING,
  'kitchen.timing': DEFAULT_KITCHEN_TIMING,
  'stock.rules': DEFAULT_STOCK_RULES,
  'menu.importPolicy': DEFAULT_MENU_IMPORT_POLICY,
  'orders.reasons': DEFAULT_ORDER_REASONS,
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
  /**
   * How much dearer the foodpanda listing was when the order became
   * foodpanda ('foodpanda.fees' upliftBps, basis points; 0 = the till's
   * prices, and on a rule written without it). foodpanda applies the deal's
   * minimum and most-off to the order at ITS prices, so the till does too
   * (pos-domain dealAmount), and the shop's part comes out the same.
   */
  upliftBps: number;
  /**
   * Whether the deal also came off a delivery-charge line on the order
   * ('discounts.delivery' when the order became foodpanda). false = the deal,
   * its minimum and its most-off are worked on the food only. Absent on a
   * rule written before 0.7.26 = true (every line, as then). An optional
   * field of format 1: an older till reading it keeps the rest of the deal.
   */
  alsoOffDeliveryCharge?: boolean;
}

/**
 * How a staff (F3) or website discount was worked, FROZEN onto its row
 * (order_discounts.rule_json, source NULL) when it was given. Every later
 * cart change and every reader after the fact (the tax split, the FBR
 * invoice of a late or queued sale and of a refund, profit, reprints) follow
 * THIS, never the live setting. A row with no rule (given before 0.7.26, or
 * on an older till) reads as `alsoOffDeliveryCharge: true`, exactly as it
 * was worked then.
 */
export interface DiscountBaseRule {
  kind: 'discount_base';
  v: 1;
  /** false = worked on, and split over, the food only (delivery-charge lines take none of it). */
  alsoOffDeliveryCharge: boolean;
  /**
   * Whose rule it is: 'till' = Settings → Money & discounts
   * ('discounts.delivery') when the discount was given; 'website' = the
   * website's own pricing for a web order (apps/web lib/pricing priceOrder:
   * the % over every line it priced), never the till's switch.
   */
  from: 'till' | 'website';
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
   * The deal's minimum order as food at TILL prices (the owner types it at
   * foodpanda's prices: pos-domain dealMinTillCents turns it back), as
   * frozen on the order; null = any order. Below it the deal takes nothing
   * off, and the cart says from how much it does.
   */
  minOrderCents?: number | null;
  /**
   * What the deal is worked on, at till prices: the food (the delivery
   * charge left out when the deal's rule says so), else the subtotal. The
   * cart compares the minimum with THIS.
   */
  baseCents?: number;
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
  /**
   * What "Put back the default" writes: the default's values (the stock
   * rules also keep every waste reason the owner added, hidden — either till
   * may have waste entries with it).
   */
  defaultValue: ShopSettingValues[K];
  /**
   * The value in use is the default's: nothing saved yet, or the default was
   * put back (which writes its values). `lastChanged` says whether it was ever saved.
   */
  isDefault: boolean;
  /** Saved by a newer version of the app: this till reads it but may not save it. */
  readOnly: boolean;
  /**
   * 'foodpanda.fees' only: never saved here, and the value in use is what
   * v0.7.20's Costing → Targets & fees saved (carried over; a Save keeps it
   * here, and Save is offered at once). `lastChanged` is then that save.
   */
  carriedOver?: boolean;
  /** Who saved it last, when, and where; null when never saved (for a carried-over value: the v0.7.20 save). */
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
  /**
   * The F3 screen: when a discount needs a manager (the locks; the main
   * process decides again on save) and the one-tap buttons.
   */
  discounts: {
    approval: ApprovalLimits;
    presets: Omit<DiscountPresets, 'v'>;
    /**
     * A discount given now also comes off the delivery charge
     * ('discounts.delivery'): the F3 screen's amounts, locks and words. The
     * main process reads the setting again when it saves the discount.
     */
    alsoOffDeliveryCharge: boolean;
  };
  /** The Live Orders colours and the "waiting too long" reminders. */
  kitchen: Omit<KitchenTiming, 'v'>;
  /**
   * Inventory (Settings → Kitchen & stock): the Waste screen's reasons —
   * hidden ones too, so an old row keeps its name in the stock history — the
   * stock bar's and "Add low stock"'s multiple of the low level, and the
   * stock-take reminders. Absent (a test, or before the till answers): the
   * released ones.
   */
  stock?: CounterStockRules;
  /**
   * The reason buttons (Settings → Staff & kitchen): the Cancel and Refund
   * boxes' and the drawer's Cash out ones. Absent (a test, or before the
   * till answers): the released ones.
   */
  reasons?: CounterOrderReasons;
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
    /** A tablet total further than this from the one expected is a mismatch. */
    tabletToleranceCents: number;
    /**
     * How much above the till's prices the foodpanda menu is, basis points:
     * the tablet shows the till's total at those prices (a price, not a cost).
     */
    upliftBps: number;
  };
}

/** The reason buttons as the counter uses them (checkout:getRules). */
export type CounterOrderReasons = Omit<OrderReasons, 'v'>;

/** The stock rules as the counter and Inventory use them (checkout:getRules): no variance figures. */
export interface CounterStockRules {
  reorderMultiple: number;
  wasteReasons: WasteReasonSetting[];
  reminders: StockTakeReminders;
}

/** The foodpanda half of orders:tender (the order number goes on the payment's referenceNo). */
export interface FoodpandaTenderCheck {
  /** The total the foodpanda tablet shows, paisa; null when not typed. */
  tabletTotalCents?: number | null;
}
