import type { HandlerContext } from '../registry.js';
import { defineHandler, IpcGuardError } from '../registry.js';
import { requireAdmin, requireCapability, REFUSED } from '../guards.js';
import { assertCounterAddress, assertCounterMaySee, assertOrderStillBeingTaken } from '../order-access.js';
import { COST_CAPABILITY, ok, hasCapability } from '@cheeseoclock/shared-types';
import type { AuthenticatedUser, OrderStockAnswer, StockSettlement } from '@cheeseoclock/shared-types';
import {
  deleteTestOrderInputSchema,
  listDeletedTestsInputSchema,
  orderStockAnswerSchema,
  testDeletePreviewInputSchema,
} from '@cheeseoclock/shared-schemas';
import {
  getCurrentSession,
  verifyManagerPin,
  verifyOwnerSecret,
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
  updateOrderItemOptions,
  applyDiscount,
  clearDiscount,
  setOrderMode,
  findResumableDraft,
  discardEmptyDrafts,
  discardDraft,
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
  findOrder,
  deleteTestOrder,
  listDeletedTests,
  testDeletePreview,
} from '../../db/repositories/order-repo.js';
import {
  checkChoicePicks,
  kitchenHearsOfClose,
  requiresManagerApproval,
  stockSettlementForCounter,
  stockStatusForCounter,
  validateOrderForTender,
} from '@cheeseoclock/pos-domain';
import { printSpooler } from '../../services/print-spooler.js';
import { webOrdersBridge } from '../../services/web-orders-bridge.js';
import { listModifierGroupsForItem, listModifiersByGroup } from '../../db/repositories/modifier-repo.js';
import { groupDisplayName } from '@cheeseoclock/shared-types';
import type { AppDatabase } from '../../db/connection.js';
import { mapOrderToFbrPayload, mapRefundToFbrDebitNote } from '@cheeseoclock/fbr-core';
import { getFbrConfig, toSellerInfo } from '../../services/fbr-config.js';
import { enqueueFbrSubmission, getFbrRowByOrder } from '../../db/repositories/fbr-queue-repo.js';
import { fbrWorker } from '../../services/fbr-worker.js';
import { decrementForOrder } from '../../db/repositories/stock-movement-repo.js';
import { getOrderStockStatus } from '../../db/repositories/order-stock-repo.js';
import {
  snapshotCustomerOntoOrder,
  detachCustomerFromOrder,
  setOrderDeliveryNotes,
} from '../../db/repositories/customer-repo.js';

/** What requireAdmin names ("… needs the owner (admin) login"). */
const DELETE_TEST = 'Deleting a test order';
const DELETED_TESTS = 'The list of deleted test orders';

function requireOrderCreate(): AuthenticatedUser {
  const session = getCurrentSession();
  if (!session) throw new IpcGuardError({ code: 'unauthenticated', message: 'Not logged in' });
  if (!hasCapability(session.role, 'order.create')) {
    throw new IpcGuardError({ code: 'forbidden', message: 'Order creation not allowed' });
  }
  return session;
}

/**
 * Ingredient quantities and food cost are the owner's business data: only a
 * login that may see costs (COST_CAPABILITY — today `menu.manage`, the same
 * logins that open Inventory) sees them: the "about Rs …" of the food, and
 * what the waste cost. A counter login still gets the question.
 */
function mayViewStock(s: AuthenticatedUser): boolean {
  return hasCapability(s.role, COST_CAPABILITY);
}

/** What a cancel / refund did to stock, as this login may read it. */
function stockForLogin(s: AuthenticatedUser, stock: StockSettlement | null): StockSettlement | null {
  if (!stock || mayViewStock(s)) return stock;
  return stockSettlementForCounter(stock);
}

/** What to say when one part of the stock answer is malformed. */
const STOCK_ANSWER_REFUSED: Record<keyof OrderStockAnswer, string> = {
  foodMade: 'Say whether the food was made',
  putBack: 'Pick which drinks go back',
  expectStatus: 'Close this and check the order again',
};

