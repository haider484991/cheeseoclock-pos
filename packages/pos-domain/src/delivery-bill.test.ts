import { describe, expect, it } from 'vitest';
import {
  deliveryBillOf,
  deliveryChargeLinesCents,
  isDeliveryChargeLine,
  salesTaxLabel,
  type DeliveryBill,
} from '@cheeseoclock/shared-types';
import { computeDiscountCents, type DiscountInput } from './discount.js';
import {
  discountBaseCents,
  splitDiscount,
  storedDiscountScope,
  taxAfterDiscount,
  type DiscountScope,
  type TaxedDiscountLine,
} from './discount-base.js';
import { computeTax } from './tax.js';

/**
 * The delivery bill (owner, 2 Oct 2026): Food / Sales tax / FOOD TOTAL (with
 * tax) / Delivery charge / CUSTOMER PAYS, read from the stored figures by
 * shared-types deliveryBillOf (shared-types has no test runner). Q1: the
 * delivery charge keeps its 15% tax. Made-up prices throughout (the
 * repository is public).
 */
const BIG_TWO = { lineTotalCents: 360_000, menuItemName: 'Big Two', taxRateBps: 1500, noDiscount: true };
const FRIES = { lineTotalCents: 30_000, menuItemName: 'Fries', taxRateBps: 1500 };
const PIZZA = { lineTotalCents: 220_000, menuItemName: 'Test Pizza', taxRateBps: 1500 };
const CHARGE_0 = { lineTotalCents: 20_000, menuItemName: 'Delivery Charge (Rs 200)', taxRateBps: 0 };
const CHARGE_15 = { ...CHARGE_0, taxRateBps: 1500 };

const STAFF_SCOPE: DiscountScope = { alsoOffDeliveryCharge: false, skipsNoDiscountLines: true };

/**
 * An order whose stored totals are worked the way recomputeOrderTotals works
 * them (the same pos-domain functions), shaped like the OrderSnapshot the
 * paper reads: its discount's scope read against the stored bill, as
 * getOrderSnapshot reads the newest row (storedDiscountScope).
 */
function worked(
  mode: string,
  lines: ReadonlyArray<TaxedDiscountLine>,
  discount?: { d: DiscountInput; scope: DiscountScope },
) {
  const subtotalCents = lines.reduce((s, l) => s + l.lineTotalCents, 0);
  const scope = discount?.scope ?? { alsoOffDeliveryCharge: true, skipsNoDiscountLines: false };
  const discountCents = discount ? (computeDiscountCents(discountBaseCents(lines, scope), discount.d) as number) : 0;
  const taxCents = subtotalCents > 0 ? taxAfterDiscount(lines, discountCents, scope).taxCents : 0;
  const read = discount
    ? storedDiscountScope(scope, lines, discountCents, taxCents, {
        discountType: discount.d.type,
        value: discount.d.value,
        source: null,
        ruleJson: null,
      })
    : null;
  return {
    order: { mode, subtotalCents, discountCents, taxCents, totalCents: subtotalCents - discountCents + taxCents },
    items: lines.map((l) => ({ ...l, menuItemName: l.menuItemName ?? 'Test Item' })),
    discounts: read ? [{ alsoOffDeliveryCharge: read.alsoOffDeliveryCharge, skipsNoDiscountLines: read.skipsNoDiscountLines }] : [],
  };
}

