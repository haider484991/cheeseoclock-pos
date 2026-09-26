import type { HandlerContext } from '../registry.js';
import { defineHandler, IpcGuardError } from '../registry.js';
import { ok, hasCapability } from '@cheeseoclock/shared-types';
import type { AuthenticatedUser } from '@cheeseoclock/shared-types';
import { getCurrentSession } from '../../services/auth-service.js';
import {
  listCustomers,
  pageCustomers,
  listAreaUsage,
  findCustomerByPhone,
  getCustomerWithAddresses,
  createCustomer,
  updateCustomer,
  listAddresses,
  searchAddresses,
  createAddress,
  setDefaultAddress,
  deleteAddress,
  getCustomerOrderHistory,
  snapshotCustomerOntoOrder,
} from '../../db/repositories/customer-repo.js';
import { getOrderSnapshot } from '../../db/repositories/order-repo.js';

function requireOrderCreate(): AuthenticatedUser {
  const session = getCurrentSession();
  if (!session) throw new IpcGuardError({ code: 'unauthenticated', message: 'Not logged in' });
  if (!hasCapability(session.role, 'order.create')) {
    throw new IpcGuardError({ code: 'forbidden', message: 'Not allowed' });
  }
  return session;
}

export function registerCustomersHandlers(ctx: HandlerContext): void {
  defineHandler('customers:list', ctx, (_ctx, payload) => {
    requireOrderCreate();
    return ok(listCustomers(ctx.db, payload ?? {}));
  });

  defineHandler('customers:page', ctx, (_ctx, payload) => {
    requireOrderCreate();
    return ok(pageCustomers(ctx.db, payload));
  });

  defineHandler('customers:areaUsage', ctx, (_ctx, payload) => {
    requireOrderCreate();
    return ok(listAreaUsage(ctx.db, payload?.limit));
  });

  defineHandler('customers:findByPhone', ctx, (_ctx, payload) => {
    requireOrderCreate();
    return ok(findCustomerByPhone(ctx.db, payload.phone));
  });

  defineHandler('customers:get', ctx, (_ctx, payload) => {
    requireOrderCreate();
    return ok(getCustomerWithAddresses(ctx.db, payload.id));
  });

  defineHandler('customers:create', ctx, (_ctx, payload) => {
    const s = requireOrderCreate();
    return ok(createCustomer(ctx.db, payload, { userId: s.id, deviceId: ctx.deviceId }));
  });

  defineHandler('customers:update', ctx, (_ctx, payload) => {
    const s = requireOrderCreate();
    return ok(updateCustomer(ctx.db, payload, { userId: s.id, deviceId: ctx.deviceId }));
  });

  defineHandler('customers:listAddresses', ctx, (_ctx, payload) => {
    requireOrderCreate();
    return ok(listAddresses(ctx.db, payload.customerId));
  });

  defineHandler('customers:searchAddresses', ctx, (_ctx, payload) => {
    requireOrderCreate();
    return ok(searchAddresses(ctx.db, payload.query, payload.limit));
  });

  defineHandler('customers:createAddress', ctx, (_ctx, payload) => {
    const s = requireOrderCreate();
    return ok(createAddress(ctx.db, payload, { userId: s.id, deviceId: ctx.deviceId }));
  });

  defineHandler('customers:setDefaultAddress', ctx, (_ctx, payload) => {
    const s = requireOrderCreate();
    setDefaultAddress(ctx.db, payload.addressId, { userId: s.id, deviceId: ctx.deviceId });
    return ok({ addressId: payload.addressId });
  });

  defineHandler('customers:deleteAddress', ctx, (_ctx, payload) => {
    const s = requireOrderCreate();
    deleteAddress(ctx.db, payload.addressId, { userId: s.id, deviceId: ctx.deviceId });
    return ok({ addressId: payload.addressId });
  });

  defineHandler('customers:orderHistory', ctx, (_ctx, payload) => {
    requireOrderCreate();
    return ok(getCustomerOrderHistory(ctx.db, payload.customerId, payload.limit));
  });

  // Freeze a customer onto an order. Like orders:attachCustomer, plus an
  // optional per-order name — the till can write "Ali (office)" on one
  // delivery without renaming the customer's master record.
  defineHandler('customers:attachToOrder', ctx, (_ctx, payload) => {
    const s = requireOrderCreate();
    const nameOverride = payload.nameOverride?.trim();
    try {
      snapshotCustomerOntoOrder(
        ctx.db,
        {
          orderId: payload.orderId,
          customerId: payload.customerId,
          addressId: payload.addressId ?? null,
          ...(payload.deliveryNotes !== undefined ? { deliveryNotes: payload.deliveryNotes } : {}),
          ...(nameOverride ? { nameOverride } : {}),
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
}