/**
 * The stock half of a cancel / refund, checked at the boundary: "Was the food
 * made?" is 'made', 'not_made' or not given (the repository then refuses when
 * the order still holds stock in the shop — the till never guesses).
 */
function stockAnswer(payload: { foodMade?: unknown; putBack?: unknown; expectStatus?: unknown }): OrderStockAnswer {
  const parsed = orderStockAnswerSchema.safeParse({
    foodMade: payload.foodMade,
    putBack: payload.putBack,
    expectStatus: payload.expectStatus,
  });
  if (!parsed.success) {
    const field = parsed.error.issues[0]?.path[0] as keyof OrderStockAnswer | undefined;
    throw new IpcGuardError({ code: 'precondition_failed', message: STOCK_ANSWER_REFUSED[field ?? 'foodMade'] });
  }
  const out: OrderStockAnswer = {};
  if (parsed.data.foodMade !== undefined) out.foodMade = parsed.data.foodMade;
  if (parsed.data.putBack !== undefined) out.putBack = parsed.data.putBack;
  if (parsed.data.expectStatus !== undefined) out.expectStatus = parsed.data.expectStatus;
  return out;
}

export function registerOrdersHandlers(ctx: HandlerContext): void {
  defineHandler('orders:create', ctx, (_ctx, payload) => {
    const s = requireOrderCreate();
    // The same address rule as the attach channels, before any row is written.
    if (payload.customerId) assertCounterAddress(ctx.db, s, payload.customerId, payload.customerAddressId);
    const order = createOrder(ctx.db, payload, { userId: s.id, deviceId: ctx.deviceId });
    // If the cashier already picked a customer, snapshot them onto the order now.
    if (payload.customerId) {
      snapshotCustomerOntoOrder(
        ctx.db,
        {
          orderId: order.id,
          customerId: payload.customerId,
          addressId: payload.customerAddressId ?? null,
        },
        { userId: s.id, deviceId: ctx.deviceId },
      );
    }
    return ok(order);
  });

  defineHandler('orders:attachCustomer', ctx, (_ctx, payload) => {
    const s = requireOrderCreate();
    // Only a bill still being rung up (see order-access.ts).
    assertOrderStillBeingTaken(ctx.db, payload.orderId);
    assertCounterAddress(ctx.db, s, payload.customerId, payload.addressId);
    try {
      snapshotCustomerOntoOrder(
        ctx.db,
        {
          orderId: payload.orderId,
          customerId: payload.customerId,
          addressId: payload.addressId ?? null,
          ...(payload.deliveryNotes !== undefined ? { deliveryNotes: payload.deliveryNotes } : {}),
        },
        { userId: s.id, deviceId: ctx.deviceId },
      );
    } catch (e) {
      throw new IpcGuardError({
        code: 'precondition_failed',
        message: e instanceof Error ? e.message : 'Could not attach customer',
      });
    }
    const snap = getOrderSnapshot(ctx.db, payload.orderId);
    if (!snap) throw new IpcGuardError({ code: 'not_found', message: 'Order not found' });
    return ok(snap);
  });

  defineHandler('orders:detachCustomer', ctx, (_ctx, payload) => {
    const s = requireOrderCreate();
    assertOrderStillBeingTaken(ctx.db, payload.orderId);
    try {
      detachCustomerFromOrder(ctx.db, payload.orderId, { userId: s.id, deviceId: ctx.deviceId });
    } catch (e) {
      throw new IpcGuardError({
        code: 'precondition_failed',
        message: e instanceof Error ? e.message : 'Could not detach customer',
      });
    }
    const snap = getOrderSnapshot(ctx.db, payload.orderId);
    if (!snap) throw new IpcGuardError({ code: 'not_found', message: 'Order not found' });
    return ok(snap);
  });

  // The counter's "Order notes" box with no customer typed in: saved before
  // the order is sent, so the kitchen ticket and the bill print it.
  defineHandler('orders:setNote', ctx, (_ctx, payload) => {
    const s = requireOrderCreate();
    assertOrderStillBeingTaken(ctx.db, payload.orderId);
    const note = typeof payload.note === 'string' ? payload.note : null;
    try {
      setOrderDeliveryNotes(ctx.db, payload.orderId, note, { userId: s.id, deviceId: ctx.deviceId });
    } catch (e) {
      throw new IpcGuardError({
        code: 'precondition_failed',
        message: e instanceof Error ? e.message : 'Could not save the order note',
      });
    }
    const snap = getOrderSnapshot(ctx.db, payload.orderId);
    if (!snap) throw new IpcGuardError({ code: 'not_found', message: 'Order not found' });
    return ok(snap);
  });

  // Past orders are for managers and the owner (`order.history`, owner
  // 2026-09-26): a counter login gets the board and Recent Orders.
  defineHandler('orders:list', ctx, (_ctx, payload) => {
    requireCapability('order.history', REFUSED.history);
    return ok(listOrders(ctx.db, payload ?? {}));
  });

  defineHandler('orders:history', ctx, (_ctx, payload) => {
    requireCapability('order.history', REFUSED.history);
    return ok(listOrderHistory(ctx.db, payload ?? {}));
  });

  // Checkout reads its own draft; a counter login opens only the draft, board
  // orders and this shift's orders (order-access.ts).
  defineHandler('orders:get', ctx, (_ctx, payload) => {
    const s = requireOrderCreate();
    const snap = getOrderSnapshot(ctx.db, payload.id);
    if (snap) assertCounterMaySee(ctx.db, s, snap.order, 'open');
    return ok(snap);
  });

  defineHandler('orders:addItem', ctx, (_ctx, payload) => {
    const s = requireOrderCreate();
    assertChoicePicks(ctx.db, payload.menuItemId, payload.modifierIds ?? []);
    // Only the fields the contract names. `unitPriceOverrideCents` and
    // `parentOrderItemId` exist for a future server-side combo expander and
    // must never be accepted from the renderer — a free item with a clean
    // audit row is one DevTools call away otherwise.
    const { orderId, menuItemId, quantity, modifierIds, notes } = payload;
    addOrderItem(
      ctx.db,
      { orderId, menuItemId, quantity, modifierIds: modifierIds ?? [], notes: notes ?? null },
      { userId: s.id, deviceId: ctx.deviceId },
    );
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

  defineHandler('orders:updateItemOptions', ctx, (_ctx, payload) => {
    const s = requireOrderCreate();
    const line = ctx.db
      .prepare('SELECT menu_item_id FROM order_items WHERE id = ? AND order_id = ? AND deleted_at IS NULL')
      .get(payload.orderItemId, payload.orderId) as { menu_item_id: string } | undefined;
    if (line) assertChoicePicks(ctx.db, line.menu_item_id, Array.isArray(payload.modifierIds) ? payload.modifierIds : []);
    updateOrderItemOptions(
      ctx.db,
      {
        orderId: payload.orderId,
        orderItemId: payload.orderItemId,
        modifierIds: Array.isArray(payload.modifierIds) ? payload.modifierIds : [],
        notes: typeof payload.notes === 'string' ? payload.notes : null,
      },
      { userId: s.id, deviceId: ctx.deviceId },
    );
    const snap = getOrderSnapshot(ctx.db, payload.orderId);
    if (!snap) throw new IpcGuardError({ code: 'not_found', message: 'Order not found' });
    return ok(snap);
  });

  defineHandler('orders:applyDiscount', ctx, async (_ctx, payload) => {
    const s = requireOrderCreate();
    let approverUserId: string | null = null;
    // The order's subtotal decides whether a flat amount is more than 10% of it.
    const current = getOrderSnapshot(ctx.db, payload.orderId);
    if (!current) throw new IpcGuardError({ code: 'not_found', message: 'Order not found' });
    if (
      requiresManagerApproval(
        { type: payload.discountType, value: payload.value },
        current.order.subtotalCents,
      )
    ) {
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

  defineHandler('orders:resumeDraft', ctx, () => {
    const s = requireOrderCreate();
    discardEmptyDrafts(ctx.db, { userId: s.id, deviceId: ctx.deviceId });
    return ok(findResumableDraft(ctx.db, ctx.deviceId));
  });

  defineHandler('orders:discardDraft', ctx, (_ctx, payload) => {
    const s = requireOrderCreate();
    try {
      discardDraft(ctx.db, payload.orderId, { userId: s.id, deviceId: ctx.deviceId });
    } catch (e) {
      throw new IpcGuardError({
        code: 'precondition_failed',
        message: e instanceof Error ? e.message : 'Could not discard order',
      });
    }
    return ok(null);
  });

  defineHandler('orders:setMode', ctx, (_ctx, payload) => {
    const s = requireOrderCreate();
    try {
      setOrderMode(ctx.db, payload.orderId, payload.mode, { userId: s.id, deviceId: ctx.deviceId });
    } catch (e) {
      throw new IpcGuardError({
        code: 'precondition_failed',
        message: e instanceof Error ? e.message : 'Could not change mode',
      });
    }
    const snap = getOrderSnapshot(ctx.db, payload.orderId);
    if (!snap) throw new IpcGuardError({ code: 'not_found', message: 'Order not found' });
    return ok(snap);
  });

  defineHandler('orders:tender', ctx, (_ctx, payload) => {
    const s = requireOrderCreate();
    let drawerOpenId: string | null;
    try {
      // Cash in the drawer: the drawer_opens row is written with the sale.
      drawerOpenId = tenderOrder(ctx.db, payload, { userId: s.id, deviceId: ctx.deviceId }).drawerOpenId;
    } catch (e) {
      throw new IpcGuardError({
        code: 'precondition_failed',
        message: e instanceof Error ? e.message : 'Tender failed',
      });
    }
    const snap = getOrderSnapshot(ctx.db, payload.orderId);
    if (!snap) throw new IpcGuardError({ code: 'not_found', message: 'Order not found after tender' });
    // Paper per Settings → Printer: a kitchen ticket (the kitchen still has to
    // cook a prepaid order) and the receipt; cash pops the drawer (for its row).
    printSpooler.onOrderEvent(payload.orderId, 'paid', { drawerOpenId });

    // Decrement ingredient stock based on recipes. Idempotent — guards against
    // double-decrement if a tender is somehow re-issued. Failures don't roll back the sale.
    try {
      decrementForOrder(ctx.db, payload.orderId, { userId: s.id, deviceId: ctx.deviceId });
    } catch (e) {
       
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
    // Kitchen ticket (once per order) per Settings → Printer.
    printSpooler.onOrderEvent(payload.orderId, 'sent_to_kitchen');
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
    // The food is leaving: the bill goes with it (per Settings → Printer).
    printSpooler.onOrderEvent(payload.orderId, 'dispatched');
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
    let drawerOpenId: string | null;
    try {
      drawerOpenId = markOrderServed(
        ctx.db,
        { orderId: payload.orderId, payment: payload.payment },
        { userId: s.id, deviceId: ctx.deviceId },
      ).drawerOpenId;
    } catch (e) {
      throw new IpcGuardError({
        code: 'precondition_failed',
        message: e instanceof Error ? e.message : 'Mark served failed',
      });
    }
    const snap = getOrderSnapshot(ctx.db, payload.orderId);
    if (!snap) throw new IpcGuardError({ code: 'not_found', message: 'Order not found' });
    // Receipt + FBR + inventory decrement when a payment was just captured
    // (takeaway COD / dine-in collect-later).
    if (payload.payment) {
      printSpooler.onOrderEvent(payload.orderId, 'payment_captured', { drawerOpenId });
      try {
        const cfg = getFbrConfig(ctx.db);
        const fbrPayload = mapOrderToFbrPayload(snap, toSellerInfo(cfg));
        enqueueFbrSubmission(ctx.db, payload.orderId, fbrPayload, cfg.mode);
        fbrWorker.kick();
      } catch (e) {
         
        console.warn('FBR enqueue failed on serve (sale not affected):', e);
      }
      // Decrement ingredient stock. decrementForOrder is idempotent, so even
      // if tender ran earlier (it won't for COD, but defense-in-depth) the
      // movements won't be double-counted.
      try {
        decrementForOrder(ctx.db, payload.orderId, { userId: s.id, deviceId: ctx.deviceId });
      } catch (e) {
         
        console.warn('Stock decrement failed on serve (sale not affected):', e);
      }
    }
    return ok(snap);
  });

  defineHandler('orders:markDelivered', ctx, (_ctx, payload) => {
    const s = requireOrderCreate();
    let drawerOpenId: string | null;
    try {
      drawerOpenId = markOrderDelivered(
        ctx.db,
        { orderId: payload.orderId, payment: payload.payment },
        { userId: s.id, deviceId: ctx.deviceId },
      ).drawerOpenId;
    } catch (e) {
      throw new IpcGuardError({
        code: 'precondition_failed',
        message: e instanceof Error ? e.message : 'Mark delivered failed',
      });
    }
    const snap = getOrderSnapshot(ctx.db, payload.orderId);
    if (!snap) throw new IpcGuardError({ code: 'not_found', message: 'Order not found' });
    // Paper + drawer, FBR and inventory decrement only when a payment was
    // just captured (the tender path already covers prepay). A pre-paid
    // delivery prints nothing here: its bill left with the rider.
    if (payload.payment) {
      printSpooler.onOrderEvent(payload.orderId, 'payment_captured', { drawerOpenId });
      try {
        const cfg = getFbrConfig(ctx.db);
        const fbrPayload = mapOrderToFbrPayload(snap, toSellerInfo(cfg));
        enqueueFbrSubmission(ctx.db, payload.orderId, fbrPayload, cfg.mode);
        fbrWorker.kick();
      } catch (e) {
        // FBR mapping failure must not block the delivery flow.
         
        console.warn('FBR enqueue failed on delivery (sale not affected):', e);
      }
      try {
        decrementForOrder(ctx.db, payload.orderId, { userId: s.id, deviceId: ctx.deviceId });
      } catch (e) {
         
        console.warn('Stock decrement failed on delivery (sale not affected):', e);
      }
    }
    return ok(snap);
  });

  defineHandler('orders:void', ctx, async (_ctx, payload) => {
    const s = requireOrderCreate();
    const answer = stockAnswer(payload);
    if (!payload.reason || !payload.reason.trim()) {
      throw new IpcGuardError({
        code: 'precondition_failed',
        message: 'Void reason is required',
      });
    }
    if (!payload.approverPin?.trim()) {
      throw new IpcGuardError({ code: 'forbidden', message: "A manager's PIN or password is needed to cancel an order" });
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
    let done: ReturnType<typeof voidOrder>;
    try {
      done = voidOrder(
        ctx.db,
        { orderId: payload.orderId, reason: payload.reason.trim(), approverUserId, ...answer },
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
    // A CANCELLED slip for the kitchen when a ticket for this order printed or
    // may have, and the food had not been handed over — still cooking, ready
    // on the pass, or out with the rider. Not for food already served or
    // delivered: "DO NOT MAKE - DO NOT SEND" then only confuses the line. The
    // spooler checks the print log, and cancels a ticket or bill still waiting
    // to print (per Settings → Printer).
    if (kitchenHearsOfClose(done.statusBefore)) printSpooler.onOrderEvent(payload.orderId, 'cancelled');
    return ok({ ...snap, stock: stockForLogin(s, done.stock) });
  });

  // The question for the Cancel / Refund dialogs, and the Order History line.
  // A counter login reads it only for an order it may open, and without the
  // ingredient lines or costs (stockForLogin).
  defineHandler('orders:stockStatus', ctx, (_ctx, payload) => {
    const s = requireOrderCreate();
    const order = findOrder(ctx.db, payload.orderId);
    if (!order) throw new IpcGuardError({ code: 'not_found', message: 'Order not found' });
    assertCounterMaySee(ctx.db, s, order, 'open');
    const status = getOrderStockStatus(ctx.db, payload.orderId, ctx.deviceId, Date.now());
    if (!status) throw new IpcGuardError({ code: 'not_found', message: 'Order not found' });
    return ok(mayViewStock(s) ? status : stockStatusForCounter(status));
  });

  // ---- Test orders the owner deletes (migration 0043) ----
  // The owner (admin) login only — a manager or cashier is refused before
  // anything is read — and the delete itself needs the owner's PIN or
  // password typed again, so an owner login left open at the counter can't
  // be used for it.

  defineHandler('orders:testDeletePreview', ctx, (_ctx, payload) => {
    requireAdmin(DELETE_TEST);
    const parsed = testDeletePreviewInputSchema.safeParse(payload);
    if (!parsed.success) throw new IpcGuardError({ code: 'validation_failed', message: 'Which order?' });
    try {
      return ok(testDeletePreview(ctx.db, parsed.data.orderId, ctx.deviceId));
    } catch (e) {
      throw new IpcGuardError({ code: 'not_found', message: e instanceof Error ? e.message : 'Order not found' });
    }
  });

  defineHandler('orders:deleteTest', ctx, async (_ctx, payload) => {
    const s = requireAdmin(DELETE_TEST);
    const parsed = deleteTestOrderInputSchema.safeParse(payload);
    if (!parsed.success) {
      throw new IpcGuardError({ code: 'precondition_failed', message: parsed.error.issues[0]?.message ?? 'Check the form' });
    }
    let ownerUserId: string;
    try {
      ownerUserId = (await verifyOwnerSecret(ctx.db, parsed.data.ownerSecret)).ownerUserId;
    } catch (e) {
      throw new IpcGuardError({ code: 'forbidden', message: e instanceof Error ? e.message : "That is not the owner's PIN or password." });
    }
    let done: ReturnType<typeof deleteTestOrder>;
    try {
      done = deleteTestOrder(
        ctx.db,
        {
          orderId: parsed.data.orderId,
          reason: parsed.data.reason,
          restock: parsed.data.restock,
          expectStatus: parsed.data.expectStatus,
          ownerUserId,
        },
        { userId: s.id, deviceId: ctx.deviceId },
      );
    } catch (e) {
      throw new IpcGuardError({ code: 'precondition_failed', message: e instanceof Error ? e.message : 'Not deleted' });
    }
    // After the commit. Paper never blocks it: the spooler finishes whatever
    // was still waiting quietly and sends the kitchen a CANCELLED slip when
    // its ticket printed and the food was not handed over.
    printSpooler.onOrderDeleted(done.orderId, done.statusBefore);
    if (done.web) {
      try {
        webOrdersBridge.kick();
      } catch (e) {
        console.warn('Website not told yet about a deleted test order (it will be on the next push):', e);
      }
    }
    return ok({ ...done, stock: stockForLogin(s, done.stock) });
  });

  defineHandler('orders:listDeletedTests', ctx, (_ctx, payload) => {
    requireAdmin(DELETED_TESTS);
    const parsed = listDeletedTestsInputSchema.safeParse(payload);
    if (!parsed.success) {
      throw new IpcGuardError({ code: 'validation_failed', message: parsed.error.issues[0]?.message ?? 'Check the dates' });
    }
    return ok(listDeletedTests(ctx.db, parsed.data));
  });

  defineHandler('orders:refund', ctx, async (_ctx, payload) => {
    const s = requireOrderCreate();
    const answer = stockAnswer(payload);
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
    let done: ReturnType<typeof refundOrder>;
    try {
      done = refundOrder(
        ctx.db,
        {
          orderId: payload.orderId,
          reason: payload.reason.trim(),
          approverUserId,
          ...(payload.amountCents !== undefined ? { amountCents: payload.amountCents } : {}),
          ...(payload.method ? { method: payload.method } : {}),
          ...answer,
        },
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
    // The refund rows this call just wrote share one timestamp. The drawer pops
    // only when THIS refund hands cash back (not because some earlier payment
    // on the order was cash) — for the drawer_opens row the refund wrote — and
    // FBR hears about this refund's amount only: summing every refund on the
    // order re-reported earlier partial ones.
    const refundRows = snap.payments.filter((p) => p.amountCents < 0);
    const latestAt = refundRows.reduce((m, p) => (p.paidAt > m ? p.paidAt : m), '');
    const thisRefund = refundRows.filter((p) => p.paidAt === latestAt);
    printSpooler.onOrderEvent(payload.orderId, 'refunded', { drawerOpenId: done.drawerOpenId });
    // Refunded in full before the food was handed over (in the kitchen, ready,
    // out with the rider): a CANCELLED slip when a ticket printed or may have.
    if (done.order.status === 'refunded' && kitchenHearsOfClose(done.statusBefore)) {
      printSpooler.onOrderEvent(payload.orderId, 'cancelled');
    }

    // Tell FBR: a refund is a Debit Note against the sale invoice. Only when
    // FBR actually accepted the sale — otherwise there is nothing to reverse.
    // Never blocks the refund.
    try {
      const sale = getFbrRowByOrder(ctx.db, payload.orderId);
      if (sale && sale.status === 'sent' && sale.irn && sale.modeAtEnqueue !== 'noop') {
        const latest = thisRefund[0];
        if (latest) {
          const refundedCents = thisRefund.reduce((sum, p) => sum + -p.amountCents, 0);
          const cfg = getFbrConfig(ctx.db);
          const note = mapRefundToFbrDebitNote(snap, toSellerInfo(cfg), {
            originalIrn: sale.irn,
            refundedCents,
            refundedAt: latest.paidAt,
          });
          enqueueFbrSubmission(ctx.db, payload.orderId, note, cfg.mode, {
            kind: 'debit_note',
            refId: latest.id,
          });
          fbrWorker.kick();
        }
      }
    } catch (e) {

      console.warn('FBR debit note enqueue failed (refund not affected):', e);
    }
    return ok({ ...snap, stock: stockForLogin(s, done.stock) });
  });
}

/**
 * The item's choice rules on the till's own writes: a required flavour, veggie
 * pick or deal pizza must be chosen, single choices hold one, maxima hold
 * (owner test 2026-09-27: a 1 litre drink went in with no flavour). Website
 * orders are checked by the site before they are imported, so the bridge does
 * not come through here.
 */
function assertChoicePicks(db: AppDatabase, menuItemId: string, modifierIds: readonly string[]): void {
  const groups = listModifierGroupsForItem(db, menuItemId).map((g) => ({
    id: g.id,
    label: groupDisplayName(g.name, g),
    selectionType: g.selectionType,
    isRequired: g.isRequired,
    minSelect: g.minSelect,
    maxSelect: g.maxSelect,
    optionIds: listModifiersByGroup(db, g.id).map((m) => m.id),
  }));
  const why = checkChoicePicks(groups, modifierIds);
  if (why) throw new IpcGuardError({ code: 'precondition_failed', message: why });
}
