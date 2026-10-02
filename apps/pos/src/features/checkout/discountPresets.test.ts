import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { NOTHING_TO_DISCOUNT } from '@cheeseoclock/pos-domain';
import {
  FLAT_PRESETS_RUPEES,
  PERCENT_PRESETS,
  currentDiscountWords,
  describeDiscount,
  describePreview,
  discountApplyStep,
  discountBaseNow,
  discountBaseText,
  discountDialogOpenFocus,
  discountDialogPrimary,
  discountDialogStart,
  discountReasonHint,
  discountReasonProblem,
  discountRefused,
  discountRuleBasisNow,
  flatChoiceRupees,
  parseDiscountEntry,
  percentChoice,
  previewDiscount,
  reasonButtons,
  sameChoice,
} from './discountPresets';

// Made-up prices: Rs 1,000 + Rs 500 at 16% tax, and a Rs 300 untaxed line.
const lines = [
  { lineTotalCents: 100_000, taxRateBps: 1600 },
  { lineTotalCents: 50_000, taxRateBps: 1600 },
  { lineTotalCents: 30_000, taxRateBps: 0 },
];
const subtotal = 180_000;

describe('discount presets', () => {
  it('offers the owner’s one-tap amounts', () => {
    expect([...PERCENT_PRESETS]).toEqual([10, 20, 25, 50, 100]);
    expect([...FLAT_PRESETS_RUPEES]).toEqual([100, 200, 500]);
    expect(flatChoiceRupees(200)).toEqual({ type: 'flat', value: 20_000 });
  });

  it('describes a discount in plain words', () => {
    expect(describeDiscount(percentChoice(25))).toBe('25% off');
    expect(describeDiscount(flatChoiceRupees(500))).toBe('Rs 500 off');
  });

  it('compares choices by type and value', () => {
    expect(sameChoice(percentChoice(10), { type: 'percent', value: 10 })).toBe(true);
    expect(sameChoice(percentChoice(10), flatChoiceRupees(10))).toBe(false);
    expect(sameChoice(null, percentChoice(10))).toBe(false);
  });
});

describe('parseDiscountEntry', () => {
  it('reads percentages from 0 to 100', () => {
    expect(parseDiscountEntry('percent', '15')).toEqual({ type: 'percent', value: 15 });
    expect(parseDiscountEntry('percent', '12.5')).toEqual({ type: 'percent', value: 12.5 });
    expect(parseDiscountEntry('percent', '100')).toEqual({ type: 'percent', value: 100 });
    expect(parseDiscountEntry('percent', '101')).toBeNull();
  });

  it('turns rupees into whole paisa', () => {
    expect(parseDiscountEntry('flat', '250')).toEqual({ type: 'flat', value: 25_000 });
    expect(parseDiscountEntry('flat', '1,250')).toEqual({ type: 'flat', value: 125_000 });
    expect(parseDiscountEntry('flat', '0.1')).toEqual({ type: 'flat', value: 10 });
    // 19.99 * 100 is 1998.9999… in floating point: still exactly 1999 paisa.
    expect(parseDiscountEntry('flat', '19.99')).toEqual({ type: 'flat', value: 1_999 });
  });

  it('refuses empty, zero, negative and junk', () => {
    for (const bad of ['', '  ', '0', '-5', 'abc', '1e3', '10%', '.']) {
      expect(parseDiscountEntry('flat', bad)).toBeNull();
      expect(parseDiscountEntry('percent', bad)).toBeNull();
    }
  });
});

