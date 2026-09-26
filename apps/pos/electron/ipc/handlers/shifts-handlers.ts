import type { HandlerContext } from '../registry.js';
import { defineHandler, IpcGuardError } from '../registry.js';
import { ok, hasCapability } from '@cheeseoclock/shared-types';
import type { AuthenticatedUser } from '@cheeseoclock/shared-types';
import { getCurrentSession, verifyManagerPin } from '../../services/auth-service.js';
import {
  closeShift,
  getCurrentShift,
  getLastCount,
  getShiftSummary,
  listCashMovements,
  listShifts,
  openShift,
  recordCashMovement,
} from '../../db/repositories/shift-repo.js';
import { printSpooler } from '../../services/print-spooler.js';
import { DrawerOpenRefused, openDrawerNoSale } from '../../services/drawer-service.js';

/**
 * Shifts IPC. Open/close are gated on the `shift.open` / `shift.close`
 * capabilities (see ROLE_CAPABILITIES). Read endpoints are open to any
 * logged-in user so the TopBar widget can show "Shift open" to everyone.
 */

function requireSession(): AuthenticatedUser {
  const s = getCurrentSession();
  if (!s) throw new IpcGuardError({ code: 'unauthenticated', message: 'Not logged in' });
  return s;
}

function requireShiftManage(capability: 'shift.open' | 'shift.close'): AuthenticatedUser {
  const s = requireSession();
  if (!hasCapability(s.role, capability)) {
    throw new IpcGuardError({
      code: 'forbidden',
      message:
        capability === 'shift.close'
          ? 'Only a manager or the owner can close the shift — ask them to log in and count the drawer'
          : 'You are not allowed to open a shift',
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
    const s = requireShiftManage('shift.open');
    try {
      const shift = openShift(
        ctx.db,
        {
          openingCashCents: Math.round(payload.openingCashCents),
          notes: payload.notes ?? null,
        },
        { userId: s.id, deviceId: ctx.deviceId },
      );
      // The drawer opens to put the float in (a failure is a toast, not an error).
      printSpooler.kickDrawerSoon();
      return ok(shift);
    } catch (e) {
      throw new IpcGuardError({
        code: 'precondition_failed',
        message: e instanceof Error ? e.message : 'Open shift failed',
      });
    }
  });

  defineHandler('shifts:close', ctx, (_ctx, payload) => {
    const s = requireShiftManage('shift.close');
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

  defineHandler('shifts:lastCount', ctx, () => {
    requireSession();
    return ok(getLastCount(ctx.db, ctx.deviceId));
  });

  // Cash in/out of the drawer. A manager or the owner records it directly; a
  // cashier needs a manager's PIN, the same as a big discount or a refund.
  defineHandler('shifts:recordCashMovement', ctx, async (_ctx, payload) => {
    const s = requireSession();
    let approvedByUserId: string | null = null;
    if (!hasCapability(s.role, 'cash.movement')) {
      if (!payload.approverPin) {
        throw new IpcGuardError({
          code: 'precondition_failed',
          message: "A manager's PIN or password is needed to take cash out of or put cash into the drawer",
        });
      }
      try {
        approvedByUserId = (await verifyManagerPin(ctx.db, payload.approverPin)).approverUserId;
      } catch (e) {
        throw new IpcGuardError({
          code: 'forbidden',
          message: e instanceof Error ? e.message : 'Manager approval failed',
        });
      }
    }
    try {
      const movement = recordCashMovement(
        ctx.db,
        {
          type: payload.type,
          amountCents: payload.amountCents,
          reason: payload.reason,
          approvedByUserId,
        },
        { userId: s.id, deviceId: ctx.deviceId },
      );
      // Cash in, cash out or a rider tip: the drawer opens for the notes.
      printSpooler.kickDrawerSoon();
      return ok(movement);
    } catch (e) {
      throw new IpcGuardError({
        code: 'precondition_failed',
        message: e instanceof Error ? e.message : 'Could not record the cash',
      });
    }
  });

  // Open the drawer with no sale, or to count it at close. The rules (who
  // may, the manager PIN for a cashier) live in drawer-service.
  defineHandler('shifts:openDrawer', ctx, async (_ctx, payload) => {
    const s = requireSession();
    try {
      return ok(
        await openDrawerNoSale(ctx.db, s, ctx.deviceId, {
          kind: payload.kind,
          reason: payload.reason ?? null,
          ...(payload.approverPin !== undefined ? { approverPin: payload.approverPin } : {}),
        }),
      );
    } catch (e) {
      if (e instanceof DrawerOpenRefused) {
        throw new IpcGuardError({ code: e.code, message: e.message });
      }
      throw new IpcGuardError({
        code: 'precondition_failed',
        message: e instanceof Error ? e.message : 'Could not open the drawer',
      });
    }
  });

  defineHandler('shifts:listCashMovements', ctx, (_ctx, payload) => {
    requireSession();
    return ok(listCashMovements(ctx.db, payload.shiftId));
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
