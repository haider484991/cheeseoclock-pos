import type { HandlerContext } from '../registry.js';
import { defineHandler, IpcGuardError } from '../registry.js';
import { ok, hasCapability } from '@cheeseoclock/shared-types';
import type { AuthenticatedUser, Customer } from '@cheeseoclock/shared-types';
import { normalizePhone } from '@cheeseoclock/pos-domain';
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
  deleteCustomer,
  getCustomerOrderHistory,
  snapshotCustomerOntoOrder,
} from '../../db/repositories/customer-repo.js';
import { getOrderSnapshot } from '../../db/repositories/order-repo.js';
import { requireAdmin, requireCapability, REFUSED } from '../guards.js';
import { exportCustomersCsv } from '../../services/customer-export.js';
import { assertCounterAddress, assertOrderStillBeingTaken } from '../order-access.js';

/**
 * Customers IPC. Two kinds of channel (owner, 2026-09-26):
 *
 *   The Customers page — `customers.manage` (managers and the owner): the
 *   list, searching it, the house-number search, a customer's past orders,
 *   and editing customers or their saved addresses. A phone book full of
 *   numbers (many of them women ordering delivery) gives the counter nothing
 *   and can be photographed; Toast, Square, Lightspeed and Clover all keep it
 *   for managers.
 *
 *   The counter — `order.create`: what taking an order needs, one customer at
 *   a time. findByPhone finds a customer only by their WHOLE number (at most
 *   one: phones are unique, migration 0006); get loads that customer's name
 *   and saved addresses (ids are UUIDv7, not guessable); create adds a new
 *   customer; createAddress saves the delivery address the customer just gave
 *   (and may make it their usual one); attachToOrder puts them on the draft;
 *   areaUsage is area names with counts of saved addresses, no people. A
 *   counter login gets a customer's name, phone and addresses only — not the
 *   email or the notes.
 */

function requireOrderCreate(): AuthenticatedUser {
  const session = getCurrentSession();
  if (!session) throw new IpcGuardError({ code: 'unauthenticated', message: 'Not logged in' });
  if (!hasCapability(session.role, 'order.create')) {
    throw new IpcGuardError({ code: 'forbidden', message: 'Not allowed' });
  }
  return session;
}

function requireCustomersManage(): AuthenticatedUser {
  return requireCapability('customers.manage', REFUSED.customers);
}

/** What the counter sees of a customer: no email, no notes. */
function forCounter<T extends Customer>(session: AuthenticatedUser, customer: T): T {
  if (hasCapability(session.role, 'customers.manage')) return customer;
  return { ...customer, email: null, notes: null };
}