describe('deliveryBillOf: the owner’s example', () => {
  it('with the delivery charge at 0%: Food 3,900 / tax 585 / FOOD TOTAL 4,485 / charge 200 / CUSTOMER PAYS 4,685', () => {
    expect(deliveryBillOf(worked('delivery', [BIG_TWO, FRIES, CHARGE_0]))).toEqual<DeliveryBill>({
      foodCents: 390_000,
      deliveryChargeCents: 20_000,
      foodTaxCents: 58_500,
      foodTaxBps: 1500,
      deliveryTaxCents: 0,
      deliveryTaxBps: 0,
      foodTotalCents: 448_500,
      customerPaysCents: 468_500,
    });
  });

  it('with the delivery charge taxed at 15% (live data, Q1): Sales tax on delivery 30, FOOD TOTAL 4,515, CUSTOMER PAYS 4,715', () => {
    expect(deliveryBillOf(worked('delivery', [BIG_TWO, FRIES, CHARGE_15]))).toEqual<DeliveryBill>({
      foodCents: 390_000,
      deliveryChargeCents: 20_000,
      foodTaxCents: 58_500,
      foodTaxBps: 1500,
      deliveryTaxCents: 3_000,
      deliveryTaxBps: 1500,
      foodTotalCents: 451_500,
      customerPaysCents: 471_500,
    });
  });

  it('a value deal and a staff 10% (food only, not on value deals): 220 off, Sales tax 837, on delivery 30, 6,447 / 6,647', () => {
    const bill = deliveryBillOf(worked('delivery', [BIG_TWO, PIZZA, CHARGE_15], { d: { type: 'percent', value: 10 }, scope: STAFF_SCOPE }));
    expect(bill).toEqual<DeliveryBill>({
      foodCents: 580_000,
      deliveryChargeCents: 20_000,
      foodTaxCents: 83_700,
      foodTaxBps: 1500,
      deliveryTaxCents: 3_000,
      deliveryTaxBps: 1500,
      foodTotalCents: 644_700,
      customerPaysCents: 664_700,
    });
  });

  it('a discount that also came off the delivery charge (the owner’s switch, or a pre-0.7.26 order): all tax on one line', () => {
    const switchOn = worked('delivery', [FRIES, PIZZA, CHARGE_15], {
      d: { type: 'percent', value: 10 },
      scope: { alsoOffDeliveryCharge: true, skipsNoDiscountLines: true },
    });
    const bill = deliveryBillOf(switchOn);
    expect(bill).not.toBeNull();
    expect(bill!.deliveryTaxCents).toBeNull();
    expect(bill!.foodTaxCents).toBe(switchOn.order.taxCents);
    expect(bill!.foodTaxBps).toBe(1500);
    expect(bill!.foodTotalCents + bill!.deliveryChargeCents).toBe(switchOn.order.totalCents);
    // A discount row from before 0.7.26 has no rule: read as also off the charge.
    const old = { ...switchOn, discounts: [{}] };
    expect(deliveryBillOf(old)!.deliveryTaxCents).toBeNull();
    // With no rate on any line in common, no number.
    const mixed = worked('delivery', [{ ...FRIES, taxRateBps: 1600 }, PIZZA, CHARGE_15], {
      d: { type: 'percent', value: 10 },
      scope: { alsoOffDeliveryCharge: true, skipsNoDiscountLines: true },
    });
    expect(deliveryBillOf(mixed)!.foodTaxBps).toBeNull();
  });

  it('a discount that left the charge alone but found nothing to come off (Rs 0) still shows the charge’s tax apart', () => {
    const dealsOnly = worked('delivery', [BIG_TWO, CHARGE_15], { d: { type: 'percent', value: 10 }, scope: STAFF_SCOPE });
    expect(dealsOnly.order.discountCents).toBe(0);
    expect(deliveryBillOf(dealsOnly)).toMatchObject({ deliveryTaxCents: 3_000, foodTaxCents: 54_000, foodTotalCents: 417_000 });
  });

  it('a charge line with no rate (a legacy snapshot) keeps all tax on one line', () => {
    const legacyCharge = { lineTotalCents: 20_000, menuItemName: 'Delivery Charge (Rs 200)' };
    const order = worked('delivery', [BIG_TWO, FRIES, legacyCharge]);
    const bill = deliveryBillOf(order);
    expect(bill).toMatchObject({ deliveryTaxCents: null, deliveryTaxBps: null, foodTaxCents: order.order.taxCents, foodTaxBps: null });
  });

  it('food at different rates: no rate on the food line, the charge’s own still shown', () => {
    const bill = deliveryBillOf(worked('delivery', [BIG_TWO, { ...FRIES, taxRateBps: 1600 }, CHARGE_15]));
    expect(bill).toMatchObject({ foodTaxBps: null, deliveryTaxBps: 1500, deliveryTaxCents: 3_000 });
  });

  it('two charge lines (two fees on one order) are summed, each taxed on its own', () => {
    const second = { lineTotalCents: 25_000, menuItemName: 'Delivery Charge (Rs 250)', taxRateBps: 1500 };
    const bill = deliveryBillOf(worked('delivery', [FRIES, CHARGE_15, second]));
    expect(bill).toMatchObject({ deliveryChargeCents: 45_000, deliveryTaxCents: 3_000 + 3_750, foodCents: 30_000, foodTaxCents: 4_500 });
  });
});

