/**
 * Settings → Money & discounts: the approval limit, the F3 buttons and
 * whether a discount also comes off the delivery charge, as typed ↔ as
 * saved, and in plain words. The main process checks every value
 * again with the key's schema (shared-schemas business-settings.ts); this
 * only says what is wrong before Save, in the same plain words. Every number
 * in the words comes from the values.
 */
import {
  computeDiscountCents,
  discountBaseCents,
  formatCents,
  mostOffWithoutManagerCents,
  requiresManagerApproval,
} from '@cheeseoclock/pos-domain';
import {
  APPROVAL_MAX_FLAT_CENTS,
  APPROVAL_MAX_PERCENT,
  isNoDiscountReasonLabel,
  NO_DISCOUNT_REASON_LABEL,
  PRESET_FLAT_MAX_CENTS,
  PRESET_FLATS_MAX,
  PRESET_PERCENTS_MAX,
  PRESET_REASON_MAX_LENGTH,
  PRESET_REASONS_MAX,
  SHOP_SETTING_FORMAT,
  type ApprovalLimits,
  type DiscountApproval,
  type DiscountDelivery,
  type DiscountPresets,
} from '@cheeseoclock/shared-types';
import { centsFromRupeesText } from './foodpandaWords';
import type { Parsed } from './foodpandaForm';

// ---------------------------------------------------------------- limit --

export interface ApprovalForm {
  percent: string;
  rupees: string;
  /** "A discount needs a reason": Yes (true) or No. */
  reasonRequired: boolean;
}

export function approvalToForm(a: DiscountApproval): ApprovalForm {
  return { percent: String(a.percentOver), rupees: String(a.flatOverCents / 100), reasonRequired: a.reasonRequired };
}

const APPROVAL_MAX_RUPEES = formatCents(APPROVAL_MAX_FLAT_CENTS);

export function approvalFromForm(f: ApprovalForm): Parsed<DiscountApproval> {
  const p = f.percent.trim();
  if (!/^\d{1,3}$/.test(p) || Number(p) > APPROVAL_MAX_PERCENT) {
    return { value: null, problem: `The % limit is a whole % from 0 to ${APPROVAL_MAX_PERCENT}.` };
  }
  const cents = centsFromRupeesText(f.rupees);
  if (cents === null || Number.isNaN(cents) || cents > APPROVAL_MAX_FLAT_CENTS) {
    return { value: null, problem: `The rupee limit is whole rupees, Rs 0 to ${APPROVAL_MAX_RUPEES}.` };
  }
  return {
    value: {
      v: SHOP_SETTING_FORMAT['discounts.approval'],
      percentOver: Number(p),
      flatOverCents: cents,
      reasonRequired: f.reasonRequired,
    },
    problem: null,
  };
}

/**
 * One line for History and "Put back the default": "Up to 10% or Rs 500
 * without a manager · a reason is optional" — the reason is always said, so a
 * Yes → No save reads as a change and "Put back the default" says the reason
 * goes back to optional.
 */
export function approvalSummary(a: ApprovalLimits & Pick<DiscountApproval, 'reasonRequired'>): string {
  const reason = a.reasonRequired ? ' · a reason is needed' : ' · a reason is optional';
  if (a.percentOver === 0) return `Every discount needs a manager${reason}`;
  if (a.flatOverCents === 0) return `Up to ${a.percentOver}% without a manager; any amount in rupees needs one${reason}`;
  return `Up to ${a.percentOver}% or ${formatCents(a.flatOverCents)} without a manager${reason}`;
}

/** The question on the card, as the owner reads it. */
export const REASON_QUESTION = 'A discount needs a reason';

/**
 * What "a discount needs a reason" does, under its choice. Every login gives
 * a discount by hand under it; what the till puts on by itself carries its
 * own name; a discount already given is not taken off (unlike a lowered
 * limit); both tills must run this version.
 */
export const REASON_RULE_NOTE =
  'With Yes, every discount given on the Discount screen (F3) needs a reason — a reason button is one tap — from every login, the owner’s too; the till refuses one without. The automatic offers, the foodpanda deal and the website’s pick-up % carry their own names. A discount already on an order keeps what it has. Update both tills the same day: an older till still lets a discount through without a reason.';

