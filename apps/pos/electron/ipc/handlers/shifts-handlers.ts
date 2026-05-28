import type { HandlerContext } from '../registry.js';
import { defineHandler, IpcGuardError } from '../registry.js';
import { ok, hasCapability } from '@cheeseoclock/shared-types';
import type { AuthenticatedUser } from '@cheeseoclock/shared-types';
import { getCurrentSession } from '../../services/auth-service.js';
import {
  closeShift,
  getCurrentShift,
  getShiftSummary,
  listShifts,
  openShift,
} from '../../db/repositories/shift-repo.js';

/**
 * Shifts IPC. Open/close are manager+admin only (settings.manage capability
 * gates them since they touch cash drawer reconciliation). Read endpoints
 * are open to any logged-in user so the TopBar widget can show "Shift open"
 * to cashiers too.
 */

function requireSession(): AuthenticatedUser {
  const s = getCurrentSession();
  if (!s) throw new IpcGuardError({ code: 'unauthenticated', message: 'Not logged in' });
  return s;
}

function requireShiftManage(): AuthenticatedUser {
  const s = requireSession();
  if (!hasCapability(s.role, 'settings.manage')) {
    throw new IpcGuardError({
      code: 'forbidden',
      message: 'Opening/closing shifts requires manager or admin',
    });
  }
  return s;
}

export function registerShiftsHandlers(ctx: HandlerContext): void {
  defineHandler('shifts:current', ctx, () => {
    requireSession();
    return ok(getCurrentShift(ctx.db, ctx.deviceId));
  });

  defineHandler('shifts:open', ctx, (_ctx, payload) => {
    const s = requireShiftManage();
    try {
      const shift = openShift(
        ctx.db,
        {
          openingCashCents: Math.round(payload.openingCashCents),
          notes: payload.notes ?? null,
        },
        { userId: s.id, deviceId: ctx.deviceId },
      );
      return ok(shift);
    } catch (e) {
      throw new IpcGuardError({
        code: 'precondition_failed',
        message: e instanceof Error ? e.message : 'Open shift failed',
      });
    }
  });

  defineHandler('shifts:close', ctx, (_ctx, payload) => {
    const s = requireShiftManage();
    try {
      const shift = closeShift(
        ctx.db,
        {
          shiftId: payload.shiftId,
          countedCashCents: Math.round(payload.countedCashCents),
          notes: payload.notes ?? null,
        },
        { userId: s.id, deviceId: ctx.deviceId },
      );
      return ok(shift);
    } catch (e) {
      throw new IpcGuardError({
        code: 'precondition_failed',
        message: e instanceof Error ? e.message : 'Close shift failed',
      });
    }
  });

  defineHandler('shifts:list', ctx, (_ctx, payload) => {
    requireSession();
    return ok(listShifts(ctx.db, payload ?? {}));
  });

  defineHandler('shifts:summary', ctx, (_ctx, payload) => {
    requireSession();
    try {
      return ok(getShiftSummary(ctx.db, payload.shiftId));
    } catch (e) {
      throw new IpcGuardError({
        code: 'not_found',
        message: e instanceof Error ? e.message : 'Shift summary failed',
      });
    }
  });
}
