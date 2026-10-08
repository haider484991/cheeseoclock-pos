import type { HandlerContext } from '../registry.js';
import { defineHandler, IpcGuardError } from '../registry.js';
import { requireAdmin, requireCapability, REFUSED, requireLicenceForSales } from '../guards.js';
import { assertCounterAddress, assertCounterMaySee, assertOrderStillBeingTaken } from '../order-access.js';
import { assertBuy1Get1Hours } from '../buy-1-get-1-hours.js';
import { COST_CAPABILITY, ok, hasCapability } from '@cheeseoclock/shared-types';
import type {
  AuthenticatedUser,
  CameBy,
  KitchenChange,
  KitchenChangeLine,
  OrderEditChangeLine,
  OrderEditOp,
  OrderEditPreview,
  OrderSnapshot,
  OrderStockAnswer,
  PaymentMethod,
  StockSettlement,
} from '@cheeseoclock/shared-types';
import {
  cameBySchema,
  changePaymentMethodInputSchema,
  deleteTestOrderInputSchema,
  foodpandaTenderCheckSchema,
  previewEditInputSchema,
  saveEditInputSchema,
  setCameByInputSchema,
  listDeletedTestsInputSchema,
  orderStockAnswerSchema,
  testDeletePreviewInputSchema,
} from '@cheeseoclock/shared-schemas';
import {
  EDIT_NEEDS_REASON,
  editNeedsPinWords,
  previewOrderEdit,
  saveOrderEdit,
  type SavedOrderEdit,
} from '../../db/repositories/order-edit-repo.js';
import { isDrinkLine } from '@cheeseoclock/printer-core';
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
  syncOrderDeliveryCharge,
  findResumableDraft,
  discardEmptyDrafts,
  discardDraft,
  tenderOrder,
  voidOrder,
  refundOrder,
  sendOrderToKitchen,
  markOrderPreparing,
  markOrderReady,
  sendOutOrder,
  sendOutRiderPaid,
  RIDER_PAYMENT_UNREADABLE,
  assignRiderToOrder,
  unassignRiderFromOrder,
  markOrderServed,
  markOrderDelivered,
  takeRiderPayment,
  findOrder,
  deleteTestOrder,
  listDeletedTests,
  testDeletePreview,
  hasFoodpandaDeal,
  FOODPANDA_DEAL_NEEDS_MANAGER,
  setOrderCameBy,
  CAME_BY_LOCKED,
} from '../../db/repositories/order-repo.js';
import {
  approvalRuleBasis,
  approvalRuleText,
  checkChoicePicks,
  discountBaseCents,
  discountReasonMissing,
  DISCOUNT_REASON_REQUIRED,
  kitchenHearsOfClose,
  NOTHING_TO_DISCOUNT,
  FREE_ORDER_IS_ALL,
  FREE_ORDER_NEEDS_MANAGER,
  FREE_ORDER_NEEDS_REASON,
  FREE_ORDER_NOT_FOODPANDA,
  requiresManagerApproval,
  stockSettlementForCounter,
  stockStatusForCounter,
  validateOrderForTender,
} from '@cheeseoclock/pos-domain';
import { printSpooler } from '../../services/print-spooler.js';
import {
  readApprovalLimits,
  readDiscountAlsoOffDeliveryCharge,
  readDiscountReasonRequired,
} from '../../db/business-settings-read.js';
import { webOrdersBridge } from '../../services/web-orders-bridge.js';
import { listModifierGroupsForItem, listModifiersByGroup } from '../../db/repositories/modifier-repo.js';
import { groupDisplayName } from '@cheeseoclock/shared-types';
import type { AppDatabase } from '../../db/connection.js';
import { mapOrderToFbrPayload, mapRefundToFbrDebitNote } from '@cheeseoclock/fbr-core';
import { getFbrConfig, toSellerInfo } from '../../services/fbr-config.js';
import { enqueueFbrSubmission, getFbrRowByOrder } from '../../db/repositories/fbr-queue-repo.js';
import { fbrWorker } from '../../services/fbr-worker.js';
import { getReceiptPrinterConfig } from '../../services/printer-config.js';
import { decrementForOrder } from '../../db/repositories/stock-movement-repo.js';
import { getOrderStockStatus } from '../../db/repositories/order-stock-repo.js';
import { changePaymentMethod } from '../../db/repositories/payment-method-repo.js';
import { kitchenTicketsNotPrinted } from '../../db/repositories/print-queue-repo.js';
import log from 'electron-log/main';
import {
  snapshotCustomerOntoOrder,
  detachCustomerFromOrder,
  setOrderDeliveryNotes,
} from '../../db/repositories/customer-repo.js';

