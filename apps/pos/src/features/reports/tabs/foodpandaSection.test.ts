/**
 * Reports → Channels → foodpanda: the warning under the figures says the
 * numbers it was worked out with, never a figure typed into the words.
 * Every figure is made up.
 */
import { describe, expect, it } from 'vitest';
import { foodpandaEstimateNote } from './FoodpandaSection';

describe('the foodpanda estimate note', () => {
  it('names the unconfirmed commission the owner typed, not the suggested figure', () => {
    const note = foodpandaEstimateNote({ commissionSuggested: true, unconfirmedCommissionBps: 2_200, estimatedOrders: 4 });
    expect(note).toContain('(22%) is not confirmed yet');
    expect(note).not.toContain('25%');
    expect(note).toContain('4 orders have no confirmed commission kept');
  });

  it('a half percent reads as one; the suggested default reads as its own figure', () => {
    expect(foodpandaEstimateNote({ commissionSuggested: true, unconfirmedCommissionBps: 2_250, estimatedOrders: 1 })).toContain('(22.5%)');
    expect(foodpandaEstimateNote({ commissionSuggested: true, unconfirmedCommissionBps: 2_500, estimatedOrders: 1 })).toContain(
      '1 order has no confirmed commission kept from when it was paid',
    );
  });

  it('with the commission confirmed it only says how many orders were worked out with today’s fees', () => {
    const note = foodpandaEstimateNote({ commissionSuggested: false, unconfirmedCommissionBps: null, estimatedOrders: 2 });
    expect(note).not.toMatch(/not confirmed yet/);
    expect(note).not.toMatch(/\d+%/);
    expect(note).toContain('2 orders');
  });
});