describe('previewDiscount', () => {
  it('with no discount shows the bill as it stands', () => {
    const p = previewDiscount(lines, subtotal, null);
    expect(p).toEqual({ discountCents: 0, taxCents: 24_000, totalCents: 204_000, needsApproval: false, capped: false });
  });

  it('works out a percentage, tax on what is left of each line', () => {
    // 10% of 1,800 = 180, split 100 / 50 / 30. Tax = 16% of (900 + 450) = 216.
    const p = previewDiscount(lines, subtotal, percentChoice(10));
    expect(p.discountCents).toBe(18_000);
    expect(p.taxCents).toBe(21_600);
    expect(p.totalCents).toBe(180_000 - 18_000 + 21_600);
    expect(p.needsApproval).toBe(false);
  });

  it('needs a manager over 10%', () => {
    expect(previewDiscount(lines, subtotal, percentChoice(20)).needsApproval).toBe(true);
    expect(previewDiscount(lines, subtotal, percentChoice(10)).needsApproval).toBe(false);
  });

  it('a flat amount over 10% of the order needs a manager too', () => {
    // Rs 100 off Rs 1,800 is under 10%; Rs 200 is over.
    expect(previewDiscount(lines, subtotal, flatChoiceRupees(100)).needsApproval).toBe(false);
    expect(previewDiscount(lines, subtotal, flatChoiceRupees(200)).needsApproval).toBe(true);
  });

  it('100% off leaves nothing to pay, tax included', () => {
    const p = previewDiscount(lines, subtotal, percentChoice(100));
    expect(p.discountCents).toBe(subtotal);
    expect(p.taxCents).toBe(0);
    expect(p.totalCents).toBe(0);
  });

  it('a flat amount bigger than the order only takes the order’s worth', () => {
    const small = [{ lineTotalCents: 30_000, taxRateBps: 1600 }];
    const p = previewDiscount(small, 30_000, flatChoiceRupees(500));
    expect(p.capped).toBe(true);
    expect(p.discountCents).toBe(30_000);
    expect(p.totalCents).toBe(0);
  });

  it('never loses a paisa over awkward splits', () => {
    const odd = [
      { lineTotalCents: 33_333, taxRateBps: 1600 },
      { lineTotalCents: 33_333, taxRateBps: 1600 },
      { lineTotalCents: 33_334, taxRateBps: 1600 },
    ];
    const p = previewDiscount(odd, 100_000, flatChoiceRupees(1));
    expect(p.discountCents).toBe(100);
    expect(p.totalCents).toBe(100_000 - 100 + p.taxCents);
    expect(p.taxCents).toBe(15_984);
  });

  it('an empty order has nothing to discount', () => {
    expect(previewDiscount([], 0, percentChoice(50))).toMatchObject({ discountCents: 0, taxCents: 0, totalCents: 0 });
  });
});

describe('the Discount dialog on an order with the owner’s foodpanda deal', () => {
  const deal = { discountType: 'percent' as const, value: 20, reason: 'Foodpanda deal 20% off', source: 'foodpanda' };

  it('opens on nothing: the deal’s own % is never re-applied as a staff discount, and its label is not a reason', () => {
    expect(discountDialogStart(deal)).toEqual({ picked: null, reason: '' });
    // A staff discount opens on itself, as before.
    expect(discountDialogStart({ discountType: 'percent', value: 10, reason: 'Regular customer', source: null })).toEqual({
      picked: { type: 'percent', value: 10 },
      reason: 'Regular customer',
    });
    expect(discountDialogStart({ discountType: 'flat', value: 20_000, reason: null })).toEqual({ picked: { type: 'flat', value: 20_000 }, reason: '' });
    expect(discountDialogStart(null)).toEqual({ picked: null, reason: '' });
  });

  it('× on the deal line, a manager’s PIN, Enter: the deal comes off (it is not put back as a staff 20%)', () => {
    const start = discountDialogStart(deal);
    expect(discountDialogPrimary({ dealOn: true, intent: 'removeDeal', hasChoice: start.picked !== null })).toBe('remove');
    // The manager picks what the tablet shows instead: Enter applies that.
    expect(discountDialogPrimary({ dealOn: true, intent: 'removeDeal', hasChoice: true })).toBe('apply');
  });

  it('opened to change it (F3, the deal line): Enter applies a choice and never takes the deal off by itself', () => {
    expect(discountDialogPrimary({ dealOn: true, intent: 'change', hasChoice: false })).toBe('apply');
    expect(discountDialogPrimary({ dealOn: true, intent: 'change', hasChoice: true })).toBe('apply');
    // No deal on the order: the × intent means nothing.
    expect(discountDialogPrimary({ dealOn: false, intent: 'removeDeal', hasChoice: false })).toBe('apply');
  });
});

