import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DISCOUNT_APPROVAL,
  DEFAULT_DISCOUNT_DELIVERY,
  DEFAULT_DISCOUNT_PRESETS,
  DEFAULT_KITCHEN_TIMING,
  DEFAULT_STAFF_TIMING,
  KITCHEN_TIMING_BOUNDS,
  STAFF_TIMING_BOUNDS,
} from '@cheeseoclock/shared-types';
import {
  approvalExample,
  approvalFromForm,
  approvalSummary,
  approvalToForm,
  deliveryExample,
  deliveryFromForm,
  deliverySummary,
  deliveryToForm,
  presetPreview,
  presetsFromForm,
  presetsSummary,
  presetsToForm,
} from './discountRules';
import {
  kitchenFromForm,
  kitchenToForm,
  staffFromForm,
  staffToForm,
  type KitchenTimingForm,
  type StaffTimingForm,
} from './timingForm';
import { kitchenTimingExample, kitchenTimingSummary, reprintRuleText, staffTimingExample, staffTimingSummary } from './timingWords';

/**
 * Settings → Money & discounts and Staff & kitchen timing: what the owner
 * types becomes the setting (or a plain-words problem before Save; the main
 * process checks again), and every sentence on the cards is built from the
 * values. Made-up amounts.
 */
describe('Money & discounts: the approval limit', () => {
  it('reads what is typed, within 0–50% and Rs 0–5,000', () => {
    expect(approvalFromForm({ percent: '15', rupees: '1,000', reasonRequired: false })).toEqual({
      value: { v: 2, percentOver: 15, flatOverCents: 100_000, reasonRequired: false },
      problem: null,
    });
    expect(approvalFromForm({ percent: '0', rupees: '0', reasonRequired: false }).value).toEqual({
      v: 2,
      percentOver: 0,
      flatOverCents: 0,
      reasonRequired: false,
    });
    expect(approvalFromForm({ percent: '51', rupees: '500', reasonRequired: false }).problem).toBe('The % limit is a whole % from 0 to 50.');
    expect(approvalFromForm({ percent: '', rupees: '500', reasonRequired: false }).problem).toBe('The % limit is a whole % from 0 to 50.');
    expect(approvalFromForm({ percent: '10', rupees: '5,001', reasonRequired: false }).problem).toBe(
      'The rupee limit is whole rupees, Rs 0 to Rs 5,000.',
    );
    expect(approvalFromForm({ percent: '10', rupees: '', reasonRequired: false }).problem).toBe('The rupee limit is whole rupees, Rs 0 to Rs 5,000.');
    // The saved value goes into the form and back unchanged.
    expect(approvalFromForm(approvalToForm(DEFAULT_DISCOUNT_APPROVAL)).value).toEqual(DEFAULT_DISCOUNT_APPROVAL);
    // "A discount needs a reason": the owner's Yes is saved as Yes, and a Yes read back stays Yes.
    expect(approvalFromForm({ percent: '10', rupees: '500', reasonRequired: true }).value).toEqual({
      v: 2,
      percentOver: 10,
      flatOverCents: 50_000,
      reasonRequired: true,
    });
    const withReason = { ...DEFAULT_DISCOUNT_APPROVAL, reasonRequired: true };
    expect(approvalToForm(withReason)).toEqual({ percent: '10', rupees: '500', reasonRequired: true });
    expect(approvalFromForm(approvalToForm(withReason)).value).toEqual(withReason);
    // A format-1 value (read as No) is saved back in this version's format.
    expect(approvalFromForm(approvalToForm({ v: 1, percentOver: 10, flatOverCents: 50_000, reasonRequired: false })).value).toEqual(
      DEFAULT_DISCOUNT_APPROVAL,
    );
  });

  it('says it in words built from the values', () => {
    expect(approvalSummary(DEFAULT_DISCOUNT_APPROVAL)).toBe('Up to 10% or Rs 500 without a manager');
    expect(approvalSummary({ percentOver: 0, flatOverCents: 50_000 })).toBe('Every discount needs a manager');
    expect(approvalSummary({ percentOver: 12, flatOverCents: 0 })).toBe('Up to 12% without a manager; any amount in rupees needs one');
    // History says when a reason is needed; a format-1 line (read with No) says nothing more.
    expect(approvalSummary({ ...DEFAULT_DISCOUNT_APPROVAL, reasonRequired: true })).toBe('Up to 10% or Rs 500 without a manager · a reason is needed');
    expect(approvalSummary({ percentOver: 0, flatOverCents: 0, reasonRequired: true })).toBe('Every discount needs a manager · a reason is needed');
    expect(approvalExample(DEFAULT_DISCOUNT_APPROVAL)).toBe(
      "On a Rs 2,000 order a cashier can give up to 10% off, or up to Rs 200 off in rupees, without a manager. On a Rs 10,000 order: up to 10% off, or up to Rs 500 off in rupees. Anything more needs a manager's PIN or password.",
    );
    expect(approvalExample({ percentOver: 20, flatOverCents: 100_000 })).toBe(
      "On a Rs 2,000 order a cashier can give up to 20% off, or up to Rs 400 off in rupees, without a manager. On a Rs 10,000 order: up to 20% off, or up to Rs 1,000 off in rupees. Anything more needs a manager's PIN or password.",
    );
    expect(approvalExample({ percentOver: 10, flatOverCents: 0 })).toContain('but nothing off in rupees');
    expect(approvalExample({ percentOver: 0, flatOverCents: 50_000 })).toBe(
      "With 0%, every discount needs a manager's PIN or password — even 5% or Rs 50 off.",
    );
  });
});

