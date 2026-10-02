/**
 * Settings → Printers, the kitchen ticket's rules in plain words (this
 * till's printer.policy: each till drives its own printers). Built from the
 * values — shared-types kitchenTicketRules, the same reading the print
 * spooler does — never typed into the text.
 */
import {
  kitchenTicketRules,
  SHIFT_REPORT_SECTIONS,
  shiftReportRules,
  type KitchenTicketRules,
  type PrintPolicy,
} from '@cheeseoclock/shared-types';

const TIMES = ['never', 'once', 'twice', 'three times'] as const;

/** What the "Kitchen ticket" rule says, from this till's policy (today's words with nothing saved). */
export function kitchenTicketText(policy: Pick<PrintPolicy, 'kitchenTicket' | 'kitchenCopies' | 'kitchenPhone' | 'kitchenDrinks'>): string {
  if (!policy.kitchenTicket) {
    return 'Off: this till prints no kitchen tickets by itself. One can still be printed by hand (the chef-hat button).';
  }
  const r = kitchenTicketRules(policy);
  const printed =
    r.copies === 1
      ? 'Printed once'
      : `Printed ${TIMES[r.copies] ?? `${r.copies} times`} at once (each ticket marked COPY 1 OF ${r.copies}, COPY 2 OF ${r.copies}${r.copies > 2 ? '…' : ''})`;
  return (
    `${printed}, the moment an order goes to the kitchen — Send to kitchen, Pay now at the counter, or a website order arriving. ` +
    `What to cook, big print, no prices, with every allergy and leave-out note. ${customerLine(r)} ${drinksLine(r)} ` +
    'Comes out of the kitchen printer if one is set up below, otherwise the receipt printer. A ticket printed again by hand is one ticket.'
  );
}

function customerLine(r: KitchenTicketRules): string {
  return r.phone ? "The customer's name and phone are on it." : "The customer's name is on it, not the phone.";
}

function drinksLine(r: KitchenTicketRules): string {
  return r.drinks
    ? 'Drinks are listed with the food.'
    : 'Drinks (a Drinks or Beverages category, or sent to the bar) are left off, with one line saying how many the counter hands out; an order of only drinks prints no ticket.';
}

/**
 * Whether two policies differ in anything this card saves (the kitchen and
 * shift report fields read with their defaults, so a policy from before
 * them and one saying the same thing are the same).
 */
export function printPolicyDiffers(a: PrintPolicy, b: PrintPolicy): boolean {
  const ka = kitchenTicketRules(a);
  const kb = kitchenTicketRules(b);
  const sa = shiftReportRules(a);
  const sb = shiftReportRules(b);
  return (
    a.kitchenTicket !== b.kitchenTicket ||
    a.deliveryBillOnDispatch !== b.deliveryBillOnDispatch ||
    a.shopCopy !== b.shopCopy ||
    a.logoOnReceipt !== b.logoOnReceipt ||
    ka.copies !== kb.copies ||
    ka.phone !== kb.phone ||
    ka.drinks !== kb.drinks ||
    sa.onClose !== sb.onClose ||
    sa.items !== sb.items ||
    SHIFT_REPORT_SECTIONS.some(({ key }) => sa.sections[key] !== sb.sections[key])
  );
}
