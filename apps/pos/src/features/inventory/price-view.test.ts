import { describe, expect, it } from 'vitest';
import type { PriceHistoryEntry } from '@cheeseoclock/shared-types';
import {
  SOURCE_CHIP,
  historyPoints,
  whenText,
  initialPriceEntry,
  packText,
  perChoices,
  perLabel,
  priceChange,
  priceText,
  readPriceEntry,
  rupeesInput,
  tagView,
  type PriceEntry,
} from './price-view';

// Made-up prices: the repo is public.

describe('a price in plain words', () => {
  it('per kg for grams, per litre for ml, per unit otherwise; free and unpriced say so', () => {
    expect(priceText({ unitCostMc: 37_500, unit: 'g', priceKind: 'set' })).toBe('Rs 375 / kg');
    expect(priceText({ unitCostMc: 42_000, unit: 'ml', priceKind: 'estimate' })).toBe('Rs 420 / litre');
    expect(priceText({ unitCostMc: 4_000_000, unit: 'pcs', priceKind: 'set' })).toBe('Rs 40 / pcs');
    expect(priceText({ unitCostMc: 83_333, unit: 'pcs', priceKind: 'set' })).toBe('Rs 0.83 / pcs');
    expect(priceText({ unitCostMc: 0, unit: 'g', priceKind: 'free' })).toBe('free');
    expect(priceText({ unitCostMc: 0, unit: 'g', priceKind: 'unset' })).toBe('no price yet');
  });

  it('the pack when it is not just "a kilo" or "one"', () => {
    expect(packText({ packSize: 6000, packPriceCents: 225_000, unit: 'g', priceKind: 'set' })).toBe('6,000 g for Rs 2,250');
    expect(packText({ packSize: 1000, packPriceCents: 37_500, unit: 'g', priceKind: 'set' })).toBeNull();
    expect(packText({ packSize: 1, packPriceCents: 4_000, unit: 'pcs', priceKind: 'set' })).toBeNull();
    expect(packText({ packSize: 12, packPriceCents: 1_000, unit: 'pcs', priceKind: 'set' })).toBe('12 pcs for Rs 10');
  });

  it('up or down on the price before', () => {
    expect(priceChange(37_500, 41_250, 'set')).toEqual({ text: '▲ 10%', tone: 'up' });
    expect(priceChange(40_000, 39_000, 'set')).toEqual({ text: '▼ 2.5%', tone: 'down' });
    expect(priceChange(40_000, 40_000, 'set')).toEqual({ text: 'same', tone: 'same' });
    expect(priceChange(0, 40_000, 'set')).toEqual({ text: 'was free', tone: 'up' });
    expect(priceChange(null, 40_000, 'set')).toBeNull();
    expect(priceChange(40_000, 0, 'unset')).toBeNull();
  });

  it('a Convert is no change; every source has a chip', () => {
    const tag = { source: 'convert' as const, effectiveAt: 'x', unit: 'g', packSize: 1000, packPriceCents: 37_500, priceKind: 'set' as const, unitCostMc: 37_500, prevUnitCostMc: 37_500 };
    expect(tagView(tag)).toEqual({ price: 'Rs 375 / kg', pack: null, change: null });
    expect(tagView({ ...tag, source: 'delivery', prevUnitCostMc: 30_000 }).change).toEqual({ text: '▲ 25%', tone: 'up' });
    expect(Object.values(SOURCE_CHIP).map((c) => c.label)).toEqual(['Starting price', 'Typed', 'Bill', 'Bill', 'Sheet', 'Batch', 'Unit change']);
  });
});

describe('the history as a line', () => {
  const entry = (p: Partial<PriceHistoryEntry>): PriceHistoryEntry => ({
    id: 'x' as PriceHistoryEntry['id'],
    ingredientId: 'i' as PriceHistoryEntry['ingredientId'],
    effectiveAt: '2026-09-01T00:00:00.000Z',
    recordedAt: '2026-09-01T00:00:00.000Z',
    unit: 'g',
    packSize: 1000,
    packPriceCents: 37_500,
    priceKind: 'set',
    unitCostMc: 37_500,
    prevUnitCostMc: null,
    source: 'manual',
    supplierId: null,
    supplierName: null,
    purchaseOrderId: null,
    purchaseOrderRef: null,
    actorUserId: null,
    actorName: null,
    notes: null,
    ...p,
  });
  it('oldest first, every price in the unit now (a kg price before a Convert in grams), unpriced ones left off', () => {
    const pts = historyPoints(
      [
        entry({ effectiveAt: '2026-09-20T00:00:00.000Z', packPriceCents: 40_000 }),
        entry({ effectiveAt: '2026-09-10T00:00:00.000Z', unit: 'kg', packSize: 1, packPriceCents: 36_000 }),
        entry({ effectiveAt: '2026-09-01T00:00:00.000Z', priceKind: 'unset', packSize: 1, packPriceCents: 0 }),
      ],
      'g',
    );
    expect(pts.map((p) => [new Date(p.at).toISOString().slice(0, 10), p.unitCostMc, p.label])).toEqual([
      ['2026-09-10', 36_000, 'Rs 360 / kg'],
      ['2026-09-20', 40_000, 'Rs 400 / kg'],
    ]);
  });

  it('the starting price (in force from the start of time) sits at the day history began, never after a later change', () => {
    const seed = { source: 'seed' as const, effectiveAt: '1970-01-01T00:00:00.000Z', packPriceCents: 30_000 };
    const pts = historyPoints(
      [entry({ effectiveAt: '2026-09-20T00:00:00.000Z', packPriceCents: 40_000 }), entry({ ...seed, recordedAt: '2026-09-15T00:00:00.000Z' })],
      'g',
    );
    expect(pts.map((p) => [new Date(p.at).toISOString().slice(0, 10), p.unitCostMc])).toEqual([
      ['2026-09-15', 30_000],
      ['2026-09-20', 40_000],
    ]);
    // Recorded on a till that began its history after a price typed on the other one: kept before it.
    const late = historyPoints(
      [entry({ effectiveAt: '2026-09-20T00:00:00.000Z', packPriceCents: 40_000 }), entry({ ...seed, recordedAt: '2026-09-25T00:00:00.000Z' })],
      'g',
    );
    expect(late.map((p) => new Date(p.at).toISOString().slice(0, 10))).toEqual(['2026-09-20', '2026-09-20']);
    expect(whenText(entry({ ...seed, recordedAt: '2026-09-27T09:00:00.000Z' }))).toEqual({ main: 'From the start', sub: expect.stringMatching(/^history began 27 Sep/) });
    expect(whenText(entry({})).sub).toBeNull();
  });
});