/** The two made-up orders the worked example uses. */
export const EXAMPLE_SMALL_ORDER_CENTS = 200_000;
export const EXAMPLE_BIG_ORDER_CENTS = 1_000_000;

/**
 * The limit's worked example: "On a Rs 2,000 order a cashier can give up to
 * 10% off, or up to Rs 200 off in rupees, without a manager. On a Rs 10,000
 * order: up to 10% off, or up to Rs 500 off in rupees. Anything more needs a
 * manager's PIN or password."
 */
export function approvalExample(a: ApprovalLimits): string {
  if (a.percentOver === 0) {
    return "With 0%, every discount needs a manager's PIN or password — even 5% or Rs 50 off.";
  }
  const inRupees = (order: number) => {
    const most = mostOffWithoutManagerCents(a, order);
    return most > 0 ? `or up to ${formatCents(most)} off in rupees` : 'but nothing off in rupees';
  };
  return (
    `On a ${formatCents(EXAMPLE_SMALL_ORDER_CENTS)} order a cashier can give up to ${a.percentOver}% off, ${inRupees(EXAMPLE_SMALL_ORDER_CENTS)}, without a manager. ` +
    `On a ${formatCents(EXAMPLE_BIG_ORDER_CENTS)} order: up to ${a.percentOver}% off, ${inRupees(EXAMPLE_BIG_ORDER_CENTS)}. ` +
    "Anything more needs a manager's PIN or password."
  );
}

/**
 * What lowering the limit does to orders still being rung up (the note under
 * the example). The till keeps who approved a discount only when a PIN or
 * password was typed for it (orders:applyDiscount), so the cart re-check
 * (order-repo auto_clear_needs_approval) also takes off a discount a manager
 * or the owner gave on their own login under the old limit.
 */
export const LOWERED_LIMIT_NOTE =
  'Lowering it takes a discount off an order still being rung up, the next time its items change, if no manager’s PIN or password was typed for it: that includes a discount a manager or the owner gave on their own login. It goes back on with a manager’s PIN or password. Paid orders never change.';

// ------------------------------------------------------ delivery charge --

/** The card's choice: does a discount also come off the delivery charge? */
export type DeliveryChargeForm = 'yes' | 'no';

export function deliveryToForm(d: Pick<DiscountDelivery, 'alsoOffDeliveryCharge'>): DeliveryChargeForm {
  return d.alsoOffDeliveryCharge ? 'yes' : 'no';
}

export function deliveryFromForm(f: DeliveryChargeForm): Parsed<DiscountDelivery> {
  return { value: { v: SHOP_SETTING_FORMAT['discounts.delivery'], alsoOffDeliveryCharge: f === 'yes' }, problem: null };
}

/** The question on the card, as the owner reads it. */
export const DELIVERY_QUESTION = 'A discount also comes off the delivery charge';

/** One line for History (and "Put back the default"). */
export function deliverySummary(d: Pick<DiscountDelivery, 'alsoOffDeliveryCharge'>): string {
  return d.alsoOffDeliveryCharge
    ? 'Yes: a discount comes off the delivery charge too'
    : 'No: a discount is on the food only; the delivery charge is paid in full';
}

/** The made-up order the example uses: Rs 2,000 of food and a Rs 200 delivery charge. */
export const EXAMPLE_FOOD_CENTS = 200_000;
export const EXAMPLE_DELIVERY_CHARGE_CENTS = 20_000;
const EXAMPLE_LINES = [
  { lineTotalCents: EXAMPLE_FOOD_CENTS, menuItemName: 'Example pizza' },
  { lineTotalCents: EXAMPLE_DELIVERY_CHARGE_CENTS, menuItemName: `Delivery Charge (${formatCents(EXAMPLE_DELIVERY_CHARGE_CENTS)})` },
];

/**
 * The worked example, from the value and the till's own maths (pos-domain
 * discountBaseCents / computeDiscountCents): "On Rs 2,000 of food with a
 * Rs 200 delivery charge, 10% off takes Rs 200 off. The Rs 200 delivery charge
 * is paid in full: even 100% off leaves it (and its tax) to pay."
 */