describe('previewDiscount on an order with a delivery charge (the owner, 28 Sep 2026: no discount on it)', () => {
  // Made-up: a Rs 1,000 pizza and a Rs 800 side (Rs 1,800 of food) and a Rs 200 delivery charge, all at 16%.
  const withCharge = [
    { lineTotalCents: 100_000, taxRateBps: 1600, menuItemName: 'Test Pizza' },
    { lineTotalCents: 20_000, taxRateBps: 1600, menuItemName: 'Delivery Charge (Rs 200)' },
    { lineTotalCents: 80_000, taxRateBps: 1600, menuItemName: 'Test Side' },
  ];
  const sub = 200_000;
  const foodOnly = { approval: { percentOver: 10, flatOverCents: 50_000 }, alsoOffDeliveryCharge: false };
  const everyLine = { ...foodOnly, alsoOffDeliveryCharge: true };

  it('a % is of the food; the delivery charge is taxed in full', () => {
    // 10% of Rs 1,800 = Rs 180; tax 16% of (900 + 200 + 720) = Rs 291.20.
    expect(previewDiscount(withCharge, sub, percentChoice(10), foodOnly)).toEqual({
      discountCents: 18_000,
      taxCents: 29_120,
      totalCents: 211_120,
      needsApproval: false,
      capped: false,
    });
    expect(discountBaseText(discountBaseNow(withCharge, sub, foodOnly), sub)).toBe(
      'Food Rs 1,800 before tax · delivery charge Rs 200 not discounted',
    );
  });

  it('100% off leaves the delivery charge and its tax to pay', () => {
    expect(previewDiscount(withCharge, sub, percentChoice(100), foodOnly)).toMatchObject({ discountCents: 180_000, taxCents: 3_200, totalCents: 23_200 });
  });

  it('rupees are capped at the food, and it says so', () => {
    const p = previewDiscount(withCharge, sub, flatChoiceRupees(5_000), foodOnly);
    expect(p).toMatchObject({ discountCents: 180_000, capped: true, totalCents: 23_200 });
    expect(describePreview(flatChoiceRupees(5_000), p, discountBaseNow(withCharge, sub, foodOnly))).toBe('Rs 5,000 off food (all the food)');
    expect(describePreview(percentChoice(10), previewDiscount(withCharge, sub, percentChoice(10), foodOnly), discountBaseNow(withCharge, sub, foodOnly))).toBe(
      '10% off food',
    );
  });

  it('the lock is on the food: Rs 190 off is over 10% of Rs 1,800 (it was under 10% of Rs 2,000)', () => {
    expect(previewDiscount(withCharge, sub, flatChoiceRupees(190), foodOnly).needsApproval).toBe(true);
    expect(previewDiscount(withCharge, sub, flatChoiceRupees(190), everyLine).needsApproval).toBe(false);
  });

  it('the owner’s switch on: the old maths, exactly as a till before 0.7.26', () => {
    const legacyLines = withCharge.map(({ lineTotalCents, taxRateBps }) => ({ lineTotalCents, taxRateBps }));
    for (const choice of [percentChoice(10), percentChoice(100), flatChoiceRupees(5_000), flatChoiceRupees(1)]) {
      expect(previewDiscount(withCharge, sub, choice, everyLine)).toEqual(previewDiscount(legacyLines, sub, choice, everyLine));
    }
    expect(previewDiscount(withCharge, sub, percentChoice(10), everyLine)).toMatchObject({ discountCents: 20_000, taxCents: 28_800 });
    expect(discountBaseText(discountBaseNow(withCharge, sub, everyLine), sub)).toBe('Order Rs 2,000 before tax');
  });
});

