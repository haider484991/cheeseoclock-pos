/**
 * Edit order (v0.7.36): change an order the kitchen already has — the owner,
 * 2 Oct 2026: "same number, ADDED / REMOVED kitchen slips, bill reprint; add
 * = any cashier, remove = manager PIN", "Was the food made?" for that item
 * only, never once the bill is with the rider or the order is paid; the user,
 * 3 Oct 2026: a discount forgotten at the counter goes on until the order is
 * paid, and a Free order.
 *
 * An edit is a list of changes (shared-types OrderEditOp) made on the screen:
 *  - previewOrderEdit replays them through the repositories' own writes
 *    ({ editing: true }) inside ONE transaction that is then rolled back:
 *    the screen sees the order exactly as Save would leave it, and nothing is
 *    written, synced or audited (writeAudit reads the chain head from the
 *    database, so a rolled-back row leaves no trace);
 *  - saveOrderEdit replays the same changes for real in one transaction,
 *    only while the order's lines and discount are still what the edit was
 *    worked on (editKey), then: the stock (more taken for what was added,
 *    what was taken off put back or booked as waste, item by item), the cost
 *    kept with the changed lines, a Free order with nothing to pay completed,
 *    and one 'order_edit' audit row with what changed and who allowed it.
 * The kitchen's ADDED / REMOVED slip prints after the commit (the handler).
 */
import { createHash } from 'node:crypto';
import type { AppDatabase } from '../connection.js';
import type { Actor } from './base.js';
import { writeAudit } from './audit-repo.js';
import {
  addOrderItem,
  applyDiscount,
  clearDiscount,
  completeFreeOrder,
  findOrder,
  getOrderSnapshot,
  removeOrderItem,
  updateOrderItemOptions,
  updateOrderItemQuantity,
} from './order-repo.js';
import { ingredientTakesOf, readOrderStockLines, recostLines, takeStockForEdit } from './stock-movement-repo.js';
import { settleOrderStock } from './order-stock-repo.js';
import { readApprovalLimits, readDiscountAlsoOffDeliveryCharge } from '../business-settings-read.js';
import {
  diffOrderLines,
  discountBaseCents,
  discountReasonMissing,
  editChangesNothing,
  editNeeds,
  orderEditBlock,
  ORDER_EDIT_REFUSED,
  requiresManagerApproval,
} from '@cheeseoclock/pos-domain';
import {
  isDeliveryChargeLine,
  type FoodMade,
  type OrderEditDiff,
  type OrderEditNeeds,
  type OrderEditOp,
  type OrderEditPreview,
  type OrderSnapshot,
} from '@cheeseoclock/shared-types';

/** Save after the order changed under the edit (another till, a payment, a cancel). */
export const EDIT_STALE = 'This order changed while you were editing it. Close the edit and start it again.';
/** An edit that would leave no food: that is a cancel. */
export const EDIT_LEAVES_NOTHING = 'That would take everything off. To stop the whole order, cancel it on Live Orders.';
/** Save with nothing changed. */
export const EDIT_CHANGES_NOTHING = 'Nothing has changed on this order.';
/** Customize, in an edit, is for a line added in it. */
export const EDIT_OPTIONS_NEW_ONLY =
  'Only an item added in this edit can be changed here. Take the item off and add it again with its new choices.';
/** Save asked for a PIN it did not get. */
export function editNeedsPinWords(why: readonly string[]): string {
  return `${why.join('. ')} — a manager's PIN or password is needed.`;
}
/** …or a reason. */
export const EDIT_NEEDS_REASON = 'Say why (for example: customer changed order).';

/** What an edit is worked on: the order's lines and its discount, not its status. */
export function editKey(snap: OrderSnapshot): string {
  const lines = snap.items.map((i) => [i.id, i.quantity, i.lineTotalCents, i.modifiers.map((m) => m.modifierName), i.notes ?? null]);
  const discounts = snap.discounts.map((d) => [d.id, d.discountType, d.value, d.amountCents, d.reason ?? null]);
  return createHash('sha256')
    .update(JSON.stringify({ lines, discounts, total: snap.order.totalCents }))
    .digest('hex')
    .slice(0, 40);
}

