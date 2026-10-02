import type { HandlerContext } from '../registry.js';
import { defineHandler, IpcGuardError } from '../registry.js';
import { ok, err, hasCapability, categoryNeverDiscounted, WEB_AVAILABILITIES } from '@cheeseoclock/shared-types';
import type { AuthenticatedUser } from '@cheeseoclock/shared-types';
import { getCurrentSession } from '../../services/auth-service.js';
import {
  listCategories,
  findCategory,
  createCategory,
  updateCategory,
  deleteCategory,
  categoryIdNeverDiscounted,
} from '../../db/repositories/category-repo.js';
import {
  listMenuItems,
  findMenuItem,
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
import {
  pickMenuImport,
  previewPickedMenuImport,
  applyPickedMenuImport,
  MenuImportFileError,
} from '../../services/menu-import-service.js';
import { MenuImportRefusedError } from '../../db/repositories/menu-import-repo.js';
import { requireAdmin, requireCapability } from '../guards.js';
import log from 'electron-log/main';
import { webOrdersBridge } from '../../services/web-orders-bridge.js';
import {
  categoryEditProblem,
  menuItemDeleteProblem,
  menuItemEditProblem,
  menuItemNameProblem,
} from '../../services/delivery-fee-items.js';

/** A delivery charge is Settings → Delivery areas': Menu's change refused, in words a manager can act on. */
function refuseIf(problem: string | null): void {
  if (problem) throw new IpcGuardError({ code: 'precondition_failed', message: problem });
}

/**
 * The website fields a Menu save may carry (migration 0045): an item's
 * webAvailability ('on' | 'pickup_only' | 'off') and a category's
 * isOnWebsite (yes / no). Absent = unchanged (the default on a new row).
 * Anything else is refused before a row is touched.
 */
function checkWebsiteFields(payload: { webAvailability?: unknown; isOnWebsite?: unknown }): void {
  const w = payload.webAvailability;
  if (w !== undefined && !(WEB_AVAILABILITIES as readonly unknown[]).includes(w)) {
    throw new IpcGuardError({
      code: 'validation_failed',
      message: 'Say where it sells on the website: on the website, pick-up only, or not on the website',
    });
  }
  const c = payload.isOnWebsite;
  if (c !== undefined && typeof c !== 'boolean') {
    throw new IpcGuardError({ code: 'validation_failed', message: 'Say whether the category is on the website: yes or no' });
  }
}

/**
 * Never discounted, a category's (migration 0047; the owner's rule,
 * 2026-10-02): yes or no; absent = unchanged (a new category: by its name).
 * Anything else is refused before a row is touched. A value other than what
 * the category does `now` (a new one: what its name says) is the owner's
 * alone (settings.manage): a manager may edit the menu, but must not put the
 * discounts back on the value deals. The same answer (a box left as it was)
 * needs no one more, and neither does a rename: the repository keeps the
 * old name's answer. `now` undefined: no such category (the update says so).
 */
function checkNoDiscount(payload: { noDiscount?: unknown }, now: boolean | undefined): void {
  const v = payload.noDiscount;
  if (v === undefined) return;
  if (typeof v !== 'boolean') {
    throw new IpcGuardError({ code: 'validation_failed', message: 'Say whether its items are never discounted: yes or no' });
  }
  if (now !== undefined && v !== now) {
    requireCapability('settings.manage', NEVER_DISCOUNTED_OWNER_ONLY);
  }
}

/** The refusal when a manager changes which items are never discounted (a category's box, or an item moved across). */
const NEVER_DISCOUNTED_OWNER_ONLY = 'Only the owner can change which items are never discounted.';

/**
 * Moving an item to another category (Menu → Items, `categoryId`) changes
 * whether it is never discounted when the two categories answer
 * differently (a value deal moved in with the pizzas, or a pizza moved in
 * with the deals): the owner's alone (settings.manage), as the category's
 * own box is — a manager may edit the menu, but must not put the discounts
 * back on the value deals. A move between two categories that answer the
 * same, or no move, needs no one more. A new item has no answer yet to
 * change: it takes its category's, like any item added to it.
 */
function checkItemMove(ctx: HandlerContext, payload: { id: string; categoryId?: unknown }): void {
  if (typeof payload.categoryId !== 'string') return;
  const item = findMenuItem(ctx.db, payload.id);
  if (!item || item.categoryId === payload.categoryId) return;
  if (categoryIdNeverDiscounted(ctx.db, item.categoryId) !== categoryIdNeverDiscounted(ctx.db, payload.categoryId)) {
    requireCapability('settings.manage', NEVER_DISCOUNTED_OWNER_ONLY);
  }
}

/**
 * The menu changed on this till: with "Publish the menu to the website by
 * itself" on (Settings → Online orders), the bridge sends it a moment later
 * (debounced). Off — the default — nothing happens, as before.
 */
function menuChanged(): void {
  webOrdersBridge.menuChanged();
}

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
    checkWebsiteFields(payload);
    // Never a caller's id: name-based ids are Settings → Delivery areas' own.
    const { name, displayOrder, colorHex, isOnWebsite, noDiscount } = payload;
    checkNoDiscount(payload, categoryNeverDiscounted({ name }));
    const out = createCategory(
      ctx.db,
      {
        name,
        displayOrder,
        colorHex,
        ...(isOnWebsite !== undefined ? { isOnWebsite } : {}),
        ...(noDiscount !== undefined ? { noDiscount } : {}),
      },
      { userId: s.id, deviceId: ctx.deviceId },
    );
    menuChanged();
    return ok(out);
  });

  defineHandler('menu:updateCategory', ctx, (_ctx, payload) => {
    const s = requireMenuManage();
    checkWebsiteFields(payload);
    const current = findCategory(ctx.db, payload.id);
    checkNoDiscount(payload, current ? categoryNeverDiscounted(current) : undefined);
    refuseIf(categoryEditProblem(ctx.db, payload.id, { isActive: payload.isActive }));
    const out = updateCategory(ctx.db, payload, { userId: s.id, deviceId: ctx.deviceId });
    menuChanged();
    return ok(out);
  });

  defineHandler('menu:deleteCategory', ctx, (_ctx, payload) => {
    const s = requireMenuManage();
    refuseIf(categoryEditProblem(ctx.db, payload.id, { delete: true }));
    deleteCategory(ctx.db, payload.id, { userId: s.id, deviceId: ctx.deviceId });
    menuChanged();
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
    checkWebsiteFields(payload);
    refuseIf(menuItemNameProblem(payload.name));
    // Never a caller's id: name-based ids are Settings → Delivery areas' own.
    const { id: _id, ...input } = payload as typeof payload & { id?: unknown };
    const out = createMenuItem(ctx.db, input, { userId: s.id, deviceId: ctx.deviceId });
    menuChanged();
    return ok(out);
  });

  defineHandler('menu:updateItem', ctx, (_ctx, payload) => {
    const s = requireMenuManage();
    checkWebsiteFields(payload);
    checkItemMove(ctx, payload);
    refuseIf(menuItemEditProblem(ctx.db, payload.id, payload));
    const out = updateMenuItem(ctx.db, payload, { userId: s.id, deviceId: ctx.deviceId });
    menuChanged();
    return ok(out);
  });

  defineHandler('menu:deleteItem', ctx, (_ctx, payload) => {
    const s = requireMenuManage();
    refuseIf(menuItemDeleteProblem(ctx.db, payload.id));
    deleteMenuItem(ctx.db, payload.id, { userId: s.id, deviceId: ctx.deviceId });
    menuChanged();
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

  // ---- Import from a menu file ----
  defineHandler('menu:importPick', ctx, async () => {
    requireMenuManage();
    try {
      return ok(await pickMenuImport(ctx.db));
    } catch (e) {
      if (e instanceof MenuImportFileError) return err({ code: 'validation_failed', message: e.message });
      throw e;
    }
  });

  defineHandler('menu:importPreview', ctx, (_ctx, payload) => {
    requireMenuManage();
    try {
      return ok(previewPickedMenuImport(ctx.db, payload.fresh));
    } catch (e) {
      if (e instanceof MenuImportFileError) return err({ code: 'precondition_failed', message: e.message });
      throw e;
    }
  });

  defineHandler('menu:importApply', ctx, (_ctx, payload) => {
    const fresh = payload?.fresh === true;
    // Replacing the whole menu is the owner's call; updating it is a manager's.
    const s = fresh ? requireAdmin('Replacing the whole menu') : requireMenuManage();
    try {
      const result = applyPickedMenuImport(ctx.db, { userId: s.id, deviceId: ctx.deviceId }, { fresh });
      // The website sells from the menu the till last published. After an
      // import that is stale (old prices, missing choices) — after a fresh
      // start every item it knows is gone and every web order fails — and
      // nothing told anyone to press Publish (audit 2026-09-25). Publish now,
      // best effort: a till with no website set up just skips it.
      void webOrdersBridge.publishMenu().catch((e: unknown) =>
        log.warn('Menu publish after import skipped', { error: e instanceof Error ? e.message : String(e) }),
      );
      return ok(result);
    } catch (e) {
      if (e instanceof MenuImportFileError || e instanceof MenuImportRefusedError) {
        return err({ code: 'precondition_failed', message: e.message });
      }
      throw e;
    }
  });

  defineHandler('menu:setItemModifierGroups', ctx, (_ctx, payload) => {
    const s = requireMenuManage();
    setItemModifierGroups(ctx.db, payload.menuItemId, payload.groups, {
      userId: s.id,
      deviceId: ctx.deviceId,
    });
    menuChanged();
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
    const out = createModifierGroup(ctx.db, payload, { userId: s.id, deviceId: ctx.deviceId });
    menuChanged();
    return ok(out);
  });

  defineHandler('menu:updateModifierGroup', ctx, (_ctx, payload) => {
    const s = requireMenuManage();
    const out = updateModifierGroup(ctx.db, payload, { userId: s.id, deviceId: ctx.deviceId });
    menuChanged();
    return ok(out);
  });

  defineHandler('menu:deleteModifierGroup', ctx, (_ctx, payload) => {
    const s = requireMenuManage();
    deleteModifierGroup(ctx.db, payload.id, { userId: s.id, deviceId: ctx.deviceId });
    menuChanged();
    return ok({ id: payload.id });
  });

  defineHandler('menu:createModifier', ctx, (_ctx, payload) => {
    const s = requireMenuManage();
    const out = createModifier(ctx.db, payload, { userId: s.id, deviceId: ctx.deviceId });
    menuChanged();
    return ok(out);
  });

  defineHandler('menu:updateModifier', ctx, (_ctx, payload) => {
    const s = requireMenuManage();
    const out = updateModifier(ctx.db, payload, { userId: s.id, deviceId: ctx.deviceId });
    menuChanged();
    return ok(out);
  });

  defineHandler('menu:deleteModifier', ctx, (_ctx, payload) => {
    const s = requireMenuManage();
    deleteModifier(ctx.db, payload.id, { userId: s.id, deviceId: ctx.deviceId });
    menuChanged();
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
    const out = createTaxCategory(ctx.db, payload, { userId: s.id, deviceId: ctx.deviceId });
    menuChanged();
    return ok(out);
  });

  defineHandler('menu:updateTaxCategory', ctx, (_ctx, payload) => {
    const s = requireMenuManage();
    const out = updateTaxCategory(ctx.db, payload, { userId: s.id, deviceId: ctx.deviceId });
    menuChanged();
    return ok(out);
  });

  defineHandler('menu:deleteTaxCategory', ctx, (_ctx, payload) => {
    const s = requireMenuManage();
    deleteTaxCategory(ctx.db, payload.id, { userId: s.id, deviceId: ctx.deviceId });
    menuChanged();
    return ok({ id: payload.id });
  });
}