describe('the reason, when the owner has made one required (Settings → Money & discounts)', () => {
  it('by default the reason is optional: no reason is fine, as before', () => {
    expect(discountReasonHint(false)).toBe('(optional, prints on the bill)');
    expect(discountReasonProblem(false, '')).toBeNull();
    expect(discountReasonProblem(false, '   ')).toBeNull();
  });

  it('required: the row says needed, and Apply waits for a reason — a reason button is one tap', () => {
    expect(discountReasonHint(true)).toBe('(needed — prints on the bill)');
    const said = 'Pick or type a reason — the owner has made one required for every discount.';
    expect(discountReasonProblem(true, '')).toBe(said);
    expect(discountReasonProblem(true, '   ')).toBe(said);
    expect(discountReasonProblem(true, 'No reason given')).toBe(said);
    // A reason button fills the box with its words: that is a reason.
    expect(discountReasonProblem(true, 'Staff')).toBeNull();
    expect(discountReasonProblem(true, ' Birthday ')).toBeNull();
  });

  it('a reason button reading as no reason (saved before, or by an older till) is left out while a reason is needed — and only then', () => {
    const saved = ['Staff', 'No reason given', 'Test birthday', 'NO REASON GIVEN'];
    expect(reasonButtons(saved, false)).toEqual(saved);
    expect(reasonButtons(saved, true)).toEqual(['Staff', 'Test birthday']);
    // Every button it leaves is one the dialog would take.
    for (const r of reasonButtons(saved, true)) expect(discountReasonProblem(true, r)).toBeNull();
  });

  it('the words for none with extra spaces between them are no reason either, and never a button', () => {
    const said = 'Pick or type a reason — the owner has made one required for every discount.';
    expect(discountReasonProblem(true, 'No  reason given')).toBe(said);
    expect(discountReasonProblem(true, ' no reason   GIVEN')).toBe(said);
    expect(reasonButtons(['Staff', 'No  reason given'], true)).toEqual(['Staff']);
  });
});

