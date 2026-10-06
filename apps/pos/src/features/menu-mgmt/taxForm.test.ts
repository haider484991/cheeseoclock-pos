/**
 * ONE set of starting tax rates. Up to v0.7.26 first-time setup offered
 * "Standard 17%", "Beverages 13%" and "Zero-rated", and Menu → Tax → Add tax
 * started a new category at 16%. Both now start from shared-types'
 * STARTING_TAX_RATE_BPS: 15%, the rate the shop charges (owner, 24 Sep 2026).
 * Only where a form starts: an existing tax category keeps its own rate.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { STARTING_TAX_CATEGORIES, STARTING_TAX_RATE_BPS, taxRatePercentText } from '@cheeseoclock/shared-types';
import { cardRateFieldStart, rateBpsOf, startingTaxRows, taxRateFieldStart, taxRatesText } from './taxForm';

const FEATURES = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = (path: string) => readFileSync(join(FEATURES, path), 'utf8');

describe('one starting tax rate', () => {
  it('is 15%, and first-time setup offers it and zero-rated, named from the rates', () => {
    expect(STARTING_TAX_RATE_BPS).toBe(1_500);
    expect(startingTaxRows()).toEqual([
      { name: 'Sales tax 15%', rateBps: 1_500 },
      { name: 'Zero-rated', rateBps: 0 },
    ]);
    expect(STARTING_TAX_CATEGORIES[0]!.rateBps).toBe(STARTING_TAX_RATE_BPS);
    expect(Object.isFrozen(STARTING_TAX_CATEGORIES)).toBe(true);
    // Fresh copies: editing a row on setup never changes the constant.
    const rows = startingTaxRows();
    rows[0]!.rateBps = 1_700;
    expect(startingTaxRows()[0]!.rateBps).toBe(1_500);
  });

  it('a new category on Menu → Tax starts at the same rate', () => {
    expect(taxRateFieldStart(null)).toBe('15');
  });

  it('an existing category keeps its own rate: nothing is changed or rewritten', () => {
    expect(taxRateFieldStart({ rateBps: 1_600 })).toBe('16');
    expect(taxRateFieldStart({ rateBps: 1_300 })).toBe('13');
    expect(taxRateFieldStart({ rateBps: 1_250 })).toBe('12.5');
    expect(taxRateFieldStart({ rateBps: 0 })).toBe('0');
  });

  it('the words say the rate they use', () => {
    expect(taxRatePercentText(1_500)).toBe('15%');
    expect(taxRatePercentText(1_250)).toBe('12.5%');
  });

  it('the card box (0052) starts empty — no card rate — unless the category has one; a box reads as basis points, empty as none', () => {
    expect(cardRateFieldStart(null)).toBe('');
    expect(cardRateFieldStart({ rateBps: 1_500 })).toBe('');
    expect(cardRateFieldStart({ rateBps: 1_500, digitalRateBps: null })).toBe('');
    expect(cardRateFieldStart({ rateBps: 1_500, digitalRateBps: 800 })).toBe('8');
    expect(cardRateFieldStart({ rateBps: 1_500, digitalRateBps: 1_250 })).toBe('12.5');
    expect(rateBpsOf('8')).toBe(800);
    expect(rateBpsOf(' 12.5 ')).toBe(1_250);
    expect(rateBpsOf('0')).toBe(0);
    expect(rateBpsOf('')).toBeNull();
    expect(rateBpsOf('abc')).toBeNull();
    expect(rateBpsOf('120')).toBe(10_000);
    expect(rateBpsOf('-3')).toBe(0);
  });

  it('the Tax list says both rates when they differ', () => {
    expect(taxRatesText({ rateBps: 1_500 })).toBe('15%');
    expect(taxRatesText({ rateBps: 1_500, digitalRateBps: null })).toBe('15%');
    expect(taxRatesText({ rateBps: 1_500, digitalRateBps: 1_500 })).toBe('15%');
    expect(taxRatesText({ rateBps: 1_500, digitalRateBps: 800 })).toBe('15% · card 8%');
    expect(taxRatesText({ rateBps: 1_250, digitalRateBps: 0 })).toBe('12.5% · card 0%');
  });

  it('setup and the Tax tab both use it; neither types a rate of its own any more', () => {
    const setup = source('onboarding/OnboardingPage.tsx');
    const tab = source('menu-mgmt/TaxTab.tsx');
    expect(setup).toMatch(/startingTaxRows\(\)/);
    expect(tab).toMatch(/taxRateFieldStart\(existing\)/);
    for (const text of [setup, tab]) {
      expect(text).not.toMatch(/\b1[67]00\b|Standard 1[67]%|Beverages 13%|\?\? 1600/);
    }
  });
});
