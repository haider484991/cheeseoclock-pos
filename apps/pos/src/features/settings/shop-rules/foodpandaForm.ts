/**
 * The foodpanda cards' forms: what is typed ↔ the setting's value. The main
 * process checks every value again with the key's schema; this only says
 * what is wrong before Save, in the same plain words.
 */
import {
  FOODPANDA_DEAL_MAX_PERCENT,
  FOODPANDA_TABLET_TOLERANCE_MAX_CENTS,
  SHOP_SETTING_FORMAT,
  type FoodpandaCheckRule,
  type FoodpandaChecks,
  type FoodpandaCommissionBase,
  type FoodpandaDeal,
  type FoodpandaFees,
} from '@cheeseoclock/shared-types';
import { bpsFromPercentText, centsFromRupeesText, dealPayer, percentFromBps, toleranceWords, type DealPayer } from './foodpandaWords';

export interface DealForm {
  percent: string;
  payer: DealPayer;
  /** Your part, when shared. */
  shopPercent: string;
  minOrder: string;
  maxOff: string;
  startsOn: string;
  endsOn: string;
}

const rupeesText = (cents: number | null) => (cents === null ? '' : String(cents / 100));

export function dealToForm(d: FoodpandaDeal): DealForm {
  return {
    percent: String(d.percent),
    payer: d.percent > 0 ? dealPayer(d) : 'shop',
    shopPercent: String(d.shopPercent),
    minOrder: rupeesText(d.minOrderCents),
    maxOff: rupeesText(d.maxOffCents),
    startsOn: d.startsOn ?? '',
    endsOn: d.endsOn ?? '',
  };
}

export type Parsed<T> = { value: T; problem: null } | { value: null; problem: string };

const wholeIn = (t: string, lo: number, hi: number): number | null => {
  const s = t.trim();
  if (!/^\d{1,3}$/.test(s)) return null;
  const n = Number(s);
  return n >= lo && n <= hi ? n : null;
};

export function dealFromForm(f: DealForm): Parsed<FoodpandaDeal> {
  const percent = wholeIn(f.percent, 0, FOODPANDA_DEAL_MAX_PERCENT);
  if (percent === null) return { value: null, problem: `The deal is a whole % from 0 to ${FOODPANDA_DEAL_MAX_PERCENT}.` };
  let shopPercent = percent;
  if (f.payer === 'foodpanda') shopPercent = 0;
  else if (f.payer === 'shared' && percent > 0) {
    const part = wholeIn(f.shopPercent, 1, percent - 1);
    if (part === null) return { value: null, problem: `Your part is a whole % from 1 to ${Math.max(1, percent - 1)}.` };
    shopPercent = part;
  }
  const minOrderCents = centsFromRupeesText(f.minOrder);
  if (Number.isNaN(minOrderCents)) return { value: null, problem: 'Type the smallest order in whole rupees, or leave it empty.' };
  const maxOffCents = centsFromRupeesText(f.maxOff);
  if (Number.isNaN(maxOffCents) || maxOffCents === 0) {
    return { value: null, problem: 'Type the most off one order in whole rupees (more than Rs 0), or leave it empty.' };
  }
  const startsOn = f.startsOn.trim() || null;
  const endsOn = f.endsOn.trim() || null;
  if (startsOn && endsOn && endsOn < startsOn) return { value: null, problem: 'The deal can’t end before it starts.' };
  return {
    value: { v: SHOP_SETTING_FORMAT['foodpanda.deal'], percent, shopPercent, minOrderCents, maxOffCents, startsOn, endsOn },
    problem: null,
  };
}

export interface FeesForm {
  commission: string;
  confirmed: boolean;
  base: FoodpandaCommissionBase;
  fixedFee: string;
  commissionTax: string;
  /** How much above the till's prices the foodpanda menu is (%). */
  uplift: string;
  /** foodpanda's fee on each order's total (%). */
  paymentFee: string;
}

export function feesToForm(f: FoodpandaFees): FeesForm {
  return {
    commission: percentFromBps(f.commissionBps).replace('%', ''),
    confirmed: f.confirmed,
    base: f.base,
    fixedFee: String(f.fixedFeeCents / 100),
    commissionTax: percentFromBps(f.commissionTaxBps).replace('%', ''),
    uplift: percentFromBps(f.upliftBps).replace('%', ''),
    paymentFee: percentFromBps(f.paymentFeeBps).replace('%', ''),
  };
}

