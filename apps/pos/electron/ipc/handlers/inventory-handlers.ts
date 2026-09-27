import type { ZodError } from 'zod';
import type { HandlerContext } from '../registry.js';
import { defineHandler, IpcGuardError } from '../registry.js';
import { COST_CAPABILITY, ok, err, hasCapability } from '@cheeseoclock/shared-types';
import { OTHER_TILL_MISSING, movementWithoutCosts, otherTillMissing, staleLinkText } from '@cheeseoclock/pos-domain';
import type { AuthenticatedUser, StockCountDetail, StockCountFinish } from '@cheeseoclock/shared-types';
import {
  createIngredientInputSchema,
  updateIngredientInputSchema,
  convertIngredientUnitInputSchema,
  setRecipeInputSchema,
  setBatchRecipeInputSchema,
  makeBatchInputSchema,
  recordMovementInputSchema,
  createPurchaseOrderInputSchema,
  receiveDeliveryInputSchema,
  setPurchaseOrderStatusInputSchema,
  createSupplierInputSchema,
  updateSupplierInputSchema,
  searchMovementsInputSchema,
  setPriceInputSchema,
  priceHistoryInputSchema,
  recordPurchaseInputSchema,
  payoutToPurchaseInputSchema,
  listDrawerPayoutsInputSchema,
  useSheetPriceInputSchema,
  startStockCountInputSchema,
  saveStockCountLinesInputSchema,
  stockCountIdInputSchema,
  listStockCountsInputSchema,
  countOneInputSchema,
} from '@cheeseoclock/shared-schemas';
import { getCurrentSession } from '../../services/auth-service.js';
import { requireCapability, REFUSED } from '../guards.js';
import {
  listIngredients,
  createIngredient,
  updateIngredient,
  deleteIngredient,
  convertIngredientToBaseUnit,
  listRecipeForItem,
  listRecipeLineCounts,
  setRecipeForItem,
} from '../../db/repositories/ingredient-repo.js';
import {
  listMovements,
  recordStockMovement,
} from '../../db/repositories/stock-movement-repo.js';
import { searchMovements } from '../../db/repositories/stock-movement-search.js';
import { getBatchRecipe, setBatchRecipe, makeBatch } from '../../db/repositories/batch-recipe-repo.js';
import { setTypedPrice, useSheetPrice } from '../../db/repositories/ingredient-cost-repo.js';
import { findIngredient } from '../../db/repositories/ingredient-repo.js';
import { latestPriceTags, listPriceHistory, readSheetPrices } from '../../db/price-history-read.js';
import { loadPriceBook } from '../../db/price-book.js';
import {
  listSuppliers,
  createSupplier,
  updateSupplier,
  listPurchaseOrders,
  getPurchaseOrderWithItems,
  createPurchaseOrder,
  setPurchaseOrderStatus,
  receiveDelivery,
  recordPurchase,
  payoutToPurchase,
} from '../../db/repositories/procurement-repo.js';
import { listDrawerPayouts } from '../../db/repositories/shift-repo.js';
import {
  cancelStockCount,
  countOneIngredient,
  finishStockCount,
  getStockCount,
  listStockCounts,
  saveStockCountLines,
  startStockCount,
} from '../../db/repositories/stock-count-repo.js';
import { sellingTillsOf } from '../../services/analytics/stock-control.js';
import { readTillLink } from '../../services/till-link.js';
import { getAnalyticsWorker } from '../../services/analytics/worker-host.js';
import type { AppDatabase } from '../../db/connection.js';

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
 * Reading stock, recipes, stock movements (waste included), suppliers and
 * purchase orders: the Inventory page's, so managers and the owner. Costs and
 * stock are the owner's business data, and no counter screen reads them
 * (owner, 2026-09-26). Making a batch stays open to anyone logged in.
 */
function requireStockView(): AuthenticatedUser {
  return requireCapability('menu.manage', REFUSED.stock);
}

/**
 * Stock rows carry what they were worth (costing spec Phase 2). Costs are the
 * owner's business figures: a login without COST_CAPABILITY gets the rows
 * without them, in the main process, not only hidden on screen.
 */
function mayViewCosts(s: AuthenticatedUser): boolean {
  return hasCapability(s.role, COST_CAPABILITY);
}

/**
 * A purchase paid from the drawer: the drawer opens for the notes, as for
 * any cash taken out (a failure is a toast, never an error). Loaded when
 * needed: the printer code is the main process's, not the repositories'.
 */
