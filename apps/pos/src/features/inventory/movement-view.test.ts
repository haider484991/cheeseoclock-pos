import { describe, expect, it } from 'vitest';
import { formatWhen, movementLabel, rangeSinceIso } from './movement-view';

describe('movementLabel', () => {
  it('names each kind of movement plainly', () => {
    expect(movementLabel({ reason: 'sale', deltaQty: -200, notes: null })).toEqual({ label: 'Sale', tone: 'blue' });
    expect(movementLabel({ reason: 'delivery', deltaQty: 6000, notes: 'PO 12' }).label).toBe('Delivery');
    expect(movementLabel({ reason: 'waste', deltaQty: -50, notes: null }).label).toBe('Waste');
    expect(movementLabel({ reason: 'count', deltaQty: 10, notes: null }).label).toBe('Stock take');
    expect(movementLabel({ reason: 'transfer', deltaQty: 10, notes: null }).label).toBe('Transfer');
  });

  it('calls stock put back by a cancelled order "Returned"', () => {
    expect(
      movementLabel({ reason: 'sale', deltaQty: 200, notes: 'Order cancelled before cooking — stock put back' }).label,
    ).toBe('Returned');
  });

  it('tells a batch apart from a hand-made fix', () => {
    expect(movementLabel({ reason: 'adjustment', deltaQty: 5000, notes: 'Made 2 batches' }).label).toBe('Batch');
    expect(movementLabel({ reason: 'adjustment', deltaQty: -800, notes: 'Used in 1 batch of Pizza Sauce' }).label).toBe(
      'Batch',
    );
    expect(movementLabel({ reason: 'adjustment', deltaQty: -3, notes: 'typo yesterday' }).label).toBe('Fix');
    expect(movementLabel({ reason: 'adjustment', deltaQty: -3, notes: null }).label).toBe('Fix');
  });
});

describe('rangeSinceIso', () => {
  const now = new Date(2026, 8, 26, 15, 30); // 26 Sep 2026, 3:30 pm local

  it('starts at local midnight', () => {
    expect(rangeSinceIso('today', now)).toBe(new Date(2026, 8, 26).toISOString());
    expect(rangeSinceIso('7d', now)).toBe(new Date(2026, 8, 20).toISOString());
    expect(rangeSinceIso('30d', now)).toBe(new Date(2026, 7, 28).toISOString());
  });

  it('has no start for all time', () => {
    expect(rangeSinceIso('all', now)).toBeUndefined();
  });
});

describe('formatWhen', () => {
  const now = new Date(2026, 8, 26, 15, 30);

  it('says today and yesterday in words', () => {
    expect(formatWhen(new Date(2026, 8, 26, 15, 4).toISOString(), now)).toMatch(/^Today 3:04\spm$/);
    expect(formatWhen(new Date(2026, 8, 25, 9, 15).toISOString(), now)).toMatch(/^Yesterday 9:15\sam$/);
  });

  it('gives the date for older ones, with the year only when it is not this year', () => {
    expect(formatWhen(new Date(2026, 8, 21, 20, 0).toISOString(), now)).toMatch(/^21 Sept? 8:00\spm$/);
    expect(formatWhen(new Date(2025, 2, 3, 13, 0).toISOString(), now)).toMatch(/^3 Mar 2025 1:00\spm$/);
  });

  it('shows an unreadable time as it is', () => {
    expect(formatWhen('not a date', now)).toBe('not a date');
  });
});