describe('Money & discounts: the buttons', () => {
  it('one box per button; an empty box drops it; the saved value goes in and back unchanged', () => {
    const form = presetsToForm(DEFAULT_DISCOUNT_PRESETS);
    expect(form.percents).toEqual(['10', '20', '25', '50', '100']);
    expect(form.rupees).toEqual(['100', '200', '500']);
    expect(form.reasons).toEqual(['Staff', 'Friends & family', 'Regular customer', 'Complaint', '', '', '', '']);
    expect(presetsFromForm(form).value).toEqual(DEFAULT_DISCOUNT_PRESETS);
    expect(
      presetsFromForm({ percents: ['5', '', '15', '', ''], rupees: ['', '1,000', ''], reasons: ['  Birthday ', '', 'Test  reason'] }).value,
    ).toEqual({ v: 1, percents: [5, 15], flatCents: [100_000], reasons: ['Birthday', 'Test reason'] });
  });

  it('says what is wrong before Save, in the main process’s bounds', () => {
    const base = presetsToForm(DEFAULT_DISCOUNT_PRESETS);
    const problem = (patch: Partial<typeof base>) => presetsFromForm({ ...base, ...patch }).problem;
    expect(problem({ percents: ['', '', '', '', ''] })).toBe('Keep at least one % button.');
    expect(problem({ percents: ['0', '', '', '', ''] })).toBe('A % button is a whole % from 1 to 100.');
    expect(problem({ percents: ['101', '', '', '', ''] })).toBe('A % button is a whole % from 1 to 100.');
    expect(problem({ percents: ['10', '10', '', '', ''] })).toBe('Two % buttons are the same.');
    expect(problem({ rupees: ['', '', ''] })).toBe('Keep at least one rupee button.');
    expect(problem({ rupees: ['0', '', ''] })).toBe('A rupee button is whole rupees, Rs 1 to Rs 5,000.');
    expect(problem({ rupees: ['5,001', '', ''] })).toBe('A rupee button is whole rupees, Rs 1 to Rs 5,000.');
    expect(problem({ rupees: ['100', '100', ''] })).toBe('Two rupee buttons are the same.');
    expect(problem({ reasons: ['', '', '', '', '', '', '', ''] })).toBe('Keep at least one reason button.');
    expect(problem({ reasons: ['x'.repeat(31), '', '', '', '', '', '', ''] })).toBe('Keep a reason to 30 letters.');
    expect(problem({ reasons: ['Staff', 'STAFF', '', '', '', '', '', ''] })).toBe('Two reason buttons are the same.');
  });

  it('the example shows the lock on the buttons above the limit, on a Rs 2,000 order', () => {
    const p = presetPreview(DEFAULT_DISCOUNT_PRESETS, DEFAULT_DISCOUNT_APPROVAL);
    expect(p.percent.map((b) => [b.label, b.offCents, b.locked])).toEqual([
      ['10%', 20_000, false],
      ['20%', 40_000, true],
      ['25%', 50_000, true],
      ['50%', 100_000, true],
      ['100%', 200_000, true],
    ]);
    // Rs 200 is exactly 10% of Rs 2,000: no lock. Rs 500 is over it.
    expect(p.flat.map((b) => [b.label, b.locked])).toEqual([
      ['Rs 100', false],
      ['Rs 200', false],
      ['Rs 500', true],
    ]);
    const raised = presetPreview(DEFAULT_DISCOUNT_PRESETS, { percentOver: 25, flatOverCents: 50_000 });
    expect(raised.percent.filter((b) => b.locked).map((b) => b.label)).toEqual(['50%', '100%']);
    expect(raised.flat.filter((b) => b.locked).map((b) => b.label)).toEqual([]);
    expect(presetsSummary(DEFAULT_DISCOUNT_PRESETS)).toBe(
      '10, 20, 25, 50, 100% · Rs 100, Rs 200, Rs 500 · Staff, Friends & family, Regular customer, Complaint',
    );
  });
});

