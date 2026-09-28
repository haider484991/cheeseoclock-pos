import {
  computeDiscountCents,
  discountBaseCents,
  formatCents,
  requiresManagerApproval,
  taxAfterDiscount,
  type TaxedDiscountLine,
} from '@cheeseoclock/pos-domain';
import {
  DEFAULT_DISCOUNT_APPROVAL,
  DEFAULT_DISCOUNT_DELIVERY,
  DEFAULT_DISCOUNT_PRESETS,
  isDeliveryChargeLine,
  type CheckoutRules,
  type DiscountPresets,
} from '@cheeseoclock/shared-types';

/**
 * The discount screen's one-tap choices and the live "what will the bill be"
 * preview. The preview works the total out exactly as the till does when the
 * discount is saved (order-repo recomputeOrderTotals): the discount split over
 * the lines in whole paisa, tax on what is left of each line.
 */

/** A discount as the till stores it: percent 0–100, or a flat amount in cents. */
export interface DiscountChoice {
  type: 'percent' | 'flat';
  value: number;
}

/**
 * The released one-tap buttons (owner, 2026-09-26): what the dialog shows
 * while nothing is saved. The owner's own are Settings → Money & discounts
 * ('discounts.presets', from checkout:getRules): presetButtons() below.
 */
export const PERCENT_PRESETS: readonly number[] = DEFAULT_DISCOUNT_PRESETS.percents;
/** One-tap flat amounts, in rupees (the released ones). */
export const FLAT_PRESETS_RUPEES: readonly number[] = DEFAULT_DISCOUNT_PRESETS.flatCents.map((c) => c / 100);
/** One-tap reasons; the reason prints on the bill and shows in the discount report (the released ones). */
export const REASON_PRESETS: readonly string[] = DEFAULT_DISCOUNT_PRESETS.reasons;

/** One one-tap button of the dialog. */
export interface PresetButton {
  key: string;
  /** "25%", "Rs 200". */
  label: string;
  choice: DiscountChoice;
}

/** The dialog's % and rupee buttons, built from the owner's values (in the order he saved them). */
export function presetButtons(presets: Pick<DiscountPresets, 'percents' | 'flatCents'>): {
  percent: PresetButton[];
  flat: PresetButton[];
} {
  return {
    percent: presets.percents.map((pct) => ({ key: `p${pct}`, label: `${pct}%`, choice: percentChoice(pct) })),
    flat: presets.flatCents.map((cents) => ({ key: `f${cents}`, label: formatCents(cents), choice: { type: 'flat' as const, value: cents } })),
  };
}

export function percentChoice(pct: number): DiscountChoice {
  return { type: 'percent', value: pct };
}
export function flatChoiceRupees(rupees: number): DiscountChoice {
  return { type: 'flat', value: Math.round(rupees * 100) };
}

export function sameChoice(a: DiscountChoice | null, b: DiscountChoice | null): boolean {
  return !!a && !!b && a.type === b.type && a.value === b.value;
}

/**
 * What the cashier typed in the "Other amount" box, as a discount — or null
 * when it is empty or not a usable amount. Percent is 0–100 (decimals allowed,
 * e.g. 12.5); rupees become whole paisa.
 */
export function parseDiscountEntry(kind: 'percent' | 'flat', text: string): DiscountChoice | null {
  const cleaned = text.replace(/,/g, '').trim();
  if (!/^\d+(\.\d+)?$|^\.\d+$/.test(cleaned)) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (kind === 'percent') {
    if (n > 100) return null;
    return { type: 'percent', value: Math.round(n * 100) / 100 };
  }
  return flatChoiceRupees(n);
}

/**
 * Why the Discount dialog was opened: 'change' (F3, the discount line, Add
 * discount) or 'removeDeal' (the × on the owner's foodpanda deal line — the
 * deal comes off only with a manager's PIN, so the dialog asks for it).
 */
export type DiscountDialogIntent = 'change' | 'removeDeal';

/** The order's discount as the dialog sees it (the snapshot's latest discount row). */
export interface CurrentDiscount {
  discountType: 'percent' | 'flat';
  value: number;
  reason: string | null;
  source?: string | null;
  /** One of the owner's automatic offers: whether the cashier took it off this order. */
  offer?: { declined: boolean } | null;
}