/**
 * Live Orders' "Ticket not printed": `kitchenTicketNotPrinted: true` on the
 * cards whose kitchen ticket this till gave up printing (print-queue-repo
 * kitchenTicketsNotPrinted); the others are left exactly as they were. A mark
 * that can't be read leaves the board as it is: the orders come first.
 */
function withKitchenTicketMarks(db: AppDatabase, snaps: OrderSnapshot[]): OrderSnapshot[] {
  if (snaps.length === 0) return snaps;
  let notPrinted: Set<string>;
  try {
    notPrinted = new Set(kitchenTicketsNotPrinted(db, { orderIds: snaps.map((s) => s.order.id) }).map((r) => r.orderId));
  } catch (e) {
    log.warn('Kitchen ticket marks not read', { error: e instanceof Error ? e.message : String(e) });
    return snaps;
  }
  if (notPrinted.size === 0) return snaps;
  return snaps.map((s) => (notPrinted.has(s.order.id) ? { ...s, kitchenTicketNotPrinted: true } : s));
}

/** What requireAdmin names ("… needs the owner (admin) login"). */
const DELETE_TEST = 'Deleting a test order';
const DELETED_TESTS = 'The list of deleted test orders';
const CHANGE_PAYMENT = 'Changing how an order was paid';

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

/** The longest phone 'orders:setDeliveryArea' takes from the panel (trimmed). */
const DELIVERY_AREA_PHONE_MAX = 30;

/**
 * The panel's phone on 'orders:setDeliveryArea', checked at the boundary:
 * trimmed, at most 30 characters; left out, null or blank = none typed.
 */
function deliveryAreaPhone(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') throw new IpcGuardError({ code: 'validation_failed', message: 'The phone number is not valid' });
  const phone = raw.trim();
  if (phone.length > DELIVERY_AREA_PHONE_MAX) {
    throw new IpcGuardError({ code: 'validation_failed', message: 'The phone number is too long' });
  }
  return phone || null;
}

