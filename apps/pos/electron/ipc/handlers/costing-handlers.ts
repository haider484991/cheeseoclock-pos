import type { ZodError } from 'zod';
import type { HandlerContext } from '../registry.js';
import { defineHandler } from '../registry.js';
import { COST_CAPABILITY, err, ok } from '@cheeseoclock/shared-types';
import type { AuthenticatedUser } from '@cheeseoclock/shared-types';
import {
  batchCalcInputSchema,
  recipeCostInputSchema,
  setCostingTargetsInputSchema,
} from '@cheeseoclock/shared-schemas';
import { requireCapability, REFUSED } from '../guards.js';
import {
  getBatchCalc,
  getCostingTargets,
  getItemCostSheet,
  getMenuCosts,
  getMissingCosts,
  previewRecipeCost,
  saveCostingTargets,
} from '../../services/costing-service.js';

/**
 * The Costing page (costing spec Phase 1). Costs are the owner's business
 * figures: every channel here is refused in the main process to a login
 * without COST_CAPABILITY (a cashier), not only hidden on screen. Changing
 * the food-cost targets is the owner's (settings.manage).
 */
function requireCosts(): AuthenticatedUser {
  return requireCapability(COST_CAPABILITY, REFUSED.costs);
}

function validationFailed(error: ZodError) {
  const first = error.issues[0];
  const path = first?.path.join('.');
  return err({
    code: 'validation_failed',
    message: first ? (path ? `${path}: ${first.message}` : first.message) : 'Invalid input',
    details: error.flatten(),
  });
}

export function registerCostingHandlers(ctx: HandlerContext): void {
  defineHandler('costing:menuCosts', ctx, () => {
    requireCosts();
    return ok(getMenuCosts(ctx.db));
  });

  defineHandler('costing:itemSheet', ctx, (_ctx, payload) => {
    requireCosts();
    if (!payload || typeof payload.menuItemId !== 'string') {
      return err({ code: 'validation_failed', message: 'Which menu item?' });
    }
    return ok(getItemCostSheet(ctx.db, payload.menuItemId));
  });

  defineHandler('costing:missingCosts', ctx, () => {
    requireCosts();
    return ok(getMissingCosts(ctx.db));
  });

  defineHandler('costing:getTargets', ctx, () => {
    requireCosts();
    return ok(getCostingTargets(ctx.db));
  });

  defineHandler('costing:setTargets', ctx, (_ctx, payload) => {
    requireCosts();
    const s = requireCapability('settings.manage', 'Only the owner can change the food-cost targets.');
    const parsed = setCostingTargetsInputSchema.safeParse(payload);
    if (!parsed.success) return validationFailed(parsed.error);
    return ok(saveCostingTargets(ctx.db, parsed.data, { userId: s.id, deviceId: ctx.deviceId }));
  });

  defineHandler('costing:recipeCost', ctx, (_ctx, payload) => {
    requireCosts();
    const parsed = recipeCostInputSchema.safeParse(payload);
    if (!parsed.success) return validationFailed(parsed.error);
    return ok(previewRecipeCost(ctx.db, parsed.data.menuItemId, parsed.data.lines));
  });

  defineHandler('costing:batchCalc', ctx, (_ctx, payload) => {
    requireCosts();
    const parsed = batchCalcInputSchema.safeParse(payload);
    if (!parsed.success) return validationFailed(parsed.error);
    return ok(getBatchCalc(ctx.db, parsed.data.ingredientId, parsed.data.amount));
  });
}
