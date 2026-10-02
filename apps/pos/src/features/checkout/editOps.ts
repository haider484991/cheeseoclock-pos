import type { OrderEditOp, OrderSnapshot } from '@cheeseoclock/shared-types';

/**
 * Edit order (v0.7.36): the changes an edit sends the till, kept short as
 * the cashier taps — the till replays them in order on the order as the
 * kitchen has it (orders:previewEdit, then orders:saveEdit). Pure, so it is
 * tested on its own.
 *
 *  - A line added in this edit carries its own quantity, choices and note
 *    (its 'add'): one more, one less or Customize change that 'add', and
 *    taking it off drops it — the kitchen never hears of it.
 *  - A line the kitchen has gets at most one change: the latest quantity
 *    ('qty'; none when it is back to what it was) or 'remove'.
 *  - One discount change: the latest (none when the order had no discount
 *    and it is taken off again).
 */

type Op = OrderEditOp;
type AddOp = Extract<Op, { op: 'add' }>;
type Base = Pick<OrderSnapshot, 'items' | 'discounts'>;

/** The line a change is about; null for the discount. */
export function opLine(op: Op): string | null {
  switch (op.op) {
    case 'add':
      return op.lineId;
    case 'qty':
    case 'remove':
    case 'options':
      return op.orderItemId;
    default:
      return null;
  }
}

/** A line the kitchen does not have yet: added in this edit. */
export function isAddedLine(ops: readonly Op[], lineId: string): boolean {
  return ops.some((o) => o.op === 'add' && o.lineId === lineId);
}

/** The edit's changes with one more tap folded in (see above). `base`: the order as the kitchen has it. */
export function appendEditOp(ops: readonly Op[], op: Op, base: Base): Op[] {
  const at = (lineId: string) => ops.findIndex((o) => o.op === 'add' && o.lineId === lineId);
  const notQtyOf = (lineId: string) => (o: Op) => !((o.op === 'qty' || o.op === 'remove') && o.orderItemId === lineId);
  switch (op.op) {
    case 'add':
      return [...ops, op];
    case 'qty': {
      const i = at(op.orderItemId);
      if (i >= 0) {
        if (op.quantity <= 0) return withoutLine(ops, op.orderItemId);
        return ops.map((o, k) => (k === i ? { ...(o as AddOp), quantity: op.quantity } : o));
      }
      const rest = ops.filter(notQtyOf(op.orderItemId));
      if (op.quantity <= 0) return [...rest, { op: 'remove', orderItemId: op.orderItemId }];
      const was = base.items.find((l) => l.id === op.orderItemId)?.quantity;
      return was === op.quantity ? rest : [...rest, op];
    }
    case 'remove':
      if (at(op.orderItemId) >= 0) return withoutLine(ops, op.orderItemId);
      return [...ops.filter(notQtyOf(op.orderItemId)), op];
    case 'options': {
      const i = at(op.orderItemId);
      // A line the kitchen has: sent as it is, and the till says no in its own words.
      if (i < 0) return [...ops, op];
      return ops.map((o, k) => (k === i ? { ...(o as AddOp), modifierIds: op.modifierIds, notes: op.notes } : o));
    }
    case 'discount':
    case 'clearDiscount': {
      const rest = ops.filter((o) => o.op !== 'discount' && o.op !== 'clearDiscount');
      if (op.op === 'clearDiscount' && base.discounts.length === 0) return rest;
      return [...rest, op];
    }
  }
}

/** Everything this edit did to one line undone: a line it added is gone, a line the kitchen has is as it was. */
export function withoutLine(ops: readonly Op[], lineId: string): Op[] {
  return ops.filter((o) => opLine(o) !== lineId);
}
