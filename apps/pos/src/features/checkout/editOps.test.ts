/**
 * Edit order's changes kept short as the cashier taps (editOps.ts): a line
 * added in the edit carries its own quantity and choices, a line the kitchen
 * has gets one change, the discount one change. Every id is made up.
 */
import { describe, expect, it } from 'vitest';
import type { OrderEditOp, OrderSnapshot } from '@cheeseoclock/shared-types';
import { appendEditOp, isAddedLine, opLine, withoutLine } from './editOps';

const base = (discounts = 0) =>
  ({
    items: [
      { id: 'k1', quantity: 2 },
      { id: 'k2', quantity: 1 },
    ],
    discounts: Array.from({ length: discounts }, () => ({})),
  }) as unknown as Pick<OrderSnapshot, 'items' | 'discounts'>;

const add = (lineId: string, quantity = 1): OrderEditOp => ({ op: 'add', lineId, menuItemId: 'm1', quantity, modifierIds: [], notes: null });
const fold = (ops: OrderEditOp[], b = base()) => ops.reduce<OrderEditOp[]>((acc, op) => appendEditOp(acc, op, b), []);

describe('a line added in this edit', () => {
  it('carries its own quantity and choices; taken off, it is gone', () => {
    const ops = fold([
      add('n1'),
      { op: 'qty', orderItemId: 'n1', quantity: 3 },
      { op: 'options', orderItemId: 'n1', modifierIds: ['c1'], notes: 'well done' },
    ]);
    expect(ops).toEqual([{ op: 'add', lineId: 'n1', menuItemId: 'm1', quantity: 3, modifierIds: ['c1'], notes: 'well done' }]);
    expect(isAddedLine(ops, 'n1')).toBe(true);
    expect(isAddedLine(ops, 'k1')).toBe(false);
    expect(appendEditOp(ops, { op: 'remove', orderItemId: 'n1' }, base())).toEqual([]);
    expect(appendEditOp(ops, { op: 'qty', orderItemId: 'n1', quantity: 0 }, base())).toEqual([]);
  });
});

describe('a line the kitchen has', () => {
  it('gets one change: the latest quantity, none when it is back to what it was, or remove', () => {
    expect(fold([{ op: 'qty', orderItemId: 'k1', quantity: 3 }, { op: 'qty', orderItemId: 'k1', quantity: 4 }])).toEqual([
      { op: 'qty', orderItemId: 'k1', quantity: 4 },
    ]);
    expect(fold([{ op: 'qty', orderItemId: 'k1', quantity: 1 }, { op: 'qty', orderItemId: 'k1', quantity: 2 }])).toEqual([]);
    expect(fold([{ op: 'qty', orderItemId: 'k1', quantity: 1 }, { op: 'qty', orderItemId: 'k1', quantity: 0 }])).toEqual([
      { op: 'remove', orderItemId: 'k1' },
    ]);
    expect(fold([{ op: 'qty', orderItemId: 'k2', quantity: 2 }, { op: 'remove', orderItemId: 'k2' }])).toEqual([{ op: 'remove', orderItemId: 'k2' }]);
  });

  it('a Customize on it is sent as it is (the till refuses it in its own words)', () => {
    const op: OrderEditOp = { op: 'options', orderItemId: 'k1', modifierIds: [], notes: null };
    expect(fold([op])).toEqual([op]);
  });
});

describe('the discount', () => {
  it('one change, the latest; taking off a discount the order never had is nothing', () => {
    const ten: OrderEditOp = { op: 'discount', discountType: 'percent', value: 10, reason: 'Forgot' };
    const free: OrderEditOp = { op: 'discount', discountType: 'percent', value: 100, reason: 'Staff meal', free: true };
    expect(fold([ten, add('n1'), free])).toEqual([add('n1'), free]);
    expect(fold([ten, { op: 'clearDiscount' }])).toEqual([]);
    expect(fold([ten, { op: 'clearDiscount' }], base(1))).toEqual([{ op: 'clearDiscount' }]);
  });
});

describe('undo one line', () => {
  it('drops everything the edit did to it, and nothing else', () => {
    const ops = fold([add('n1'), { op: 'qty', orderItemId: 'k1', quantity: 5 }, { op: 'remove', orderItemId: 'k2' }]);
    expect(withoutLine(ops, 'k1').map(opLine)).toEqual(['n1', 'k2']);
    expect(withoutLine(ops, 'n1').map(opLine)).toEqual(['k1', 'k2']);
  });
});