function kickDrawer(): void {
  void import('../../services/print-spooler.js')
    .then((m) => m.printSpooler.kickDrawerSoon())
    .catch(() => undefined);
}

/**
 * Stock takes (costing spec Phase 8) show what the stock is worth and what
 * went missing: managers and the owner (COST_CAPABILITY). A cashier is
 * refused here, in the main process.
 */
function requireStockTakes(): AuthenticatedUser {
  return requireCapability(COST_CAPABILITY, REFUSED.stockTakes);
}

/**
 * The sentence beside a finished stock take's "expected" when it may be
 * short of the other till's rows (costing spec D14): two tills take orders
 * with the link off, or the link is on but has not worked lately. Null
 * with nothing to say (one till, link off: the shop as it runs).
 */
function expectedNote(db: AppDatabase): string | null {
  const link = readTillLink(db);
  if (otherTillMissing(sellingTillsOf(db), link)) {
    return `${OTHER_TILL_MISSING}, so "expected" counts only the sales rung here.`;
  }
  return staleLinkText(link);
}

function finished(db: AppDatabase, r: { count: StockCountDetail; alreadyFinished: boolean }): StockCountFinish {
  // A new stock take: the Reports worker works the Dashboard's stock line out now, not on the owner's next tap.
  if (!r.alreadyFinished) warmStockTakes(db);
  return { ...r, expectedNote: expectedNote(db) };
}

/**
 * Tell the Reports worker a stock take was finished (worker-client.ts warm):
 * the card's "Do this" stock line and the weekly sheet's "last stock take"
 * are worked out between asks. Never fails the finish; without a worker the
 * card works it out when asked.
 */
