/**
 * Both tills are updated the same day, but for a while one may still be
 * v0.7.29. What that till (its own schemas, frozen in
 * old-till-v0729.fixture.ts) makes of the two shop rules this version writes
 * in format 2 — 'discounts.approval' (reasonRequired) and 'foodpanda.checks'
 * (tabletToleranceCents) — and what this version makes of the format-1
 * values it saves. Every value is made up.
 */
import { describe, expect, it } from 'vitest';
import { BUSINESS_SETTING_READ_SCHEMAS, BUSINESS_SETTING_SCHEMAS, storedFormatIsNewer } from '@cheeseoclock/shared-schemas';
import { DEFAULT_DISCOUNT_APPROVAL, DEFAULT_FOODPANDA_CHECKS, SHOP_SETTING_FORMAT } from '@cheeseoclock/shared-types';
import * as OLD from './old-till-v0729.fixture.js';

type Key = 'discounts.approval' | 'foodpanda.checks';
const WRITTEN_HERE: ReadonlyArray<readonly [Key, Record<string, unknown>]> = [
  ['discounts.approval', { v: 2, percentOver: 10, flatOverCents: 50_000, reasonRequired: true }],
  ['discounts.approval', { ...DEFAULT_DISCOUNT_APPROVAL }],
  ['foodpanda.checks', { v: 2, orderCode: 'required', tabletTotal: 'optional', tabletToleranceCents: 0 }],
  ['foodpanda.checks', { ...DEFAULT_FOODPANDA_CHECKS }],
];

describe('a v0.7.29 till and the values this version writes', () => {
  it('the frozen code is v0.7.29’s format (1 for both), and this version writes format 2', () => {
    expect(OLD.SHOP_SETTING_FORMAT).toEqual({ 'foodpanda.checks': 1, 'discounts.approval': 1 });
    expect([SHOP_SETTING_FORMAT['discounts.approval'], SHOP_SETTING_FORMAT['foodpanda.checks']]).toEqual([2, 2]);
  });

  for (const [key, value] of WRITTEN_HERE) {
    it(`${key} ${JSON.stringify(value)}: written here; the old till reads what it knows, shows it read-only and never saves over it`, () => {
      // This version takes it as written.
      expect(BUSINESS_SETTING_SCHEMAS[key].safeParse(value).success).toBe(true);
      // The old till reads the fields it knows (the new one dropped)…
      const read = OLD.BUSINESS_SETTING_READ_SCHEMAS[key].safeParse(value);
      const known = { ...value };
      delete known['reasonRequired'];
      delete known['tabletToleranceCents'];
      expect(read).toEqual({ success: true, data: known });
      // …shows the card read-only (a newer format)…
      expect(OLD.storedFormatIsNewer(key, value)).toBe(true);
      // …and its own write schema refuses a format-2 value: it cannot save over it and drop the new field.
      expect(OLD.BUSINESS_SETTING_SCHEMAS[key].safeParse(value).success).toBe(false);
    });
  }

  it('the other way: what the old till saves (format 1) reads here with today’s behaviour — a reason optional, Rs 1 — and is not "newer"', () => {
    const oldApproval = { v: 1, percentOver: 10, flatOverCents: 50_000 };
    const oldChecks = { v: 1, orderCode: 'optional', tabletTotal: 'optional' };
    expect(OLD.BUSINESS_SETTING_SCHEMAS['discounts.approval'].safeParse(oldApproval).success).toBe(true);
    expect(OLD.BUSINESS_SETTING_SCHEMAS['foodpanda.checks'].safeParse(oldChecks).success).toBe(true);
    expect(BUSINESS_SETTING_READ_SCHEMAS['discounts.approval'].safeParse(oldApproval)).toMatchObject({ success: true, data: { reasonRequired: false } });
    expect(BUSINESS_SETTING_READ_SCHEMAS['foodpanda.checks'].safeParse(oldChecks)).toMatchObject({ success: true, data: { tabletToleranceCents: 100 } });
    expect(storedFormatIsNewer('discounts.approval', oldApproval)).toBe(false);
    expect(storedFormatIsNewer('foodpanda.checks', oldChecks)).toBe(false);
  });
});

describe('the two keys of the menu files from the costing PC (v0.7.32)', () => {
  const marker = {
    v: 1,
    packageId: '0b8f6c8e-8f8a-4c8a-9d2e-1c6a7d2b9e10',
    seq: 4,
    sha256: 'a'.repeat(64),
    fileName: 'test-menu.json',
    appliedByDevice: 'till-1',
    appliedAt: '2026-09-29T09:00:00.000Z',
    automatic: true,
    counts: { newItems: 3, updatedItems: 5 },
  };

  it('menu.lastPackage: written strictly; a newer till’s marker (a higher format, a field this one does not know) still reads — never as "none"', () => {
    expect(BUSINESS_SETTING_SCHEMAS['menu.lastPackage'].safeParse(marker).success).toBe(true);
    expect(BUSINESS_SETTING_SCHEMAS['menu.lastPackage'].safeParse({ ...marker, fromTheFuture: 1 }).success).toBe(false);
    expect(BUSINESS_SETTING_SCHEMAS['menu.lastPackage'].safeParse({ ...marker, v: 2 }).success).toBe(false);
    const newer = BUSINESS_SETTING_READ_SCHEMAS['menu.lastPackage'].safeParse({ ...marker, v: 2, fromTheFuture: { x: 1 } });
    expect(newer).toMatchObject({ success: true, data: { v: 2, packageId: marker.packageId, seq: 4, appliedByDevice: 'till-1' } });
    // The counts are numbers only; a count it does not know is dropped, a missing one is 0.
    expect(newer.success && newer.data.counts).toEqual({
      newItems: 3,
      updatedItems: 5,
      priceChanges: 0,
      newIngredients: 0,
      updatedIngredients: 0,
      newCategories: 0,
      recipesSet: 0,
      choiceGroupsChanged: 0,
      batchRecipesSet: 0,
      skipped: 0,
    });
    // Not a shop rule: never "newer" for a card.
    expect(storedFormatIsNewer('menu.lastPackage', { ...marker, v: 2 })).toBe(false);
  });

  it('menu.autoUpdate: format 1 as written here; a newer till’s value reads what it knows and shows the card read-only', () => {
    expect(SHOP_SETTING_FORMAT['menu.autoUpdate']).toBe(1);
    expect(BUSINESS_SETTING_SCHEMAS['menu.autoUpdate'].safeParse({ v: 1, mode: 'ask' }).success).toBe(true);
    expect(BUSINESS_SETTING_READ_SCHEMAS['menu.autoUpdate'].safeParse({ v: 2, mode: 'ask', later: true })).toEqual({ success: true, data: { v: 2, mode: 'ask' } });
    expect(storedFormatIsNewer('menu.autoUpdate', { v: 2, mode: 'ask' })).toBe(true);
    expect(storedFormatIsNewer('menu.autoUpdate', { v: 1, mode: 'ask', later: true })).toBe(true);
    expect(storedFormatIsNewer('menu.autoUpdate', { v: 1, mode: 'auto' })).toBe(false);
  });
});
