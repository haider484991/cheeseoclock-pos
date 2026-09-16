import type { ZodError } from 'zod';
import type { HandlerContext } from '../registry.js';
import { defineHandler, IpcGuardError } from '../registry.js';
import { ok, err, hasCapability } from '@cheeseoclock/shared-types';
import type { AuthenticatedUser } from '@cheeseoclock/shared-types';
import {
  createIngredientInputSchema,
  updateIngredientInputSchema,
  setRecipeInputSchema,
  recordMovementInputSchema,
  createPurchaseOrderInputSchema,
  receiveDeliveryInputSchema,
} from '@cheeseoclock/shared-schemas';
import { getCurrentSession } from '../../services/auth-service.js';
import {
  listIngredients,
  createIngredient,
  updateIngredient,
  deleteIngredient,
  listRecipeForItem,
  setRecipeForItem,
} from '../../db/repositories/ingredient-repo.js';
import {
  listMovements,
  recordStockMovement,
} from '../../db/repositories/stock-movement-repo.js';
import {
  listSuppliers,
  createSupplier,
  updateSupplier,
  listPurchaseOrders,
  getPurchaseOrderWithItems,
  createPurchaseOrder,
  setPurchaseOrderStatus,
  receiveDelivery,
} from '../../db/repositories/procurement-repo.js';

function requireSession(): AuthenticatedUser {
  const session = getCurrentSession();
  if (!session) throw new IpcGuardError({ code: 'unauthenticated', message: 'Not logged in' });
  return session;
}

function requireInventoryManage(): AuthenticatedUser {
  const session = requireSession();
  // Inventory editing requires menu.manage (admin/manager). Reuse the existing capability
  // rather than adding a new one for now.
  if (!hasCapability(session.role, 'menu.manage')) {
    throw new IpcGuardError({
      code: 'forbidden',
      message: 'Inventory management requires manager or admin role',
    });
  }
  return session;
}

/**
 * Quantities and cents are INTEGER columns; a fractional value from the
 * renderer would land in SQLite as REAL. Reject it here with the field named,
 * before any repository runs.
 */
function validationFailed(error: ZodError) {
  const first = error.issues[0];
  const path = first?.path.join('.');
  return err({
    code: 'validation_failed',
    message: first ? (path ? `${path}: ${first.message}` : first.message) : 'Invalid input',
    details: error.flatten(),
  });
}

export function registerInventoryHandlers(ctx: HandlerContext): void {
  // ---- Ingredients ----
  defineHandler('inventory:listIngredients', ctx, (_ctx, payload) => {
    requireSession();
    return ok(listIngredients(ctx.db, payload ?? {}));
  });

  defineHandler('inventory:createIngredient', ctx, (_ctx, payload) => {
    const s = requireInventoryManage();
    const parsed = createIngredientInputSchema.safeParse(payload);
    if (!parsed.success) return validationFailed(parsed.error);
    return ok(createIngredient(ctx.db, parsed.data, { userId: s.id, deviceId: ctx.deviceId }));
  });

  defineHandler('inventory:updateIngredient', ctx, (_ctx, payload) => {
    const s = requireInventoryManage();
    const parsed = updateIngredientInputSchema.safeParse(payload);
    if (!parsed.success) return validationFailed(parsed.error);
    return ok(updateIngredient(ctx.db, parsed.data, { userId: s.id, deviceId: ctx.deviceId }));
  });

  defineHandler('inventory:deleteIngredient', ctx, (_ctx, payload) => {
    const s = requireInventoryManage();
    deleteIngredient(ctx.db, payload.id, { userId: s.id, deviceId: ctx.deviceId });
    return ok({ id: payload.id });
  });

  // ---- Recipes ----
  defineHandler('inventory:getRecipe', ctx, (_ctx, payload) => {
    requireSession();
    return ok(listRecipeForItem(ctx.db, payload.menuItemId));
  });

  defineHandler('inventory:setRecipe', ctx, (_ctx, payload) => {
    const s = requireInventoryManage();
    const parsed = setRecipeInputSchema.safeParse(payload);
    if (!parsed.success) return validationFailed(parsed.error);
    setRecipeForItem(ctx.db, parsed.data.menuItemId, parsed.data.lines, {
      userId: s.id,
      deviceId: ctx.deviceId,
    });
    return ok({ menuItemId: parsed.data.menuItemId });
  });

  // ---- Movements ----
  defineHandler('inventory:listMovements', ctx, (_ctx, payload) => {
    requireSession();
    return ok(listMovements(ctx.db, payload ?? {}));
  });

  defineHandler('inventory:recordMovement', ctx, (_ctx, payload) => {
    const s = requireInventoryManage();
    const parsed = recordMovementInputSchema.safeParse(payload);
    if (!parsed.success) return validationFailed(parsed.error);
    return ok(recordStockMovement(ctx.db, parsed.data, { userId: s.id, deviceId: ctx.deviceId }));
  });

  // ---- Suppliers ----
  defineHandler('inventory:listSuppliers', ctx, (_ctx, payload) => {
    requireSession();
    return ok(listSuppliers(ctx.db, payload ?? {}));
  });

  defineHandler('inventory:createSupplier', ctx, (_ctx, payload) => {
    const s = requireInventoryManage();
    return ok(createSupplier(ctx.db, payload, { userId: s.id, deviceId: ctx.deviceId }));
  });

  defineHandler('inventory:updateSupplier', ctx, (_ctx, payload) => {
    const s = requireInventoryManage();
    return ok(updateSupplier(ctx.db, payload, { userId: s.id, deviceId: ctx.deviceId }));
  });

  // ---- Purchase orders ----
  defineHandler('inventory:listPurchaseOrders', ctx, (_ctx, payload) => {
    requireSession();
    return ok(listPurchaseOrders(ctx.db, payload ?? {}));
  });

  defineHandler('inventory:getPurchaseOrder', ctx, (_ctx, payload) => {
    requireSession();
    return ok(getPurchaseOrderWithItems(ctx.db, payload.id));
  });

  defineHandler('inventory:createPurchaseOrder', ctx, (_ctx, payload) => {
    const s = requireInventoryManage();
    const parsed = createPurchaseOrderInputSchema.safeParse(payload);
    if (!parsed.success) return validationFailed(parsed.error);
    return ok(createPurchaseOrder(ctx.db, parsed.data, { userId: s.id, deviceId: ctx.deviceId }));
  });

  defineHandler('inventory:setPurchaseOrderStatus', ctx, (_ctx, payload) => {
    const s = requireInventoryManage();
    setPurchaseOrderStatus(ctx.db, payload.id, payload.status, {
      userId: s.id,
      deviceId: ctx.deviceId,
    });
    return ok({ ok: true } as const);
  });

  defineHandler('inventory:receiveDelivery', ctx, (_ctx, payload) => {
    const s = requireInventoryManage();
    const parsed = receiveDeliveryInputSchema.safeParse(payload);
    if (!parsed.success) return validationFailed(parsed.error);
    return ok(receiveDelivery(ctx.db, parsed.data, { userId: s.id, deviceId: ctx.deviceId }));
  });
}
