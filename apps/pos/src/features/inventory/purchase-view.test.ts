import { describe, expect, it } from 'vitest';
import type { Ingredient } from '@cheeseoclock/shared-types';
import {
  billUnitText,
  lineCheck,
  lineWords,
  mergePurchaseLists,
  orderedPriceText,
  payoutMatchText,
  purchaseTotalText,
  readBill,
  readBoughtQty,
  readQty,
} from './purchase-view';

// Every price here is made up (costing spec D11).
const onion = {
  unit: 'g',
  costPerUnitCents: 15,
  packSize: 1000,
  packPriceCents: 15_000, // Rs 150 / kg
  priceKind: 'set',
  priceFromRecipe: false,
} satisfies Pick<Ingredient, 'unit' | 'costPerUnitCents' | 'packSize' | 'packPriceCents' | 'priceKind' | 'priceFromRecipe'>;

describe('what a bill says, in plain words (costing spec Phase 5)', () => {
  it('amounts and rupees as typed', () => {
    expect(readQty('5 kg', 'g')).toBe(5_000);
    expect(readQty('2.5kg', 'g')).toBe(2_500);
    expect(readQty('750', 'g')).toBe(750);
    expect(readQty('12', 'pcs')).toBe(12);
    expect(readQty('1.5', 'pcs')).toBeNull();
    expect(readQty('', 'g')).toBeNull();
    expect(readBill('1,250')).toBe(125_000);
    expect(readBill('0')).toBe(0);
    expect(readBill('12.5')).toBe(1_250);
    expect(readBill('abc')).toBeNull();
  });

  it('a price per kg from a bill, and an ordered line as it was bought', () => {
    expect(billUnitText(2_000, 37_500, 'g')).toBe('Rs 187.50 / kg');
    expect(orderedPriceText({ orderedPackSize: 1_000, orderedPackPriceCents: 37_550, unitCostCents: 38 }, 'g')).toBe('Rs 375.50 / kg');
    expect(orderedPriceText({ orderedPackSize: 6_000, orderedPackPriceCents: 225_000, unitCostCents: 38 }, 'g')).toBe('Rs 2,250 for 6,000 g');
    expect(orderedPriceText({ orderedPackSize: null, orderedPackPriceCents: null, unitCostCents: 95 }, 'g')).toBe('Rs 950 / kg');
  });

  it("a quick purchase far above the usual price asks, with 'keep' picked", () => {
    const c = lineCheck(onion, 2_000, 37_500, 'quick')!;
    expect(c).toMatchObject({ ask: true, adoptByDefault: false });
    expect(lineWords(c, 2_000, 37_500, 'g')).toEqual({
      price: 'Rs 187.50 / kg',
      note: '25% dearer than usual (Rs 150 / kg). Use Rs 187.50 / kg as the new price?',
      ask: true,
      warn: true,
    });
    // A purchase order delivered asks the same, with "use" picked.
    expect(lineCheck(onion, 2_000, 37_500, 'order')).toMatchObject({ ask: true, adoptByDefault: true });
  });

  it('close to the usual price, no price yet, made here, a bill of Rs 0', () => {
    expect(lineWords(lineCheck(onion, 2_000, 31_000, 'quick')!, 2_000, 31_000, 'g').note).toBe(
      'Close to the usual Rs 150 / kg: the price becomes Rs 155 / kg.',
    );
    const unset = { ...onion, priceKind: 'unset' as const, packSize: null, packPriceCents: null, costPerUnitCents: 0 };
    expect(lineWords(lineCheck(unset, 1_000, 20_000, 'quick')!, 1_000, 20_000, 'g').note).toBe('No price yet: Rs 200 / kg becomes its price.');
    const made = { ...onion, priceFromRecipe: true };
    expect(lineWords(lineCheck(made, 1_000, 20_000, 'quick')!, 1_000, 20_000, 'g').note).toMatch(/^Made here/);
    expect(lineWords(lineCheck(onion, 1_000, 0, 'order')!, 1_000, 0, 'g').note).toMatch(/price stays/);
    expect(lineCheck(onion, null, 100, 'quick')).toBeNull();
  });

  it('Receive / Record a purchase: a number alone under 1,000 of something weighed asks for the unit; what is read is shown', () => {
    // The Receive box's hint says "5 kg": "5" is not booked as 5 g.
    expect(readBoughtQty('5', 'g')).toEqual({ qty: null, shows: null, problem: '5 g or 5 kg? Type the unit.' });
    expect(readBoughtQty('750', 'ml')).toEqual({ qty: null, shows: null, problem: '750 ml or 750 litre? Type the unit.' });
    // With the unit it is what it says, and the screen shows it back.
    expect(readBoughtQty('5 kg', 'g')).toEqual({ qty: 5_000, shows: '= 5 kg', problem: null });
    expect(readBoughtQty('5 g', 'g')).toEqual({ qty: 5, shows: '= 5 g', problem: null });
    expect(readBoughtQty('750g', 'g')).toEqual({ qty: 750, shows: '= 750 g', problem: null });
    expect(readBoughtQty('2.5kg', 'g')).toEqual({ qty: 2_500, shows: '= 2.5 kg', problem: null });
    // 1,000 or more alone is grams, as "Everything came" and the old screens always typed it; shown exactly.
    expect(readBoughtQty('5000', 'g')).toMatchObject({ qty: 5_000, shows: '= 5 kg' });
    expect(readBoughtQty('1234', 'g')).toMatchObject({ qty: 1_234, shows: '= 1,234 g' });
    // Counted things: a number alone is pieces.
    expect(readBoughtQty('12', 'pcs')).toEqual({ qty: 12, shows: '= 12 pcs', problem: null });
    // Empty is not a problem yet; nonsense is, in plain words.
    expect(readBoughtQty('  ', 'g')).toEqual({ qty: null, shows: null, problem: null });
    expect(readBoughtQty('lots', 'g').problem).toBe('Type it like 5 kg or 500 g.');
    expect(readBoughtQty('1.5', 'pcs').problem).toBe('Type a whole number, like 12 pcs.');
  });

  it('the Purchases list: what was billed for what came, beside what was ordered', () => {
    const order = { kind: 'order' as const, totalCents: 375_000 };
    expect(purchaseTotalText({ ...order, status: 'ordered', billedCents: 0 })).toEqual({ main: 'Rs 3,750', note: null });
    expect(purchaseTotalText({ ...order, status: 'partial', billedCents: 273_000 })).toEqual({ main: 'Rs 2,730', note: 'billed · ordered Rs 3,750' });
    expect(purchaseTotalText({ ...order, status: 'received', billedCents: 410_000 })).toEqual({ main: 'Rs 4,100', note: 'billed · ordered Rs 3,750' });
    expect(purchaseTotalText({ ...order, status: 'received', billedCents: 375_000 })).toEqual({ main: 'Rs 3,750', note: 'billed' });
    expect(purchaseTotalText({ kind: 'quick', status: 'received', totalCents: 31_000, billedCents: 31_000 })).toEqual({ main: 'Rs 310', note: null });
  });

  it('the Purchases list keeps every open order, however many purchases are newer', () => {
    const newest = [{ id: 'q3' }, { id: 'q2' }, { id: 'o2' }];
    const open = [{ id: 'o2' }, { id: 'o1' }];
    expect(mergePurchaseLists(newest, open).map((p) => p.id)).toEqual(['q3', 'q2', 'o2', 'o1']);
    expect(mergePurchaseLists([], open).map((p) => p.id)).toEqual(['o2', 'o1']);
  });

  it('a payout and the lines turned out of it', () => {
    expect(payoutMatchText(300_000, 300_000)).toBeNull();
    expect(payoutMatchText(300_000, 280_000)).toMatch(/Rs 200 not on an ingredient/);
    expect(payoutMatchText(300_000, 310_000)).toMatch(/more than the Rs 3,000 taken from the drawer/);
  });
});