describe('Staff & kitchen timing: the forms', () => {
  it('the saved value goes in and back unchanged; each bound is the main process’s', () => {
    expect(staffFromForm(staffToForm(DEFAULT_STAFF_TIMING)).value).toEqual(DEFAULT_STAFF_TIMING);
    expect(kitchenFromForm(kitchenToForm(DEFAULT_KITCHEN_TIMING)).value).toEqual(DEFAULT_KITCHEN_TIMING);
    const staff = staffToForm(DEFAULT_STAFF_TIMING);
    for (const [field, [lo, hi]] of Object.entries(STAFF_TIMING_BOUNDS) as Array<[keyof StaffTimingForm, readonly [number, number]]>) {
      expect({ field, lo: staffFromForm({ ...staff, [field]: String(lo) }).problem }).toEqual({ field, lo: null });
      expect({ field, hi: staffFromForm({ ...staff, [field]: String(hi) }).problem }).toEqual({ field, hi: null });
      if (lo > 0) expect({ field, below: staffFromForm({ ...staff, [field]: String(lo - 1) }).value }).toEqual({ field, below: null });
      expect({ field, above: staffFromForm({ ...staff, [field]: String(hi + 1) }).value }).toEqual({ field, above: null });
      expect({ field, empty: staffFromForm({ ...staff, [field]: '' }).value }).toEqual({ field, empty: null });
    }
    const kitchen = kitchenToForm({ v: 1, amberMin: 10, redMin: 60, notStartedMin: 10, notDoneMin: 60 });
    for (const [field, [lo, hi]] of Object.entries(KITCHEN_TIMING_BOUNDS) as Array<[keyof KitchenTimingForm, readonly [number, number]]>) {
      expect({ field, below: kitchenFromForm({ ...kitchen, [field]: String(lo - 1) }).value }).toEqual({ field, below: null });
      expect({ field, above: kitchenFromForm({ ...kitchen, [field]: String(hi + 1) }).value }).toEqual({ field, above: null });
    }
    expect(staffFromForm({ ...staff, idleLogoutMin: '0' }).problem).toBe(
      'Sign out an idle owner or manager after: a whole number from 5 to 60 minutes.',
    );
    expect(kitchenFromForm({ ...kitchen, amberMin: '60', redMin: '60' }).problem).toBe(
      'A card turns red after it turns amber: give red more minutes.',
    );
    expect(kitchenFromForm({ ...kitchen, notStartedMin: '30', notDoneMin: '20' }).problem).toBe(
      'The “not done” reminder comes after “not started”: give it more minutes.',
    );
  });
});

