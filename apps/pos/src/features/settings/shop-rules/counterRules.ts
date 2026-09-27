/**
 * The owner's rules as the counter uses them (checkout:getRules, any login):
 * the F3 screen's approval limit and buttons, and the Live Orders timings.
 *
 * Until the main process has answered — and on a till where nothing is
 * saved — these are the released defaults, which are exactly what the till
 * did before the settings existed. The screen may be a Save behind; the main
 * process decides every discount again when it is saved.
 */
import {
  DEFAULT_DISCOUNT_APPROVAL,
  DEFAULT_DISCOUNT_DELIVERY,
  DEFAULT_DISCOUNT_PRESETS,
  DEFAULT_KITCHEN_TIMING,
  type CheckoutRules,
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
