/**
 * FROZEN BASELINE — v0.7.51, copied by `git show v0.7.51:<path>`. DO NOT EDIT.
 * The pilot's split-payment rules and the words they say, for the oracle.
 */
/**
 * The sale as its payments settle it, with a tax rate for each way of paying
 * (0.7.45). splitTender's rule for one way beside cash, for any number:
 *
 *   Each part paid by card, a wallet or a bank transfer buys the same share
 *   of the bill at that way's prices (its amount over the bill that way);
 *   the cash pays the rest of the bill at cash prices.
 *
 * So Rs 540 on a card against a bill of Rs 1,080 by card (Rs 1,150 in cash)
 * still buys half the bill and leaves Rs 575 in cash. With every part by
 * card, a wallet or a bank at the same bill — every sale the till takes from
 * Pay, and every sale before 0.7.45 — it IS splitTender, to the paisa. Parts
 * at different bills (Rs 500 by JazzCash and the rest by card, at different
 * rates) are worked out exactly, in whole numbers, never in floating point.
 *
 * The part "at its own rate" (digitalNetCents / digitalTaxCents, what the
 * receipt calls the card part and Reports split the tax by) is the part paid
 * a way whose rate is not the cash rate (shared-types paysOwnRate): a wallet
 * that pays the cash rate counts as cash there.
 */
import {
  billByMethod,
  isRatedPaymentMethod,
  paysOwnRate,
  RATED_METHOD_LABEL,
  type BillByMethod,
  type PaymentMethod,
  type RatedPaymentMethod,
} from '@cheeseoclock/shared-types';
import { splitTender, type SplitTenderOutcome } from './split-tender-v0.7.51.js';

/**
 * An order's bill as Pay settles it: by each way of paying, and what the tax
 * is on. `totalCents` is the bill at the cash rates — the stored total of an
 * order not paid yet; a paid one's is the bill as it was settled, so the
 * caller works the cash bill out again from the lines.
 */
export interface MethodQuote extends BillByMethod {
  /** Subtotal less discount: what the tax is on. */
  netCents: number;
}

/** One payment of the sale. */
export interface SettleLeg {
  method: PaymentMethod | string;
  amountCents: number;
}

