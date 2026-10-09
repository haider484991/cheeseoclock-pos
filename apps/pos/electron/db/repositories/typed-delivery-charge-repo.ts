import type { AppDatabase } from '../connection.js';
import type { Actor } from './base.js';
import { writeAudit } from './audit-repo.js';
import { addOrderItem, deliveryChargeLinesOf, findOrder, removeOrderItem } from './order-repo.js';
import { deliveryChargeItemForTypedFee } from './delivery-zones-repo.js';
import { DELIVERY_FEE_MAX_CENTS } from '@cheeseoclock/shared-types';

/**
 * orders:setDeliveryCharge — a delivery charge the cashier types on the
 * customer panel ("Custom charge"; owner, 10 Oct 2026: "i want custom
 * delivery charges entering option too so if we want to add custom delivery
 * fees"): a customer outside the areas, a long way, a special price.
 *
 * On an OPEN counter delivery, in ONE transaction: every delivery charge
 * line comes off and one "Delivery Charge (Rs N)" at the typed fee goes on —
 * the shop's own item at that fee, else one made switched off
 * (delivery-zones-repo deliveryChargeItemForTypedFee). Each line change is
 * synced and audited (addOrderItem / removeOrderItem), and the event is
 * audited on the order (TYPED_DELIVERY_CHARGE_ACTION — never the area's
 * record, so the area's own rule reads it as a charge put on by hand: it
 * stays while the area stays the same; a new area swaps it for that area's
 * charge; "Put it back" puts the area's back). It is a charge like any
 * other everywhere after: never discounted unless the owner says so, its
 * tax the charges' (Settings → Tax on the delivery charge), the outside
 * rider's at Send out. Never a website order (it arrives with the fee the
 * customer paid) or a foodpanda one (foodpanda delivers it).
 */
export const TYPED_DELIVERY_CHARGE_ACTION = 'delivery_charge_typed';

export function setTypedDeliveryCharge(
  db: AppDatabase,
  orderId: string,
  feeCents: number,
  actor: Actor & { userId: string },
): { itemId: string | null; removed: number; added: boolean } {
  let out: { itemId: string | null; removed: number; added: boolean } = { itemId: null, removed: 0, added: false };
  const tx = db.transaction(() => {
    const order = findOrder(db, orderId);
    if (!order) throw new Error('Order not found');
    if (order.status !== 'open') throw new Error('Only an order still being taken can change its delivery charge');
    if (order.source !== 'pos') throw new Error('A website order keeps the delivery charge the customer paid');
    if (order.mode === 'foodpanda') throw new Error('A foodpanda order never carries the shop’s delivery charge');
    if (order.mode !== 'delivery') throw new Error('Only a delivery order has a delivery charge');
    if (!Number.isInteger(feeCents) || feeCents < 100 || feeCents > DELIVERY_FEE_MAX_CENTS || feeCents % 100 !== 0) {
      throw new Error(
        `A delivery charge is in whole rupees, Rs 1 to Rs ${(DELIVERY_FEE_MAX_CENTS / 100).toLocaleString('en-PK')}`,
      );
    }
    const lines = deliveryChargeLinesOf(db, orderId);
    // Already exactly that: one charge, once, at the typed fee — nothing to write.
    const only = lines.length === 1 ? lines[0] : undefined;
    if (only && only.unitPriceCents === feeCents && only.quantity === 1) {
      out = { itemId: only.menuItemId, removed: 0, added: false };
      return;
    }
    const itemId = deliveryChargeItemForTypedFee(db, feeCents, actor);
    for (const l of lines) removeOrderItem(db, orderId, l.id, actor);
    addOrderItem(
      db,
      { orderId, menuItemId: itemId, quantity: 1, modifierIds: [], allowSwitchedOffDeliveryCharge: true },
      actor,
    );
    writeAudit(db, {
      entityType: 'orders',
      entityId: orderId,
      action: TYPED_DELIVERY_CHARGE_ACTION,
      actorUserId: actor.userId,
      before: { charges: lines.map((l) => ({ unitPriceCents: l.unitPriceCents, quantity: l.quantity })) },
      after: { feeCents, itemId },
    });
    out = { itemId, removed: lines.length, added: true };
  });
  tx();
  return out;
}
