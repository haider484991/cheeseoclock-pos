/**
 * The FBR sale invoice and its debit note (fbr-core mapper) with value deals
 * (owner, 2 Oct 2026: value deals never get any discount). fbr-core has no
 * test runner of its own: the till, which queues these invoices
 * (fbr-worker), tests them here. Each bill below is stored the way the till
 * stores it (pos-domain taxAfterDiscount on the discount's scope), so the
 * invoice must add up to it line by line. Every name and amount is made up.
 */
import { describe, expect, it } from 'vitest';
import { mapOrderToFbrPayload, mapRefundToFbrDebitNote, type FbrSellerInfo } from '@cheeseoclock/fbr-core';
import { computeDiscountCents, discountBaseCents, taxAfterDiscount, type DiscountScope } from '@cheeseoclock/pos-domain';
import type { Cents, OrderDiscount, OrderNumber, OrderSnapshot, UUID } from '@cheeseoclock/shared-types';

const SELLER: FbrSellerInfo = { sellerNTNCNIC: '0000000', sellerBusinessName: 'Test Shop', sellerProvince: 'Sindh', sellerAddress: 'Test Road' };
const PAID_AT = '2026-09-26T14:00:00.000Z';
const REFUNDED_AT = '2026-09-27T09:30:00.000Z';

interface Line {
  name: string;
  cents: number;
  rateBps: number;
  /** The line's snapshot (order_items.no_discount); absent = a line sold before 0.7.34. */
  noDiscount?: boolean;
}
const PIZZA: Line = { name: 'Test Fajita Pizza', cents: 150_000, rateBps: 1_500 };
const BIG_TWO: Line = { name: 'Big Two', cents: 360_000, rateBps: 1_500, noDiscount: true };
const CHARGE: Line = { name: 'Delivery Charge (Rs 200)', cents: 20_000, rateBps: 1_500 };

/** The discount row as getOrderSnapshot gives it: the scope it was worked on, and a foodpanda deal's source. */
interface Given {
  type: 'percent' | 'flat';
  value: number;
  scope: DiscountScope;
  source?: 'foodpanda' | null;
  /** Leave both scope fields off the row: a snapshot made before 0.7.34 carried only alsoOffDeliveryCharge. */
  pre0734?: boolean;
}

/** The order as the till stores it: the discount worked on its scope's base, the tax on what is left of each line. */
function snapshotOf(lines: Line[], given: Given | null): OrderSnapshot {
  const discountLines = lines.map((l) => ({
    lineTotalCents: l.cents,
    menuItemName: l.name,
    taxRateBps: l.rateBps,
    ...(l.noDiscount === undefined ? {} : { noDiscount: l.noDiscount }),
  }));
  const subtotal = lines.reduce((s, l) => s + l.cents, 0);
  const scope = given?.scope ?? { alsoOffDeliveryCharge: true, skipsNoDiscountLines: false };
  const discount = given ? (computeDiscountCents(discountBaseCents(discountLines, scope), { type: given.type, value: given.value }) as number) : 0;
  const tax = taxAfterDiscount(discountLines, discount, scope).taxCents;
  const discounts: OrderDiscount[] = given
    ? [
        {
          id: 'disc-1' as UUID,
          orderId: 'order-1' as UUID,
          discountType: given.type,
          value: given.value,
          reason: given.source === 'foodpanda' ? null : 'Staff',
          appliedByUserId: 'u_cash' as UUID,
          approvedByUserId: null,
          amountCents: discount as Cents,
          source: given.source ?? null,
          alsoOffDeliveryCharge: given.scope.alsoOffDeliveryCharge,
          ...(given.pre0734 ? {} : { skipsNoDiscountLines: given.scope.skipsNoDiscountLines }),
        },
      ]
    : [];
  return {
    order: {
      id: 'order-1' as UUID,
      orderNumber: '0042' as OrderNumber,
      mode: 'delivery',
      status: 'paid',
      tableId: null,
      customerId: null,
      cashierId: 'u_cash' as UUID,
      shiftId: 'shift-1' as UUID,
      source: 'pos',
      notes: null,
      subtotalCents: subtotal as Cents,
      discountCents: discount as Cents,
      taxCents: tax as Cents,
      totalCents: (subtotal - discount + tax) as Cents,
      createdAt: '2026-09-26T13:40:00.000Z',
      paidAt: PAID_AT,
      voidedAt: null,
      voidedBy: null,
      voidReason: null,
      assignedRiderId: null,
      dispatchedAt: null,
      deliveredAt: null,
    },
    items: lines.map((l, i) => ({
      id: `line-${i}` as UUID,
      orderId: 'order-1' as UUID,
      menuItemId: `item-${i}` as UUID,
      comboId: null,
      parentOrderItemId: null,
      quantity: 1,
      unitPriceCents: l.cents as Cents,
      lineTotalCents: l.cents as Cents,
      taxCategoryId: 'tax-1' as UUID,
      notes: null,
      kitchenStatus: 'served',
      ...(l.noDiscount === undefined ? {} : { noDiscount: l.noDiscount }),
      menuItemName: l.name,
      categoryName: 'Test',
      prepStation: 'kitchen',
      taxRateBps: l.rateBps,
      modifiers: [],
    })),
    discounts,
    payments: [],
    cashierName: 'Test Cashier',
    tableLabel: null,
    customerName: null,
    customerPhone: null,
    deliveryAddress: null,
    rider: null,
  };
}