describe('"Set price": what was typed, as the exact pack', () => {
  const e = (p: Partial<PriceEntry>): PriceEntry => ({ per: 'thousand', rupees: '', packSize: '', guess: false, free: false, ...p });

  it('Rs 155 per kg is 1,000 g for Rs 155 exactly', () => {
    expect(readPriceEntry(e({ rupees: '155' }), 'g')).toEqual({ ok: true, free: false, pack: { size: 1000, priceCents: 15_500 }, unitCostMc: 15_500, priceKind: 'set' });
  });
  it('a pack of N, a piece, a guess, free', () => {
    expect(readPriceEntry(e({ per: 'pack', rupees: '2,250', packSize: '6,000' }), 'g')).toMatchObject({ ok: true, pack: { size: 6000, priceCents: 225_000 }, unitCostMc: 37_500 });
    expect(readPriceEntry(e({ per: 'piece', rupees: '40', guess: true }), 'pcs')).toMatchObject({ ok: true, pack: { size: 1, priceCents: 4_000 }, priceKind: 'estimate' });
    expect(readPriceEntry(e({ free: true, rupees: 'anything' }), 'g')).toEqual({ ok: true, free: true });
  });
  it('says what is wrong, in plain words', () => {
    expect(readPriceEntry(e({}), 'g')).toEqual({ ok: false, empty: true, problem: 'Type the price in rupees, per kg.' });
    expect(readPriceEntry(e({ rupees: 'abc' }), 'g')).toMatchObject({ ok: false, empty: false, problem: 'Type a price like 375 or 375.50.' });
    expect(readPriceEntry(e({ rupees: '0' }), 'g')).toMatchObject({ problem: 'Rs 0 is no price: tick "Free" if it costs nothing.' });
    expect(readPriceEntry(e({ per: 'pack', rupees: '10' }), 'pcs')).toMatchObject({ problem: 'Say how much one pack holds, in whole pcs.' });
    expect(readPriceEntry(e({ per: 'piece', rupees: '10' }), 'g')).toMatchObject({ ok: false, problem: expect.stringMatching(/^Per piece does not fit/) });
  });
  it('opens with the price the way it is kept', () => {
    const kept = (p: { packSize: number | null; packPriceCents: number | null; costPerUnitCents?: number; unit?: string; priceKind?: 'set' | 'estimate' | 'free' | 'unset' }) =>
      initialPriceEntry({ unit: p.unit ?? 'g', costPerUnitCents: p.costPerUnitCents ?? 0, packSize: p.packSize, packPriceCents: p.packPriceCents, priceKind: p.priceKind ?? 'set' });
    expect(kept({ packSize: 1000, packPriceCents: 37_500 })).toMatchObject({ per: 'thousand', rupees: '375' });
    expect(kept({ packSize: 6000, packPriceCents: 225_000 })).toMatchObject({ per: 'pack', rupees: '2250', packSize: '6000' });
    expect(kept({ packSize: null, packPriceCents: null, costPerUnitCents: 38 })).toMatchObject({ per: 'thousand', rupees: '380' });
    expect(kept({ packSize: null, packPriceCents: null, costPerUnitCents: 4_050, unit: 'pcs', priceKind: 'estimate' })).toMatchObject({ per: 'piece', rupees: '40.5', guess: true });
    expect(kept({ packSize: null, packPriceCents: null, priceKind: 'free' })).toMatchObject({ free: true, rupees: '' });
    expect(kept({ packSize: null, packPriceCents: null, priceKind: 'unset', unit: 'pcs' })).toMatchObject({ per: 'piece', rupees: '' });
  });
  it('the ways each unit can be priced', () => {
    expect(perChoices('g')).toEqual(['thousand', 'pack']);
    expect(perChoices('pcs')).toEqual(['piece', 'pack']);
    expect([perLabel('thousand', 'ml'), perLabel('pack', 'g'), perLabel('piece', 'pcs')]).toEqual(['per litre', 'for a pack', 'per piece']);
    expect([rupeesInput(37_500), rupeesInput(15_550), rupeesInput(15_505)]).toEqual(['375', '155.5', '155.05']);
  });
});
