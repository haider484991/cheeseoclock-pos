import type { HandlerContext } from '../registry.js';
import { defineHandler, IpcGuardError } from '../registry.js';
import { ok, hasCapability } from '@cheeseoclock/shared-types';
import type { AuthenticatedUser } from '@cheeseoclock/shared-types';
import {
  getCurrentSession,
  verifyManagerPin,
} from '../../services/auth-service.js';
import {
  createOrder,
  listOrders,
  listOrderHistory,
  listActiveOrders,
  getOrderSnapshot,
  addOrderItem,
  removeOrderItem,
  updateOrderItemQuantity,
  applyDiscount,
  clearDiscount,
  tenderOrder,
  voidOrder,
  refundOrder,
  sendOrderToKitchen,
  markOrderPreparing,
  markOrderReady,
  assignRiderToOrder,
  unassignRiderFromOrder,
  markOrderServed,
  markOrderDelivered,
} from '../../db/repositories/order-repo.js';
import { requiresManagerApproval, validateOrderForTender } from '@cheeseoclock/pos-domain';
import { printSpooler } from '../../services/print-spooler.js';
import { mapOrderToFbrPayload } from '@cheeseoclock/fbr-core';
import { getFbrConfig, toSellerInfo } from '../../services/fbr-config.js';
import { enqueueFbrSubmission } from '../../db/repositories/fbr-queue-repo.js';
import { fbrWorker } from '../../services/fbr-worker.js';
import { decrementForOrder } from '../../db/repositories/stock-movement-repo.js';
import { snapshotCustomerOntoOrder } from '../../db/repositories/customer-repo.js';
import { nowIso } from '../../db/repositories/base.js';

function requireOrderCreate(): AuthenticatedUser {
  const session = getCurrentSession();
  if (!session) throw new IpcGuardError({ code: 'unauthenticated', message: 'Not logged in' });
  if (!hasCapability(session.role, 'order.create')) {
    throw new IpcGuardError({ code: 'forbidden', message: 'Order creation not allowed' });
  }
  return session;
}