/** The invoice's lines by name, in rupees: before tax, tax, and the discount key (undefined when the line has none). */
const byName = (items: ReturnType<typeof mapOrderToFbrPayload>['items']) =>
  Object.fromEntries(items.map((i) => [i.productDescription, { net: i.valueSalesExcludingST, tax: i.salesTaxApplicable, discount: i.discount }]));
const paisa = (x: number) => Math.round(x * 100);
const taxOf = (items: ReturnType<typeof mapOrderToFbrPayload>['items']) => items.reduce((t, i) => t + paisa(i.salesTaxApplicable), 0);

const STAFF_10_SKIPS: Given = { type: 'percent', value: 10, scope: { alsoOffDeliveryCharge: false, skipsNoDiscountLines: true } };

describe('a staff discount that leaves the value deals alone', () => {
  it('Pizza + Big Two at 10%: Rs 150 off the pizza only; Big Two has no discount key at Rs 3,600; the line tax adds up to the stored tax', () => {
    const s = snapshotOf([PIZZA, BIG_TWO], STAFF_10_SKIPS);
    // 10% of the Rs 1,500 pizza; tax 15% of (Rs 1,350 + Rs 3,600).
    expect(s.order).toMatchObject({ subtotalCents: 510_000, discountCents: 15_000, taxCents: 74_250, totalCents: 569_250 });
    const sale = mapOrderToFbrPayload(s, SELLER);
    expect(byName(sale.items)).toEqual({
      'Test Fajita Pizza': { net: 1_350, tax: 202.5, discount: 150 },
      'Big Two': { net: 3_600, tax: 540, discount: undefined },
    });
    expect(sale.items.find((i) => i.productDescription === 'Big Two')).not.toHaveProperty('discount');
    expect(taxOf(sale.items)).toBe(74_250);
  });

  it('a 50% debit note is the sale halved, line by line; Big Two still has no discount key', () => {
    const s = snapshotOf([PIZZA, BIG_TWO], STAFF_10_SKIPS);
    const note = mapRefundToFbrDebitNote(s, SELLER, { originalIrn: 'IRN-TEST-1', refundedCents: 569_250 / 2, refundedAt: REFUNDED_AT });
    expect(note.invoiceType).toBe('Debit Note');
    expect(byName(note.items)).toEqual({
      'Refund: Test Fajita Pizza': { net: 675, tax: 101.25, discount: 75 },
      'Refund: Big Two': { net: 1_800, tax: 270, discount: undefined },
    });
    expect(note.items.find((i) => i.productDescription === 'Refund: Big Two')).not.toHaveProperty('discount');
    expect(taxOf(note.items)).toBe(74_250 / 2);
  });

  it('a delivery with a food-only discount: the Rs 200 charge and the deal keep their full value and no discount key', () => {
    const s = snapshotOf([PIZZA, BIG_TWO, CHARGE], STAFF_10_SKIPS);
    const sale = mapOrderToFbrPayload(s, SELLER);
    expect(byName(sale.items)).toEqual({
      'Test Fajita Pizza': { net: 1_350, tax: 202.5, discount: 150 },
      'Big Two': { net: 3_600, tax: 540, discount: undefined },
      'Delivery Charge (Rs 200)': { net: 200, tax: 30, discount: undefined },
    });
    expect(sale.items.find((i) => i.productDescription === 'Delivery Charge (Rs 200)')).not.toHaveProperty('discount');
    expect(taxOf(sale.items)).toBe(s.order.taxCents);
  });

  it('a delivery with no value deal and a food-only discount: the charge line stays at Rs 200 before tax with no discount key', () => {
    const s = snapshotOf([PIZZA, CHARGE], STAFF_10_SKIPS);
    const charge = mapOrderToFbrPayload(s, SELLER).items.find((i) => i.productDescription === 'Delivery Charge (Rs 200)');
    expect(charge).toMatchObject({ valueSalesExcludingST: 200, salesTaxApplicable: 30 });
    expect(charge).not.toHaveProperty('discount');
  });

  it('a discount more than the deal-free lines can carry (only an older till stores one) is split over every line, so the invoice adds up', () => {
    // An older till re-worked a Rs 1,000 flat over the deal too: more than the Rs 600 the scope leaves.
    const small: Line = { name: 'Test Small Pizza', cents: 60_000, rateBps: 1_500 };
    const s = snapshotOf([small, BIG_TWO], { type: 'flat', value: 100_000, scope: { alsoOffDeliveryCharge: true, skipsNoDiscountLines: false } });
    const stored = { ...s, discounts: [{ ...s.discounts[0]!, skipsNoDiscountLines: true }] };
    expect(stored.order.discountCents).toBe(100_000);
    const sale = mapOrderToFbrPayload(stored, SELLER);
    expect(sale.items.reduce((t, i) => t + paisa(i.discount ?? 0), 0)).toBe(100_000);
    expect(sale.items.reduce((t, i) => t + paisa(i.valueSalesExcludingST), 0)).toBe(420_000 - 100_000);
    expect(taxOf(sale.items)).toBe(stored.order.taxCents);
  });
});

