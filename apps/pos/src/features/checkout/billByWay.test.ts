/**
 * The bill by each way of paying in the screens' words (billByWay.ts): Pay,
 * Picked up + Pay and Take payment charge the chosen way's bill (0.7.45; the
 * owner, 12 Oct 2026: "first the cashier thought it will paid cash then
 * customer decided to pay on card"). Every amount is made up.
 */
import { describe, expect, it } from 'vitest';
import { formatCents } from '@cheeseoclock/pos-domain';
import { offersTakePayment } from '../orders/boardLogic';
import { billFor, billsLine, dependsOnWay, quoteOf, wayRateNote } from './billByWay';

// A Rs 1,000 bill before tax: Rs 1,150 in cash (15%), Rs 1,080 by card and EasyPaisa (8%),
// JazzCash at the cash rate, Rs 1,100 by bank (10%).
const order = {
  subtotalCents: 100_000,
  discountCents: 0,
  totalCents: 115_000,
  digitalTotalCents: 108_000,
  methodTotalsCents: { jazzcash: 115_000, bank_transfer: 110_000 },
};

describe('the bill the chosen way charges', () => {
  it('cash the total; each other way its own bill; foodpanda the total, however', () => {
    const q = quoteOf(order);
    expect(q).toEqual({ totalCents: 115_000, digitalTotalCents: 108_000, methodTotalsCents: { jazzcash: 115_000, bank_transfer: 110_000 }, netCents: 100_000 });
    expect(billFor(q, 'cash')).toBe(115_000);
    expect(billFor(q, 'card')).toBe(108_000);
    expect(billFor(q, 'easypaisa')).toBe(108_000);
    expect(billFor(q, 'jazzcash')).toBe(115_000);
    expect(billFor(q, 'bank_transfer')).toBe(110_000);
    expect(billFor(q, 'card', true)).toBe(115_000);
    expect(dependsOnWay(q)).toBe(true);
    expect(dependsOnWay(q, true)).toBe(false);
  });

  it('an order with no card rate: the total whatever the way, and no line of bills', () => {
    const q = quoteOf({ subtotalCents: 100_000, discountCents: 0, totalCents: 115_000 });
    expect(billFor(q, 'card')).toBe(115_000);
    expect(dependsOnWay(q)).toBe(false);
    expect(billsLine(q)).toBeNull();
  });
});

describe('the words', () => {
  it('the bills beside each other, the way at the cash rate left out', () => {
    expect(billsLine(quoteOf(order))).toBe(`By card / EasyPaisa ${formatCents(108_000)} · bank ${formatCents(110_000)} · in cash ${formatCents(115_000)}`);
    // Every way at one bill: as since 0052.
    expect(billsLine(quoteOf({ ...order, methodTotalsCents: null }))).toBe(
      `By card / EasyPaisa / JazzCash / bank ${formatCents(108_000)} · in cash ${formatCents(115_000)}`,
    );
  });

  it('under the amount charged one way: its rate and the cash bill; nothing for cash or a way at the cash rate', () => {
    const q = quoteOf(order);
    expect(wayRateNote(q, 'card')).toBe(`Tax at the card rate · ${formatCents(115_000)} in cash`);
    expect(wayRateNote(q, 'bank_transfer')).toBe(`Tax at the bank transfer rate · ${formatCents(115_000)} in cash`);
    expect(wayRateNote(q, 'jazzcash')).toBeNull();
    expect(wayRateNote(q, 'cash')).toBeNull();
  });
});

describe('Take payment on Live Orders (0.7.45)', () => {
  it('an unpaid takeaway the kitchen has, New or Preparing; never Ready (Picked up + Pay), paid, or a delivery', () => {
    expect(offersTakePayment({ mode: 'takeaway', status: 'sent_to_kitchen', paidAt: null })).toBe(true);
    expect(offersTakePayment({ mode: 'takeaway', status: 'preparing', paidAt: null })).toBe(true);
    expect(offersTakePayment({ mode: 'takeaway', status: 'ready', paidAt: null })).toBe(false);
    expect(offersTakePayment({ mode: 'takeaway', status: 'preparing', paidAt: '2026-10-12T10:00:00.000Z' })).toBe(false);
    expect(offersTakePayment({ mode: 'delivery', status: 'preparing', paidAt: null })).toBe(false);
    expect(offersTakePayment({ mode: 'foodpanda', status: 'preparing', paidAt: null })).toBe(false);
  });
});