/** The terms of the order's discount as staff set them (not what it comes to on today's lines). */
function discountTerms(snap: OrderSnapshot): string {
  const d = snap.discounts[snap.discounts.length - 1];
  return d ? JSON.stringify([d.source ?? null, d.discountType, d.value, d.reason ?? null, d.freeOrder === true, d.offer?.declined === true]) : 'none';
}

function isFree(snap: OrderSnapshot): boolean {
  return snap.discounts.some((d) => d.freeOrder === true);
}

/** The order the edit is for, refused in its own words when it can't be changed now. */
function editableOrder(db: AppDatabase, orderId: string): OrderSnapshot {
  const order = findOrder(db, orderId);
  if (!order) throw new Error('Order not found');
  const block = orderEditBlock(order);
  if (block) throw new Error(ORDER_EDIT_REFUSED[block]);
  const snap = getOrderSnapshot(db, orderId);
  if (!snap) throw new Error('Order not found');
  return snap;
}

/**
 * The changes, through the repositories' own writes in edit mode, in order.
 * `approverUserId`: the manager who allowed the edit (Save), passed to a
 * discount that needs one; the preview passes the signed-in login's (its
 * rows are rolled back) so a discount over the limit can be shown first.
 */
function replay(
  db: AppDatabase,
  orderId: string,
  ops: ReadonlyArray<OrderEditOp>,
  actor: Actor & { userId: string },
  approverUserId: string | null,
): void {
  const added = new Set<string>();
  const editing = { editing: true } as const;
  for (const op of ops) {
    switch (op.op) {
      case 'add':
        addOrderItem(
          db,
          { orderId, menuItemId: op.menuItemId, quantity: op.quantity, modifierIds: op.modifierIds, notes: op.notes ?? null, itemId: op.lineId },
          actor,
          editing,
        );
        added.add(op.lineId);
        break;
      case 'qty':
        updateOrderItemQuantity(db, orderId, op.orderItemId, op.quantity, actor, editing);
        break;
      case 'remove':
        removeOrderItem(db, orderId, op.orderItemId, actor, editing);
        break;
      case 'options':
        if (!added.has(op.orderItemId)) throw new Error(EDIT_OPTIONS_NEW_ONLY);
        updateOrderItemOptions(db, { orderId, orderItemId: op.orderItemId, modifierIds: op.modifierIds, notes: op.notes }, actor, editing);
        break;
      case 'discount':
        applyDiscount(
          db,
          {
            orderId,
            discountType: op.discountType,
            value: op.value,
            reason: op.reason ?? null,
            approverUserId,
            ...(op.free === true ? { free: true } : {}),
          },
          actor,
          editing,
        );
        break;
      case 'clearDiscount':
        clearDiscount(db, orderId, actor, { ...editing, approverUserId });
        break;
    }
  }
}

/**
 * The staff discount the edit leaves on the order is over the signed-in
 * login's limit (Settings → Money & discounts), worked on the order's lines
 * as they are after the edit, as the F3 screen does. Only when the edit gave
 * or changed it; a Free order always needs a manager (editNeeds says so).
 */
function discountOverLimit(db: AppDatabase, ops: ReadonlyArray<OrderEditOp>, after: OrderSnapshot): boolean {
  let last: Extract<OrderEditOp, { op: 'discount' | 'clearDiscount' }> | null = null;
  for (const op of ops) if (op.op === 'discount' || op.op === 'clearDiscount') last = op;
  if (!last || last.op !== 'discount' || last.free === true) return false;
  const base = discountBaseCents(after.items, {
    alsoOffDeliveryCharge: readDiscountAlsoOffDeliveryCharge(db),
    skipsNoDiscountLines: after.order.mode !== 'foodpanda',
  });
  return requiresManagerApproval({ type: last.discountType, value: last.value }, base, readApprovalLimits(db));
}

