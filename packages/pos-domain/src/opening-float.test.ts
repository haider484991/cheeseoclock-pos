import { describe, expect, it } from 'vitest';
import { DEFAULT_OPENING_FLOAT, OPENING_FLOAT_MAX_CENTS, TILL_SETTING_DEFAULTS } from '@cheeseoclock/shared-types';
import { openingFloatPrefill } from './opening-float.js';

const LAST = { countedCashCents: 1_234_500, closedAt: '2026-09-26T20:05:00.000Z' };

describe('the Open shift box starts the float count on', () => {
  it('by default: the last count on this till (today), frozen', () => {
    expect(DEFAULT_OPENING_FLOAT).toEqual({ mode: 'lastCount', fixedCents: 0 });
    expect(Object.isFrozen(DEFAULT_OPENING_FLOAT)).toBe(true);
    expect(TILL_SETTING_DEFAULTS['drawer.openingFloat']).toBe(DEFAULT_OPENING_FLOAT);
    expect(openingFloatPrefill(DEFAULT_OPENING_FLOAT, LAST)).toEqual({ prefillCents: 1_234_500, from: 'last_count', lastCount: LAST });
  });

  it('a first shift (no count yet) still opens: nothing to start from, the box starts at 0', () => {
    expect(openingFloatPrefill(DEFAULT_OPENING_FLOAT, null)).toEqual({ prefillCents: null, from: 'none', lastCount: null });
  });

  it('fixed: the owner’s amount, even when a last count exists — and on a first shift', () => {
    const fixed = { mode: 'fixed' as const, fixedCents: 500_000 };
    expect(openingFloatPrefill(fixed, LAST)).toEqual({ prefillCents: 500_000, from: 'fixed', lastCount: LAST });
    expect(openingFloatPrefill(fixed, null)).toEqual({ prefillCents: 500_000, from: 'fixed', lastCount: null });
    expect(openingFloatPrefill({ mode: 'fixed', fixedCents: 0 }, LAST)).toMatchObject({ prefillCents: 0, from: 'fixed' });
  });

  it('the fixed amount is at most Rs 100,000', () => {
    expect(OPENING_FLOAT_MAX_CENTS).toBe(10_000_000);
  });
});