export function deliveryExample(d: Pick<DiscountDelivery, 'alsoOffDeliveryCharge'>): string {
  const also = d.alsoOffDeliveryCharge;
  // The scope a discount given at the counter freezes (the example has no value deal in it).
  const base = discountBaseCents(EXAMPLE_LINES, { alsoOffDeliveryCharge: also, skipsNoDiscountLines: true });
  const subtotal = EXAMPLE_FOOD_CENTS + EXAMPLE_DELIVERY_CHARGE_CENTS;
  const tenOff = computeDiscountCents(base, { type: 'percent', value: 10 });
  const leftAtAll = subtotal - computeDiscountCents(base, { type: 'percent', value: 100 });
  const bigFlat = 300_000;
  const flatOff = computeDiscountCents(base, { type: 'flat', value: bigFlat });
  const order = `On ${formatCents(EXAMPLE_FOOD_CENTS)} of food with a ${formatCents(EXAMPLE_DELIVERY_CHARGE_CENTS)} delivery charge`;
  if (also) {
    return (
      `${order}, 10% off takes ${formatCents(tenOff)} off: the delivery charge is discounted too. ` +
      `${formatCents(bigFlat)} off takes ${formatCents(flatOff)}, and 100% off leaves ${leftAtAll > 0 ? formatCents(leftAtAll) : 'nothing'} to pay.`
    );
  }
  return (
    `${order}, 10% off takes ${formatCents(tenOff)} off (10% of the food). The ${formatCents(EXAMPLE_DELIVERY_CHARGE_CENTS)} delivery charge is paid in full: ` +
    `${formatCents(bigFlat)} off takes ${formatCents(flatOff)} (all the food), and even 100% off leaves the ${formatCents(leftAtAll)} delivery charge (and its tax) to pay.`
  );
}

/**
 * Under the approval limit's example: on an order with a delivery charge,
 * what the % limit is of — the same amount a discount is worked on, so it
 * follows "A discount also comes off the delivery charge" (its saved value).
 */
export function approvalDeliveryNote(d: Pick<DiscountDelivery, 'alsoOffDeliveryCharge'>): string {
  return d.alsoOffDeliveryCharge
    ? `With a delivery charge on the order, the % is of the whole order, the delivery charge too (“${DELIVERY_QUESTION}”: Yes).`
    : `With a delivery charge on the order, the % is of the food only: the delivery charge doesn’t count (“${DELIVERY_QUESTION}”: No).`;
}

/** What changing it does, and what it never touches (the note under the example). */
export const DELIVERY_RULE_NOTE =
  'A change counts for discounts given from then on, on both tills, and the approval limit is checked on the same amount. A discount already on an order keeps the rule it was given with, and paid orders never change. Website orders keep the website’s own prices. The foodpanda deal follows the rule in force when the order became foodpanda.';

/** "Never changed" is not "as the till always worked" here: until this setting, a discount came off the delivery charge too. */
export const DELIVERY_NEVER_CHANGED =
  'Never changed: a discount is on the food only (your rule of 28 Sep 2026). Before this setting, discounts came off the delivery charge too.';

// -------------------------------------------------------------- buttons --

/**
 * Under Discount buttons, while a category is never discounted (Menu →
 * Categories: Value Deals by its name, unless the owner changed it): no
 * button, typed amount or automatic offer comes off those items.
 */
export const VALUE_DEALS_DISCOUNT_NOTE = 'Value deals never get a discount (Menu → Categories).';

/** One box per button; an empty box drops that button. */
export interface PresetsForm {
  percents: string[];
  rupees: string[];
  reasons: string[];
}

const pad = (xs: string[], n: number) => [...xs, ...Array.from({ length: Math.max(0, n - xs.length) }, () => '')].slice(0, n);

export function presetsToForm(p: Pick<DiscountPresets, 'percents' | 'flatCents' | 'reasons'>): PresetsForm {
  return {
    percents: pad(p.percents.map(String), PRESET_PERCENTS_MAX),
    rupees: pad(p.flatCents.map((c) => String(c / 100)), PRESET_FLATS_MAX),
    reasons: pad([...p.reasons], PRESET_REASONS_MAX),
  };
}

const PRESET_FLAT_MAX_RUPEES = formatCents(PRESET_FLAT_MAX_CENTS);

/** The main process refuses the same button (shared-schemas discountPresetsSchema), in these words. */
export const NO_REASON_BUTTON_PROBLEM = `A reason button can't be “${NO_DISCOUNT_REASON_LABEL}”: Reports use those words for a discount with no reason.`;

