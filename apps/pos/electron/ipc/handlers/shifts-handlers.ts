import type { HandlerContext } from '../registry.js';
import { defineHandler, IpcGuardError } from '../registry.js';
import { ok, hasCapability } from '@cheeseoclock/shared-types';
import { openingFloatPrefill } from '@cheeseoclock/pos-domain';
import type { AuthenticatedUser } from '@cheeseoclock/shared-types';
import { getCurrentSession, verifyManagerPin } from '../../services/auth-service.js';
import {
  closeShift,
  findShift,
  getCurrentShift,
  getLastCount,
  getShiftSummary,
  listCashMovements,
  listShifts,
  listUnpaidForClose,
  openShift,
  recordCashMovement,
} from '../../db/repositories/shift-repo.js';
import { listRefusedItemRefundsOwed } from '../../db/repositories/order-repo.js';
import type { AppDatabase } from '../../db/connection.js';
import { printSpooler } from '../../services/print-spooler.js';
import { DrawerOpenRefused, openDrawerNoSale } from '../../services/drawer-service.js';
import { closeWouldPauseWebOrders, followShiftForWebOrders } from '../../services/web-orders-shift-pause.js';
import { requireCapability, REFUSED } from '../guards.js';
import { readOpeningFloat } from '../../services/till-settings.js';

/**
 * Shifts IPC. Open/close are gated on the `shift.open` / `shift.close`
 * capabilities (see ROLE_CAPABILITIES). Anyone logged in reads the shift open
 * now (the TopBar's "Shift open" pill) and the last counted cash (the float
 * suggestion). The money of a shift — takings, expected cash, past shifts'
 * counts — is for managers and the owner: a cashier who knows what the drawer
 * should hold knows how much can go missing, and the count is blind
 * (owner, 2026-09-26). A cashier sees the cash in / out of the shift open now
 * only (the list in that dialog).
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
          ? CLOSE_REFUSED
          : 'You are not allowed to open a shift',
    });
  }
  return s;
}

/** A cashier's login with no manager's PIN or password asks to close. */
export const CLOSE_REFUSED =
  'Only a manager or the owner can close the shift — ask them to log in and count the drawer, or to type their PIN or password here';

/** Who closes the shift: the person signed in, or the manager whose PIN was typed on a cashier's till. */
export interface ShiftCloser {
  userId: string;
  name: string;
  /** Set when a manager's PIN or password approved it on a cashier's login: who was signed in. */
  tillSignedInUserId: string | null;
}

/**
 * Cashiers never close a shift (owner, 2026-09-25). A manager or the owner
 * signed in closes it themselves; on a cashier's login the manager types
 * their PIN or password (owner, 2026-09-27) — checked here, in the main
 * process, with the sign-in lockout rules (verifyManagerPin), and the shift
 * is closed by that manager. Anything else is refused.
 */
export async function shiftCloser(
  db: AppDatabase,
  s: AuthenticatedUser,
  approverPin: unknown,
): Promise<ShiftCloser> {
  if (hasCapability(s.role, 'shift.close')) {
    return { userId: s.id, name: s.fullName, tillSignedInUserId: null };
  }
  const pin = typeof approverPin === 'string' ? approverPin : '';
  if (pin.trim() === '') {
    throw new IpcGuardError({ code: 'forbidden', message: CLOSE_REFUSED });
  }
  try {
    const m = await verifyManagerPin(db, pin);
    return { userId: m.approverUserId, name: m.approverName, tillSignedInUserId: s.id };
  } catch (e) {
    throw new IpcGuardError({
      code: 'forbidden',
      message: e instanceof Error ? e.message : 'Manager approval failed',
    });
  }
}