describe('Apply, decided in one place: the button, Enter and a second tap on a preset', () => {
  const SAID_REASON = 'Pick or type a reason — the owner has made one required for every discount.';
  // Made-up: 5% off a Rs 2,000 order, no PIN needed; a made-up manager PIN.
  const base: Parameters<typeof discountApplyStep>[0] = {
    choice: percentChoice(5),
    typing: false,
    discountCents: 10_000,
    needsApproval: false,
    reasonRequired: false,
    reason: '',
    pin: '',
  };
  const step = (over: Partial<typeof base>) => discountApplyStep({ ...base, ...over });

  it('nothing saved (a reason optional): a discount with no reason goes, as before', () => {
    expect(step({})).toEqual({ kind: 'save', choice: percentChoice(5), reason: undefined, approverPin: undefined });
    expect(step({ reason: '  Staff ' })).toEqual({ kind: 'save', choice: percentChoice(5), reason: 'Staff', approverPin: undefined });
    expect(step({ reason: '   ' })).toMatchObject({ kind: 'save', reason: undefined });
  });

  it('with the owner’s Yes: no reason, spaces or the words for none are refused, the cursor to the reason — any reason goes', () => {
    for (const reason of ['', '   ', 'No reason given', 'no  REASON given']) {
      expect({ reason, s: step({ reasonRequired: true, reason }) }).toEqual({
        reason,
        s: { kind: 'refuse', message: SAID_REASON, focus: 'reason' },
      });
    }
    expect(step({ reasonRequired: true, reason: 'Birthday' })).toEqual({ kind: 'save', choice: percentChoice(5), reason: 'Birthday', approverPin: undefined });
  });

  it('the reason is said before the PIN (as the main process does): a PIN typed or not, the reason first', () => {
    for (const pin of ['', '12', '4827']) {
      expect({ pin, s: step({ reasonRequired: true, needsApproval: true, pin }) }).toEqual({
        pin,
        s: { kind: 'refuse', message: SAID_REASON, focus: 'reason' },
      });
    }
    // With a reason, the PIN is next.
    expect(step({ reasonRequired: true, reason: 'Complaint', needsApproval: true })).toEqual({
      kind: 'refuse',
      message: "This discount needs a manager's PIN or password.",
      focus: 'pin',
    });
    expect(step({ reasonRequired: true, reason: 'Complaint', needsApproval: true, pin: '12' })).toEqual({
      kind: 'refuse',
      message: 'A PIN is 4 to 12 numbers',
      focus: 'pin',
    });
    expect(step({ reasonRequired: true, reason: 'Complaint', needsApproval: true, pin: '4827' })).toEqual({
      kind: 'save',
      choice: percentChoice(5),
      reason: 'Complaint',
      approverPin: '4827',
    });
  });

  it('nothing picked, a bad amount or nothing to take off: said, nothing sent', () => {
    expect(step({ choice: null })).toEqual({ kind: 'refuse', message: 'Pick a discount or type an amount.', focus: null });
    expect(step({ choice: null, typing: true })).toEqual({ kind: 'refuse', message: 'That amount does not work — check it.', focus: null });
    expect(step({ discountCents: 0 })).toEqual({ kind: 'refuse', message: 'Nothing to take off this order.', focus: null });
  });

  it('refused by the main process: its reason words as they are (the PIN kept); anything else "Discount not applied", a PIN sent is cleared', () => {
    expect(discountRefused(SAID_REASON, true)).toEqual({ error: SAID_REASON, focus: 'reason', clearPin: false });
    expect(discountRefused(SAID_REASON, false)).toEqual({ error: SAID_REASON, focus: 'reason', clearPin: false });
    expect(discountRefused("That is not a manager's PIN or password", true)).toEqual({
      error: "Discount not applied: That is not a manager's PIN or password",
      focus: 'pin',
      clearPin: true,
    });
    expect(discountRefused('Order not found', false)).toEqual({ error: 'Discount not applied: Order not found', focus: null, clearPin: false });
  });

  it('the dialog carries it out: its button, Enter and a second tap all go through it', () => {
    const src = readFileSync(fileURLToPath(new URL('./DiscountDialog.tsx', import.meta.url)), 'utf8');
    // The button is on exactly when Apply would send it.
    expect(src).toMatch(/const canApply = applyNow\.kind === 'save' && !saving && !busy;/);
    // apply() (Enter, a second tap, the button) decides with the same function and stops on a refusal…
    const apply = src.slice(src.indexOf('async function apply('), src.indexOf('async function remove('));
    const decide = apply.indexOf('discountApplyStep({');
    const stop = apply.indexOf("if (step.kind === 'refuse') {");
    const send = apply.indexOf('await applyDiscount(step.choice.type, step.choice.value, step.reason, step.approverPin)');
    expect(decide).toBeGreaterThan(-1);
    expect(stop).toBeGreaterThan(decide);
    expect(send).toBeGreaterThan(stop);
    expect(apply.slice(stop, send)).toContain('return;');
    // …with the owner's "a discount needs a reason" and what is typed — as the button decides (Enter
    // and a second tap never go past a missing reason to the main process, using up the PIN's try).
    const calls = src
      .split('discountApplyStep({')
      .slice(1)
      .map((c) => c.slice(0, c.indexOf('})')));
    expect(calls).toHaveLength(2);
    for (const args of calls) {
      expect(args).toMatch(/\sreasonRequired: rules\.reasonRequired,\s/);
      expect(args).toMatch(/\sreason,\s/);
      expect(args).toMatch(/\spin,\s/);
    }
    expect(apply.slice(decide, stop)).toMatch(/\sreasonRequired: rules\.reasonRequired,\s/);
    // …and says the main process's refusal as discountRefused words it.
    expect(apply).toContain("discountRefused(e instanceof Error ? e.message : 'Unknown error', step.approverPin !== undefined)");
    expect(apply).toContain('setError(refused.error)');
    expect(apply).not.toContain('`Discount not applied');
    // Enter and a second tap call apply() — never applyDiscount directly.
    expect(src.match(/applyDiscount\(/g)?.length).toBe(1);
  });
});

/**
 * NO DISCOUNT ON VALUE DEALS (the owner, 2026-10-02): F3 works a discount as
 * orders:applyDiscount does — on everything but the value deals (the lines
 * marked noDiscount), except on a foodpanda order, which must match the
 * tablet — and says so. Made-up: a Rs 1,500 pizza and a Rs 3,600 deal, 16%.
 */
describe('F3 on an order with a value deal', () => {
  const PIZZA = { lineTotalCents: 150_000, taxRateBps: 1600, menuItemName: 'Test Pizza', noDiscount: false };
  const DEAL = { lineTotalCents: 360_000, taxRateBps: 1600, menuItemName: 'Test Big Deal', noDiscount: true };
  const CHARGE = { lineTotalCents: 20_000, taxRateBps: 1600, menuItemName: 'Delivery Charge (Rs 200)' };
  const lines = [DEAL, PIZZA];
  const sub = 510_000;
  const rules = { approval: { percentOver: 10, flatOverCents: 50_000 }, alsoOffDeliveryCharge: false };

  it('the header says what is worked on and what is not, in three ways', () => {
    expect(discountBaseText(discountBaseNow(lines, sub, rules, 'takeaway'), sub)).toBe('Food Rs 1,500 before tax · value deals Rs 3,600 not discounted');
    expect(discountBaseText(discountBaseNow([...lines, CHARGE], sub + 20_000, rules, 'delivery'), sub + 20_000)).toBe(
      'Food Rs 1,500 before tax · value deals Rs 3,600 and delivery charge Rs 200 not discounted',
    );
    expect(discountBaseText(discountBaseNow([DEAL], 360_000, rules, 'takeaway'), 360_000)).toBe(NOTHING_TO_DISCOUNT);
    // A deal with only a delivery charge beside it: nothing either (the charge is paid in full).
    expect(discountBaseText(discountBaseNow([DEAL, CHARGE], 380_000, rules, 'delivery'), 380_000)).toBe(NOTHING_TO_DISCOUNT);
  });

  it('the owner’s switch on: the charge counted in is named, as the limit line names it; off, as before', () => {
    const on = { ...rules, alsoOffDeliveryCharge: true };
    const withCharge = [...lines, CHARGE];
    const subWith = sub + 20_000;
    const basisOn = discountRuleBasisNow(withCharge, on, 'delivery');
    expect(basisOn).toBe('food_and_charge_no_deals');
    expect(discountBaseText(discountBaseNow(withCharge, subWith, on, 'delivery'), subWith, basisOn)).toBe(
      'Food and delivery charge Rs 1,700 before tax · value deals Rs 3,600 not discounted',
    );
    const basisOff = discountRuleBasisNow(withCharge, rules, 'delivery');
    expect(basisOff).toBe('food_no_deals');
    expect(discountBaseText(discountBaseNow(withCharge, subWith, rules, 'delivery'), subWith, basisOff)).toBe(
      'Food Rs 1,500 before tax · value deals Rs 3,600 and delivery charge Rs 200 not discounted',
    );
    // No charge on the order: "Food" under either switch.
    expect(discountRuleBasisNow(lines, on, 'takeaway')).toBe('food_no_deals');
    expect(discountBaseText(discountBaseNow(lines, sub, on, 'takeaway'), sub, discountRuleBasisNow(lines, on, 'takeaway'))).toBe(
      'Food Rs 1,500 before tax · value deals Rs 3,600 not discounted',
    );
    // Only value deals beside the charge, switch on: Rs 200 to work on, and it says what that is.
    expect(discountBaseText(discountBaseNow([DEAL, CHARGE], 380_000, on, 'delivery'), 380_000, discountRuleBasisNow([DEAL, CHARGE], on, 'delivery'))).toBe(
      'Food and delivery charge Rs 200 before tax · value deals Rs 3,600 not discounted',
    );
    // A foodpanda order covers the deals: the words of an order without them.
    expect(discountRuleBasisNow(withCharge, on, 'foodpanda')).toBe('order');
    expect(discountRuleBasisNow(withCharge, rules, 'foodpanda')).toBe('food');
  });

  it('where the cursor goes when F3 opens: the amount box; the PIN from the deal’s ×; the dialog itself with only value deals', () => {
    expect(discountDialogOpenFocus({ removingDeal: false, onlyValueDeals: false })).toBe('custom');
    expect(discountDialogOpenFocus({ removingDeal: true, onlyValueDeals: false })).toBe('pin');
    expect(discountDialogOpenFocus({ removingDeal: false, onlyValueDeals: true })).toBe('dialog');
  });

  it('10% of the pizza: Rs 150 off, the deal taxed in full', () => {
    // Tax: 16% of 3,600 + 16% of (1,500 − 150) = 576 + 216.
    expect(previewDiscount(lines, sub, percentChoice(10), rules, 'takeaway')).toEqual({
      discountCents: 15_000,
      taxCents: 79_200,
      totalCents: 574_200,
      needsApproval: false,
      capped: false,
    });
    // No mode given (a counter order): the same.
    expect(previewDiscount(lines, sub, percentChoice(10), rules)).toMatchObject({ discountCents: 15_000 });
    // With the owner's switch on (the delivery charge too): still never the deal.
    expect(previewDiscount([...lines, CHARGE], sub + 20_000, percentChoice(10), { ...rules, alsoOffDeliveryCharge: true }, 'delivery')).toMatchObject({
      discountCents: 17_000,
    });
    expect(discountBaseNow([...lines, CHARGE], sub + 20_000, { alsoOffDeliveryCharge: true }, 'delivery')).toEqual({
      baseCents: 170_000,
      untouchedCents: 0,
      dealsCents: 360_000,
    });
  });

  it('the lock is on the food without the deal: Rs 200 off is over 10% of Rs 1,500', () => {
    expect(previewDiscount(lines, sub, flatChoiceRupees(200), rules, 'takeaway').needsApproval).toBe(true);
    expect(previewDiscount(lines, sub, flatChoiceRupees(200), rules, 'foodpanda').needsApproval).toBe(false);
  });

  it('the preview’s words; rupees are capped at what is not a deal, and it says so', () => {
    const base = discountBaseNow(lines, sub, rules, 'takeaway');
    expect(describePreview(percentChoice(10), previewDiscount(lines, sub, percentChoice(10), rules, 'takeaway'), base)).toBe(
      '10% off, not on value deals',
    );
    const capped = previewDiscount(lines, sub, flatChoiceRupees(2_000), rules, 'takeaway');
    expect(capped).toMatchObject({ discountCents: 150_000, capped: true });
    expect(describePreview(flatChoiceRupees(2_000), capped, base)).toBe('Rs 2,000 off (all but the value deals)');
    const withCharge = discountBaseNow([...lines, CHARGE], sub + 20_000, rules, 'delivery');
    expect(describePreview(percentChoice(10), { capped: false }, withCharge)).toBe('10% off food, not on value deals');
  });

  it('only value deals on the order: nothing to take off — Apply stays off and says why, before anything else', () => {
    const base = discountBaseNow([DEAL], 360_000, rules, 'takeaway');
    expect(base).toEqual({ baseCents: 0, untouchedCents: 0, dealsCents: 360_000 });
    expect(previewDiscount([DEAL], 360_000, percentChoice(10), rules, 'takeaway')).toMatchObject({ discountCents: 0, totalCents: 417_600 });
    const step = (choice: ReturnType<typeof percentChoice> | null) =>
      discountApplyStep({
        onlyValueDeals: base.baseCents === 0 && base.dealsCents > 0,
        choice,
        typing: false,
        discountCents: 0,
        needsApproval: false,
        reasonRequired: true,
        reason: '',
        pin: '',
      });
    expect(step(percentChoice(10))).toEqual({ kind: 'refuse', message: NOTHING_TO_DISCOUNT, focus: null });
    expect(step(null)).toEqual({ kind: 'refuse', message: NOTHING_TO_DISCOUNT, focus: null });
  });

  it('a foodpanda order: the deal is discounted too, as the tablet does', () => {
    // 10% of Rs 5,100 = Rs 510, split 360 / 150 over the deal and the pizza: tax 16% of (3,240 + 1,350).
    expect(previewDiscount(lines, sub, percentChoice(10), rules, 'foodpanda')).toEqual({
      discountCents: 51_000,
      taxCents: 73_440,
      totalCents: 532_440,
      needsApproval: false,
      capped: false,
    });
    expect(discountBaseNow(lines, sub, rules, 'foodpanda')).toEqual({ baseCents: 510_000, untouchedCents: 0, dealsCents: 0 });
    expect(discountBaseText(discountBaseNow(lines, sub, rules, 'foodpanda'), sub)).toBe('Order Rs 5,100 before tax');
  });

  it('the discount already on the order says it left the deals alone, from its own frozen rule', () => {
    const staff = { discountType: 'percent' as const, value: 10, reason: 'Staff', source: null, alsoOffDeliveryCharge: false, skipsNoDiscountLines: true };
    expect(currentDiscountWords(staff, lines, rules).now).toBe('10% off, not on value deals');
    expect(currentDiscountWords(staff, [...lines, CHARGE], rules).now).toBe('10% off food, not on value deals');
    // Given before 0.7.34 (no field) or on a foodpanda order: as before.
    expect(currentDiscountWords({ ...staff, skipsNoDiscountLines: undefined }, lines, rules).now).toBe('10% off');
    expect(currentDiscountWords({ ...staff, skipsNoDiscountLines: false }, lines, rules).now).toBe('10% off');
    // No deal on the order: nothing to say.
    expect(currentDiscountWords(staff, [PIZZA], rules).now).toBe('10% off');
  });
});