export function presetsFromForm(f: PresetsForm): Parsed<DiscountPresets> {
  const percentsText = f.percents.map((t) => t.trim().replace(/%$/, '').trim()).filter((t) => t !== '');
  if (percentsText.length === 0) return { value: null, problem: 'Keep at least one % button.' };
  if (percentsText.some((t) => !/^\d{1,3}$/.test(t) || Number(t) < 1 || Number(t) > 100)) {
    return { value: null, problem: 'A % button is a whole % from 1 to 100.' };
  }
  const percents = percentsText.map(Number);
  if (new Set(percents).size !== percents.length) return { value: null, problem: 'Two % buttons are the same.' };

  const rupeesText = f.rupees.map((t) => t.trim()).filter((t) => t !== '');
  if (rupeesText.length === 0) return { value: null, problem: 'Keep at least one rupee button.' };
  const flatCents = rupeesText.map((t) => centsFromRupeesText(t));
  if (flatCents.some((c) => c === null || Number.isNaN(c) || c < 100 || c > PRESET_FLAT_MAX_CENTS)) {
    return { value: null, problem: `A rupee button is whole rupees, Rs 1 to ${PRESET_FLAT_MAX_RUPEES}.` };
  }
  const flats = flatCents as number[];
  if (new Set(flats).size !== flats.length) return { value: null, problem: 'Two rupee buttons are the same.' };

  const reasons = f.reasons.map((t) => t.replace(/\s+/g, ' ').trim()).filter((t) => t !== '');
  if (reasons.length === 0) return { value: null, problem: 'Keep at least one reason button.' };
  if (reasons.some((r) => r.length > PRESET_REASON_MAX_LENGTH)) {
    return { value: null, problem: `Keep a reason to ${PRESET_REASON_MAX_LENGTH} letters.` };
  }
  if (new Set(reasons.map((r) => r.toLowerCase())).size !== reasons.length) {
    return { value: null, problem: 'Two reason buttons are the same.' };
  }
  // The words Reports use for "no reason": the till counts them as none, so the button would never work.
  if (reasons.some(isNoDiscountReasonLabel)) {
    return { value: null, problem: NO_REASON_BUTTON_PROBLEM };
  }
  return {
    value: {
      v: SHOP_SETTING_FORMAT['discounts.presets'],
      percents: percents.slice(0, PRESET_PERCENTS_MAX),
      flatCents: flats.slice(0, PRESET_FLATS_MAX),
      reasons: reasons.slice(0, PRESET_REASONS_MAX),
    },
    problem: null,
  };
}

/** One line for History: "10, 20, 25, 50, 100% · Rs 100, Rs 200, Rs 500 · Staff, Friends & family…". */
export function presetsSummary(p: Pick<DiscountPresets, 'percents' | 'flatCents' | 'reasons'>): string {
  return `${p.percents.join(', ')}% · ${p.flatCents.map((c) => formatCents(c)).join(', ')} · ${p.reasons.join(', ')}`;
}

/** A button as the F3 screen would show it on the example order: what it takes off, and the lock. */
export interface PresetPreview {
  label: string;
  offCents: number;
  locked: boolean;
}

/**
 * The buttons on the made-up Rs 2,000 order, each with what it takes off and
 * whether the F3 screen shows the lock (the same rule as the till's:
 * requiresManagerApproval with the saved limit).
 */
export function presetPreview(
  p: Pick<DiscountPresets, 'percents' | 'flatCents'>,
  limits: ApprovalLimits,
  orderCents = EXAMPLE_SMALL_ORDER_CENTS,
): { percent: PresetPreview[]; flat: PresetPreview[] } {
  return {
    percent: p.percents.map((pct) => ({
      label: `${pct}%`,
      offCents: Math.round((orderCents * Math.min(100, pct)) / 100),
      locked: requiresManagerApproval({ type: 'percent', value: pct }, orderCents, limits),
    })),
    flat: p.flatCents.map((c) => ({
      label: formatCents(c),
      offCents: Math.min(c, orderCents),
      locked: requiresManagerApproval({ type: 'flat', value: c }, orderCents, limits),
    })),
  };
}
