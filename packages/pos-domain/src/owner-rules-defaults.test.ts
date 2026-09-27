import { describe, expect, it } from 'vitest';
import {
  APPROVAL_MAX_FLAT_CENTS,
  APPROVAL_MAX_PERCENT,
  DEFAULT_DISCOUNT_APPROVAL,
  DEFAULT_DISCOUNT_PRESETS,
  DEFAULT_KITCHEN_TIMING,
  DEFAULT_STAFF_TIMING,
  KITCHEN_TIMING_BOUNDS,
  PRESET_FLAT_MAX_CENTS,
  PRESET_FLATS_MAX,
  PRESET_PERCENTS_MAX,
  PRESET_REASON_MAX_LENGTH,
  PRESET_REASONS_MAX,
  SHOP_SETTING_DEFAULTS,
  SHOP_SETTING_FORMAT,
  STAFF_TIMING_BOUNDS,
} from '@cheeseoclock/shared-types';
import { requiresManagerApproval } from './discount.js';

/**
 * Settings step 2 (Money & discounts) and step 6 (Staff & kitchen timing):
 * the frozen defaults ARE today's numbers, so installing the version changes
 * nothing until the owner saves. Released values: NEVER edit one (two tills
 * on different versions with the key unsaved must read the same). If this
 * test fails, put the value back.
 */
describe('the released defaults are today’s numbers', () => {
  it('discounts.approval: over 10%, or over Rs 500, needs a manager (was MANAGER_APPROVAL_*_THRESHOLD)', () => {
    expect(DEFAULT_DISCOUNT_APPROVAL).toEqual({ v: 1, percentOver: 10, flatOverCents: 50_000 });
    expect(SHOP_SETTING_DEFAULTS['discounts.approval']).toBe(DEFAULT_DISCOUNT_APPROVAL);
  });

  it('discounts.presets: 10 / 20 / 25 / 50 / 100 %, Rs 100 / 200 / 500, the four reasons (owner, 2026-09-26)', () => {
    expect(DEFAULT_DISCOUNT_PRESETS).toEqual({
      v: 1,
      percents: [10, 20, 25, 50, 100],
      flatCents: [10_000, 20_000, 50_000],
      reasons: ['Staff', 'Friends & family', 'Regular customer', 'Complaint'],
    });
    // Deeply frozen: nobody can change a default by pushing onto its list.
    expect(Object.isFrozen(DEFAULT_DISCOUNT_PRESETS.percents)).toBe(true);
    expect(Object.isFrozen(DEFAULT_DISCOUNT_PRESETS.flatCents)).toBe(true);
    expect(Object.isFrozen(DEFAULT_DISCOUNT_PRESETS.reasons)).toBe(true);
  });

  it('staff.timing: 15 min idle (owner / manager), 12 h logins, a 10-minute step-in, one free reprint within 30 min', () => {
    expect(DEFAULT_STAFF_TIMING).toEqual({
      v: 1,
      idleLogoutMin: 15,
      maxLoginHours: 12,
      stepInMin: 10,
      freeReprints: 1,
      reprintWindowMin: 30,
    });
  });

  it('kitchen.timing: amber 15, red 30; reminders at 10 (not started) and 30 (not done)', () => {
    expect(DEFAULT_KITCHEN_TIMING).toEqual({ v: 1, amberMin: 15, redMin: 30, notStartedMin: 10, notDoneMin: 30 });
  });

  it('every new default is frozen, in the format this version writes, and inside its own bounds', () => {
    for (const key of ['discounts.approval', 'discounts.presets', 'staff.timing', 'kitchen.timing'] as const) {
      expect(Object.isFrozen(SHOP_SETTING_DEFAULTS[key])).toBe(true);
      expect(SHOP_SETTING_DEFAULTS[key].v).toBe(SHOP_SETTING_FORMAT[key]);
    }
    expect(DEFAULT_DISCOUNT_APPROVAL.percentOver).toBeLessThanOrEqual(APPROVAL_MAX_PERCENT);
    expect(DEFAULT_DISCOUNT_APPROVAL.flatOverCents).toBeLessThanOrEqual(APPROVAL_MAX_FLAT_CENTS);
    expect(DEFAULT_DISCOUNT_PRESETS.percents.length).toBeLessThanOrEqual(PRESET_PERCENTS_MAX);
    expect(DEFAULT_DISCOUNT_PRESETS.flatCents.length).toBeLessThanOrEqual(PRESET_FLATS_MAX);
    expect(DEFAULT_DISCOUNT_PRESETS.reasons.length).toBeLessThanOrEqual(PRESET_REASONS_MAX);
    expect(Math.max(...DEFAULT_DISCOUNT_PRESETS.flatCents)).toBeLessThanOrEqual(PRESET_FLAT_MAX_CENTS);
    expect(Math.max(...DEFAULT_DISCOUNT_PRESETS.reasons.map((r) => r.length))).toBeLessThanOrEqual(PRESET_REASON_MAX_LENGTH);
    for (const [field, [lo, hi]] of Object.entries(STAFF_TIMING_BOUNDS)) {
      const v = DEFAULT_STAFF_TIMING[field as keyof typeof STAFF_TIMING_BOUNDS];
      expect({ field, inside: v >= lo && v <= hi }).toEqual({ field, inside: true });
    }
    for (const [field, [lo, hi]] of Object.entries(KITCHEN_TIMING_BOUNDS)) {
      const v = DEFAULT_KITCHEN_TIMING[field as keyof typeof KITCHEN_TIMING_BOUNDS];
      expect({ field, inside: v >= lo && v <= hi }).toEqual({ field, inside: true });
    }
  });

  it('the owner’s bounds (design: whole % 0–50, Rs 0–5,000; idle 5–60 never off, logins 8–24 h, step-in 5–30, reprints 0–3 within 10–120)', () => {
    expect([APPROVAL_MAX_PERCENT, APPROVAL_MAX_FLAT_CENTS]).toEqual([50, 500_000]);
    expect([PRESET_PERCENTS_MAX, PRESET_FLATS_MAX, PRESET_REASONS_MAX, PRESET_REASON_MAX_LENGTH]).toEqual([5, 3, 8, 30]);
    expect(STAFF_TIMING_BOUNDS).toEqual({
      idleLogoutMin: [5, 60],
      maxLoginHours: [8, 24],
      stepInMin: [5, 30],
      freeReprints: [0, 3],
      reprintWindowMin: [10, 120],
    });
    // Idle sign-out can't be switched off: its lowest is above 0.
    expect(STAFF_TIMING_BOUNDS.idleLogoutMin[0]).toBeGreaterThan(0);
  });

  it('with no limits passed, the one approval rule works exactly as with the default limits', () => {
    const cases = [
      [{ type: 'percent', value: 10 }, 200_000],
      [{ type: 'percent', value: 11 }, 200_000],
      [{ type: 'flat', value: 20_000 }, 200_000],
      [{ type: 'flat', value: 20_100 }, 200_000],
      [{ type: 'flat', value: 50_000 }, 1_000_000],
      [{ type: 'flat', value: 50_100 }, 1_000_000],
      [{ type: 'flat', value: 49_900 }, undefined],
    ] as const;
    for (const [d, subtotal] of cases) {
      expect(requiresManagerApproval(d, subtotal)).toBe(requiresManagerApproval(d, subtotal, DEFAULT_DISCOUNT_APPROVAL));
    }
  });
});
