import {
  approvalRuleBasis,
  computeDiscountCents,
  discountBaseCents,
  discountReasonMissing,
  DISCOUNT_REASON_REQUIRED,
  formatCents,
  NOTHING_TO_DISCOUNT,
  requiresManagerApproval,
  taxAfterDiscount,
  type ApprovalRuleBasis,
  type DiscountLine,
  type DiscountScope,
  type TaxedDiscountLine,
} from '@cheeseoclock/pos-domain';
import {
  DEFAULT_DISCOUNT_APPROVAL,
  DEFAULT_DISCOUNT_DELIVERY,
  DEFAULT_DISCOUNT_PRESETS,
  NOT_ON_VALUE_DEALS,
  discountLeavesNoDiscountItems,
  isDeliveryChargeLine,
  type CheckoutRules,
  type DiscountPresets,
} from '@cheeseoclock/shared-types';
import { approvalProblem, secretReady } from '../../components/secret/secretRules';

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

/**
 * The words beside the dialog's Reason heading: needed when the owner has
 * made a reason required (Settings → Money & discounts, via
 * checkout:getRules), optional otherwise — as before the setting.
 */
export function discountReasonHint(reasonRequired: boolean): string {
  return reasonRequired ? '(needed — prints on the bill)' : '(optional, prints on the bill)';
}

/**
 * Why the dialog will not apply a discount yet, as far as its reason goes:
 * the owner has made one required and none is picked or typed. The same
 * test as the main process (pos-domain discountReasonMissing), which refuses
 * the discount without one in any case. Null: the reason is fine.
 */
export function discountReasonProblem(reasonRequired: boolean, reason: string): string | null {
  return reasonRequired && discountReasonMissing(reason) ? DISCOUNT_REASON_REQUIRED : null;
}

/** Where the dialog puts the cursor after saying why it did not apply. */
export type DiscountDialogFocus = 'reason' | 'pin' | null;

/**
 * Where the cursor goes when the dialog opens: the manager's PIN when it was
 * opened from the foodpanda deal's ×; the "Other" amount box (keys first: F3,
 * type 15, Enter); and — with only value deals on the order, where that box
 * is off and cannot take the cursor — the dialog itself. Never left behind
 * the dialog: there Enter would send the order to the kitchen, or a typed
 * 15 land in the menu search. On the dialog, Enter says why nothing comes
 * off (NOTHING_TO_DISCOUNT) and Esc closes it.
 */
export function discountDialogOpenFocus(p: { removingDeal: boolean; onlyValueDeals: boolean }): 'pin' | 'custom' | 'dialog' {
  if (p.removingDeal) return 'pin';
  return p.onlyValueDeals ? 'dialog' : 'custom';
}

/** What Apply does — the big button, Enter, or a preset tapped a second time. */
export type DiscountApplyStep =
  /** Not applied: this is said (and the cursor goes to the box that needs it). */
  | { kind: 'refuse'; message: string; focus: DiscountDialogFocus }
  /** Send it: the reason as typed (undefined when none), the manager's PIN when one is needed. */
  | { kind: 'save'; choice: DiscountChoice; reason: string | undefined; approverPin: string | undefined };

/**
 * Apply, decided in one place: the button is on exactly when this says
 * 'save' (DiscountDialog canApply), and Enter or a second tap on a preset —
 * which do not go through the button — are refused by the same words. In
 * order: something on the order a discount may come off (not only value
 * deals); something picked; something to take off; the owner's "a discount
 * needs a reason" (said before the PIN, as the main process does, so a PIN
 * typed is never lost to it); the manager's PIN when the discount needs one.
 * The main process decides every one again when it saves.
 */