export function registerOrdersHandlers(ctx: HandlerContext): void {
  defineHandler('orders:create', ctx, (_ctx, payload) => {
    const s = requireOrderCreate();
    requireLicenceForSales();
    // The same address rule as the attach channels, before any row is written.
    if (payload.customerId) assertCounterAddress(ctx.db, s, payload.customerId, payload.customerAddressId);
    // How it came in, when a chip was tapped before the first item: one of the counter's three.
    let cameBy: CameBy | null = null;
    if (payload.cameBy !== undefined && payload.cameBy !== null) {
      const c = cameBySchema.safeParse(payload.cameBy);
      if (!c.success) throw new IpcGuardError({ code: 'validation_failed', message: 'Walk-in, Phone or WhatsApp' });
      cameBy = c.data;
    }
    const actor = { userId: s.id, deviceId: ctx.deviceId };
    const order = ctx.db.transaction(() => {
      // A new cart replaces this till's emptied one: dropped (audit discard_empty_draft, synced as a
      // delete), never reused. Here only, never inside createOrder: the website bridge calls
      // createOrder on this same till and would drop the cart a cashier is holding.
      discardEmptyDrafts(ctx.db, actor);
      const created = createOrder(
        ctx.db,
        {
          mode: payload.mode,
          tableId: payload.tableId ?? null,
          customerId: payload.customerId ?? null,
          notes: payload.notes ?? null,
          cameBy,
        },
        actor,
      );
      // If the cashier already picked a customer, snapshot them onto the order now.
      if (payload.customerId) {
        snapshotCustomerOntoOrder(
          ctx.db,
          {
            orderId: created.id,
            customerId: payload.customerId,
            addressId: payload.customerAddressId ?? null,
          },
          actor,
        );
      }
      return created;
    })();
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
    assertBuy1Get1Hours(ctx.db, payload.orderId, [payload.menuItemId]);
    // Only the fields the contract names. `unitPriceOverrideCents` and
    // `parentOrderItemId` exist for a future server-side combo expander and
    // must never be accepted from the renderer — a free item with a clean
    // audit row is one DevTools call away otherwise. `noDiscount` is the web
    // bridge's alone: here the line always takes its category's answer.
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
    // The order's subtotal decides whether a flat amount is more than the % limit of it.
    const current = getOrderSnapshot(ctx.db, payload.orderId);
    if (!current) throw new IpcGuardError({ code: 'not_found', message: 'Order not found' });

    // A Free order (v0.7.36): 100% off the whole order, value deals and delivery charge
    // included — always with a reason and a manager's PIN or password, checked in that order
    // (a missing reason never uses up a PIN attempt). The repository checks again.
    if (payload.free === true) {
      if (payload.discountType !== 'percent' || payload.value !== 100) {
        throw new IpcGuardError({ code: 'validation_failed', message: FREE_ORDER_IS_ALL });
      }
      if (current.order.mode === 'foodpanda') throw new IpcGuardError({ code: 'precondition_failed', message: FREE_ORDER_NOT_FOODPANDA });
      if (discountReasonMissing(payload.reason)) throw new IpcGuardError({ code: 'validation_failed', message: FREE_ORDER_NEEDS_REASON });
      if (!payload.approverPin) throw new IpcGuardError({ code: 'precondition_failed', message: FREE_ORDER_NEEDS_MANAGER });
      try {
        approverUserId = (await verifyManagerPin(ctx.db, payload.approverPin)).approverUserId;
      } catch (e) {
        throw new IpcGuardError({ code: 'forbidden', message: e instanceof Error ? e.message : 'Manager approval failed' });
      }
      applyDiscount(
        ctx.db,
        { orderId: payload.orderId, discountType: 'percent', value: 100, reason: payload.reason ?? null, approverUserId, free: true },
        { userId: s.id, deviceId: ctx.deviceId },
      );
      const freeSnap = getOrderSnapshot(ctx.db, payload.orderId);
      if (!freeSnap) throw new IpcGuardError({ code: 'not_found', message: 'Order not found' });
      return ok(freeSnap);
    }
    // The owner's "a discount needs a reason" (Settings → Money & discounts), read live: every
    // discount given here is one given by hand (any login, a manager replacing the foodpanda deal
    // too). Refused BEFORE the manager's PIN is checked, so a missing reason never uses up a
    // PIN attempt. The repository checks again.
    if (readDiscountReasonRequired(ctx.db) && discountReasonMissing(payload.reason)) {
      throw new IpcGuardError({ code: 'validation_failed', message: DISCOUNT_REASON_REQUIRED });
    }
    // The shop's foodpanda deal on this order: changing it is a manager's, whatever the amount.
    const replacesDeal = hasFoodpandaDeal(ctx.db, payload.orderId);
    // The live limit (Settings → Money & discounts): the screen may be a Save behind, this decides.
    const limits = readApprovalLimits(ctx.db);
    // …on what the discount will be worked on: the food only, unless the owner's
    // switch says it also comes off the delivery charge; never the value deals,
    // except on a foodpanda order (a manager matching the tablet, which covers
    // them). The repository freezes the same on the row, and checks again.
    const skipsDeals = current.order.mode !== 'foodpanda';
    const scope = { alsoOffDeliveryCharge: readDiscountAlsoOffDeliveryCharge(ctx.db), skipsNoDiscountLines: skipsDeals };
    const base = discountBaseCents(current.items, scope);
    const leavesDeals = skipsDeals && current.items.some((i) => i.noDiscount === true);
    // Every line it could come off is a value deal: refused BEFORE the manager's PIN is
    // checked, so it never uses up a PIN attempt. The repository refuses too.
    if (base === 0 && leavesDeals) {
      throw new IpcGuardError({ code: 'precondition_failed', message: NOTHING_TO_DISCOUNT });
    }
    if (replacesDeal || requiresManagerApproval({ type: payload.discountType, value: payload.value }, base, limits)) {
      if (!payload.approverPin) {
        throw new IpcGuardError({
          code: 'precondition_failed',
          message: replacesDeal
            ? FOODPANDA_DEAL_NEEDS_MANAGER
            : // The rule in words, on what it was checked on (the F3 screen's limit line, the same
              // test): the food without the value deals when they were left out of it (with the
              // delivery charge named when the owner's switch counts it in); the food, when only a
              // delivery charge is.
              `Manager approval required for this discount. ${approvalRuleText(limits, approvalRuleBasis(current.items, scope))}`,
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

  defineHandler('orders:clearDiscount', ctx, async (_ctx, payload) => {
    const s = requireOrderCreate();
    // Taking the shop's foodpanda deal off is changing it: a manager's PIN or password.
    let approverUserId: string | null = null;
    if (hasFoodpandaDeal(ctx.db, payload.orderId)) {
      if (!payload.approverPin) {
        throw new IpcGuardError({ code: 'precondition_failed', message: FOODPANDA_DEAL_NEEDS_MANAGER });
      }
      try {
        approverUserId = (await verifyManagerPin(ctx.db, payload.approverPin)).approverUserId;
      } catch (e) {
        throw new IpcGuardError({ code: 'forbidden', message: e instanceof Error ? e.message : 'Manager approval failed' });
      }
    }
    clearDiscount(ctx.db, payload.orderId, { userId: s.id, deviceId: ctx.deviceId }, { approverUserId });
    const snap = getOrderSnapshot(ctx.db, payload.orderId);
    if (!snap) throw new IpcGuardError({ code: 'not_found', message: 'Order not found' });
    return ok(snap);
  });

  // ---- Edit order (v0.7.36) ------------------------------------------------
  // The owner, 2 Oct 2026: an order the kitchen has is changed under the same
  // number — adding is any cashier's, taking off needs a manager's PIN — and
  // the user, 3 Oct 2026: a discount until it is paid, and a Free order.

  defineHandler('orders:previewEdit', ctx, (_ctx, payload) => {
    const s = requireOrderCreate();
    const parsed = previewEditInputSchema.safeParse(payload);
    if (!parsed.success) {
      throw new IpcGuardError({ code: 'validation_failed', message: parsed.error.issues[0]?.message ?? 'Those changes are not valid' });
    }
    const order = findOrder(ctx.db, parsed.data.orderId);
    if (!order) throw new IpcGuardError({ code: 'not_found', message: 'Order not found' });
    assertCounterMaySee(ctx.db, s, order, 'open');
    assertEditPicks(ctx.db, parsed.data.ops);
    assertBuy1Get1Hours(ctx.db, parsed.data.orderId, addedItems(parsed.data.ops));
    try {
      return ok(previewOrderEdit(ctx.db, parsed.data, { userId: s.id, deviceId: ctx.deviceId }));
    } catch (e) {
      throw new IpcGuardError({ code: 'precondition_failed', message: e instanceof Error ? e.message : 'The edit could not be worked out' });
    }
  });

  defineHandler('orders:saveEdit', ctx, async (_ctx, payload) => {
    const s = requireOrderCreate();
    const parsed = saveEditInputSchema.safeParse(payload);
    if (!parsed.success) {
      throw new IpcGuardError({ code: 'validation_failed', message: parsed.error.issues[0]?.message ?? 'Those changes are not valid' });
    }
    const input = parsed.data;
    const order = findOrder(ctx.db, input.orderId);
    if (!order) throw new IpcGuardError({ code: 'not_found', message: 'Order not found' });
    assertCounterMaySee(ctx.db, s, order, 'open');
    assertEditPicks(ctx.db, input.ops);
    assertBuy1Get1Hours(ctx.db, input.orderId, addedItems(input.ops));
    const actor = { userId: s.id, deviceId: ctx.deviceId };
    // What Save asks for (nothing written), then the manager's PIN when it asks for one: a
    // reason missing is refused first, so it never uses up a PIN attempt.
    let asked: OrderEditPreview;
    try {
      asked = previewOrderEdit(ctx.db, { orderId: input.orderId, ops: input.ops }, actor);
    } catch (e) {
      throw new IpcGuardError({ code: 'precondition_failed', message: e instanceof Error ? e.message : 'The edit could not be worked out' });
    }
    if (asked.needs.reason && discountReasonMissing(input.reason)) {
      throw new IpcGuardError({ code: 'validation_failed', message: EDIT_NEEDS_REASON });
    }
    let approverUserId: string | null = null;
    if (asked.needs.pin) {
      if (!input.approverPin) throw new IpcGuardError({ code: 'precondition_failed', message: editNeedsPinWords(asked.needs.why) });
      try {
        approverUserId = (await verifyManagerPin(ctx.db, input.approverPin)).approverUserId;
      } catch (e) {
        throw new IpcGuardError({ code: 'forbidden', message: e instanceof Error ? e.message : 'Manager approval failed' });
      }
    }
    // The order as it was: the lines taken off are read from it for the kitchen's slip.
    const base = getOrderSnapshot(ctx.db, input.orderId);
    if (!base) throw new IpcGuardError({ code: 'not_found', message: 'Order not found' });
    let saved: SavedOrderEdit;
    try {
      saved = saveOrderEdit(
        ctx.db,
        {
          orderId: input.orderId,
          baseKey: input.baseKey,
          ops: input.ops,
          approverUserId,
          reason: input.reason ?? null,
          ...(input.foodMade ? { foodMade: input.foodMade } : {}),
        },
        actor,
      );
    } catch (e) {
      throw new IpcGuardError({ code: 'precondition_failed', message: e instanceof Error ? e.message : 'The edit was not saved' });
    }
    // A Free order paid at Rs 0: its FBR invoice queued, as Pay's is (never blocks the edit) —
    // first, so a receipt printed for it below waits for the number as Pay's does.
    if (saved.completedFree) {
      try {
        const cfg = getFbrConfig(ctx.db);
        enqueueFbrSubmission(ctx.db, input.orderId, mapOrderToFbrPayload(saved.snapshot, toSellerInfo(cfg)), cfg.mode);
        fbrWorker.kick();
      } catch (e) {
        log.warn('FBR enqueue failed for a Free order (edit saved)', { orderId: input.orderId, error: e instanceof Error ? e.message : String(e) });
      }
    }
    // After the commit: the kitchen's CHANGE slip (what was added, what not to make), and the
    // bill again when one already went out.
    printSpooler.onOrderEdited(input.orderId, kitchenChangeOf(ctx.db, input.orderId, saved, base, s.id, input.reason ?? null));
    return ok({ snapshot: saved.snapshot, diff: saved.diff });
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

  // The owner, 28 Sep 2026: "if delivery area selected the delivery fee should be automatically
  // added". The customer panel's area, or its "Put it back": the repository decides
  // (syncOrderDeliveryCharge → deliveryChargeForArea) — the area's fee on a delivery, swapped when
  // the area changes, off when it is cleared; only on a CHANGE (a charge taken off by hand stays
  // off) unless putBack; never twice, never foodpanda or a website order. The customer save at
  // Send and Pay does the same inside its own transaction (snapshotCustomerOntoOrder).
  // `phone`: the panel's phone, for the add-on rule (no second charge while the same customer's
  // delivery is still in the shop) until the order has a phone of its own.
  defineHandler('orders:setDeliveryArea', ctx, (_ctx, payload) => {
    const s = requireOrderCreate();
    const area = typeof payload?.area === 'string' ? payload.area.slice(0, 200) : null;
    if (typeof payload?.orderId !== 'string') throw new IpcGuardError({ code: 'validation_failed', message: 'Which order?' });
    const putBack = payload?.putBack === true;
    const phone = deliveryAreaPhone(payload?.phone);
    // The repository's own refusals ("…inactive", "A foodpanda order never carries…") reach the
    // cashier through defineHandler as they are; a database error stays hidden behind a reference.
    try {
      syncOrderDeliveryCharge(ctx.db, payload.orderId, area, { userId: s.id, deviceId: ctx.deviceId }, { putBack, phone });
    } catch (e) {
      if (e instanceof Error && Object.getPrototypeOf(e) === Error.prototype && e.message === 'Order not found') {
        throw new IpcGuardError({ code: 'not_found', message: 'Order not found' });
      }
      throw e;
    }
    const snap = getOrderSnapshot(ctx.db, payload.orderId);
    if (!snap) throw new IpcGuardError({ code: 'not_found', message: 'Order not found' });
    return ok(snap);
  });

  // How a counter order came in (Walk-in · Phone · WhatsApp). While it is
  // being rung up, any login that takes orders sets it (the owner's automatic
  // offers follow). Once it is sent it is locked: a manager's PIN or password
  // changes it, audited, and the bill does not move.
  defineHandler('orders:setCameBy', ctx, async (_ctx, payload) => {
    const s = requireOrderCreate();
    const parsed = setCameByInputSchema.safeParse(payload);
    if (!parsed.success) {
      throw new IpcGuardError({ code: 'validation_failed', message: parsed.error.issues[0]?.message ?? 'Walk-in, Phone or WhatsApp' });
    }
    const { orderId, cameBy, approverPin } = parsed.data;
    const order = findOrder(ctx.db, orderId);
    if (!order) throw new IpcGuardError({ code: 'not_found', message: 'Order not found' });
    assertCounterMaySee(ctx.db, s, order, 'open');
    let approverUserId: string | null = null;
    if (order.status !== 'open' && (order.cameBy ?? null) !== cameBy) {
      if (!approverPin) throw new IpcGuardError({ code: 'precondition_failed', message: CAME_BY_LOCKED });
      try {
        approverUserId = (await verifyManagerPin(ctx.db, approverPin)).approverUserId;
      } catch (e) {
        throw new IpcGuardError({ code: 'forbidden', message: e instanceof Error ? e.message : 'Manager approval failed' });
      }
    }
    try {
      setOrderCameBy(ctx.db, orderId, cameBy, { userId: s.id, deviceId: ctx.deviceId }, { approverUserId });
    } catch (e) {
      throw new IpcGuardError({
        code: 'precondition_failed',
        message: e instanceof Error ? e.message : 'Could not change how the order came in',
      });
    }
    const snap = getOrderSnapshot(ctx.db, orderId);
    if (!snap) throw new IpcGuardError({ code: 'not_found', message: 'Order not found' });
    return ok(snap);
  });

  defineHandler('orders:tender', ctx, (_ctx, payload) => {
    const s = requireOrderCreate();
    requireLicenceForSales();
    const fp = foodpandaTenderCheckSchema.safeParse(payload.foodpanda ?? {});
    if (!fp.success) {
      throw new IpcGuardError({ code: 'validation_failed', message: fp.error.issues[0]?.message ?? 'Check the tablet total' });
    }
    let drawerOpenId: string | null;
    try {
      // Cash in the drawer: the drawer_opens row is written with the sale
      // (a foodpanda order has no cash leg: no row, and the drawer stays shut).
      drawerOpenId = tenderOrder(
        ctx.db,
        // drawerOpensOn: Settings → Printers, which sales open the drawer (0052).
        { orderId: payload.orderId, payments: payload.payments, foodpanda: fp.data, drawerOpensOn: getReceiptPrinterConfig(ctx.db)?.drawer?.opensOn ?? null },
        { userId: s.id, deviceId: ctx.deviceId },
      ).drawerOpenId;
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
    // A Free order is paid at Rs 0 as it goes (the repository): its FBR invoice queued, as Pay's is.
    if (snap.order.paidAt === null && next.order.paidAt !== null) {
      try {
        const cfg = getFbrConfig(ctx.db);
        enqueueFbrSubmission(ctx.db, payload.orderId, mapOrderToFbrPayload(next, toSellerInfo(cfg)), cfg.mode);
        fbrWorker.kick();
      } catch (e) {
        log.warn('FBR enqueue failed for a Free order (sent to the kitchen)', { orderId: payload.orderId, error: e instanceof Error ? e.message : String(e) });
      }
    }
    return ok(next);
  });

  defineHandler('orders:listActive', ctx, (_ctx, payload) => {
    requireOrderCreate();
    return ok(withKitchenTicketMarks(ctx.db, listActiveOrders(ctx.db, payload ?? {})));
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

  /**
   * A rider's money just came in (Delivered + Pay, Rider paid, or Send out
   * with "Paid now"): the drawer (only for the row the repository wrote with
   * the cash) and the paper, the FBR invoice and the stock — after the sale
   * is saved, and never stopping it. `when` names the step in the log;
   * `printEvent` is what the spooler hears ('sent_out_paid' when the food
   * left in the same step: the bill that goes with it prints now).
   */
  const riderMoneyTaken = (
    snap: OrderSnapshot,
    drawerOpenId: string | null,
    s: AuthenticatedUser,
    when: string,
    printEvent: 'payment_captured' | 'sent_out_paid' = 'payment_captured',
  ) => {
    const orderId = snap.order.id;
    printSpooler.onOrderEvent(orderId, printEvent, { drawerOpenId });
    try {
      const cfg = getFbrConfig(ctx.db);
      const fbrPayload = mapOrderToFbrPayload(snap, toSellerInfo(cfg));
      enqueueFbrSubmission(ctx.db, orderId, fbrPayload, cfg.mode);
      fbrWorker.kick();
    } catch (e) {
      // FBR mapping failure must not block the delivery flow.
      console.warn(`FBR enqueue failed on ${when} (sale not affected):`, e);
    }
    try {
      decrementForOrder(ctx.db, orderId, { userId: s.id, deviceId: ctx.deviceId });
    } catch (e) {
      console.warn(`Stock decrement failed on ${when} (sale not affected):`, e);
    }
  };

  // Send out (owner, 2 Oct 2026): an outside rider takes the order. Like
  // Assign rider, any login that takes orders and no manager PIN (the drawer
  // log and the close's riders row are the check). The repository freezes
  // what he keeps; the bill goes with the food, once per order on either till.
  // A prepaid order (owner Q2): the repository paid his delivery charge from
  // the drawer in the same transaction, and the drawer opens for that row
  // after the commit (no row, no pulse).
  // An add-on that now goes alone: 'Pay the rider Rs 200 for this trip'
  // ticked pays his trip from the drawer, with a manager's PIN or password as
  // a cancel's trip payout has (the repository checks there is a trip to pay).
  // "Paid now" (e2e fix A): `riderPayment` sends it out and takes the rider's
  // money in one step (sendOutRiderPaid: both or nothing); only then does
  // the bill print, once, so its SHOP COPY says RIDER PAID THE SHOP.
  defineHandler('orders:sendOut', ctx, async (_ctx, payload) => {
    const s = requireOrderCreate();
    let drawerOpenId: string | null;
    // One trip, one fee: only a true says the rider was already paid on another
    // order of this customer (the repository checks it again).
    const riderAlreadyPaid = payload.riderAlreadyPaid === true;
    // Paid now: how he paid, as the Rider paid box sent it (the repository
    // checks the method and what he keeps); anything but an object is refused.
    const rp: unknown = payload.riderPayment;
    if (rp !== undefined && rp !== null && typeof rp !== 'object') {
      throw new IpcGuardError({ code: 'precondition_failed', message: RIDER_PAYMENT_UNREADABLE });
    }
    const riderPayment =
      rp && typeof rp === 'object'
        ? (rp as { method?: unknown; referenceNo?: unknown; riderKeepsCents?: unknown })
        : null;
    // Only a true asks to pay the trip; it needs the manager's approval first.
    let payRiderForTrip: { approverUserId: string } | null = null;
    if (payload.payRiderForTrip === true) {
      if (typeof payload.approverPin !== 'string' || !payload.approverPin.trim()) {
        throw new IpcGuardError({ code: 'forbidden', message: "A manager's PIN or password is needed to pay the rider for the trip" });
      }
      try {
        payRiderForTrip = { approverUserId: (await verifyManagerPin(ctx.db, payload.approverPin)).approverUserId };
      } catch (e) {
        throw new IpcGuardError({
          code: 'forbidden',
          message: e instanceof Error ? e.message : 'Manager approval failed',
        });
      }
    }
    const sendOpts = {
      ...(riderAlreadyPaid ? { riderAlreadyPaid } : {}),
      ...(payRiderForTrip ? { payRiderForTrip } : {}),
    };
    if (riderPayment) {
      let done: ReturnType<typeof sendOutRiderPaid>;
      try {
        done = sendOutRiderPaid(
          ctx.db,
          {
            orderId: payload.orderId,
            method: riderPayment.method as PaymentMethod,
            referenceNo: typeof riderPayment.referenceNo === 'string' ? riderPayment.referenceNo : null,
            riderKeepsCents: riderPayment.riderKeepsCents as number,
          },
          { userId: s.id, deviceId: ctx.deviceId },
          sendOpts,
        );
      } catch (e) {
        // Nothing was written: the order is where it was, and nothing prints.
        throw new IpcGuardError({
          code: 'precondition_failed',
          message: e instanceof Error ? e.message : 'Send out failed',
        });
      }
      // His trip (an add-on going alone), paid from the drawer at Send out.
      if (done.sentDrawerOpenId) printSpooler.kickDrawerSoon(done.sentDrawerOpenId);
      const paidSnap = getOrderSnapshot(ctx.db, payload.orderId);
      if (!paidSnap) throw new IpcGuardError({ code: 'not_found', message: 'Order not found' });
      riderMoneyTaken(paidSnap, done.drawerOpenId, s, 'Send out (Paid now)', 'sent_out_paid');
      return ok(paidSnap);
    }
    try {
      drawerOpenId = sendOutOrder(ctx.db, payload.orderId, { userId: s.id, deviceId: ctx.deviceId }, sendOpts).drawerOpenId;
    } catch (e) {
      throw new IpcGuardError({
        code: 'precondition_failed',
        message: e instanceof Error ? e.message : 'Send out failed',
      });
    }
    if (drawerOpenId) printSpooler.kickDrawerSoon(drawerOpenId);
    const snap = getOrderSnapshot(ctx.db, payload.orderId);
    if (!snap) throw new IpcGuardError({ code: 'not_found', message: 'Order not found' });
    printSpooler.onOrderEvent(payload.orderId, 'dispatched');
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
        { orderId: payload.orderId, payment: payload.payment, drawerOpensOn: getReceiptPrinterConfig(ctx.db)?.drawer?.opensOn ?? null },
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
        // riderKeepsCents: what an outside rider keeps, as the window showed
        // it (absent for the shop's own riders); the repository checks it.
        // refusedItem: "Customer refused an item" — its part refund is owed
        // until it is done (only a true counts; the repository refuses it on
        // anything but an outside rider's Delivered + Pay).
        {
          orderId: payload.orderId,
          payment: payload.payment,
          riderKeepsCents: payload.riderKeepsCents,
          ...(payload.refusedItem === true ? { refusedItem: true } : {}),
          drawerOpensOn: getReceiptPrinterConfig(ctx.db)?.drawer?.opensOn ?? null,
        },
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
    // delivery prints nothing here: its bill left with the rider. So does
    // one an outside rider already paid for while out (Rider paid).
    if (payload.payment) riderMoneyTaken(snap, drawerOpenId, s, 'delivery');
    return ok(snap);
  });

  // Rider paid (owner, 2 Oct 2026: Send out asks "Has the rider paid the
  // shop?" -> Paid now): an outside rider pays the shop while he is still
  // out. Like Send out, any login that takes orders and no manager PIN. The
  // repository takes the full total his way and pays out what he keeps in
  // the same transaction, and leaves the order out for delivery; then, as
  // when a rider brings the money back: the drawer, the paper (the bill that
  // left with the food is the customer's: normally nothing more prints), FBR
  // and the stock, once. A refusal comes back in the repository's words.
  defineHandler('orders:riderPaid', ctx, (_ctx, payload) => {
    const s = requireOrderCreate();
    let drawerOpenId: string | null;
    try {
      drawerOpenId = takeRiderPayment(
        ctx.db,
        {
          orderId: payload.orderId,
          method: payload.method,
          referenceNo: payload.referenceNo ?? null,
          riderKeepsCents: payload.riderKeepsCents,
        },
        { userId: s.id, deviceId: ctx.deviceId },
      ).drawerOpenId;
    } catch (e) {
      throw new IpcGuardError({
        code: 'precondition_failed',
        message: e instanceof Error ? e.message : 'Rider paid failed',
      });
    }
    const snap = getOrderSnapshot(ctx.db, payload.orderId);
    if (!snap) throw new IpcGuardError({ code: 'not_found', message: 'Order not found' });
    riderMoneyTaken(snap, drawerOpenId, s, 'Rider paid');
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
    // A wasted trip (the owner, 2 Oct 2026: "pay the rider's fee if they
    // went"): the cancel box's answer for an outside rider who took it out.
    // Only a true or false is an answer; the repository refuses a cancel that
    // needs one and has none.
    const payRiderForTrip = typeof payload.payRiderForTrip === 'boolean' ? payload.payRiderForTrip : undefined;
    let done: ReturnType<typeof voidOrder>;
    try {
      done = voidOrder(
        ctx.db,
        {
          orderId: payload.orderId,
          reason: payload.reason.trim(),
          approverUserId,
          ...answer,
          ...(payRiderForTrip !== undefined ? { payRiderForTrip } : {}),
        },
        { userId: s.id, deviceId: ctx.deviceId },
      );
    } catch (e) {
      throw new IpcGuardError({
        code: 'precondition_failed',
        message: e instanceof Error ? e.message : 'Void failed',
      });
    }
    // He was paid for the trip from the drawer: it opens for that row, after the commit.
    if (done.drawerOpenId) printSpooler.kickDrawerSoon(done.drawerOpenId);
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

  // ---- How a paid order was paid, put right by the owner (v0.7.42) ----
  // The owner (admin) login only: a payment typed in as Cash that came by
  // JazzCash leaves the drawer short at the close (payment-method-repo.ts).

  defineHandler('orders:changePaymentMethod', ctx, (_ctx, payload) => {
    const s = requireAdmin(CHANGE_PAYMENT);
    const parsed = changePaymentMethodInputSchema.safeParse(payload);
    if (!parsed.success) {
      throw new IpcGuardError({ code: 'validation_failed', message: 'Pick Cash, Card, EasyPaisa, JazzCash or Bank transfer.' });
    }
    let change: ReturnType<typeof changePaymentMethod>;
    try {
      change = changePaymentMethod(ctx.db, parsed.data, { userId: s.id, deviceId: ctx.deviceId });
    } catch (e) {
      throw new IpcGuardError({
        code: 'precondition_failed',
        message: e instanceof Error ? e.message : 'Could not change how it was paid',
      });
    }
    const snap = getOrderSnapshot(ctx.db, parsed.data.orderId);
    if (!snap) throw new IpcGuardError({ code: 'not_found', message: 'Order not found' });
    return ok({ snapshot: snap, closedShift: change.closedShift });
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
 * An edit's choices, checked as Add and Customize check them: every new line
 * (add) and every new line's new choices (options: the line's item is its
 * add's, earlier in the same edit; a line the edit did not add is refused
 * by the repository in its own words).
 */
function assertEditPicks(db: AppDatabase, ops: ReadonlyArray<OrderEditOp>): void {
  const itemOf = new Map<string, string>();
  for (const op of ops) {
    if (op.op === 'add') {
      assertChoicePicks(db, op.menuItemId, op.modifierIds);
      itemOf.set(op.lineId, op.menuItemId);
    } else if (op.op === 'options') {
      const menuItemId = itemOf.get(op.orderItemId);
      if (menuItemId) assertChoicePicks(db, menuItemId, op.modifierIds);
    }
  }
}

/** The menu items an edit puts on the order (its 'add' ops), for the Buy 1 Get 1 hours. */
function addedItems(ops: ReadonlyArray<OrderEditOp>): string[] {
  return ops.flatMap((op) => (op.op === 'add' ? [op.menuItemId] : []));
}

/**
 * The kitchen's CHANGE slip for a saved edit: the food it added (read on the
 * order as it is now) and took off (read on the order as it was), never a
 * delivery charge, each marked a drink or not for the till's drinks rule;
 * numbered by the order's edits so far.
 */
function kitchenChangeOf(
  db: AppDatabase,
  orderId: string,
  saved: SavedOrderEdit,
  base: OrderSnapshot,
  byUserId: string,
  reason: string | null,
): KitchenChange {
  const line = (snap: OrderSnapshot, c: OrderEditChangeLine): KitchenChangeLine => {
    const it = snap.items.find((i) => i.id === c.lineId);
    return { name: c.menuItemName, quantity: c.quantity, modifiers: c.modifiers, notes: c.notes, drink: it ? isDrinkLine(it) : false };
  };
  const editNo = Number(
    (db.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE entity_type = 'orders' AND entity_id = ? AND action = 'order_edit'`).get(orderId) as {
      n: number;
    }).n,
  );
  return {
    editNo: Math.max(1, editNo),
    at: new Date().toISOString(),
    byUserId,
    reason: reason?.trim() || null,
    added: saved.diff.added.filter((l) => !l.fee).map((l) => line(saved.snapshot, l)),
    removed: saved.diff.removed.filter((l) => !l.fee).map((l) => line(base, l)),
  };
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