describe('Staff & kitchen timing: the words', () => {
  it('the reprint rule as Settings → Printers says it, built from the values', () => {
    expect(reprintRuleText(DEFAULT_STAFF_TIMING)).toBe(
      "A counter login gets one copy of a paid receipt for the order in front of it (on Live Orders, or paid in the last 30 minutes); any more, or an older order, needs a manager's PIN or password.",
    );
    expect(reprintRuleText({ freeReprints: 2, reprintWindowMin: 60 })).toBe(
      "A counter login gets two copies of a paid receipt for the order in front of it (on Live Orders, or paid in the last 60 minutes); any more, or an older order, needs a manager's PIN or password.",
    );
    // None: the copy that adds the FBR number is still free (reprint-policy.ts), so the words say so.
    expect(reprintRuleText({ freeReprints: 0, reprintWindowMin: 60 })).toBe(
      "A counter login can't print a paid receipt again by hand: every copy needs a manager's PIN or password, except the one copy that adds the FBR number when the receipt first printed without it (for the order in front of it: on Live Orders, or paid in the last 60 minutes).",
    );
    // The setting could not be read here: the rule, with no number in it.
    expect(reprintRuleText(null)).not.toMatch(/\d/);
  });

  it('History lines and worked examples follow the values', () => {
    expect(staffTimingSummary(DEFAULT_STAFF_TIMING)).toBe('Idle sign-out 15 min · logins 12 h · step-in 10 min · 1 free reprint within 30 min');
    expect(staffTimingSummary({ v: 1, idleLogoutMin: 5, maxLoginHours: 16, stepInMin: 20, freeReprints: 0, reprintWindowMin: 60 })).toBe(
      'Idle sign-out 5 min · logins 16 h · step-in 20 min · no free reprints',
    );
    const example = staffTimingExample({ v: 1, idleLogoutMin: 20, maxLoginHours: 16, stepInMin: 25, freeReprints: 2, reprintWindowMin: 45 });
    expect(example).toContain('after 20 minutes with nobody touching it');
    expect(example).toContain('signed out 16 hours later at the latest');
    expect(example).toContain('gets 25 minutes');
    expect(example).toContain('two copies of a paid receipt');
    expect(example).toContain('paid in the last 45 minutes');
    expect(example).toContain('A cashier is never signed out for that.');

    expect(kitchenTimingSummary(DEFAULT_KITCHEN_TIMING)).toBe('Amber 15 min, red 30 · reminders: not started 10, not done 30');
    expect(kitchenTimingExample(DEFAULT_KITCHEN_TIMING)).toBe(
      'An order that came in at 7:00 turns amber on Live Orders at 7:15 and red at 7:30. A website order still in New at 7:10 gets a soft beep and a note; if it is still not done at 7:30, another (Settings → Sounds turns the beep on or off).',
    );
    expect(kitchenTimingExample({ v: 1, amberMin: 20, redMin: 75, notStartedMin: 5, notDoneMin: 120 })).toContain(
      'amber on Live Orders at 7:20 and red at 8:15. A website order still in New at 7:05',
    );
  });
});

describe('"A discount also comes off the delivery charge" (the owner, 28 Sep 2026)', () => {
  it('the choice round-trips; No is the default and reads as such', () => {
    expect(deliveryToForm(DEFAULT_DISCOUNT_DELIVERY)).toBe('no');
    expect(deliveryFromForm('no')).toEqual({ value: { v: 1, alsoOffDeliveryCharge: false }, problem: null });
    expect(deliveryFromForm('yes')).toEqual({ value: { v: 1, alsoOffDeliveryCharge: true }, problem: null });
    expect(deliveryToForm({ alsoOffDeliveryCharge: true })).toBe('yes');
    expect(deliverySummary(DEFAULT_DISCOUNT_DELIVERY)).toBe('No: a discount is on the food only; the delivery charge is paid in full');
    expect(deliverySummary({ alsoOffDeliveryCharge: true })).toBe('Yes: a discount comes off the delivery charge too');
  });

  it('the example is the till’s own maths on the made-up order', () => {
    expect(deliveryExample({ alsoOffDeliveryCharge: false })).toContain('10% off takes Rs 200 off (10% of the food)');
    expect(deliveryExample({ alsoOffDeliveryCharge: false })).toContain('even 100% off leaves the Rs 200 delivery charge (and its tax) to pay');
    expect(deliveryExample({ alsoOffDeliveryCharge: true })).toContain('10% off takes Rs 220 off');
    expect(deliveryExample({ alsoOffDeliveryCharge: true })).toContain('100% off leaves nothing to pay');
  });
});
