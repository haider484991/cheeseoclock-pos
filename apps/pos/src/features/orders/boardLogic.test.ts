import { describe, expect, it } from 'vitest';
import type { OrderSnapshot } from '@cheeseoclock/shared-types';
import {
  ageLabel,
  ageMinutes,
  ageTone,
  cardFlags,
  cardItemCount,
  cardLines,
  matchesBoardSearch,
  nextBoardAction,
  parseRupeesToCents,
  quickCashOptions,
} from './boardLogic';

describe('age', () => {
  const now = Date.parse('2026-09-26T15:00:00.000Z');

  it('counts whole minutes since the order', () => {
    expect(ageMinutes('2026-09-26T14:47:30.000Z', now)).toBe(12);
    expect(ageMinutes('2026-09-26T15:00:30.000Z', now)).toBe(0); // clock skew: never negative
    expect(ageMinutes('not a date', now)).toBe(0);
  });

  it('turns amber at 15 minutes and red at 30', () => {
    expect(ageTone(14)).toBe('ok');
    expect(ageTone(15)).toBe('warn');
    expect(ageTone(29)).toBe('warn');
    expect(ageTone(30)).toBe('late');
  });

  it('reads short', () => {
    expect(ageLabel(0)).toBe('just now');
    expect(ageLabel(9)).toBe('9m');
    expect(ageLabel(65)).toBe('1h 05m');
  });
});

describe('next action', () => {
  it('walks the kitchen steps', () => {
    expect(nextBoardAction('sent_to_kitchen', 'takeaway', false).kind).toBe('preparing');
    expect(nextBoardAction('preparing', 'delivery', true).kind).toBe('ready');
  });

  it('a ready delivery gets a rider', () => {
    expect(nextBoardAction('ready', 'delivery', false)).toEqual({ kind: 'assign_rider', label: 'Assign rider' });
  });

  it('an unpaid order never closes without its payment', () => {
    expect(nextBoardAction('ready', 'takeaway', false)).toEqual({ kind: 'hand_over', label: 'Picked up + Pay' });
    expect(nextBoardAction('ready', 'foodpanda', false).kind).toBe('hand_over');
    expect(nextBoardAction('out_for_delivery', 'delivery', false)).toEqual({
      kind: 'hand_over',
      label: 'Delivered + Pay',
    });
  });

  it('a paid order closes in one tap', () => {
    expect(nextBoardAction('ready', 'takeaway', true)).toEqual({ kind: 'served', label: 'Picked up' });
    expect(nextBoardAction('ready', 'foodpanda', true).kind).toBe('served');
    expect(nextBoardAction('out_for_delivery', 'delivery', true)).toEqual({ kind: 'delivered', label: 'Delivered' });
  });

  it('finished orders offer nothing', () => {
    for (const s of ['paid', 'served', 'delivered', 'void', 'refunded'] as const) {
      expect(nextBoardAction(s, 'takeaway', true).kind).toBe('none');
    }
  });
});

type Item = OrderSnapshot['items'][number];
type LineOver = Omit<Partial<Item>, 'id' | 'parentOrderItemId'> & { id?: string; parentOrderItemId?: string | null };
const line = (over: LineOver): Item =>
  ({
    id: 'i',
    menuItemName: 'Fajita Pizza',
    quantity: 1,
    notes: null,
    parentOrderItemId: null,
    modifiers: [],
    ...over,
  }) as Item;
const mod = (modifierName: string) => ({ id: modifierName, modifierName }) as Item['modifiers'][number];

describe('card flags', () => {
  it('shows leave-outs and notes from every line, even hidden ones', () => {
    const items = [
      line({ id: 'a', menuItemName: 'Fries' }),
      line({ id: 'b', menuItemName: 'Burger', modifiers: [mod('Extra cheese'), mod('No onion')] }),
      line({ id: 'c', menuItemName: 'Wings' }),
      line({ id: 'd', menuItemName: 'Pizza', notes: ' Nut allergy ' }),
    ];
    expect(cardFlags({ items })).toEqual(['NO ONION (Burger)', 'Nut allergy (Pizza)']);
  });

  it('nothing to flag', () => {
    expect(cardFlags({ items: [line({ notes: '  ' })] })).toEqual([]);
  });
});

describe('card lines', () => {
  it('lists and counts deal parts once, under their deal', () => {
    const items = [
      line({ id: 'deal', quantity: 2 }),
      line({ id: 'part', parentOrderItemId: 'deal', quantity: 2 }),
      line({ id: 'fries', quantity: 1 }),
    ];
    expect(cardLines(items).map((i) => i.id)).toEqual(['deal', 'fries']);
    expect(cardItemCount(items)).toBe(3);
  });
});

describe('cash helpers', () => {
  it('offers the exact bill and the notes people hand over', () => {
    expect(quickCashOptions(185_000)).toEqual([185_000, 190_000, 200_000, 500_000]);
    expect(quickCashOptions(200_000)).toEqual([200_000, 500_000]);
    expect(quickCashOptions(0)).toEqual([]);
  });

  it('reads rupees typed with commas', () => {
    expect(parseRupeesToCents('2,000')).toBe(200_000);
    expect(parseRupeesToCents(' 1850.5 ')).toBe(185_050);
    expect(parseRupeesToCents('Rs 500')).toBe(50_000);
    expect(parseRupeesToCents('')).toBeNaN();
    expect(parseRupeesToCents('12abc')).toBeNaN();
    expect(parseRupeesToCents('-5')).toBeNaN();
  });
});

describe('board search', () => {
  const snap = {
    order: { orderNumber: '20260926-0042' },
    customerName: 'Ali Khan',
    customerPhone: '0300-1234567',
    rider: { name: 'Bilal' },
  } as Parameters<typeof matchesBoardSearch>[0];

  it('finds by order number', () => {
    expect(matchesBoardSearch(snap, '42')).toBe(true);
    expect(matchesBoardSearch(snap, '#0042')).toBe(true);
    expect(matchesBoardSearch(snap, '4')).toBe(false);
  });

  it('finds by name, rider or phone', () => {
    expect(matchesBoardSearch(snap, 'ali')).toBe(true);
    expect(matchesBoardSearch(snap, 'bilal')).toBe(true);
    expect(matchesBoardSearch(snap, '03001234567')).toBe(true);
    expect(matchesBoardSearch(snap, '1234567')).toBe(true);
    expect(matchesBoardSearch(snap, 'sara')).toBe(false);
  });

  it('empty search shows everything', () => {
    expect(matchesBoardSearch(snap, '  ')).toBe(true);
  });
});