export function registerShiftsHandlers(ctx: HandlerContext): void {
  defineHandler('shifts:current', ctx, () => {
    requireSession();
    return ok(getCurrentShift(ctx.db, ctx.deviceId));
  });

  defineHandler('shifts:open', ctx, (_ctx, payload) => {
    const s = requireShiftManage('shift.open');
    try {
      const { drawerOpenId, ...shift } = openShift(
        ctx.db,
        {
          openingCashCents: Math.round(payload.openingCashCents),
          notes: payload.notes ?? null,
        },
        { userId: s.id, deviceId: ctx.deviceId },
      );
      // The drawer opens to put the float in, for the 'float' row written with
      // the shift (a failure is a toast, not an error).
      printSpooler.kickDrawerSoon(drawerOpenId);
      // Website orders start again (unless the owner switched them off by
      // hand). Never throws: the website never holds up the shift.
      followShiftForWebOrders(ctx.db, ctx.deviceId, 'opened', s.id);
      return ok(shift);
    } catch (e) {
      throw new IpcGuardError({
        code: 'precondition_failed',
        message: e instanceof Error ? e.message : 'Open shift failed',
      });
    }
  });

  defineHandler('shifts:close', ctx, async (_ctx, payload) => {
    const s = requireSession();
    const closer = await shiftCloser(ctx.db, s, payload.approverPin);
    try {
      const shift = closeShift(
        ctx.db,
        {
          shiftId: payload.shiftId,
          countedCashCents: Math.round(payload.countedCashCents),
          notes: payload.notes ?? null,
          carryOverReason: typeof payload.carryOverReason === 'string' ? payload.carryOverReason : null,
          // The unpaid orders the close box showed: one that came in during
          // the count is not carried over on a reason given for the others.
          carryOverOrderIds: Array.isArray(payload.carryOverOrderIds)
            ? payload.carryOverOrderIds.filter((id): id is string => typeof id === 'string')
            : null,
          // The drawer counted note by note, passed on as sent, only after
          // the PIN check above: the repository is the one strict gate (the
          // owner's rows, whole notes, a sum that is the counted cash).
          countedNotes:
            payload.countedNotes != null && typeof payload.countedNotes === 'object' ? payload.countedNotes : null,
        },
        { userId: closer.userId, deviceId: ctx.deviceId },
        closer.tillSignedInUserId ? { via: 'manager_pin', tillSignedInUserId: closer.tillSignedInUserId } : null,
      );
      // The till's last shift closed: website orders pause until one opens
      // (owner, 2026-09-27). Never throws: the close is already saved.
      followShiftForWebOrders(ctx.db, ctx.deviceId, 'closed', closer.userId);
      // Closed with a manager's PIN on a cashier's login: the manager sees
      // Counted and Over / Short there, but the expected cash never goes to
      // a cashier's screen (the shift's totals are refused to that login,
      // shifts:summary). The row keeps it; Shift history shows it the owner.
      return ok(closer.tillSignedInUserId ? { ...shift, expectedCashCents: null } : shift);
    } catch (e) {
      throw new IpcGuardError({
        code: 'precondition_failed',
        message: e instanceof Error ? e.message : 'Close shift failed',
      });
    }
  });

  // Before the count: who closes, the unpaid orders the close will carry
  // over, and whether the close pauses website orders on this till (a yes or
  // no for the close box to warn; the close itself applies the real rule).
  // The same people as the close itself; no money of the shift (the count is
  // blind), only the unpaid orders' own totals. Also this shift's deliveries
  // whose refused item is still to refund (order numbers only): the drawer is
  // short by them, and the box says why — never a reason to refuse the close.
  defineHandler('shifts:closeCheck', ctx, async (_ctx, payload) => {
    const s = requireSession();
    const closer = await shiftCloser(ctx.db, s, payload.approverPin);
    const shift = findShift(ctx.db, payload.shiftId);
    if (!shift || shift.closedAt !== null) {
      throw new IpcGuardError({ code: 'precondition_failed', message: 'That shift is not open any more' });
    }
    const refusedItemRefundsOwed = listRefusedItemRefundsOwed(ctx.db, shift.id);
    return ok({
      closerName: closer.name,
      viaManagerPin: closer.tillSignedInUserId !== null,
      unpaidOrders: listUnpaidForClose(ctx.db, shift.deviceId),
      pausesWebsiteOrders: closeWouldPauseWebOrders(ctx.db, ctx.deviceId, shift.id),
      ...(refusedItemRefundsOwed.length > 0 ? { refusedItemRefundsOwed } : {}),
    });
  });

  defineHandler('shifts:list', ctx, (_ctx, payload) => {
    requireCapability('report.view', REFUSED.shiftHistory);
    return ok(listShifts(ctx.db, payload ?? {}));
  });

  defineHandler('shifts:lastCount', ctx, () => {
    requireSession();
    return ok(getLastCount(ctx.db, ctx.deviceId));
  });

  // What the Open shift box starts the count on: this till's last count, or
  // the owner's fixed float (Settings → Staff & kitchen, this till only).
  // Anyone who may open a shift reads it (a cashier opens the morning shift);
  // it is only a starting figure — the float is still counted and typed.
  defineHandler('shifts:openingFloat', ctx, () => {
    requireSession();
    return ok(openingFloatPrefill(readOpeningFloat(ctx.db), getLastCount(ctx.db, ctx.deviceId)));
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
      const { drawerOpenId, ...movement } = recordCashMovement(
        ctx.db,
        {
          type: payload.type,
          amountCents: payload.amountCents,
          reason: payload.reason,
          approvedByUserId,
        },
        { userId: s.id, deviceId: ctx.deviceId },
      );
      // Cash in, cash out or a rider tip: the drawer opens for the notes, for
      // the row written with the movement.
      printSpooler.kickDrawerSoon(drawerOpenId);
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
    const s = requireSession();
    if (!hasCapability(s.role, 'shift.close') && findShift(ctx.db, payload.shiftId)?.closedAt !== null) {
      throw new IpcGuardError({ code: 'forbidden', message: REFUSED.earlierShiftCash });
    }
    return ok(listCashMovements(ctx.db, payload.shiftId));
  });

  // Takings and the expected cash: the close dialog's, so the same people.
  defineHandler('shifts:summary', ctx, (_ctx, payload) => {
    requireCapability('shift.close', REFUSED.shiftTotals);
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
