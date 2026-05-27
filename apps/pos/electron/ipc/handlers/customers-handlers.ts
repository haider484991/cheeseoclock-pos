import type { HandlerContext } from '../registry.js';
import { defineHandler, IpcGuardError } from '../registry.js';
import { ok, hasCapability } from '@cheeseoclock/shared-types';
import type { AuthenticatedUser } from '@cheeseoclock/shared-types';
import { getCurrentSession } from '../../services/auth-service.js';
import {
  listCustomers,
  findCustomerByPhone,
  getCustomerWithAddresses,
  createCustomer,
  updateCustomer,
  listAddresses,
  createAddress,
  setDefaultAddress,
  deleteAddress,
  getCustomerOrderHistory,
} from '../../db/repositories/customer-repo.js';

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
}
