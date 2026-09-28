import { describe, expect, it } from 'vitest';
import { formatWhen, movementDetails, movementLabel, rangeSinceIso } from './movement-view';

describe('movementDetails', () => {
  it('names the order by its short number, then the note', () => {
    expect(
      movementDetails({ orderNumber: '20260926-0042', refPurchaseOrderId: null, purchaseOrderRef: null, notes: 'Cancelled, not made — put back' }),
    ).toBe('Order #0042 · Cancelled, not made — put back');
    expect(
      movementDetails({
        orderNumber: '20260926-0042',
        refPurchaseOrderId: null,
        purchaseOrderRef: null,
        notes: 'Cancelled after cooking — counted as waste',
      }),
    ).toBe('Order #0042 · Cancelled after cooking — counted as waste');
    expect(movementDetails({ orderNumber: null, refPurchaseOrderId: '0190abcdef12', purchaseOrderRef: null, notes: null })).toBe(
      'PO 0190abcd',
    );
    expect(movementDetails({ orderNumber: null, refPurchaseOrderId: 'x', purchaseOrderRef: 'R-7', notes: 'PO R-7 received' })).toBe(
      'PO R-7 received',
    );
  });
});

describe('movementLabel', () => {
  it('names each kind of movement plainly', () => {
    expect(movementLabel({ reason: 'sale', deltaQty: -200, notes: null })).toEqual({ label: 'Sale', tone: 'blue' });
    expect(movementLabel({ reason: 'delivery', deltaQty: 6000, notes: 'PO 12' }).label).toBe('Delivery');
    expect(movementLabel({ reason: 'waste', deltaQty: -50, notes: null }).label).toBe('Waste');
    expect(movementLabel({ reason: 'count', deltaQty: 10, notes: null }).label).toBe('Stock take');
    expect(movementLabel({ reason: 'transfer', deltaQty: 10, notes: null }).label).toBe('Transfer');
  });

  it('calls stock put back by a cancelled order "Returned" (older tills\' note too)', () => {
    expect(
      movementLabel({ reason: 'sale', deltaQty: 200, notes: 'Order cancelled before cooking — stock put back' }).label,
    ).toBe('Returned');
    expect(movementLabel({ reason: 'sale', deltaQty: 90, notes: 'Cancelled, not made — put back' })).toEqual({
      label: 'Returned',
      tone: 'stone',
    });
    expect(movementLabel({ reason: 'sale', deltaQty: 1, notes: 'Refunded — sealed drink put back' }).label).toBe('Returned');
    // Put back on the till that took it (the details column carries the note).
    expect(movementLabel({ reason: 'sale', deltaQty: 90, notes: 'Cancelled, not made — put back on the till that sent it' })).toEqual({
      label: 'Returned',
      tone: 'stone',
    });
    expect(
      movementLabel({ reason: 'sale', deltaQty: 1, notes: 'Cancelled — sealed drink put back on the till that sent it' }).label,
    ).toBe('Returned');
  });

  it('food made for a cancelled order: the sale undone quietly, then "Waste"', () => {
    expect(movementLabel({ reason: 'sale', deltaQty: 90, notes: 'Cancelled after cooking — moved to waste' })).toEqual({
      label: 'Moved to waste',
      tone: 'stone',
      quiet: true,
    });
    expect(movementLabel({ reason: 'waste', deltaQty: -90, notes: 'Refunded after cooking — counted as waste' })).toEqual({
      label: 'Waste',
      tone: 'red',
    });
  });

  it('a cancel that a stock take had already counted is not a stock take', () => {
    const note = 'Cancelled, not made — already in the stock take';
    expect(movementLabel({ reason: 'count', deltaQty: -90, notes: note })).toEqual({ label: 'Already counted', tone: 'stone', quiet: true });
    expect(movementLabel({ reason: 'sale', deltaQty: 90, notes: note }).label).toBe('Already counted');
    expect(movementLabel({ reason: 'count', deltaQty: 90, notes: 'Weekly count' }).label).toBe('Stock take');
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
  // Pakistan time is UTC+5 all year: 05:00 PKT is 00:00 UTC.
  const pkt = (day: number, h: number, m = 0) => new Date(Date.UTC(2026, 8, day, h - 5, m));

  it('"Today" starts at 05:00 Pakistan time (the trading day), not at midnight', () => {
    // 26 Sep, 3:30 pm: today began at 05:00 on the 26th.
    expect(rangeSinceIso('today', pkt(26, 15, 30))).toBe('2026-09-26T00:00:00.000Z');
    // 27 Sep, 2 am: still the 26th's trading day — last night's stock shows under Today.
    expect(rangeSinceIso('today', pkt(27, 2))).toBe('2026-09-26T00:00:00.000Z');
    // 04:59 is the night before; 05:00 starts a new day.
    expect(rangeSinceIso('today', pkt(27, 4, 59))).toBe('2026-09-26T00:00:00.000Z');
    expect(rangeSinceIso('today', pkt(27, 5))).toBe('2026-09-27T00:00:00.000Z');
  });

  it('the last 7 and 30 days are trading days too', () => {
    expect(rangeSinceIso('7d', pkt(26, 15, 30))).toBe('2026-09-20T00:00:00.000Z');
    expect(rangeSinceIso('30d', pkt(26, 15, 30))).toBe('2026-08-28T00:00:00.000Z');
    expect(rangeSinceIso('7d', pkt(27, 2))).toBe('2026-09-20T00:00:00.000Z');
  });

  it('has no start for all time', () => {
    expect(rangeSinceIso('all', pkt(26, 15, 30))).toBeUndefined();
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

describe('movementLabel: waste reasons and batches by their detail', () => {
  it('waste booked by hand says why; "other" and older rows just say Waste', () => {
    expect(movementLabel({ reason: 'waste', deltaQty: -5, notes: null, detail: 'waste:burnt' }).label).toBe('Waste · burnt');
    expect(movementLabel({ reason: 'waste', deltaQty: -5, notes: null, detail: 'waste:staff_meal' }).label).toBe('Waste · staff meal');
    expect(movementLabel({ reason: 'waste', deltaQty: -5, notes: null, detail: 'waste:other' }).label).toBe('Waste');
    expect(movementLabel({ reason: 'waste', deltaQty: -5, notes: null }).label).toBe('Waste');
  });

  it('a batch row is a batch whatever its note says', () => {
    expect(movementLabel({ reason: 'adjustment', deltaQty: 500, notes: 'Made 500 g', detail: 'batch_out' }).label).toBe('Batch');
    expect(movementLabel({ reason: 'adjustment', deltaQty: -5, notes: 'Fixed a typo', detail: 'correction' }).label).toBe('Fix');
  });
});