function rupees(cents: number): string {
  return (cents / 100).toLocaleString('en-PK', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

/** "card", "JazzCash", "bank transfer": a way of paying in a sentence. */
export function methodWords(method: RatedPaymentMethod): string {
  return method === 'card' ? 'card' : method === 'bank_transfer' ? 'bank transfer' : RATED_METHOD_LABEL[method];
}

/** The parts by card / wallet / bank, one per bill they pay at (in the order the legs came). */
interface Group {
  methods: RatedPaymentMethod[];
  /** The bill paid entirely this way. */
  billCents: number;
  /** Paid this way. */
  amountCents: number;
  /** Taxed at a rate other than the cash rate. */
  ownRate: boolean;
}

function groupsOf(quote: MethodQuote, legs: ReadonlyArray<SettleLeg>): Group[] {
  const groups: Group[] = [];
  for (const leg of legs) {
    if (!isRatedPaymentMethod(leg.method)) continue;
    const billCents = billByMethod(quote, leg.method);
    const ownRate = paysOwnRate(quote, leg.method);
    const same = groups.find((g) => g.billCents === billCents && g.ownRate === ownRate);
    if (same) {
      same.amountCents += leg.amountCents;
      if (!same.methods.includes(leg.method)) same.methods.push(leg.method);
    } else {
      groups.push({ methods: [leg.method], billCents, amountCents: leg.amountCents, ownRate });
    }
  }
  return groups;
}

/** Half up, as Math.round does for a positive number: n / d for BigInts, d > 0, n >= 0. */
function roundDiv(n: bigint, d: bigint): bigint {
  return (2n * n + d) / (2n * d);
}

/**
 * The sale with these payments: what is still due in cash, the bill as they
 * settle it, its tax, and the part at a rate of its own. The cash legs (and
 * any way that is not a card, a wallet or a bank) are not summed here: the
 * caller checks they come to `cashDueCents`.
 */
export function settleLegs(quote: MethodQuote, legs: ReadonlyArray<SettleLeg>): SplitTenderOutcome {
  for (const leg of legs) {
    if (!Number.isInteger(leg.amountCents) || leg.amountCents < 0) {
      return { ok: false, reason: 'Each payment must be whole paisa, not below zero' };
    }
  }
  const groups = groupsOf(quote, legs).filter((g) => g.amountCents > 0);
  // None, or one bill for them all: the 0052 rule itself (a way that pays the cash rate, at no card rate).
  if (groups.length <= 1) {
    const g = groups[0];
    return splitTender(
      { totalCents: quote.totalCents, digitalTotalCents: g?.ownRate ? g.billCents : null, netCents: quote.netCents },
      g ? g.amountCents : 0,
    );
  }

  // Parts at different bills: each buys amount / bill of it, all in whole numbers.
  for (const g of groups) {
    const what = g.methods.map(methodWords).join(' / ');
    if (g.billCents <= 0) return { ok: false, reason: `Nothing of this bill can be paid by ${what}` };
    if (g.amountCents > g.billCents) {
      return { ok: false, reason: `Rs ${rupees(g.amountCents)} by ${what} is more than the bill by ${what} (Rs ${rupees(g.billCents)})` };
    }
  }
  const total = BigInt(quote.totalCents);
  // The share left for cash: 1 − Σ amount / bill = left / every bill multiplied together.
  const all = groups.reduce((p, g) => p * BigInt(g.billCents), 1n);
  const left = groups.reduce((rest, g) => rest - (BigInt(g.amountCents) * all) / BigInt(g.billCents), all);
  if (left < 0n) {
    const paid = groups.map((g) => `Rs ${rupees(g.amountCents)} by ${g.methods.map(methodWords).join(' / ')}`).join(' and ');
    return { ok: false, reason: `${paid} come to more than the bill` };
  }
  const cashDueCents = Number(roundDiv(total * left, all));
  const paidOtherWays = groups.reduce((n, g) => n + g.amountCents, 0);
  const totalCents = paidOtherWays + cashDueCents;
  let digitalNetCents = 0;
  let digitalTaxCents = 0;
  for (const g of groups) {
    if (!g.ownRate) continue;
    const net = Math.round((g.amountCents * quote.netCents) / g.billCents);
    digitalNetCents += net;
    digitalTaxCents += g.amountCents - net;
  }
  return { ok: true, cashDueCents, totalCents, taxCents: totalCents - quote.netCents, digitalNetCents, digitalTaxCents };
}

/**
 * A leg moved to another way of paying (Change payment, 0.7.45): it keeps the
 * share of the bill it paid and pays it at the new way's prices. Returns the
 * new amount that settles the sale exactly with the other legs as they are
 * (the cash due then is what the cash legs already paid), or null when none
 * does. `index`: the leg that moves, within `legs`.
 */
export function movedLegAmount(
  quote: MethodQuote,
  legs: ReadonlyArray<SettleLeg>,
  index: number,
  to: PaymentMethod | string,
): number | null {
  const leg = legs[index];
  if (!leg) return null;
  const cashPaid = (ls: ReadonlyArray<SettleLeg>) => ls.filter((l) => !isRatedPaymentMethod(l.method)).reduce((n, l) => n + l.amountCents, 0);
  const others = legs.filter((_, i) => i !== index);
  const fits = (amount: number) => {
    if (amount <= 0) return false;
    const next = [...others, { method: to, amountCents: amount }];
    const s = settleLegs(quote, next);
    return s.ok && s.cashDueCents === cashPaid(next);
  };
  // To cash: the cash still due with the other legs as they are, less the cash they already paid.
  if (!isRatedPaymentMethod(to)) {
    const s = settleLegs(quote, others);
    if (!s.ok) return null;
    const amount = s.cashDueCents - cashPaid(others);
    return fits(amount) ? amount : null;
  }
  // To a card, a wallet or a bank: the share it paid, at that way's bill — and, for the paisa
  // the rounding can leave either way, the nearest amount that settles the sale exactly.
  const from = billByMethod(quote, leg.method);
  if (from <= 0) return null;
  const guess = Math.round((leg.amountCents * billByMethod(quote, to)) / from);
  for (const d of [0, 1, -1, 2, -2]) {
    if (fits(guess + d)) return guess + d;
  }
  return null;
}