function diffOf(db: AppDatabase, ops: ReadonlyArray<OrderEditOp>, before: OrderSnapshot, after: OrderSnapshot): { diff: OrderEditDiff; needs: OrderEditNeeds } {
  const lines = diffOrderLines(before.items, after.items);
  const diff: OrderEditDiff = {
    ...lines,
    discountChanged: discountTerms(before) !== discountTerms(after),
    freeOrder: isFree(after) && !isFree(before),
    totalBeforeCents: before.order.totalCents,
    totalAfterCents: after.order.totalCents,
  };
  return { diff, needs: editNeeds(diff, discountOverLimit(db, ops, after)) };
}

/** The edit must leave food on the order: taking everything off is a cancel. */
function assertLeavesFood(after: OrderSnapshot): void {
  if (!after.items.some((i) => !isDeliveryChargeLine(i))) throw new Error(EDIT_LEAVES_NOTHING);
}

/** Thrown to roll the preview's transaction back, carrying what it saw. */
class PreviewDone extends Error {
  constructor(readonly preview: OrderEditPreview) {
    super('preview');
  }
}

/**
 * The order the kitchen has, as `ops` would leave it (orders:previewEdit).
 * Nothing is written: the changes run inside a transaction that is rolled
 * back. With no changes: the order as it is (an edit's start). Refused for an
 * order that can't be changed now, and for a change the till would refuse
 * at Save, in the same words.
 */
export function previewOrderEdit(
  db: AppDatabase,
  input: { orderId: string; ops: ReadonlyArray<OrderEditOp> },
  actor: Actor & { userId: string },
): OrderEditPreview {
  const before = editableOrder(db, input.orderId);
  const baseKey = editKey(before);
  if (input.ops.length === 0) {
    const { diff, needs } = diffOf(db, [], before, before);
    return { snapshot: before, diff, needs, baseKey };
  }
  try {
    db.transaction(() => {
      replay(db, input.orderId, input.ops, actor, actor.userId);
      const after = getOrderSnapshot(db, input.orderId);
      if (!after) throw new Error('Order not found');
      assertLeavesFood(after);
      const { diff, needs } = diffOf(db, input.ops, before, after);
      throw new PreviewDone({ snapshot: after, diff, needs, baseKey });
    })();
  } catch (e) {
    if (e instanceof PreviewDone) return e.preview;
    throw e;
  }
  throw new Error('The edit could not be worked out');
}

export interface SaveOrderEditInput {
  orderId: string;
  baseKey: string;
  ops: ReadonlyArray<OrderEditOp>;
  /** The manager who allowed it (the handler checked the PIN), or null. */
  approverUserId: string | null;
  reason?: string | null;
  foodMade?: Readonly<Record<string, FoodMade>>;
}

export interface SavedOrderEdit {
  snapshot: OrderSnapshot;
  diff: OrderEditDiff;
  needs: OrderEditNeeds;
  /** A Free order with nothing to pay was completed (paid at Rs 0): the handler queues its FBR invoice. */
  completedFree: boolean;
}

/**
 * Save an edit (orders:saveEdit), in ONE transaction: the order must still be
 * one an edit may change and still be what the edit was worked on (else
 * EDIT_STALE); the changes are made; a manager (`approverUserId`) and a reason
 * are required when the edit needs them (editNeeds), and "Was the food made?"
 * for each item the kitchen had that goes down or comes off while the order
 * still holds its stock. Then the stock — taken off first for what came off
 * (settleOrderStock 'edited', that item's share only), then taken for what was
 * added (takeStockForEdit) — the cost kept with lines that went down, a Free
 * order with nothing left to pay completed (completeFreeOrder), and one
 * 'order_edit' audit row.
 */
