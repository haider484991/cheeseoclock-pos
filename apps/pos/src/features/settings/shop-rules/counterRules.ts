/**
 * The owner's rules as the counter uses them (checkout:getRules, any login):
 * the F3 screen's approval limit and buttons, the Live Orders timings, and
 * Inventory's stock rules (the Waste screen's reasons, the stock bar's and
 * "Add low stock"'s multiple, the stock-take reminders).
 *
 * Until the main process has answered — and on a till where nothing is
 * saved — these are the released defaults, which are exactly what the till
 * did before the settings existed. The screen may be a Save behind; the main
 * process decides every discount again when it is saved.
 */
import {
  DEFAULT_DELIVERY_ZONES,
  DEFAULT_DISCOUNT_APPROVAL,
  DEFAULT_DISCOUNT_DELIVERY,
  DEFAULT_DISCOUNT_PRESETS,
  DEFAULT_KITCHEN_TIMING,
  DEFAULT_STOCK_RULES,
  type CheckoutRules,
  type CounterStockRules,
  type DeliveryZoneSetting,
} from '@cheeseoclock/shared-types';

export type CounterDiscountRules = CheckoutRules['discounts'];
export type CounterKitchenTiming = CheckoutRules['kitchen'];

/**
 * The released F3 rules: over 10% or Rs 500 needs a manager; 10/20/25/50/100 %,
 * Rs 100/200/500, four reasons; a discount leaves the delivery charge alone
 * (the owner's answer, 28 Sep 2026).
 */
export const DEFAULT_COUNTER_DISCOUNTS: CounterDiscountRules = {
  approval: { percentOver: DEFAULT_DISCOUNT_APPROVAL.percentOver, flatOverCents: DEFAULT_DISCOUNT_APPROVAL.flatOverCents },
  presets: {
    percents: [...DEFAULT_DISCOUNT_PRESETS.percents],
    flatCents: [...DEFAULT_DISCOUNT_PRESETS.flatCents],
    reasons: [...DEFAULT_DISCOUNT_PRESETS.reasons],
  },
  alsoOffDeliveryCharge: DEFAULT_DISCOUNT_DELIVERY.alsoOffDeliveryCharge,
};

/** The released Live Orders timings: amber 15, red 30; reminders at 10 (not started) and 30 (not done). */
export const DEFAULT_COUNTER_KITCHEN: CounterKitchenTiming = {
  amberMin: DEFAULT_KITCHEN_TIMING.amberMin,
  redMin: DEFAULT_KITCHEN_TIMING.redMin,
  notStartedMin: DEFAULT_KITCHEN_TIMING.notStartedMin,
  notDoneMin: DEFAULT_KITCHEN_TIMING.notDoneMin,
};

/** The F3 rules from checkout:getRules, or the released ones until it has answered. */
export function discountRulesOf(rules: Pick<CheckoutRules, 'discounts'> | null | undefined): CounterDiscountRules {
  return rules?.discounts ?? DEFAULT_COUNTER_DISCOUNTS;
}

/** The Live Orders timings from checkout:getRules, or the released ones until it has answered. */
export function kitchenTimingOf(rules: Pick<CheckoutRules, 'kitchen'> | null | undefined): CounterKitchenTiming {
  return rules?.kitchen ?? DEFAULT_COUNTER_KITCHEN;
}

/** The released stock rules: the seven waste reasons, a full stock bar at 3 × the low level, no reminders. */
export const DEFAULT_COUNTER_STOCK: CounterStockRules = {
  reorderMultiple: DEFAULT_STOCK_RULES.reorderMultiple,
  wasteReasons: DEFAULT_STOCK_RULES.wasteReasons.map((r) => ({ ...r })),
  reminders: { ...DEFAULT_STOCK_RULES.reminders },
};

/**
 * The delivery areas and fees (Settings → Delivery areas) from
 * checkout:getRules — every area, switched-off ones too — or the released
 * 21 until it has answered.
 */
export function deliveryZonesOf(rules: Pick<CheckoutRules, 'delivery'> | null | undefined): readonly DeliveryZoneSetting[] {
  return rules?.delivery?.zones ?? DEFAULT_DELIVERY_ZONES.zones;
}

/** Inventory's stock rules from checkout:getRules, or the released ones until it has answered. */
export function stockRulesOf(rules: Pick<CheckoutRules, 'stock'> | null | undefined): CounterStockRules {
  return rules?.stock ?? DEFAULT_COUNTER_STOCK;
}
