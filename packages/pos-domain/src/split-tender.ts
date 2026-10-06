/**
 * Tax by how the customer pays (migration 0052). Sindh charges a restaurant's
 * bill one rate when it is paid in cash and a lower one when it is paid by
 * card, wallet or bank transfer (the owner, 6 Oct 2026). The till works out
 * every order's totals at the cash rates, as it always did, and stores
 * beside them what the same bill comes to at the card rates
 * (orders.digital_total_cents). Pay then settles the bill from what the
 * customer actually puts on the card:
 *
 *   The card amount buys the same share of the bill at card prices; the
 *   rest of the bill is paid at cash prices.
 *
 * So Rs 540 on a card against a bill of Rs 1,080 by card (Rs 1,150 in cash)
 * buys half the bill: the other half is Rs 575 in cash, the customer pays
 * Rs 1,115, and the tax is 8% on the card half and 15% on the cash half.
 * All cash: the stored total, to the paisa, exactly as before 0052. All card:
 * the card total. No card rate on the order: the stored total, however it
 * is paid — this is the only rule, and Pay and the till agree on it because
 * both read this one function.
 */
import type { PaymentMethod } from '@cheeseoclock/shared-types';

/** The ways of paying the card rate is for: everything but cash (and foodpanda, which settles its own orders). */
export const DIGITAL_PAYMENT_METHODS: ReadonlyArray<PaymentMethod> = Object.freeze(['card', 'easypaisa', 'jazzcash', 'bank_transfer']);

/** Is money paid this way paid by card / wallet / bank (the card rate)? */
export function isDigitalPayment(method: string): boolean {
  return (DIGITAL_PAYMENT_METHODS as ReadonlyArray<string>).includes(method);
}

/** The stored figures of an order Pay settles. */
export interface TenderQuote {
  /** The stored total: the bill at the cash rates. */
  totalCents: number;
  /** The bill if paid entirely by card / wallet / bank (orders.digital_total_cents); null = no card rate on this order. */
  digitalTotalCents: number | null;
  /** Subtotal less discount: what the tax is on. */
  netCents: number;
}

/** What the sale comes to with `digitalCents` of it on a card / wallet / bank. */
export interface SplitTender {
  /** What the customer still pays in cash (0 when the whole bill went on the card). */
  cashDueCents: number;
  /** The bill as settled: the card amount plus the cash. */
  totalCents: number;
  /** The tax in it: the card part at the card rates, the cash part at the cash rates. */
  taxCents: number;
  /** The part of the bill before tax paid by card / wallet / bank (0 with no card rate on the order). */
  digitalNetCents: number;
  /** The tax on that part (0 with no card rate on the order). */
  digitalTaxCents: number;
}

export type SplitTenderOutcome = ({ ok: true } & SplitTender) | { ok: false; reason: string };

function rupees(cents: number): string {
  return (cents / 100).toLocaleString('en-PK', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

/**
 * The sale with `digitalCents` of the bill on a card / wallet / bank (the
 * sum of those legs; 0 = all cash). Whole paisa in, whole paisa out: the
 * cash part is rounded to the paisa once, the card part's tax is what is
 * left of the card amount after its share of the bill before tax, so the
 * parts always add up to what was paid.
 */
export function splitTender(quote: TenderQuote, digitalCents: number): SplitTenderOutcome {
  const total = quote.totalCents;
  const hasCardRate = quote.digitalTotalCents !== null;
  const cardTotal = quote.digitalTotalCents ?? total;
  const net = quote.netCents;
  if (!Number.isInteger(digitalCents) || digitalCents < 0) {
    return { ok: false, reason: 'The card amount must be whole paisa, not below zero' };
  }
  if (digitalCents > cardTotal) {
    return {
      ok: false,
      reason: hasCardRate
        ? `Rs ${rupees(digitalCents)} on the card is more than the bill by card (Rs ${rupees(cardTotal)})`
        : `Rs ${rupees(digitalCents)} on the card is more than the bill (Rs ${rupees(total)})`,
    };
  }
  // Nothing can go on a card against a Rs 0 bill by card: all of it is cash (Rs 0 of it, usually).
  if (cardTotal <= 0) {
    return { ok: true, cashDueCents: total, totalCents: total, taxCents: total - net, digitalNetCents: 0, digitalTaxCents: 0 };
  }
  const cashDueCents = Math.round(((cardTotal - digitalCents) * total) / cardTotal);
  const totalCents = digitalCents + cashDueCents;
  const digitalNetCents = hasCardRate ? Math.round((digitalCents * net) / cardTotal) : 0;
  return {
    ok: true,
    cashDueCents,
    totalCents,
    taxCents: totalCents - net,
    digitalNetCents,
    digitalTaxCents: hasCardRate ? digitalCents - digitalNetCents : 0,
  };
}

/** The card / wallet / bank money among a sale's legs. */
export function digitalCentsOf(payments: ReadonlyArray<{ method: string; amountCents: number }>): number {
  return payments.filter((p) => isDigitalPayment(p.method)).reduce((n, p) => n + p.amountCents, 0);
}