function warmStockTakes(db: AppDatabase): void {
  try {
    getAnalyticsWorker()?.warm(readTillLink(db));
  } catch {
    // Worked out when the card asks.
  }
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
    requireStockView();
    // Where each price came from and what it was before (costing spec Phase
    // 4): costs, so COST_CAPABILITY — which stock view already needs.
    // And whether a batch's price is worked out from its recipe (every input
    // priced): "Set price" then points at the recipe instead.
    // And what the costing sheet says it costs (Phase 6: a reference beside the till's price).
    const tags = latestPriceTags(ctx.db);
    const book = loadPriceBook(ctx.db);
    const sheets = readSheetPrices(ctx.db);
    return ok(
      listIngredients(ctx.db, payload ?? {}).map((i) => ({
        ...i,
        latestPrice: tags.get(i.id) ?? null,
        priceFromRecipe: book.prices.get(i.id)?.batch?.complete === true,
        sheetPrice: sheets.get(i.id) ?? null,
      })),
    );
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

  defineHandler('inventory:convertIngredientUnit', ctx, (_ctx, payload) => {
    const s = requireInventoryManage();
    const parsed = convertIngredientUnitInputSchema.safeParse(payload);
    if (!parsed.success) return validationFailed(parsed.error);
    return ok(convertIngredientToBaseUnit(ctx.db, parsed.data.id, { userId: s.id, deviceId: ctx.deviceId }));
  });

  // ---- Prices (costing spec Phase 4): costs, so COST_CAPABILITY ----
  defineHandler('inventory:setPrice', ctx, (_ctx, payload) => {
    const s = requireCapability(COST_CAPABILITY, REFUSED.prices);
    const parsed = setPriceInputSchema.safeParse(payload);
    if (!parsed.success) return validationFailed(parsed.error);
    const p = parsed.data;
    setTypedPrice(
      ctx.db,
      {
        ingredientId: p.ingredientId,
        typed: { per: p.per, priceCents: p.priceCents, packSize: p.packSize ?? null },
        priceKind: p.priceKind,
        notes: p.notes ?? null,
      },
      { userId: s.id, deviceId: ctx.deviceId },
    );
    const ing = findIngredient(ctx.db, p.ingredientId);
    if (!ing) return err({ code: 'not_found', message: 'Ingredient not found' });
    return ok(ing);
  });

  // "Use the sheet's price" (costing spec Phase 6): a typed line in its history.
  defineHandler('inventory:useSheetPrice', ctx, (_ctx, payload) => {
    const s = requireCapability(COST_CAPABILITY, REFUSED.prices);
    const parsed = useSheetPriceInputSchema.safeParse(payload);
    if (!parsed.success) return validationFailed(parsed.error);
    useSheetPrice(ctx.db, parsed.data.ingredientId, { userId: s.id, deviceId: ctx.deviceId });
    const ing = findIngredient(ctx.db, parsed.data.ingredientId);
    if (!ing) return err({ code: 'not_found', message: 'Ingredient not found' });
    return ok(ing);
  });

  defineHandler('inventory:priceHistory', ctx, (_ctx, payload) => {
    requireCapability(COST_CAPABILITY, REFUSED.costs);
    const parsed = priceHistoryInputSchema.safeParse(payload);
    if (!parsed.success) return validationFailed(parsed.error);
    return ok(listPriceHistory(ctx.db, parsed.data.ingredientId, parsed.data.limit));
  });

  // ---- Recipes ----
  defineHandler('inventory:getRecipe', ctx, (_ctx, payload) => {
    requireStockView();
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

  defineHandler('inventory:listRecipeLineCounts', ctx, () => {
    requireStockView();
    return ok(listRecipeLineCounts(ctx.db));
  });

  // ---- Batch recipes (made in-house) ----
  defineHandler('inventory:getBatchRecipe', ctx, (_ctx, payload) => {
    requireStockView();
    return ok(getBatchRecipe(ctx.db, payload.ingredientId));
  });

  defineHandler('inventory:setBatchRecipe', ctx, (_ctx, payload) => {
    const s = requireInventoryManage();
    const parsed = setBatchRecipeInputSchema.safeParse(payload);
    if (!parsed.success) return validationFailed(parsed.error);
    setBatchRecipe(ctx.db, parsed.data, { userId: s.id, deviceId: ctx.deviceId });
    return ok({ ingredientId: parsed.data.ingredientId });
  });

  defineHandler('inventory:makeBatch', ctx, (_ctx, payload) => {
    // Kitchen staff make batches; any signed-in user may record one. The
    // answer carries no costs (what was made, and the stock now): the rows'
    // values stay with the rows.
    const s = requireSession();
    const parsed = makeBatchInputSchema.safeParse(payload);
    if (!parsed.success) return validationFailed(parsed.error);
    return ok(makeBatch(ctx.db, parsed.data, { userId: s.id, deviceId: ctx.deviceId }));
  });

  // ---- Movements ----
  defineHandler('inventory:listMovements', ctx, (_ctx, payload) => {
    const s = requireStockView();
    const rows = listMovements(ctx.db, payload ?? {});
    return ok(mayViewCosts(s) ? rows : rows.map(movementWithoutCosts));
  });

  defineHandler('inventory:searchMovements', ctx, (_ctx, payload) => {
    const s = requireStockView();
    const parsed = searchMovementsInputSchema.safeParse(payload ?? {});
    if (!parsed.success) return validationFailed(parsed.error);
    const page = searchMovements(ctx.db, parsed.data);
    return ok(mayViewCosts(s) ? page : { ...page, rows: page.rows.map(movementWithoutCosts) });
  });

  defineHandler('inventory:recordMovement', ctx, (_ctx, payload) => {
    const s = requireInventoryManage();
    // Every stock take is a stock take now (costing spec Phase 8): its "expected" is shop stock.
    if ((payload as { reason?: unknown } | undefined)?.reason === 'count') {
      return err({ code: 'validation_failed', message: 'Count stock with a stock take (the Stock button, or Inventory → Stock takes).' });
    }
    const parsed = recordMovementInputSchema.safeParse(payload);
    if (!parsed.success) return validationFailed(parsed.error);
    return ok(recordStockMovement(ctx.db, parsed.data, { userId: s.id, deviceId: ctx.deviceId }));
  });

  // ---- Stock takes (costing spec Phase 8): COST_CAPABILITY ----
  defineHandler('inventory:stockCountList', ctx, (_ctx, payload) => {
    requireStockTakes();
    const parsed = listStockCountsInputSchema.safeParse(payload ?? {});
    if (!parsed.success) return validationFailed(parsed.error);
    return ok(listStockCounts(ctx.db, ctx.deviceId, parsed.data));
  });

  defineHandler('inventory:stockCountGet', ctx, (_ctx, payload) => {
    requireStockTakes();
    const parsed = stockCountIdInputSchema.safeParse(payload);
    if (!parsed.success) return validationFailed(parsed.error);
    return ok(getStockCount(ctx.db, parsed.data.countId, ctx.deviceId));
  });

  defineHandler('inventory:stockCountStart', ctx, (_ctx, payload) => {
    const s = requireStockTakes();
    const parsed = startStockCountInputSchema.safeParse(payload);
    if (!parsed.success) return validationFailed(parsed.error);
    return ok(startStockCount(ctx.db, parsed.data, { userId: s.id, deviceId: ctx.deviceId }));
  });

  defineHandler('inventory:stockCountSave', ctx, (_ctx, payload) => {
    const s = requireStockTakes();
    const parsed = saveStockCountLinesInputSchema.safeParse(payload);
    if (!parsed.success) return validationFailed(parsed.error);
    return ok(saveStockCountLines(ctx.db, parsed.data, { userId: s.id, deviceId: ctx.deviceId }));
  });

  defineHandler('inventory:stockCountFinish', ctx, (_ctx, payload) => {
    const s = requireStockTakes();
    const parsed = stockCountIdInputSchema.safeParse(payload);
    if (!parsed.success) return validationFailed(parsed.error);
    return ok(finished(ctx.db, finishStockCount(ctx.db, parsed.data.countId, { userId: s.id, deviceId: ctx.deviceId })));
  });

  defineHandler('inventory:stockCountCancel', ctx, (_ctx, payload) => {
    const s = requireStockTakes();
    const parsed = stockCountIdInputSchema.safeParse(payload);
    if (!parsed.success) return validationFailed(parsed.error);
    return ok({ cancelled: cancelStockCount(ctx.db, parsed.data.countId, { userId: s.id, deviceId: ctx.deviceId }) });
  });

  defineHandler('inventory:stockCountOne', ctx, (_ctx, payload) => {
    const s = requireStockTakes();
    const parsed = countOneInputSchema.safeParse(payload);
    if (!parsed.success) return validationFailed(parsed.error);
    return ok(finished(ctx.db, countOneIngredient(ctx.db, parsed.data, { userId: s.id, deviceId: ctx.deviceId })));
  });

  // ---- Suppliers ----
  defineHandler('inventory:listSuppliers', ctx, (_ctx, payload) => {
    requireStockView();
    return ok(listSuppliers(ctx.db, payload ?? {}));
  });

  defineHandler('inventory:createSupplier', ctx, (_ctx, payload) => {
    const s = requireInventoryManage();
    const parsed = createSupplierInputSchema.safeParse(payload);
    if (!parsed.success) return validationFailed(parsed.error);
    return ok(createSupplier(ctx.db, parsed.data, { userId: s.id, deviceId: ctx.deviceId }));
  });

  defineHandler('inventory:updateSupplier', ctx, (_ctx, payload) => {
    const s = requireInventoryManage();
    const parsed = updateSupplierInputSchema.safeParse(payload);
    if (!parsed.success) return validationFailed(parsed.error);
    return ok(updateSupplier(ctx.db, parsed.data, { userId: s.id, deviceId: ctx.deviceId }));
  });

  // ---- Purchase orders ----
  defineHandler('inventory:listPurchaseOrders', ctx, (_ctx, payload) => {
    requireStockView();
    return ok(listPurchaseOrders(ctx.db, payload ?? {}));
  });

  defineHandler('inventory:getPurchaseOrder', ctx, (_ctx, payload) => {
    requireStockView();
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
    const parsed = setPurchaseOrderStatusInputSchema.safeParse(payload);
    if (!parsed.success) return validationFailed(parsed.error);
    setPurchaseOrderStatus(ctx.db, parsed.data.id, parsed.data.status, {
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

  // ---- Purchases (costing spec Phase 5): what was paid, so COST_CAPABILITY ----
  defineHandler('inventory:recordPurchase', ctx, (_ctx, payload) => {
    const s = requireCapability(COST_CAPABILITY, REFUSED.purchases);
    const parsed = recordPurchaseInputSchema.safeParse(payload);
    if (!parsed.success) return validationFailed(parsed.error);
    const result = recordPurchase(ctx.db, parsed.data, { userId: s.id, deviceId: ctx.deviceId });
    if (parsed.data.paidFromDrawer) kickDrawer();
    return ok(result);
  });

  defineHandler('inventory:payoutToPurchase', ctx, (_ctx, payload) => {
    const s = requireCapability(COST_CAPABILITY, REFUSED.purchases);
    const parsed = payoutToPurchaseInputSchema.safeParse(payload);
    if (!parsed.success) return validationFailed(parsed.error);
    return ok(payoutToPurchase(ctx.db, parsed.data, { userId: s.id, deviceId: ctx.deviceId }));
  });

  defineHandler('inventory:listDrawerPayouts', ctx, (_ctx, payload) => {
    requireCapability(COST_CAPABILITY, REFUSED.purchases);
    const parsed = listDrawerPayoutsInputSchema.safeParse(payload ?? {});
    if (!parsed.success) return validationFailed(parsed.error);
    return ok(listDrawerPayouts(ctx.db, ctx.deviceId, parsed.data));
  });
}