/**
 * Where the Discount dialog starts. A staff discount opens on itself (its
 * choice and its reason), so a tap changes it. The owner's foodpanda deal
 * (and each of his automatic offers) opens on NOTHING: re-applying its own % would turn the deal into a staff
 * discount without its minimum and most-off, under the manager's name — and
 * its label ("Foodpanda deal 20% off") is not the reason for any other
 * discount a manager types in its place.
 */
export function discountDialogStart(current: CurrentDiscount | null): { picked: DiscountChoice | null; reason: string } {
  // The owner's automatic offers too: its name is not the reason for a staff discount, and re-applying
  // it would make it a staff discount without its minimum and most-off.
  if (!current || current.source === 'foodpanda' || current.source === 'offer') return { picked: null, reason: '' };
  return { picked: { type: current.discountType, value: current.value }, reason: current.reason ?? '' };
}

/**
 * What Enter (and the big button) does: take the deal off when the dialog
 * was opened from the deal's × and nothing else is picked; otherwise apply
 * the choice.
 */
export function discountDialogPrimary(p: { dealOn: boolean; intent: DiscountDialogIntent; hasChoice: boolean }): 'apply' | 'remove' {
  return p.dealOn && p.intent === 'removeDeal' && !p.hasChoice ? 'remove' : 'apply';
}

/** "10% off", "Rs 200 off". */
export function describeDiscount(d: DiscountChoice): string {
  return d.type === 'percent' ? `${d.value}% off` : `${formatCents(d.value)} off`;
}

/**
 * The preview's words for a choice: "10% off", or "10% off food" when the
 * order has a delivery charge the discount leaves alone; a rupee amount
 * bigger than what it is worked on says so ("(the whole order)", "(all the
 * food)").
 */
export function describePreview(d: DiscountChoice, p: Pick<DiscountPreview, 'capped'>, base: Pick<DiscountBaseNow, 'untouchedCents'>): string {
  const foodOnly = base.untouchedCents > 0;
  const capped = p.capped ? (foodOnly ? ' (all the food)' : ' (the whole order)') : '';
  return `${describeDiscount(d)}${foodOnly ? ' food' : ''}${capped}`;
}

/** The order's discount as the dialog's header reads it: its choice and reason, and the rule frozen on it (the snapshot's). */
export interface CurrentDiscountOnOrder extends CurrentDiscount {
  alsoOffDeliveryCharge?: boolean;
}

/**
 * The header's "now …" words for the discount already on the order, and a
 * note when it was given under the other rule than the one a discount given
 * now follows (the owner changed "A discount also comes off the delivery
 * charge", or it was given before the rule existed). The header's first part
 * follows the switch as it is now (what Apply would do); these follow the
 * discount's OWN frozen rule (what the order's bill is), so the two never
 * contradict each other:
 *  - "10% off food": it leaves the delivery charge alone;
 *  - "10% off, delivery charge too": it came off the charge, while a
 *    discount given now would not;
 *  - "10% off": no delivery charge on the order, or both rules agree.
 * The owner's foodpanda deal keeps its own words.
 */
export function currentDiscountWords(
  current: CurrentDiscountOnOrder,
  lines: ReadonlyArray<{ readonly menuItemName?: string | null }>,
  rules: Pick<DiscountScreenRules, 'alsoOffDeliveryCharge'>,
): { now: string; ruleNote: string | null } {
  if (current.source === 'foodpanda' && current.reason) return { now: `${current.reason} (set by the owner)`, ruleNote: null };
  if (current.source === 'offer' && current.reason) {
    return {
      now: current.offer?.declined ? `${current.reason} taken off this order` : `${current.reason} (the owner’s offer)`,
      ruleNote: null,
    };
  }
  const choice = describeDiscount({ type: current.discountType, value: current.value });
  if (!lines.some(isDeliveryChargeLine)) return { now: choice, ruleNote: null };
  const itCovers = current.alsoOffDeliveryCharge !== false;
  if (itCovers === rules.alsoOffDeliveryCharge) return { now: itCovers ? choice : `${choice} food`, ruleNote: null };
  return itCovers
    ? {
        now: `${choice}, delivery charge too`,
        ruleNote: 'Given when a discount also came off the delivery charge. Apply it again to take it off the food only.',
      }
    : {
        now: `${choice} food`,
        ruleNote: 'Given when a discount was on the food only. Apply it again to take it off the delivery charge too.',
      };
}

