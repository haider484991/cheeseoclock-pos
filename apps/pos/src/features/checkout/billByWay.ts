/**
 * The bill by each way of paying, as Pay, Picked up and Change payment show
 * it (0052 the card rate; 0.7.45 a rate for each way of paying). One rule,
 * shared-types billByMethod / pos-domain settleLegs, the till's own: the
 * screens only put it into words.
 */
import { formatCents, type MethodQuote } from '@cheeseoclock/pos-domain';
import {
  billByMethod,
  billDependsOnMethod,
  billsByMethod,
  RATED_METHOD_LABEL,
  type Order,
  type PaymentMethod,
  type RatedPaymentMethod,
} from '@cheeseoclock/shared-types';

/** An order not paid yet as Pay settles it: its stored total is the bill in cash. */
export function quoteOf(order: Pick<Order, 'totalCents' | 'subtotalCents' | 'discountCents' | 'digitalTotalCents' | 'methodTotalsCents'>): MethodQuote {
  return {
    totalCents: order.totalCents,
    digitalTotalCents: order.digitalTotalCents ?? null,
    methodTotalsCents: order.methodTotalsCents ?? null,
    netCents: order.subtotalCents - order.discountCents,
  };
}

/** The bill if it is all paid `method` (foodpanda's own orders: the total, however). */
export function billFor(quote: MethodQuote, method: PaymentMethod, foodpanda = false): number {
  return foodpanda ? quote.totalCents : billByMethod(quote, method);
}

/** Does this bill depend on how it is paid (never a foodpanda order's)? */
export function dependsOnWay(quote: MethodQuote, foodpanda = false): boolean {
  return !foodpanda && billDependsOnMethod(quote);
}

/** "card", "card / EasyPaisa", "JazzCash": ways of paying in a line of words. */
export function waysWords(methods: ReadonlyArray<RatedPaymentMethod>): string {
  return methods.map((m) => (m === 'card' ? 'card' : m === 'bank_transfer' ? 'bank' : RATED_METHOD_LABEL[m])).join(' / ');
}

/**
 * The bills beside each other, for the cashier to tell the customer before
 * they choose: "By card Rs 1,080 · in cash Rs 1,150"; with ways of their own,
 * "By card / EasyPaisa Rs 1,080 · bank Rs 1,100 · in cash Rs 1,150". Null when
 * the bill is the same however it is paid.
 */
export function billsLine(quote: MethodQuote): string | null {
  const groups = billsByMethod(quote);
  if (groups.length === 0) return null;
  const parts = groups.map((g, i) => `${i === 0 ? 'By ' : ''}${waysWords(g.methods)} ${formatCents(g.totalCents)}`);
  return `${parts.join(' · ')} · in cash ${formatCents(quote.totalCents)}`;
}

/** Under the amount charged one way: "Tax at the card rate · Rs 1,150 in cash"; null when it is the cash bill. */
export function wayRateNote(quote: MethodQuote, method: PaymentMethod): string | null {
  const bill = billByMethod(quote, method);
  if (bill === quote.totalCents || method === 'cash') return null;
  const way = method === 'card' ? 'card' : method === 'bank_transfer' ? 'bank transfer' : method === 'foodpanda' ? 'foodpanda' : RATED_METHOD_LABEL[method];
  return `Tax at the ${way} rate · ${formatCents(quote.totalCents)} in cash`;
}
