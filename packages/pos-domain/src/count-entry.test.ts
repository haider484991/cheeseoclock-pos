import { describe, expect, it } from 'vitest';
import { bigUnitOf, countEntryModes, countEntryOf, countEntryQty, countReadBack } from './count-entry.js';

describe('the count sheet: kilos, packs + loose, or plain units (costing spec Phase 8)', () => {
  it('offers the easiest way first', () => {
    expect(countEntryModes('g', 2_000)).toEqual(['big', 'packs', 'base']);
    expect(countEntryModes('g', null)).toEqual(['big', 'base']);
    expect(countEntryModes('ml', 1)).toEqual(['big', 'base']);
    expect(countEntryModes('pcs', 50)).toEqual(['packs', 'base']);
    expect(countEntryModes('pcs', null)).toEqual(['base']);
    expect(bigUnitOf('g')).toEqual({ label: 'kg', factor: 1000 });
    expect(bigUnitOf('ml')).toEqual({ label: 'litres', factor: 1000 });
    expect(bigUnitOf('pcs')).toBeNull();
  });

  it('kilos to the gram; never a float', () => {
    expect(countEntryQty({ mode: 'big', amount: '2.35' }, 'g', null)).toEqual({ ok: true, qty: 2_350 });
    expect(countEntryQty({ mode: 'big', amount: '12' }, 'g', null)).toEqual({ ok: true, qty: 12_000 });
    expect(countEntryQty({ mode: 'big', amount: '.5' }, 'g', null)).toEqual({ ok: true, qty: 500 });
    expect(countEntryQty({ mode: 'big', amount: '0.001' }, 'g', null)).toEqual({ ok: true, qty: 1 });
    expect(countEntryQty({ mode: 'big', amount: '1,250.5' }, 'ml', null)).toEqual({ ok: true, qty: 1_250_500 });
    expect(countEntryQty({ mode: 'big', amount: '2.3456' }, 'g', null)).toMatchObject({ ok: false });
    expect(countEntryQty({ mode: 'big', amount: '-2' }, 'g', null)).toMatchObject({ ok: false });
    expect(countEntryQty({ mode: 'big', amount: 'two' }, 'g', null)).toMatchObject({ ok: false });
  });

  it('whole packs plus what is loose', () => {
    expect(countEntryQty({ mode: 'packs', amount: '3', loose: '250' }, 'g', 2_000)).toEqual({ ok: true, qty: 6_250 });
    expect(countEntryQty({ mode: 'packs', amount: '', loose: '250' }, 'g', 2_000)).toEqual({ ok: true, qty: 250 });
    expect(countEntryQty({ mode: 'packs', amount: '4' }, 'pcs', 50)).toEqual({ ok: true, qty: 200 });
    expect(countEntryQty({ mode: 'packs', amount: '1.5' }, 'pcs', 50)).toMatchObject({ ok: false });
    expect(countEntryQty({ mode: 'packs', amount: '1' }, 'pcs', null)).toMatchObject({ ok: false });
  });

  it('a blank box is "not counted", never zero; 0 is zero', () => {
    expect(countEntryQty({ mode: 'base', amount: '' }, 'g', null)).toEqual({ ok: true, qty: null });
    expect(countEntryQty({ mode: 'packs', amount: ' ', loose: '' }, 'g', 1_000)).toEqual({ ok: true, qty: null });
    expect(countEntryQty({ mode: 'base', amount: '0' }, 'g', null)).toEqual({ ok: true, qty: 0 });
    expect(countEntryQty({ mode: 'base', amount: '12.5' }, 'g', null)).toMatchObject({ ok: false });
    expect(countEntryQty({ mode: 'base', amount: '999999999' }, 'g', null)).toMatchObject({ ok: false });
  });

  it('a saved count reads back the same in each way', () => {
    for (const [qty, unit, pack] of [
      [2_350, 'g', 1_000],
      [12_000, 'g', 2_000],
      [7, 'pcs', 50],
      [0, 'ml', null],
    ] as const) {
      for (const mode of countEntryModes(unit, pack)) {
        const back = countEntryQty(countEntryOf(qty, mode, unit, pack), unit, pack);
        expect({ qty, unit, mode, back }).toEqual({ qty, unit, mode, back: { ok: true, qty } });
      }
    }
    expect(countEntryOf(2_350, 'big', 'g', null)).toEqual({ mode: 'big', amount: '2.35' });
    expect(countEntryOf(6_250, 'packs', 'g', 2_000)).toEqual({ mode: 'packs', amount: '3', loose: '250' });
    expect(countEntryOf(null, 'big', 'g', null)).toEqual({ mode: 'big', amount: '', loose: '' });
  });

  it('a comma is read the one way it can be meant, never dropped', () => {
    // In kilos: a comma before one or two digits is the point ("2,5" was read as 25 kg).
    expect(countEntryQty({ mode: 'big', amount: '2,5' }, 'g', null)).toEqual({ ok: true, qty: 2_500 });
    expect(countEntryQty({ mode: 'big', amount: '2,25' }, 'g', null)).toEqual({ ok: true, qty: 2_250 });
    // "2,500" in a kilo box: 2.5 kg or 2,500 kg? Asked again, not guessed.
    expect(countEntryQty({ mode: 'big', amount: '2,500' }, 'g', null)).toEqual({ ok: false, message: 'Use a point for part of a kilo, like 2.5' });
    expect(countEntryQty({ mode: 'big', amount: '2,5,0' }, 'ml', null)).toEqual({ ok: false, message: 'Use a point for part of a litre, like 2.5' });
    // Whole grams, pieces, packs: commas between thousands are fine; any other comma is not.
    expect(countEntryQty({ mode: 'base', amount: '2,500' }, 'g', null)).toEqual({ ok: true, qty: 2_500 });
    expect(countEntryQty({ mode: 'base', amount: '12,000' }, 'pcs', null)).toEqual({ ok: true, qty: 12_000 });
    expect(countEntryQty({ mode: 'base', amount: '2,5' }, 'g', null)).toEqual({ ok: false, message: 'Type it without commas' });
    expect(countEntryQty({ mode: 'packs', amount: '3', loose: '2,50' }, 'g', 1_000)).toEqual({ ok: false, message: 'Type the loose g without commas' });
    expect(countEntryQty({ mode: 'packs', amount: '1,000', loose: '' }, 'pcs', 10)).toEqual({ ok: true, qty: 10_000 });
  });

  it('says what a box was read as, exactly (to the gram)', () => {
    expect(countReadBack(7_250, 'g')).toBe('= 7.25 kg');
    expect(countReadBack(2_345, 'g')).toBe('= 2.345 kg');
    expect(countReadBack(2_500_000, 'g')).toBe('= 2,500 kg');
    expect(countReadBack(12_000, 'g')).toBe('= 12 kg');
    expect(countReadBack(250, 'g')).toBe('= 250 g');
    expect(countReadBack(0, 'g')).toBe('= 0 g');
    expect(countReadBack(1_500, 'ml')).toBe('= 1.5 L');
    expect(countReadBack(1_200, 'pcs')).toBe('= 1,200 pcs');
  });
});
