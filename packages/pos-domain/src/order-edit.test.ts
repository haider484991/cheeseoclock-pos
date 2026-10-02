import { describe, expect, it } from 'vitest';
import {
  diffOrderLines,
  editChangesNothing,
  editNeeds,
  EDITABLE_STATUSES,
  orderEditBlock,
  ORDER_EDIT_REFUSED,
  type EditableLine,
} from './order-edit.js';
import { discountRuleScope, freeOrderRule, isFreeOrderRule, parseDiscountBaseRule, tillDiscountRule } from './discount-base.js';
import type { OrderStatus } from '@cheeseoclock/shared-types';

const line = (id: string, name: string, quantity: number, mods: string[] = [], notes: string | null = null): EditableLine => ({
  id,
  menuItemName: name,
  quantity,
  modifiers: mods.map((m) => ({ modifierName: m })),
  notes,
});

describe('orderEditBlock', () => {
  const base = { status: 'sent_to_kitchen' as OrderStatus, paidAt: null, mode: 'delivery' as const, riderKeepsCents: null };

  it('lets the kitchen states through while unpaid and not out', () => {
    for (const status of EDITABLE_STATUSES) expect(orderEditBlock({ ...base, status })).toBeNull();
    expect(orderEditBlock({ ...base, mode: 'takeaway', status: 'ready' })).toBeNull();
    // An order from before 0049 has no riderKeepsCents at all.
    expect(orderEditBlock({ status: 'preparing', paidAt: null, mode: 'delivery' })).toBeNull();
  });

  it('says why not, in the order a cashier would ask', () => {
    expect(orderEditBlock({ ...base, status: 'open' })).toBe('not_sent');
    expect(orderEditBlock({ ...base, paidAt: '2026-10-03T10:00:00.000Z' })).toBe('paid');
    expect(orderEditBlock({ ...base, status: 'out_for_delivery' })).toBe('out');
    // Sent out with an outside rider and brought back to Ready keeps nothing; a frozen keep (even 0) is out.
    expect(orderEditBlock({ ...base, status: 'ready', riderKeepsCents: 0 })).toBe('out');
    for (const status of ['delivered', 'served', 'paid', 'void', 'refunded'] as OrderStatus[]) {
      expect(orderEditBlock({ ...base, status })).toBe('closed');
    }
    expect(orderEditBlock({ ...base, mode: 'foodpanda' })).toBe('foodpanda');
    // Paid wins over out: Refund is the way either way, the words say paid.
    expect(orderEditBlock({ ...base, status: 'out_for_delivery', paidAt: '2026-10-03T10:00:00.000Z' })).toBe('paid');
  });

  it('has words for every refusal', () => {
    for (const k of ['not_sent', 'paid', 'out', 'closed', 'foodpanda'] as const) expect(ORDER_EDIT_REFUSED[k].length).toBeGreaterThan(10);
  });
});

describe('diffOrderLines', () => {
  it('adds new lines whole and the extra of a line that went up', () => {
    const before = [line('a', 'Fajita Pizza — Large 12"', 1), line('b', 'Soft Drink — 1 litre', 1)];
    const after = [line('a', 'Fajita Pizza — Large 12"', 1), line('b', 'Soft Drink — 1 litre', 3), line('c', 'Fries', 2, ['Large'])];
    const d = diffOrderLines(before, after);
    expect(d.removed).toEqual([]);
    expect(d.added.map((l) => [l.lineId, l.quantity])).toEqual([
      ['b', 2],
      ['c', 2],
    ]);
    expect(d.added[1]!.modifiers).toEqual(['Large']);
  });

  it('removes lines gone and the difference of a line that went down', () => {
    const before = [line('a', 'Cheetos — Large 12"', 2), line('b', 'Nuggets', 1)];
    const after = [line('a', 'Cheetos — Large 12"', 1)];
    const d = diffOrderLines(before, after);
    expect(d.added).toEqual([]);
    expect(d.removed.map((l) => [l.lineId, l.quantity])).toEqual([
      ['a', 1],
      ['b', 1],
    ]);
  });

  it('reads a line whose choices or note changed as taken off and added again', () => {
    const before = [line('a', 'Crown Crust — Large 12"', 1, ['Ranch'])];
    const after = [line('a', 'Crown Crust — Large 12"', 1, ['Garlic Mayo'], 'no onion')];
    const d = diffOrderLines(before, after);
    expect(d.removed.map((l) => [l.lineId, l.quantity, l.modifiers])).toEqual([['a', 1, ['Ranch']]]);
    expect(d.added.map((l) => [l.lineId, l.quantity, l.modifiers, l.notes])).toEqual([['a', 1, ['Garlic Mayo'], 'no onion']]);
  });

  it('marks the delivery charge as a fee', () => {
    const d = diffOrderLines([line('f', 'Delivery Charge (Rs 200)', 1)], []);
    expect(d.removed[0]!.fee).toBe(true);
    expect(diffOrderLines([], [line('p', 'Fajita Pizza — Medium 9"', 1)]).added[0]!.fee).toBe(false);
  });

  it('changes nothing when nothing changed', () => {
    const lines = [line('a', 'Fries', 1)];
    const d = diffOrderLines(lines, lines.map((l) => ({ ...l })));
    expect(editChangesNothing({ ...d, discountChanged: false })).toBe(true);
    expect(editChangesNothing({ ...d, discountChanged: true })).toBe(false);
  });
});