describe('deliveryBillOf: null keeps the usual layout', () => {
  it('not a delivery: takeaway, dine-in, foodpanda, online', () => {
    for (const mode of ['takeaway', 'dine_in', 'foodpanda', 'online']) {
      expect({ mode, bill: deliveryBillOf(worked(mode, [BIG_TWO, FRIES, CHARGE_15])) }).toEqual({ mode, bill: null });
    }
  });

  it('a delivery with no charge line, or a Rs 0 charge (a Rs 0 area)', () => {
    expect(deliveryBillOf(worked('delivery', [BIG_TWO, FRIES]))).toBeNull();
    expect(deliveryBillOf(worked('delivery', [BIG_TWO, FRIES, { ...CHARGE_15, lineTotalCents: 0, menuItemName: 'Delivery Charge (Rs 0)' }]))).toBeNull();
  });

  it('a total below the charge (a discount that also came off the charge): never a negative FOOD TOTAL', () => {
    const allOff = worked('delivery', [FRIES, CHARGE_15], { d: { type: 'percent', value: 100 }, scope: { alsoOffDeliveryCharge: true, skipsNoDiscountLines: false } });
    expect(allOff.order.totalCents).toBe(0);
    expect(deliveryBillOf(allOff)).toBeNull();
    // Equal to the charge is still a bill (FOOD TOTAL Rs 0).
    const exact = { ...allOff, order: { ...allOff.order, totalCents: 20_000 } };
    expect(deliveryBillOf(exact)).toMatchObject({ foodTotalCents: 0, customerPaysCents: 20_000 });
  });
});

describe('deliveryChargeLinesCents', () => {
  it('Σ of the lines sold under a "Delivery Charge…" name, 0 when none', () => {
    expect(deliveryChargeLinesCents({ items: [BIG_TWO, FRIES, CHARGE_15] })).toBe(20_000);
    expect(deliveryChargeLinesCents({ items: [FRIES, { ...CHARGE_15, lineTotalCents: 25_000, menuItemName: 'Delivery Charge (Rs 250)' }] })).toBe(25_000);
    expect(deliveryChargeLinesCents({ items: [BIG_TWO, FRIES] })).toBe(0);
    expect(deliveryChargeLinesCents({ items: [] })).toBe(0);
  });

  it('reads the name the line was sold under, never a fee item id', () => {
    expect(deliveryChargeLinesCents({ items: [{ lineTotalCents: 20_000, menuItemName: '  delivery charge (rs 200)' }] })).toBe(20_000);
    const feeItemLine = { lineTotalCents: 20_000, menuItemName: 'Rider fee', menuItemId: 'fee-200' };
    expect(deliveryChargeLinesCents({ items: [feeItemLine] })).toBe(0);
  });
});

describe('salesTaxLabel', () => {
  it('the food’s line and the delivery’s line, with and without a rate', () => {
    expect(salesTaxLabel(1500)).toBe('Sales tax 15%');
    expect(salesTaxLabel(null)).toBe('Sales tax');
    expect(salesTaxLabel(1500, true)).toBe('Sales tax on delivery 15%');
    expect(salesTaxLabel(null, true)).toBe('Sales tax on delivery');
  });

  it('the rate as the receipt’s Tax (16.5%) writes it; 0, below 0 or a part basis point gives no number', () => {
    expect(salesTaxLabel(1650)).toBe('Sales tax 16.5%');
    expect(salesTaxLabel(1625)).toBe('Sales tax 16.25%');
    expect(salesTaxLabel(1600)).toBe('Sales tax 16%');
    expect(salesTaxLabel(5)).toBe('Sales tax 0.05%');
    expect(salesTaxLabel(0)).toBe('Sales tax');
    expect(salesTaxLabel(0, true)).toBe('Sales tax on delivery');
    expect(salesTaxLabel(-100)).toBe('Sales tax');
    expect(salesTaxLabel(1500.5)).toBe('Sales tax');
  });
});