/** The dialog's header: "Order Rs 2,000 before tax", or "Food Rs 2,000 before tax · delivery charge Rs 200 not discounted". */
export function discountBaseText(p: DiscountBaseNow, subtotalCents: number): string {
  if (p.untouchedCents > 0) {
    return `Food ${formatCents(p.baseCents)} before tax · delivery charge ${formatCents(p.untouchedCents)} not discounted`;
  }
  return `Order ${formatCents(subtotalCents)} before tax`;
}

export interface DiscountPreview {
  discountCents: number;
  taxCents: number;
  totalCents: number;
  /** Needs a manager's PIN: pos-domain requiresManagerApproval with the owner's limit, the rule the till enforces when saving. */
  needsApproval: boolean;
  /** A flat amount bigger than what it is worked on: only that much comes off. */
  capped: boolean;
}

/** What a discount given now is worked on, for the dialog's words. */
export interface DiscountBaseNow {
  /** Before tax: the food only, or (the owner's switch on) every line — the order's subtotal. */
  baseCents: number;
  /** The delivery charge on this order that a discount leaves alone (0 when there is none, or the switch is on). */
  untouchedCents: number;
}

/** The F3 screen's rules (checkout:getRules): the approval limit and whether a discount also comes off the delivery charge. */
export type DiscountScreenRules = Pick<CheckoutRules['discounts'], 'approval' | 'alsoOffDeliveryCharge'>;

/** The released rules: 10% / Rs 500, and a discount leaves the delivery charge alone. */
export const RELEASED_SCREEN_RULES: DiscountScreenRules = {
  approval: { percentOver: DEFAULT_DISCOUNT_APPROVAL.percentOver, flatOverCents: DEFAULT_DISCOUNT_APPROVAL.flatOverCents },
  alsoOffDeliveryCharge: DEFAULT_DISCOUNT_DELIVERY.alsoOffDeliveryCharge,
};

/**
 * The bill if `choice` were applied now, worked out exactly as the till does
 * when the discount is saved (order-repo applyDiscount / recomputeOrderTotals,
 * pos-domain discount-base.ts): a % of the food (every line with the owner's
 * switch on), a rupee amount at most that, split over the lines in whole
 * paisa with a delivery charge the discount leaves alone taking none, tax on
 * what is left of each line; the lock on the same base. `lines` are the
 * order's lines in ticket order (their totals, tax rates and the names they
 * were sold under); `subtotalCents` is their sum. With no choice it is the
 * bill with no discount. `rules` are the owner's (checkout:getRules); the
 * released ones when absent.
 */
export function previewDiscount(
  lines: ReadonlyArray<TaxedDiscountLine>,
  subtotalCents: number,
  choice: DiscountChoice | null,
  rules: DiscountScreenRules = RELEASED_SCREEN_RULES,
): DiscountPreview {
  const alsoOff = rules.alsoOffDeliveryCharge;
  const { baseCents } = discountBaseNow(lines, subtotalCents, rules);
  const discountCents = choice ? computeDiscountCents(baseCents, choice) : 0;
  const taxCents = subtotalCents > 0 ? taxAfterDiscount(lines, discountCents, alsoOff).taxCents : 0;
  return {
    discountCents,
    taxCents,
    totalCents: subtotalCents - discountCents + taxCents,
    needsApproval: choice ? requiresManagerApproval(choice, baseCents, rules.approval) : false,
    capped: !!choice && choice.type === 'flat' && choice.value > baseCents,
  };
}

/**
 * What a discount given now is worked on (pos-domain discountBaseCents): with
 * the switch on, every line — the order's subtotal, exactly as before; else
 * the food only, and the delivery charge it leaves alone.
 */
export function discountBaseNow(
  lines: ReadonlyArray<TaxedDiscountLine>,
  subtotalCents: number,
  rules: Pick<DiscountScreenRules, 'alsoOffDeliveryCharge'> = RELEASED_SCREEN_RULES,
): DiscountBaseNow {
  if (rules.alsoOffDeliveryCharge) return { baseCents: subtotalCents, untouchedCents: 0 };
  const baseCents = discountBaseCents(lines, false);
  return { baseCents, untouchedCents: Math.max(0, subtotalCents - baseCents) };
}