export function discountApplyStep(p: {
  /**
   * Every line a discount could come off is a value deal (DiscountBaseNow:
   * nothing to work it on, value deals on the order): the main process
   * refuses it with NOTHING_TO_DISCOUNT, and so does this.
   */
  onlyValueDeals?: boolean;
  choice: DiscountChoice | null;
  /** The "Other" box has something in it (it says "check it" rather than "pick one"). */
  typing: boolean;
  /** What the choice takes off this order (previewDiscount). */
  discountCents: number;
  /** A manager's PIN is needed: over the owner's limit, or the foodpanda deal is on the order. */
  needsApproval: boolean;
  reasonRequired: boolean;
  reason: string;
  pin: string;
}): DiscountApplyStep {
  if (p.onlyValueDeals) return { kind: 'refuse', message: NOTHING_TO_DISCOUNT, focus: null };
  if (!p.choice) {
    return { kind: 'refuse', message: p.typing ? 'That amount does not work — check it.' : 'Pick a discount or type an amount.', focus: null };
  }
  if (p.discountCents <= 0) return { kind: 'refuse', message: 'Nothing to take off this order.', focus: null };
  const reasonSays = discountReasonProblem(p.reasonRequired, p.reason);
  if (reasonSays) return { kind: 'refuse', message: reasonSays, focus: 'reason' };
  if (p.needsApproval && !secretReady(p.pin)) {
    const said = (p.pin.trim() ? approvalProblem(p.pin) : null) ?? "This discount needs a manager's PIN or password.";
    return { kind: 'refuse', message: said, focus: 'pin' };
  }
  return { kind: 'save', choice: p.choice, reason: p.reason.trim() || undefined, approverPin: p.needsApproval ? p.pin : undefined };
}

/**
 * The main process refused the discount: what the dialog says, where the
 * cursor goes, and whether the PIN is cleared. Refused for its reason alone
 * (before any PIN was checked): the dialog's own words, cleared once a
 * reason is given, and the PIN stays typed. Anything else: "Discount not
 * applied: …", and a PIN that was sent is cleared for another try.
 */
export function discountRefused(message: string, sentPin: boolean): { error: string; focus: DiscountDialogFocus; clearPin: boolean } {
  if (message === DISCOUNT_REASON_REQUIRED) return { error: message, focus: 'reason', clearPin: false };
  return { error: `Discount not applied: ${message}`, focus: sentPin ? 'pin' : null, clearPin: sentPin };
}

/**
 * The reason buttons the dialog shows: the owner's, except — while a reason
 * is needed — one reading as no reason ("No reason given"), which the till
 * would refuse. Settings no longer saves such a button, but a list saved
 * before, or by an older till, may still have one. Every button otherwise,
 * as before the setting.
 */
export function reasonButtons(reasons: readonly string[], reasonRequired: boolean): readonly string[] {
  return reasonRequired ? reasons.filter((r) => !discountReasonMissing(r)) : reasons;
}

/** "10% off", "Rs 200 off". */
export function describeDiscount(d: DiscountChoice): string {
  return d.type === 'percent' ? `${d.value}% off` : `${formatCents(d.value)} off`;
}

/**
 * The preview's words for a choice: "10% off", or "10% off food" when the
 * order has a delivery charge the discount leaves alone, and ", not on value
 * deals" when it has value deals it leaves alone; a rupee amount bigger than
 * what it is worked on says so ("(the whole order)", "(all the food)", "(all
 * but the value deals)").
 */
export function describePreview(
  d: DiscountChoice,
  p: Pick<DiscountPreview, 'capped'>,
  base: Pick<DiscountBaseNow, 'untouchedCents'> & Partial<Pick<DiscountBaseNow, 'dealsCents'>>,
): string {
  const foodOnly = base.untouchedCents > 0;
  const food = foodOnly ? ' food' : '';
  if ((base.dealsCents ?? 0) > 0) {
    return p.capped ? `${describeDiscount(d)}${food} (all but the value deals)` : `${describeDiscount(d)}${food}, ${NOT_ON_VALUE_DEALS}`;
  }
  const capped = p.capped ? (foodOnly ? ' (all the food)' : ' (the whole order)') : '';
  return `${describeDiscount(d)}${food}${capped}`;
}