export function registerOrdersHandlers(ctx: HandlerContext): void {
  defineHandler('orders:create', ctx, (_ctx, payload) => {
    const s = requireOrderCreate();
    const order = createOrder(ctx.db, payload, { userId: s.id, deviceId: ctx.deviceId });
    // If the cashier already picked a customer, snapshot them onto the order now.
    if (payload.customerId) {
      snapshotCustomerOntoOrder(ctx.db, order.id, payload.customerId, payload.customerAddressId ?? null);
    }
    return ok(order);
  });

  defineHandler('orders:attachCustomer', ctx, (_ctx, payload) => {
    requireOrderCreate();
    snapshotCustomerOntoOrder(ctx.db, payload.orderId, payload.customerId, payload.addressId ?? null);
    if (payload.deliveryNotes !== undefined) {
      ctx.db
        .prepare(
          `UPDATE orders SET delivery_notes = ?, updated_at = ?, version = version + 1 WHERE id = ?`,
        )
        .run(payload.deliveryNotes ?? null, nowIso(), payload.orderId);
    }
    const snap = getOrderSnapshot(ctx.db, payload.orderId);
    if (!snap) throw new IpcGuardError({ code: 'not_found', message: 'Order not found' });
    return ok(snap);
  });

  defineHandler('orders:detachCustomer', ctx, (_ctx, payload) => {
    requireOrderCreate();
    ctx.db
      .prepare(
        `UPDATE orders SET
            customer_id = NULL, customer_name_snapshot = NULL, customer_phone_snapshot = NULL,
            delivery_address_snapshot = NULL, delivery_notes = NULL,
            updated_at = ?, version = version + 1
          WHERE id = ?`,
      )
      .run(nowIso(), payload.orderId);
    const snap = getOrderSnapshot(ctx.db, payload.orderId);
    if (!snap) throw new IpcGuardError({ code: 'not_found', message: 'Order not found' });
    return ok(snap);
  });

  defineHandler('orders:list', ctx, (_ctx, payload) => {
    requireOrderCreate();
    return ok(listOrders(ctx.db, payload ?? {}));
  });

  defineHandler('orders:history', ctx, (_ctx, payload) => {
    requireOrderCreate();
    return ok(listOrderHistory(ctx.db, payload ?? {}));
  });

  defineHandler('orders:get', ctx, (_ctx, payload) => {
    requireOrderCreate();
    return ok(getOrderSnapshot(ctx.db, payload.id));
  });

  defineHandler('orders:addItem', ctx, (_ctx, payload) => {
    const s = requireOrderCreate();
    addOrderItem(ctx.db, payload, { userId: s.id, deviceId: ctx.deviceId });
    const snap = getOrderSnapshot(ctx.db, payload.orderId);
    if (!snap) throw new IpcGuardError({ code: 'not_found', message: 'Order not found after add' });
    return ok(snap);
  });

  defineHandler('orders:updateItemQuantity', ctx, (_ctx, payload) => {
    const s = requireOrderCreate();
    updateOrderItemQuantity(ctx.db, payload.orderId, payload.orderItemId, payload.quantity, {
      userId: s.id,
      deviceId: ctx.deviceId,
    });
    const snap = getOrderSnapshot(ctx.db, payload.orderId);
    if (!snap) throw new IpcGuardError({ code: 'not_found', message: 'Order not found' });
    return ok(snap);
  });

  defineHandler('orders:removeItem', ctx, (_ctx, payload) => {
    const s = requireOrderCreate();
    removeOrderItem(ctx.db, payload.orderId, payload.orderItemId, {
      userId: s.id,
      deviceId: ctx.deviceId,
    });
    const snap = getOrderSnapshot(ctx.db, payload.orderId);
    if (!snap) throw new IpcGuardError({ code: 'not_found', message: 'Order not found' });
    return ok(snap);
  });

  defineHandler('orders:applyDiscount', ctx, async (_ctx, payload) => {
    const s = requireOrderCreate();
    let approverUserId: string | null = null;
    if (requiresManagerApproval({ type: payload.discountType, value: payload.value })) {
      if (!payload.approverPin) {
        throw new IpcGuardError({
          code: 'precondition_failed',
          message: 'Manager approval required for this discount',
        });
      }
      try {
        const approver = await verifyManagerPin(ctx.db, payload.approverPin);
        approverUserId = approver.approverUserId;
      } catch (e) {
        throw new IpcGuardError({
          code: 'forbidden',
          message: e instanceof Error ? e.message : 'Manager approval failed',
        });
      }
    }

    applyDiscount(
      ctx.db,
      {
        orderId: payload.orderId,
        discountType: payload.discountType,
        value: payload.value,
        reason: payload.reason ?? null,
        approverUserId,
      },
      { userId: s.id, deviceId: ctx.deviceId },
    );
    const snap = getOrderSnapshot(ctx.db, payload.orderId);
    if (!snap) throw new IpcGuardError({ code: 'not_found', message: 'Order not found' });
    return ok(snap);
  });

  defineHandler('orders:clearDiscount', ctx, (_ctx, payload) => {
    const s = requireOrderCreate();
    clearDiscount(ctx.db, payload.orderId, { userId: s.id, deviceId: ctx.deviceId });
    const snap = getOrderSnapshot(ctx.db, payload.orderId);
    if (!snap) throw new IpcGuardError({ code: 'not_found', message: 'Order not found' });
    return ok(snap);
  });

  defineHandler('orders:tender', ctx, (_ctx, payload) => {
    const s = requireOrderCreate();
    try {
      tenderOrder(ctx.db, payload, { userId: s.id, deviceId: ctx.deviceId });
    } catch (e) {
      throw new IpcGuardError({
        code: 'precondition_failed',
        message: e instanceof Error ? e.message : 'Tender failed',
      });
    }
    const snap = getOrderSnapshot(ctx.db, payload.orderId);
    if (!snap) throw new IpcGuardError({ code: 'not_found', message: 'Order not found after tender' });
    // Fire-and-forget receipt print — open drawer if there's any cash payment.
    const openDrawer = payload.payments.some((p) => p.method === 'cash');
    printSpooler.enqueueReceipt(payload.orderId, openDrawer);

    // Decrement ingredient stock based on recipes. Idempotent — guards against
    // double-decrement if a tender is somehow re-issued. Failures don't roll back the sale.
    try {
      decrementForOrder(ctx.db, payload.orderId, { userId: s.id, deviceId: ctx.deviceId });
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('Stock decrement failed (sale not affected):', e);
    }

    // Enqueue an FBR submission. The worker picks it up asynchronously.
    // Failure here must not block the sale — wrap in try.
    try {
      const cfg = getFbrConfig(ctx.db);
      const fbrPayload = mapOrderToFbrPayload(snap, toSellerInfo(cfg));
      enqueueFbrSubmission(ctx.db, payload.orderId, fbrPayload, cfg.mode);
      fbrWorker.kick();
    } catch (e) {
      // Don't fail the tender if FBR mapping/enqueue fails.
      // Log and continue — order is paid, the cashier saw success.
      // eslint-disable-next-line no-console
      console.warn('FBR enqueue failed (sale not affected):', e);
    }

    return ok(snap);
  });

  // ---- Live Orders board: status transitions ---------------------------
  defineHandler('orders:sendToKitchen', ctx, (_ctx, payload) => {
    const s = requireOrderCreate();
    // Re-validate server-side that the order is shippable to the kitchen.
    // Same rules as tender (needs items, customer for delivery, etc.) so the
    // dispatcher isn't handed a half-typed order.
    const snap = getOrderSnapshot(ctx.db, payload.orderId);
    if (!snap) throw new IpcGuardError({ code: 'not_found', message: 'Order not found' });
    const itemCount = snap.items.reduce((n, i) => n + i.quantity, 0);
    const v = validateOrderForTender({
      mode: snap.order.mode,
      itemCount,
      subtotalCents: snap.order.subtotalCents,
      tableId: snap.order.tableId,
      customerName: snap.customerName,
      customerPhone: snap.customerPhone,
      deliveryAddress: snap.deliveryAddress,
    });
    if (!v.ok) {
      throw new IpcGuardError({
        code: 'precondition_failed',
        message: v.missing.join('; '),
      });
    }
    try {
      sendOrderToKitchen(ctx.db, payload.orderId, { userId: s.id, deviceId: ctx.deviceId });
    } catch (e) {
      throw new IpcGuardError({
        code: 'precondition_failed',
        message: e instanceof Error ? e.message : 'Send to kitchen failed',
      });
    }
    const next = getOrderSnapshot(ctx.db, payload.orderId);
    if (!next) throw new IpcGuardError({ code: 'not_found', message: 'Order vanished' });
    return ok(next);
  });

  defineHandler('orders:listActive', ctx, (_ctx, payload) => {
    requireOrderCreate();
    return ok(listActiveOrders(ctx.db, payload ?? {}));
  });

  defineHandler('orders:markPreparing', ctx, (_ctx, payload) => {
    const s = requireOrderCreate();
    try {
      markOrderPreparing(ctx.db, payload.orderId, { userId: s.id, deviceId: ctx.deviceId });
    } catch (e) {
      throw new IpcGuardError({
        code: 'precondition_failed',
        message: e instanceof Error ? e.message : 'Transition failed',
      });
    }
    const snap = getOrderSnapshot(ctx.db, payload.orderId);
    if (!snap) throw new IpcGuardError({ code: 'not_found', message: 'Order not found' });
    return ok(snap);
  });

  defineHandler('orders:markReady', ctx, (_ctx, payload) => {
    const s = requireOrderCreate();
    try {
      markOrderReady(ctx.db, payload.orderId, { userId: s.id, deviceId: ctx.deviceId });
    } catch (e) {
      throw new IpcGuardError({
        code: 'precondition_failed',
        message: e instanceof Error ? e.message : 'Transition failed',
      });
    }
    const snap = getOrderSnapshot(ctx.db, payload.orderId);
    if (!snap) throw new IpcGuardError({ code: 'not_found', message: 'Order not found' });
    return ok(snap);
  });

  defineHandler('orders:assignRider', ctx, (_ctx, payload) => {
    const s = requireOrderCreate();
    try {
      assignRiderToOrder(ctx.db, payload.orderId, payload.riderId, {
        userId: s.id,
        deviceId: ctx.deviceId,
      });
    } catch (e) {
      throw new IpcGuardError({
        code: 'precondition_failed',
        message: e instanceof Error ? e.message : 'Assign failed',
      });
    }
    const snap = getOrderSnapshot(ctx.db, payload.orderId);
    if (!snap) throw new IpcGuardError({ code: 'not_found', message: 'Order not found' });
    return ok(snap);
  });

  defineHandler('orders:unassignRider', ctx, (_ctx, payload) => {
    const s = requireOrderCreate();
    try {
      unassignRiderFromOrder(ctx.db, payload.orderId, { userId: s.id, deviceId: ctx.deviceId });
    } catch (e) {
      throw new IpcGuardError({
        code: 'precondition_failed',
        message: e instanceof Error ? e.message : 'Unassign failed',
      });
    }
    const snap = getOrderSnapshot(ctx.db, payload.orderId);
    if (!snap) throw new IpcGuardError({ code: 'not_found', message: 'Order not found' });
    return ok(snap);
  });

  defineHandler('orders:markServed', ctx, (_ctx, payload) => {
    const s = requireOrderCreate();
    try {
      markOrderServed(
        ctx.db,
        { orderId: payload.orderId, payment: payload.payment },
        { userId: s.id, deviceId: ctx.deviceId },
      );
    } catch (e) {
      throw new IpcGuardError({
        code: 'precondition_failed',
        message: e instanceof Error ? e.message : 'Mark served failed',
      });
    }
    const snap = getOrderSnapshot(ctx.db, payload.orderId);
    if (!snap) throw new IpcGuardError({ code: 'not_found', message: 'Order not found' });
    // Receipt + FBR when a payment was just captured (takeaway COD).
    if (payload.payment) {
      const openDrawer = payload.payment.method === 'cash';
      printSpooler.enqueueReceipt(payload.orderId, openDrawer);
      try {
        const cfg = getFbrConfig(ctx.db);
        const fbrPayload = mapOrderToFbrPayload(snap, toSellerInfo(cfg));
        enqueueFbrSubmission(ctx.db, payload.orderId, fbrPayload, cfg.mode);
        fbrWorker.kick();
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('FBR enqueue failed on serve (sale not affected):', e);
      }
    }
    return ok(snap);
  });

  defineHandler('orders:markDelivered', ctx, (_ctx, payload) => {
    const s = requireOrderCreate();
    try {
      markOrderDelivered(
        ctx.db,
        { orderId: payload.orderId, payment: payload.payment },
        { userId: s.id, deviceId: ctx.deviceId },
      );
    } catch (e) {
      throw new IpcGuardError({
        code: 'precondition_failed',
        message: e instanceof Error ? e.message : 'Mark delivered failed',
      });
    }
    const snap = getOrderSnapshot(ctx.db, payload.orderId);
    if (!snap) throw new IpcGuardError({ code: 'not_found', message: 'Order not found' });
    // Fire-and-forget receipt print. When a COD payment was just captured we
    // also pop the drawer (cash on board). For pre-paid orders this is a
    // plain delivery confirmation reprint.
    const openDrawer = payload.payment?.method === 'cash';
    printSpooler.enqueueReceipt(payload.orderId, openDrawer);
    // FBR enqueue for the just-captured COD payment (tender path normally
    // does this — for COD, this is the first time payment is committed).
    if (payload.payment) {
      try {
        const cfg = getFbrConfig(ctx.db);
        const fbrPayload = mapOrderToFbrPayload(snap, toSellerInfo(cfg));
        enqueueFbrSubmission(ctx.db, payload.orderId, fbrPayload, cfg.mode);
        fbrWorker.kick();
      } catch (e) {
        // FBR mapping failure must not block the delivery flow.
        // eslint-disable-next-line no-console
        console.warn('FBR enqueue failed on delivery (sale not affected):', e);
      }
    }
    return ok(snap);
  });

  defineHandler('orders:void', ctx, async (_ctx, payload) => {
    const s = requireOrderCreate();
    if (!payload.reason || !payload.reason.trim()) {
      throw new IpcGuardError({
        code: 'precondition_failed',
        message: 'Void reason is required',
      });
    }
    let approverUserId: string;
    try {
      const approver = await verifyManagerPin(ctx.db, payload.approverPin);
      approverUserId = approver.approverUserId;
    } catch (e) {
      throw new IpcGuardError({
        code: 'forbidden',
        message: e instanceof Error ? e.message : 'Manager approval failed',
      });
    }
    try {
      voidOrder(
        ctx.db,
        { orderId: payload.orderId, reason: payload.reason.trim(), approverUserId },
        { userId: s.id, deviceId: ctx.deviceId },
      );
    } catch (e) {
      throw new IpcGuardError({
        code: 'precondition_failed',
        message: e instanceof Error ? e.message : 'Void failed',
      });
    }
    const snap = getOrderSnapshot(ctx.db, payload.orderId);
    if (!snap) throw new IpcGuardError({ code: 'not_found', message: 'Order not found' });
    return ok(snap);
  });

  defineHandler('orders:refund', ctx, async (_ctx, payload) => {
    const s = requireOrderCreate();
    if (!payload.reason || !payload.reason.trim()) {
      throw new IpcGuardError({
        code: 'precondition_failed',
        message: 'Refund reason is required',
      });
    }
    let approverUserId: string;
    try {
      const approver = await verifyManagerPin(ctx.db, payload.approverPin);
      approverUserId = approver.approverUserId;
    } catch (e) {
      throw new IpcGuardError({
        code: 'forbidden',
        message: e instanceof Error ? e.message : 'Manager approval failed',
      });
    }
    try {
      refundOrder(
        ctx.db,
        { orderId: payload.orderId, reason: payload.reason.trim(), approverUserId },
        { userId: s.id, deviceId: ctx.deviceId },
      );
    } catch (e) {
      throw new IpcGuardError({
        code: 'precondition_failed',
        message: e instanceof Error ? e.message : 'Refund failed',
      });
    }
    const snap = getOrderSnapshot(ctx.db, payload.orderId);
    if (!snap) throw new IpcGuardError({ code: 'not_found', message: 'Order not found' });
    // Pop the drawer + reprint when there were cash payments to refund.
    const hadCash = snap.payments.some((p) => p.method === 'cash');
    printSpooler.enqueueReceipt(payload.orderId, hadCash);
    return ok(snap);
  });
}