export function feesFromForm(f: FeesForm): Parsed<FoodpandaFees> {
  const commissionBps = bpsFromPercentText(f.commission);
  if (commissionBps === null || commissionBps > 5_000) {
    return { value: null, problem: 'The commission is a % from 0 to 50, with at most two decimals.' };
  }
  const fee = centsFromRupeesText(f.fixedFee);
  if (fee !== null && (Number.isNaN(fee) || fee > 200_000)) return { value: null, problem: 'The fee per order is whole rupees, Rs 0 to Rs 2,000.' };
  const tax = f.commissionTax.trim() === '' ? 0 : bpsFromPercentText(f.commissionTax);
  if (tax === null || tax > 5_000) return { value: null, problem: 'The tax on the commission is a % from 0 to 50.' };
  const uplift = f.uplift.trim() === '' ? 0 : bpsFromPercentText(f.uplift);
  if (uplift === null || uplift > 10_000) {
    return { value: null, problem: "How much dearer foodpanda is: a % from 0 to 100 (0 if foodpanda shows the till's prices)." };
  }
  const paymentFee = f.paymentFee.trim() === '' ? 0 : bpsFromPercentText(f.paymentFee);
  if (paymentFee === null || paymentFee > 5_000) {
    return { value: null, problem: "foodpanda's fee on the order's total is a % from 0 to 50 (0 if none)." };
  }
  return {
    value: {
      v: SHOP_SETTING_FORMAT['foodpanda.fees'],
      commissionBps,
      confirmed: f.confirmed,
      base: f.base,
      fixedFeeCents: fee ?? 0,
      commissionTaxBps: tax,
      upliftBps: uplift,
      paymentFeeBps: paymentFee,
    },
    problem: null,
  };
}

export interface ChecksForm {
  orderCode: FoodpandaCheckRule;
  tabletTotal: FoodpandaCheckRule;
  /** How far the tablet may be from the till before Pay says so, in whole rupees. */
  tolerance: string;
}

export function checksToForm(c: FoodpandaChecks): ChecksForm {
  return { orderCode: c.orderCode, tabletTotal: c.tabletTotal, tolerance: String(c.tabletToleranceCents / 100) };
}

const TOLERANCE_MAX_RUPEES = FOODPANDA_TABLET_TOLERANCE_MAX_CENTS / 100;

/**
 * The checks as this version saves them: ALWAYS in its own format (a value
 * an older version saved, v1, would otherwise go back as v1 and be refused),
 * the tolerance whole rupees from Rs 0 to Rs 10 (an anti-fraud check: never
 * wider).
 */
export function checksFromForm(f: ChecksForm): Parsed<FoodpandaChecks> {
  // Digits only: "0.5", "1,0", "Rs 5" and the like are refused as typed, never read as some other amount.
  const typed = f.tolerance.trim();
  const cents = /^\d{1,3}$/.test(typed) ? Number(typed) * 100 : null;
  if (cents === null || cents > FOODPANDA_TABLET_TOLERANCE_MAX_CENTS) {
    return {
      value: null,
      problem: `The difference allowed on the tablet is whole rupees, Rs 0 to Rs ${TOLERANCE_MAX_RUPEES}.`,
    };
  }
  return {
    value: { v: SHOP_SETTING_FORMAT['foodpanda.checks'], orderCode: f.orderCode, tabletTotal: f.tabletTotal, tabletToleranceCents: cents },
    problem: null,
  };
}

/**
 * The tolerance box as the owner types: kept exactly as typed. Nothing is
 * stripped ("0.5" must never turn into "05", Rs 5): checksFromForm refuses
 * anything that is not whole rupees from Rs 0 to Rs 10, and the card shows
 * its message.
 */
export function typeTolerance(f: ChecksForm, typed: string): ChecksForm {
  return { ...f, tolerance: typed };
}

/**
 * The checks card's intro: "Pay can ask … If the till's total is more than
 * Rs 5 different, …". It follows the box as the owner types (like the deal
 * card's worked example), as soon as the box holds a tolerance the card
 * would save; while it holds one the card refuses, it keeps the saved value
 * and the card's problem line says what is wrong.
 */
export function checksIntro(f: ChecksForm, saved: Pick<FoodpandaChecks, 'tabletToleranceCents'>): string {
  const cents = checksFromForm(f).value?.tabletToleranceCents ?? saved.tabletToleranceCents;
  return (
    `Pay can ask for foodpanda’s order number and the total on the foodpanda tablet. If the till’s total is ${toleranceWords(cents)}, ` +
    'the till says so and Reports lists the order — how you know the till matches foodpanda, and how a walk-in cash sale rung up as foodpanda shows up.'
  );
}

/** Two values are the same setting (the form is not "dirty"). */
export function sameValue(a: unknown, b: unknown): boolean {
  const flat = (x: unknown) =>
    x && typeof x === 'object' ? JSON.stringify(Object.fromEntries(Object.entries(x).sort(([k1], [k2]) => k1.localeCompare(k2)))) : JSON.stringify(x);
  return flat(a) === flat(b);
}
