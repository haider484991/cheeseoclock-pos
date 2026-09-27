/**
 * "Prices for the costing file" (costing spec Phase 6): the till's prices,
 * where each came from and since when, beside the sheet's — a handoff for
 * whoever keeps the costing workbook. Only MADE-UP fixture prices go in
 * here (costing spec D11: the repo is public); the test checks the file
 * holds exactly the fixture's prices and nothing else.
 */
import { describe, expect, it } from 'vitest';
import type { Ingredient, UUID } from '@cheeseoclock/shared-types';
import { COSTING_FILE_HEADER, costingFileCsv, costingFileName, costingFileRows } from './costing-file';

const ing = (p: Partial<Ingredient> & Pick<Ingredient, 'name' | 'unit'>): Ingredient => ({
  id: `id-${p.name}` as UUID,
  category: 'other',
  categoryAuto: true,
  currentQty: 0,
  lowThreshold: 0,
  costPerUnitCents: 0,
  packSize: null,
  packPriceCents: null,
  priceKind: 'set',
  batchYield: null,
  batchMethod: null,
  defaultSupplierId: null,
  sku: null,
  notes: null,
  isActive: true,
  latestPrice: null,
  priceFromRecipe: false,
  sheetPrice: null,
  ...p,
});

// The made-up fixture: every figure here is invented.
const FIXTURE: Ingredient[] = [
  ing({
    name: 'Test cheese',
    unit: 'g',
    packSize: 2000,
    packPriceCents: 260_000,
    latestPrice: { source: 'delivery', effectiveAt: '2026-09-20T08:00:00.000Z', unit: 'g', packSize: 2000, packPriceCents: 260_000, priceKind: 'set', unitCostMc: 130_000, prevUnitCostMc: 120_000 },
    sheetPrice: { packSize: 1000, packPriceCents: 110_000, priceKind: 'set', unitCostMc: 110_000, at: '2026-09-21T08:00:00.000Z' },
  }),
  ing({
    name: 'Test box',
    unit: 'pcs',
    costPerUnitCents: 4_000,
    latestPrice: { source: 'seed', effectiveAt: '1970-01-01T00:00:00.000Z', unit: 'pcs', packSize: 1, packPriceCents: 4_000, priceKind: 'set', unitCostMc: 4_000_000, prevUnitCostMc: null },
    sheetPrice: { packSize: 1, packPriceCents: 4_000, priceKind: 'set', unitCostMc: 4_000_000, at: '2026-09-21T08:00:00.000Z' },
  }),
  ing({ name: 'Test bottle', unit: 'pcs', priceKind: 'unset' }),
  ing({ name: 'Test salt', unit: 'g', priceKind: 'free' }),
  ing({ name: 'Test sauce', unit: 'g', packSize: 2000, packPriceCents: 35_625, priceFromRecipe: true }),
  ing({ name: 'Test retired', unit: 'g', packSize: 1000, packPriceCents: 99_900, isActive: false }),
];

describe('Prices for the costing file', () => {
  it('one row per active ingredient, by name: the till price per kg / piece, where from, since, and the sheet\'s', () => {
    const rows = costingFileRows(FIXTURE);
    expect(rows[0]).toEqual([...COSTING_FILE_HEADER]);
    expect(rows.slice(1)).toEqual([
      ['Test bottle', null, 'pcs', null, null, 'no price yet', '', '', null, ''],
      ['Test box', { cents: 4_000 }, 'pcs', null, null, 'known', 'Starting price', '', { cents: 4_000 }, 'same'],
      ['Test cheese', { cents: 130_000 }, 'kg', 2000, { cents: 260_000 }, 'known', 'Bill', '2026-09-20', { cents: 110_000 }, '18.2% dearer'],
      ['Test salt', { cents: 0 }, 'kg', null, null, 'free', '', '', null, ''],
      ['Test sauce', { cents: 17_813 }, 'kg', 2000, { cents: 35_625 }, 'from its batch recipe', '', '', null, ''],
    ]);
  });

  it('the file holds the fixture\'s made-up prices only, as plain rupees Excel reads, with a byte-order mark', () => {
    const csv = costingFileCsv(FIXTURE);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const lines = csv.slice(1).trim().split('\r\n');
    expect(lines).toHaveLength(6);
    expect(lines[3]).toBe('Test cheese,1300.00,kg,2000,2600.00,known,Bill,2026-09-20,1100.00,18.2% dearer');
    // Every rupee figure in it is one of the fixture's (nothing else can leak into the file).
    const money = [...csv.matchAll(/\b\d+\.\d{2}\b/g)].map((m) => m[0]).sort();
    expect(money).toEqual(['0.00', '1100.00', '1300.00', '178.13', '2600.00', '356.25', '40.00', '40.00'].sort());
    expect(csv).not.toContain('Test retired');
  });

  it('is named for the day', () => {
    expect(costingFileName(new Date('2026-09-27T10:00:00.000Z'))).toBe('prices-for-the-costing-file-2026-09-27.csv');
  });
});
