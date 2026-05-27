import type { HandlerContext } from '../registry.js';
import { defineHandler, IpcGuardError } from '../registry.js';
import { ok, hasCapability } from '@cheeseoclock/shared-types';
import type { AuthenticatedUser } from '@cheeseoclock/shared-types';
import { getCurrentSession } from '../../services/auth-service.js';
import {
  listCategories,
  createCategory,
  updateCategory,
  deleteCategory,
} from '../../db/repositories/category-repo.js';
import {
  listMenuItems,
  createMenuItem,
  updateMenuItem,
  deleteMenuItem,
  findMenuItemByBarcode,
} from '../../db/repositories/menu-item-repo.js';
import {
  listModifierGroups,
  createModifierGroup,
  updateModifierGroup,
  deleteModifierGroup,
  createModifier,
  updateModifier,
  deleteModifier,
  listModifiersByGroup,
  listModifierGroupsForItem,
  setItemModifierGroups,
} from '../../db/repositories/modifier-repo.js';
import {
  listTaxCategories,
  createTaxCategory,
  updateTaxCategory,
  deleteTaxCategory,
} from '../../db/repositories/tax-category-repo.js';
import { listCombos } from '../../db/repositories/combo-repo.js';

function requireSession(): AuthenticatedUser {
  const session = getCurrentSession();
  if (!session) throw new IpcGuardError({ code: 'unauthenticated', message: 'Not logged in' });
  return session;
}

function requireMenuManage(): AuthenticatedUser {
  const session = requireSession();
  if (!hasCapability(session.role, 'menu.manage')) {
    throw new IpcGuardError({ code: 'forbidden', message: 'Menu management not allowed for this role' });
  }
  return session;
}

export function registerMenuHandlers(ctx: HandlerContext): void {
  // ---- Categories ----
  defineHandler('menu:listCategories', ctx, (_ctx, payload) => {
    requireSession();
    return ok(listCategories(ctx.db, { activeOnly: payload?.activeOnly }));
  });

  defineHandler('menu:createCategory', ctx, (_ctx, payload) => {
    const s = requireMenuManage();
    return ok(createCategory(ctx.db, payload, { userId: s.id, deviceId: ctx.deviceId }));
  });

  defineHandler('menu:updateCategory', ctx, (_ctx, payload) => {
    const s = requireMenuManage();
    return ok(updateCategory(ctx.db, payload, { userId: s.id, deviceId: ctx.deviceId }));
  });

  defineHandler('menu:deleteCategory', ctx, (_ctx, payload) => {
    const s = requireMenuManage();
    deleteCategory(ctx.db, payload.id, { userId: s.id, deviceId: ctx.deviceId });
    return ok({ id: payload.id });
  });

  // ---- Items ----
  defineHandler('menu:listItems', ctx, (_ctx, payload) => {
    requireSession();
    return ok(listMenuItems(ctx.db, payload ?? {}));
  });

  defineHandler('menu:findItemByBarcode', ctx, (_ctx, payload) => {
    requireSession();
    return ok(findMenuItemByBarcode(ctx.db, payload.barcode));
  });

  defineHandler('menu:createItem', ctx, (_ctx, payload) => {
    const s = requireMenuManage();
    return ok(createMenuItem(ctx.db, payload, { userId: s.id, deviceId: ctx.deviceId }));
  });

  defineHandler('menu:updateItem', ctx, (_ctx, payload) => {
    const s = requireMenuManage();
    return ok(updateMenuItem(ctx.db, payload, { userId: s.id, deviceId: ctx.deviceId }));
  });

  defineHandler('menu:deleteItem', ctx, (_ctx, payload) => {
    const s = requireMenuManage();
    deleteMenuItem(ctx.db, payload.id, { userId: s.id, deviceId: ctx.deviceId });
    return ok({ id: payload.id });
  });

  defineHandler('menu:listModifierGroupsForItem', ctx, (_ctx, payload) => {
    requireSession();
    const groups = listModifierGroupsForItem(ctx.db, payload.menuItemId);
    return ok(
      groups.map((g) => ({
        ...g,
        modifiers: listModifiersByGroup(ctx.db, g.id),
      })),
    );
  });

  defineHandler('menu:setItemModifierGroups', ctx, (_ctx, payload) => {
    const s = requireMenuManage();
    setItemModifierGroups(ctx.db, payload.menuItemId, payload.groups, {
      userId: s.id,
      deviceId: ctx.deviceId,
    });
    return ok({ menuItemId: payload.menuItemId });
  });

  // ---- Modifier groups + modifiers ----
  defineHandler('menu:listModifierGroups', ctx, () => {
    requireSession();
    const groups = listModifierGroups(ctx.db);
    return ok(groups.map((g) => ({ ...g, modifiers: listModifiersByGroup(ctx.db, g.id) })));
  });

  defineHandler('menu:createModifierGroup', ctx, (_ctx, payload) => {
    const s = requireMenuManage();
    return ok(createModifierGroup(ctx.db, payload, { userId: s.id, deviceId: ctx.deviceId }));
  });

  defineHandler('menu:updateModifierGroup', ctx, (_ctx, payload) => {
    const s = requireMenuManage();
    return ok(updateModifierGroup(ctx.db, payload, { userId: s.id, deviceId: ctx.deviceId }));
  });

  defineHandler('menu:deleteModifierGroup', ctx, (_ctx, payload) => {
    const s = requireMenuManage();
    deleteModifierGroup(ctx.db, payload.id, { userId: s.id, deviceId: ctx.deviceId });
    return ok({ id: payload.id });
  });

  defineHandler('menu:createModifier', ctx, (_ctx, payload) => {
    const s = requireMenuManage();
    return ok(createModifier(ctx.db, payload, { userId: s.id, deviceId: ctx.deviceId }));
  });

  defineHandler('menu:updateModifier', ctx, (_ctx, payload) => {
    const s = requireMenuManage();
    return ok(updateModifier(ctx.db, payload, { userId: s.id, deviceId: ctx.deviceId }));
  });

  defineHandler('menu:deleteModifier', ctx, (_ctx, payload) => {
    const s = requireMenuManage();
    deleteModifier(ctx.db, payload.id, { userId: s.id, deviceId: ctx.deviceId });
    return ok({ id: payload.id });
  });

  // ---- Combos (list-only for Phase 2; structure CRUD lands later) ----
  defineHandler('menu:listCombos', ctx, (_ctx, payload) => {
    requireSession();
    return ok(listCombos(ctx.db, { activeOnly: payload?.activeOnly }));
  });

  // ---- Tax categories ----
  defineHandler('menu:listTaxCategories', ctx, () => {
    requireSession();
    return ok(listTaxCategories(ctx.db));
  });

  defineHandler('menu:createTaxCategory', ctx, (_ctx, payload) => {
    const s = requireMenuManage();
    return ok(createTaxCategory(ctx.db, payload, { userId: s.id, deviceId: ctx.deviceId }));
  });

  defineHandler('menu:updateTaxCategory', ctx, (_ctx, payload) => {
    const s = requireMenuManage();
    return ok(updateTaxCategory(ctx.db, payload, { userId: s.id, deviceId: ctx.deviceId }));
  });

  defineHandler('menu:deleteTaxCategory', ctx, (_ctx, payload) => {
    const s = requireMenuManage();
    deleteTaxCategory(ctx.db, payload.id, { userId: s.id, deviceId: ctx.deviceId });
    return ok({ id: payload.id });
  });
}