export function registerCustomersHandlers(ctx: HandlerContext): void {
  defineHandler('customers:list', ctx, (_ctx, payload) => {
    requireCustomersManage();
    return ok(listCustomers(ctx.db, payload ?? {}));
  });

  defineHandler('customers:page', ctx, (_ctx, payload) => {
    requireCustomersManage();
    return ok(pageCustomers(ctx.db, payload));
  });

  defineHandler('customers:areaUsage', ctx, (_ctx, payload) => {
    requireOrderCreate();
    return ok(listAreaUsage(ctx.db, payload?.limit));
  });

  // Counter: the whole number or nothing. Part of a number ("0300", the last
  // few digits) never finds anyone, so the list can't be read a few at a
  // time. Managers keep the old lookup of a number saved as typed.
  defineHandler('customers:findByPhone', ctx, (_ctx, payload) => {
    const s = requireOrderCreate();
    const counter = !hasCapability(s.role, 'customers.manage');
    if (counter && !normalizePhone(typeof payload?.phone === 'string' ? payload.phone : '')) return ok(null);
    const found = findCustomerByPhone(ctx.db, payload.phone);
    return ok(found ? forCounter(s, found) : null);
  });

  defineHandler('customers:get', ctx, (_ctx, payload) => {
    const s = requireOrderCreate();
    const found = getCustomerWithAddresses(ctx.db, payload.id);
    return ok(found ? forCounter(s, found) : null);
  });

  defineHandler('customers:create', ctx, (_ctx, payload) => {
    const s = requireOrderCreate();
    // Returns the existing customer when that phone is already saved.
    return ok(forCounter(s, createCustomer(ctx.db, payload, { userId: s.id, deviceId: ctx.deviceId })));
  });

  defineHandler('customers:update', ctx, (_ctx, payload) => {
    const s = requireCustomersManage();
    return ok(updateCustomer(ctx.db, payload, { userId: s.id, deviceId: ctx.deviceId }));
  });

  defineHandler('customers:listAddresses', ctx, (_ctx, payload) => {
    requireCustomersManage();
    return ok(listAddresses(ctx.db, payload.customerId));
  });

  // "41-C" → every saved house starting with it, with its customer's name and
  // phone: a search across the whole customer list, so the Customers page's.
  defineHandler('customers:searchAddresses', ctx, (_ctx, payload) => {
    requireCustomersManage();
    return ok(searchAddresses(ctx.db, payload.query, payload.limit));
  });

  // Counter: the address the customer on the phone just gave, saved for them
  // (and, when asked, made the one filled in next time — a regular who moved
  // is fixed at the counter, not by a wrong delivery).
  defineHandler('customers:createAddress', ctx, (_ctx, payload) => {
    const s = requireOrderCreate();
    return ok(createAddress(ctx.db, payload, { userId: s.id, deviceId: ctx.deviceId }));
  });

  defineHandler('customers:setDefaultAddress', ctx, (_ctx, payload) => {
    const s = requireCustomersManage();
    setDefaultAddress(ctx.db, payload.addressId, { userId: s.id, deviceId: ctx.deviceId });
    return ok({ addressId: payload.addressId });
  });

  // Remove a person from the till (customers.manage): blanked and hidden with
  // every address; past bills keep what was printed on them.
  defineHandler('customers:delete', ctx, (_ctx, payload) => {
    const s = requireCustomersManage();
    const id = typeof payload?.id === 'string' ? payload.id : '';
    if (!id) throw new IpcGuardError({ code: 'validation_failed', message: 'Which customer?' });
    try {
      deleteCustomer(ctx.db, id, { userId: s.id, deviceId: ctx.deviceId });
    } catch (e) {
      if (e instanceof Error && e.message === 'Customer not found') {
        throw new IpcGuardError({ code: 'not_found', message: 'That customer is no longer on the till.' });
      }
      throw e;
    }
    return ok({ id });
  });

  // The whole customer book as a file: the owner only.
  defineHandler('customers:exportCsv', ctx, async () => {
    const owner = requireAdmin('Saving the customer list as a file');
    return ok(await exportCustomersCsv(ctx.db, owner.id));
  });

  defineHandler('customers:deleteAddress', ctx, (_ctx, payload) => {
    const s = requireCustomersManage();
    deleteAddress(ctx.db, payload.addressId, { userId: s.id, deviceId: ctx.deviceId });
    return ok({ addressId: payload.addressId });
  });

  defineHandler('customers:orderHistory', ctx, (_ctx, payload) => {
    requireCustomersManage();
    return ok(getCustomerOrderHistory(ctx.db, payload.customerId, payload.limit));
  });

  // Freeze a customer onto an order. Like orders:attachCustomer, plus an
  // optional per-order name — the till can write "Ali (office)" on one
  // delivery without renaming the customer's master record. Only the draft
  // still being rung up; at the counter only that customer's own address.
  defineHandler('customers:attachToOrder', ctx, (_ctx, payload) => {
    const s = requireOrderCreate();
    assertOrderStillBeingTaken(ctx.db, payload.orderId);
    assertCounterAddress(ctx.db, s, payload.customerId, payload.addressId);
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