export function saveOrderEdit(db: AppDatabase, input: SaveOrderEditInput, actor: Actor & { userId: string }): SavedOrderEdit {
  let saved!: SavedOrderEdit;
  db.transaction(() => {
    const before = editableOrder(db, input.orderId);
    if (editKey(before) !== input.baseKey) throw new Error(EDIT_STALE);
    // What Save asks for, worked out first (the preview, rolled back): a
    // missing PIN or reason is refused in the edit's own words, before any
    // repository would refuse a step in its own.
    const asked = previewOrderEdit(db, { orderId: input.orderId, ops: input.ops }, actor);
    if (editChangesNothing(asked.diff)) throw new Error(EDIT_CHANGES_NOTHING);
    if (asked.needs.pin && !input.approverUserId) throw new Error(editNeedsPinWords(asked.needs.why));
    if (asked.needs.reason && discountReasonMissing(input.reason)) throw new Error(EDIT_NEEDS_REASON);
    // The lines as they were, with their picks: an item taken off is settled by what IT took.
    const stockLines = new Map(readOrderStockLines(db, input.orderId).map((l) => [l.id, l]));

    replay(db, input.orderId, input.ops, actor, input.approverUserId);
    let after = getOrderSnapshot(db, input.orderId);
    if (!after) throw new Error('Order not found');
    assertLeavesFood(after);
    const { diff, needs } = diffOf(db, input.ops, before, after);
    if (editChangesNothing(diff)) throw new Error(EDIT_CHANGES_NOTHING);
    if (needs.pin && !input.approverUserId) throw new Error(editNeedsPinWords(needs.why));
    if (needs.reason && discountReasonMissing(input.reason)) throw new Error(EDIT_NEEDS_REASON);

    // What came off: each item settled on its own answer, by what it took.
    for (const off of diff.removed) {
      if (off.fee) continue;
      const line = stockLines.get(off.lineId);
      if (!line) continue;
      const limitTo = ingredientTakesOf(db, [{ line, quantity: off.quantity }]);
      if (limitTo.size === 0) continue;
      const foodMade = input.foodMade?.[off.lineId];
      settleOrderStock(
        db,
        {
          orderId: input.orderId,
          how: 'edited',
          statusBefore: before.order.status,
          ...(foodMade ? { foodMade } : {}),
          approverUserId: input.approverUserId,
          limitTo,
        },
        actor,
      );
    }
    // What was added: taken off stock now (all of the order, if it took none yet).
    const added = diff.added.filter((l) => !l.fee).map((l) => ({ lineId: l.lineId, quantity: l.quantity }));
    if (added.length > 0) takeStockForEdit(db, input.orderId, added, actor);
    // A line still on the order that went down keeps the cost of what is left.
    const live = new Set<string>(after.items.map((i) => i.id as string));
    const wentDown = [...new Set(diff.removed.filter((l) => !l.fee && live.has(l.lineId)).map((l) => l.lineId))];
    if (wentDown.length > 0) {
      try {
        db.transaction(() => recostLines(db, input.orderId, wentDown, actor))();
      } catch {
        // The cost kept with a sale never blocks it (as at Send).
      }
    }

    // A Free order with nothing to pay: paid now, at Rs 0 (it is then prepaid).
    let completedFree = false;
    if (diff.freeOrder || (isFree(after) && after.order.paidAt === null && after.order.totalCents === 0)) {
      if (after.order.totalCents === 0 && after.order.paidAt === null) {
        completeFreeOrder(db, input.orderId, actor);
        completedFree = true;
      }
    }
    after = getOrderSnapshot(db, input.orderId) ?? after;

    writeAudit(db, {
      entityType: 'orders',
      entityId: input.orderId,
      action: 'order_edit',
      actorUserId: actor.userId,
      before: {
        status: before.order.status,
        subtotalCents: before.order.subtotalCents,
        discountCents: before.order.discountCents,
        taxCents: before.order.taxCents,
        totalCents: before.order.totalCents,
      },
      after: {
        added: diff.added,
        removed: diff.removed,
        discountChanged: diff.discountChanged,
        freeOrder: diff.freeOrder,
        completedFree,
        reason: input.reason?.trim() || null,
        approverUserId: input.approverUserId,
        foodMade: input.foodMade ?? null,
        subtotalCents: after.order.subtotalCents,
        discountCents: after.order.discountCents,
        taxCents: after.order.taxCents,
        totalCents: after.order.totalCents,
      },
    });
    saved = { snapshot: after, diff, needs, completedFree };
  })();
  return saved;
}