/** The order's discount as the dialog's header reads it: its choice and reason, and the rule frozen on it (the snapshot's). */
export interface CurrentDiscountOnOrder extends CurrentDiscount {
  alsoOffDeliveryCharge?: boolean;
  skipsNoDiscountLines?: boolean;
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
 * Each adds ", not on value deals" when its own frozen rule left the value
 * deals on this order alone. The owner's foodpanda deal keeps its own words.
 */
export function currentDiscountWords(
  current: CurrentDiscountOnOrder,
  lines: ReadonlyArray<{ readonly menuItemName?: string | null; readonly noDiscount?: boolean }>,
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
  const deals = discountLeavesNoDiscountItems(current, lines) ? `, ${NOT_ON_VALUE_DEALS}` : '';
  if (!lines.some((l) => isDeliveryChargeLine(l))) return { now: `${choice}${deals}`, ruleNote: null };
  const itCovers = current.alsoOffDeliveryCharge !== false;
  if (itCovers === rules.alsoOffDeliveryCharge) return { now: `${itCovers ? choice : `${choice} food`}${deals}`, ruleNote: null };
  return itCovers
    ? {
        now: `${choice}, delivery charge too${deals}`,
        ruleNote: 'Given when a discount also came off the delivery charge. Apply it again to take it off the food only.',
      }
    : {
        now: `${choice} food${deals}`,
        ruleNote: 'Given when a discount was on the food only. Apply it again to take it off the delivery charge too.',
      };
}

/**
 * The dialog's header: "Order Rs 2,000 before tax", "Food Rs 2,000 before
 * tax · delivery charge Rs 200 not discounted", "Food Rs 1,500 before tax ·
 * value deals Rs 3,600 not discounted", "Food Rs 1,500 before tax · value
 * deals Rs 3,600 and delivery charge Rs 200 not discounted" — and, when only
 * value deals are left for it, NOTHING_TO_DISCOUNT (the main process's words).
 * With the owner's switch on, a delivery charge counted in beside value deals
 * is named: "Food and delivery charge Rs 1,700 before tax · value deals Rs
 * 3,600 not discounted". `basis` is discountRuleBasisNow for the same order —
 * what the limit line under it says (approvalRuleText), so the two agree.
 */
export function discountBaseText(p: DiscountBaseNow, subtotalCents: number, basis?: ApprovalRuleBasis): string {
  if (p.dealsCents > 0) {
    if (p.baseCents === 0) return NOTHING_TO_DISCOUNT;
    const charge = p.untouchedCents > 0 ? ` and delivery charge ${formatCents(p.untouchedCents)}` : '';
    const what = basis === 'food_and_charge_no_deals' ? 'Food and delivery charge' : 'Food';
    return `${what} ${formatCents(p.baseCents)} before tax · value deals ${formatCents(p.dealsCents)}${charge} not discounted`;
  }
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
  /**
   * Before tax: the food only, or (the owner's switch on) every line — the
   * order's subtotal; the value deals left out of either (not on a foodpanda
   * order).
   */
  baseCents: number;
  /** The delivery charge on this order that a discount leaves alone (0 when there is none, or the switch is on). */
  untouchedCents: number;
  /**
   * The value deals on this order a discount leaves alone (the lines marked
   * noDiscount; 0 when there are none, or on a foodpanda order, where a
   * manager's discount covers them to match the tablet).
   */
  dealsCents: number;
}

/** The F3 screen's rules (checkout:getRules): the approval limit and whether a discount also comes off the delivery charge. */
export type DiscountScreenRules = Pick<CheckoutRules['discounts'], 'approval' | 'alsoOffDeliveryCharge'>;

/** The released rules: 10% / Rs 500, and a discount leaves the delivery charge alone. */
export const RELEASED_SCREEN_RULES: DiscountScreenRules = {
  approval: { percentOver: DEFAULT_DISCOUNT_APPROVAL.percentOver, flatOverCents: DEFAULT_DISCOUNT_APPROVAL.flatOverCents },
  alsoOffDeliveryCharge: DEFAULT_DISCOUNT_DELIVERY.alsoOffDeliveryCharge,
};

/**
 * What a discount given now may come off, exactly as orders:applyDiscount
 * works it: the delivery charge only with the owner's switch on; the value
 * deals never, except on a foodpanda order (a manager matching the tablet,
 * which covers them).
 */
export function discountScopeNow(
  rules: Pick<DiscountScreenRules, 'alsoOffDeliveryCharge'>,
  mode: string | null | undefined,
): DiscountScope {
  return { alsoOffDeliveryCharge: rules.alsoOffDeliveryCharge, skipsNoDiscountLines: mode !== 'foodpanda' };
}

/**
 * What the limit line says a discount given now is checked on (pos-domain
 * approvalRuleBasis on discountScopeNow — the main process's refusal names
 * the same): the order, the food, the food without the value deals, or —
 * the owner's switch on — the food and delivery charge without them. The
 * header (discountBaseText) takes it too, so the two never name different
 * things.
 */
export function discountRuleBasisNow(
  lines: ReadonlyArray<DiscountLine>,
  rules: Pick<DiscountScreenRules, 'alsoOffDeliveryCharge'>,
  mode: string | null | undefined,
): ApprovalRuleBasis {
  return approvalRuleBasis(lines, discountScopeNow(rules, mode));
}

/**
 * The bill if `choice` were applied now, worked out exactly as the till does
 * when the discount is saved (order-repo applyDiscount / recomputeOrderTotals,
 * pos-domain discount-base.ts): a % of the food (every line with the owner's
 * switch on) without the value deals (not on a foodpanda order), a rupee
 * amount at most that, split over the lines in whole paisa with a delivery
 * charge or a value deal the discount leaves alone taking none, tax on what
 * is left of each line; the lock on the same base. `lines` are the order's
 * lines in ticket order (their totals, tax rates, the names they were sold
 * under and their value-deal mark); `subtotalCents` is their sum. With no
 * choice it is the bill with no discount. `rules` are the owner's
 * (checkout:getRules); the released ones when absent. `mode` is the order's.
 */
export function previewDiscount(
  lines: ReadonlyArray<TaxedDiscountLine>,
  subtotalCents: number,
  choice: DiscountChoice | null,
  rules: DiscountScreenRules = RELEASED_SCREEN_RULES,
  mode?: string | null,
): DiscountPreview {
  const { baseCents } = discountBaseNow(lines, subtotalCents, rules, mode);
  const discountCents = choice ? computeDiscountCents(baseCents, choice) : 0;
  const scope = discountScopeNow(rules, mode);
  const taxCents = subtotalCents > 0 ? taxAfterDiscount(lines, discountCents, scope).taxCents : 0;
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
 * the food only, and the delivery charge it leaves alone. The value deals
 * are left out of either and counted on their own (not on a foodpanda order).
 */
export function discountBaseNow(
  lines: ReadonlyArray<TaxedDiscountLine>,
  subtotalCents: number,
  rules: Pick<DiscountScreenRules, 'alsoOffDeliveryCharge'> = RELEASED_SCREEN_RULES,
  mode?: string | null,
): DiscountBaseNow {
  const scope = discountScopeNow(rules, mode);
  const dealsCents = scope.skipsNoDiscountLines
    ? lines.reduce((s, l) => s + (l.noDiscount === true ? Math.max(0, l.lineTotalCents) : 0), 0)
    : 0;
  if (rules.alsoOffDeliveryCharge) return { baseCents: Math.max(0, subtotalCents - dealsCents), untouchedCents: 0, dealsCents };
  const baseCents = discountBaseCents(lines, scope);
  return { baseCents, untouchedCents: Math.max(0, subtotalCents - baseCents - dealsCents), dealsCents };
}