describe('deliveryBillOf: 2,000 made-up orders worked as the till works them', () => {
  it('FOOD TOTAL + charge = total; the parts add up to FOOD TOTAL; a split charge tax is the tax the till put on it', () => {
    let seed = 20261002;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
    const seen = { bills: 0, nulls: 0, split: 0, splitWithDealsSkipped: 0, splitWithDiscount: 0, oneLine: 0 };
    for (let n = 0; n < 2_000; n++) {
      const lines: TaxedDiscountLine[] = Array.from({ length: 1 + Math.floor(rnd() * 6) }, (_, i) => {
        const kind = rnd();
        const rate = rnd() < 0.04 ? undefined : pick([0, 500, 1500, 1500, 1600]);
        if (kind < 0.3) {
          const fee = pick([0, 15_000, 20_000, 20_000, 25_000]);
          return { lineTotalCents: fee * (rnd() < 0.1 ? 2 : 1), menuItemName: `Delivery Charge (Rs ${fee / 100})`, ...(rate === undefined ? {} : { taxRateBps: rate }) };
        }
        const unit = rnd() < 0.05 ? 0 : 10_000 + Math.floor(rnd() * 400_000);
        return {
          lineTotalCents: unit * (1 + Math.floor(rnd() * 3)),
          menuItemName: kind < 0.55 ? `Test Deal ${i}` : `Test Item ${i}`,
          ...(kind < 0.55 ? { noDiscount: true } : rnd() < 0.2 ? { noDiscount: false } : {}),
          ...(rate === undefined ? {} : { taxRateBps: rate }),
        };
      });
      const mode = pick(['delivery', 'delivery', 'delivery', 'delivery', 'takeaway', 'foodpanda', 'dine_in', 'online']);
      const scope: DiscountScope = { alsoOffDeliveryCharge: rnd() < 0.35, skipsNoDiscountLines: rnd() < 0.7 };
      const subtotal = lines.reduce((s, l) => s + l.lineTotalCents, 0);
      const d: DiscountInput | null =
        rnd() < 0.3
          ? null
          : rnd() < 0.6
            ? { type: 'percent', value: pick([0, 5, 10, 10, 15, 20, 50, 100]) }
            : { type: 'flat', value: Math.floor(rnd() * (subtotal + 50_000)) };
      const s = worked(mode, lines, d ? { d, scope } : undefined);
      const { order } = s;
      const charge = lines.filter((l) => isDeliveryChargeLine(l)).reduce((t, l) => t + l.lineTotalCents, 0);
      expect(deliveryChargeLinesCents(s)).toBe(charge);

      const bill = deliveryBillOf(s);
      const wantsBill = mode === 'delivery' && charge > 0 && order.totalCents >= charge;
      expect({ n, isBill: bill !== null }).toEqual({ n, isBill: wantsBill });
      if (!bill) {
        seen.nulls++;
        continue;
      }
      seen.bills++;
      for (const [k, v] of Object.entries(bill)) {
        if (v !== null) expect({ n, k, safe: Number.isSafeInteger(v) }).toEqual({ n, k, safe: true });
      }
      expect(bill.deliveryChargeCents).toBe(charge);
      expect(bill.customerPaysCents).toBe(order.totalCents);
      expect(bill.foodTotalCents + bill.deliveryChargeCents).toBe(order.totalCents);
      expect(bill.foodCents + bill.deliveryChargeCents).toBe(order.subtotalCents);
      expect(bill.foodCents - order.discountCents + bill.foodTaxCents + (bill.deliveryTaxCents ?? 0)).toBe(bill.foodTotalCents);

      // What the till stored for each line: its share of the discount, then its tax on what is left.
      const shares = splitDiscount(lines, order.discountCents, d ? scope : { alsoOffDeliveryCharge: true, skipsNoDiscountLines: false });
      const lineTax = lines.map(
        (l, i) => computeTax(Math.max(0, l.lineTotalCents - (shares[i] ?? 0)), l.taxRateBps ?? 0, 'exclusive').taxCents as number,
      );
      const isCharge = lines.map((l) => isDeliveryChargeLine(l));
      if (bill.deliveryTaxCents !== null) {
        seen.split++;
        if (order.discountCents > 0) seen.splitWithDiscount++;
        if (order.discountCents > 0 && scope.skipsNoDiscountLines && lines.some((l) => l.noDiscount)) seen.splitWithDealsSkipped++;
        // The charge took none of the discount, and its tax on paper is the tax the till put on it.
        lines.forEach((_, i) => {
          if (isCharge[i]) expect({ n, i, share: shares[i] }).toEqual({ n, i, share: 0 });
        });
        expect(bill.deliveryTaxCents).toBe(lineTax.reduce((t, x, i) => t + (isCharge[i] ? x : 0), 0));
        expect(bill.foodTaxCents).toBe(lineTax.reduce((t, x, i) => t + (isCharge[i] ? 0 : x), 0));
      } else {
        seen.oneLine++;
        expect(bill.foodTaxCents).toBe(order.taxCents);
        // Only when the discount came off the charge too, or a charge line has no rate.
        const tookDiscount = order.discountCents > 0 && scope.alsoOffDeliveryCharge;
        const noRate = lines.some((l) => isDeliveryChargeLine(l) && l.taxRateBps === undefined);
        expect({ n, why: tookDiscount || noRate }).toEqual({ n, why: true });
      }
    }
    // The made-up orders reach every branch.
    expect(seen.bills).toBeGreaterThan(500);
    expect(seen.nulls).toBeGreaterThan(300);
    expect(seen.split).toBeGreaterThan(200);
    expect(seen.splitWithDiscount).toBeGreaterThan(100);
    expect(seen.splitWithDealsSkipped).toBeGreaterThan(50);
    expect(seen.oneLine).toBeGreaterThan(50);
  });
});