describe('a discount that covers the deals keeps covering them', () => {
  it('the foodpanda deal (it never skips: it matches the tablet) splits over the deal too', () => {
    const s = snapshotOf([PIZZA, BIG_TWO], {
      type: 'percent',
      value: 20,
      source: 'foodpanda',
      scope: { alsoOffDeliveryCharge: false, skipsNoDiscountLines: false },
    });
    // 20% of Rs 5,100: Rs 1,020, split Rs 300 / Rs 720.
    expect(s.order.discountCents).toBe(102_000);
    const sale = mapOrderToFbrPayload(s, SELLER);
    expect(byName(sale.items)).toEqual({
      'Test Fajita Pizza': { net: 1_200, tax: 180, discount: 300 },
      'Big Two': { net: 2_880, tax: 432, discount: 720 },
    });
    expect(taxOf(sale.items)).toBe(s.order.taxCents);
  });
});

/**
 * A snapshot from before 0.7.34 — no never-discounted mark on its lines, no
 * skipsNoDiscountLines on its discount — and the same order's lines marked
 * under a discount that did not skip them: the sale invoice and both debit
 * notes are byte for byte what the v0.7.33 mapper made of them.
 */
describe('history maps as before', () => {
  const FOOD_ONLY_OVER_DEALS: Given = { type: 'percent', value: 10, scope: { alsoOffDeliveryCharge: false, skipsNoDiscountLines: false }, pre0734: true };
  const unmarked = { ...BIG_TWO, noDiscount: undefined };
  const payloads = (s: OrderSnapshot) =>
    JSON.stringify([
      mapOrderToFbrPayload(s, SELLER),
      mapRefundToFbrDebitNote(s, SELLER, { originalIrn: 'IRN-TEST-2', refundedCents: s.order.totalCents, refundedAt: REFUNDED_AT }),
      mapRefundToFbrDebitNote(s, SELLER, { originalIrn: 'IRN-TEST-2', refundedCents: 123_456, refundedAt: REFUNDED_AT }),
    ]);
  // Captured from the v0.7.33 mapper (fbr-core mapper.ts at b45ca6c) for this order.
  const V0733 = '[{"invoiceType":"Sale Invoice","invoiceDate":"2026-09-26","sellerNTNCNIC":"0000000","sellerBusinessName":"Test Shop","sellerProvince":"Sindh","sellerAddress":"Test Road","buyerRegistrationType":"Unregistered","invoiceRefNo":"0042","items":[{"hsCode":"2106.9090","productDescription":"Test Fajita Pizza","rate":"15%","uoM":"Each","quantity":1,"totalValues":1552.5,"valueSalesExcludingST":1350,"fixedNotifiedValueOrRetailPrice":1500,"salesTaxApplicable":202.5,"salesTaxWithheldAtSource":0,"saleType":"Goods at standard rate (default)","discount":150},{"hsCode":"2106.9090","productDescription":"Big Two","rate":"15%","uoM":"Each","quantity":1,"totalValues":3726,"valueSalesExcludingST":3240,"fixedNotifiedValueOrRetailPrice":3600,"salesTaxApplicable":486,"salesTaxWithheldAtSource":0,"saleType":"Goods at standard rate (default)","discount":360},{"hsCode":"2106.9090","productDescription":"Delivery Charge (Rs 200)","rate":"15%","uoM":"Each","quantity":1,"totalValues":230,"valueSalesExcludingST":200,"fixedNotifiedValueOrRetailPrice":200,"salesTaxApplicable":30,"salesTaxWithheldAtSource":0,"saleType":"Goods at standard rate (default)"}]},{"invoiceType":"Debit Note","invoiceDate":"2026-09-27","sellerNTNCNIC":"0000000","sellerBusinessName":"Test Shop","sellerProvince":"Sindh","sellerAddress":"Test Road","buyerRegistrationType":"Unregistered","invoiceRefNo":"IRN-TEST-2","items":[{"hsCode":"2106.9090","productDescription":"Test Fajita Pizza","rate":"15%","uoM":"Each","quantity":1,"totalValues":1552.5,"valueSalesExcludingST":1350,"fixedNotifiedValueOrRetailPrice":1500,"salesTaxApplicable":202.5,"salesTaxWithheldAtSource":0,"saleType":"Goods at standard rate (default)","discount":150},{"hsCode":"2106.9090","productDescription":"Big Two","rate":"15%","uoM":"Each","quantity":1,"totalValues":3726,"valueSalesExcludingST":3240,"fixedNotifiedValueOrRetailPrice":3600,"salesTaxApplicable":486,"salesTaxWithheldAtSource":0,"saleType":"Goods at standard rate (default)","discount":360},{"hsCode":"2106.9090","productDescription":"Delivery Charge (Rs 200)","rate":"15%","uoM":"Each","quantity":1,"totalValues":230,"valueSalesExcludingST":200,"fixedNotifiedValueOrRetailPrice":200,"salesTaxApplicable":30,"salesTaxWithheldAtSource":0,"saleType":"Goods at standard rate (default)"}]},{"invoiceType":"Debit Note","invoiceDate":"2026-09-27","sellerNTNCNIC":"0000000","sellerBusinessName":"Test Shop","sellerProvince":"Sindh","sellerAddress":"Test Road","buyerRegistrationType":"Unregistered","invoiceRefNo":"IRN-TEST-2","items":[{"hsCode":"2106.9090","productDescription":"Refund: Test Fajita Pizza","rate":"15%","uoM":"Each","quantity":1,"totalValues":347.94,"valueSalesExcludingST":302.56,"fixedNotifiedValueOrRetailPrice":302.56,"salesTaxApplicable":45.38,"salesTaxWithheldAtSource":0,"saleType":"Goods at standard rate (default)","discount":33.62},{"hsCode":"2106.9090","productDescription":"Refund: Big Two","rate":"15%","uoM":"Each","quantity":1,"totalValues":835.07,"valueSalesExcludingST":726.15,"fixedNotifiedValueOrRetailPrice":726.15,"salesTaxApplicable":108.92,"salesTaxWithheldAtSource":0,"saleType":"Goods at standard rate (default)","discount":80.68},{"hsCode":"2106.9090","productDescription":"Refund: Delivery Charge (Rs 200)","rate":"15%","uoM":"Each","quantity":1,"totalValues":51.54,"valueSalesExcludingST":44.82,"fixedNotifiedValueOrRetailPrice":44.82,"salesTaxApplicable":6.72,"salesTaxWithheldAtSource":0,"saleType":"Goods at standard rate (default)"}]}]';

  it('a pre-0.7.34 snapshot (no fields): byte for byte', () => {
    expect(payloads(snapshotOf([PIZZA, unmarked, CHARGE], FOOD_ONLY_OVER_DEALS))).toBe(V0733);
  });

  it('marked lines under a discount row that does not skip (a v0.7.33 discount, read on this version): byte for byte', () => {
    expect(payloads(snapshotOf([PIZZA, BIG_TWO, CHARGE], FOOD_ONLY_OVER_DEALS))).toBe(V0733);
    expect(payloads(snapshotOf([PIZZA, BIG_TWO, CHARGE], { ...FOOD_ONLY_OVER_DEALS, pre0734: false }))).toBe(V0733);
  });
});