describe('editNeeds', () => {
  const food = { lineId: 'a', menuItemName: 'Fries', quantity: 1, modifiers: [], notes: null, fee: false };
  const fee = { ...food, lineId: 'f', menuItemName: 'Delivery Charge (Rs 200)', fee: true };

  it('asks nothing for adding only', () => {
    expect(editNeeds({ removed: [], freeOrder: false }, false)).toEqual({ pin: false, why: [], reason: false });
  });

  it('asks a PIN and a reason when something the kitchen has comes off', () => {
    const n = editNeeds({ removed: [food], freeOrder: false }, false);
    expect(n.pin).toBe(true);
    expect(n.reason).toBe(true);
    expect(n.why).toEqual(['An item the kitchen has comes off']);
    expect(editNeeds({ removed: [food, { ...food, lineId: 'b' }], freeOrder: false }, false).why).toEqual(['Items the kitchen has come off']);
    expect(editNeeds({ removed: [fee], freeOrder: false }, false).why).toEqual(['The delivery charge comes off']);
  });

  it('asks a PIN for a discount over the limit, and a PIN and reason for a Free order', () => {
    expect(editNeeds({ removed: [], freeOrder: false }, true)).toEqual({ pin: true, why: ['The discount is over the limit'], reason: false });
    expect(editNeeds({ removed: [], freeOrder: true }, true)).toEqual({ pin: true, why: ['A Free order'], reason: true });
  });
});

describe('Free order rule', () => {
  it('covers every line, the delivery charge and the value deals', () => {
    const rule = freeOrderRule();
    expect(rule).toEqual({ kind: 'discount_base', v: 1, alsoOffDeliveryCharge: true, from: 'till', freeOrder: true });
    expect(discountRuleScope(JSON.stringify(rule))).toEqual({ alsoOffDeliveryCharge: true, skipsNoDiscountLines: false });
  });

  it('is told apart from any other rule, and survives a round trip', () => {
    expect(isFreeOrderRule(JSON.stringify(freeOrderRule()))).toBe(true);
    expect(isFreeOrderRule(JSON.stringify(tillDiscountRule(true, false)))).toBe(false);
    expect(isFreeOrderRule(null)).toBe(false);
    expect(parseDiscountBaseRule(JSON.stringify(freeOrderRule()))?.freeOrder).toBe(true);
    // Only exactly true, and never the website's.
    expect(isFreeOrderRule(JSON.stringify({ ...tillDiscountRule(true, false), freeOrder: 'yes' }))).toBe(false);
    expect(isFreeOrderRule(JSON.stringify({ ...tillDiscountRule(true, false), from: 'website', freeOrder: true }))).toBe(false);
  });

  it('leaves the JSON of every other rule as it was', () => {
    expect(JSON.stringify(parseDiscountBaseRule(JSON.stringify(tillDiscountRule(false, true))))).toBe(
      JSON.stringify(tillDiscountRule(false, true)),
    );
  });
});
