import type { HandlerContext } from '../registry.js';
import { defineHandler, IpcGuardError } from '../registry.js';
import { ok, hasCapability } from '@cheeseoclock/shared-types';
import type { AuthenticatedUser } from '@cheeseoclock/shared-types';
import { getCurrentSession } from '../../services/auth-service.js';
import {
  listRiders,
  createRider,
  updateRider,
  deactivateRider,
} from '../../db/repositories/rider-repo.js';

/**
 * Riders are dispatch-flow records. Any till user can read the roster and add
 * a rider — the cashier dispatching a delivery has to be able to, or the order
 * cannot leave (owner, 2026-09-25: "the cashier can't add rider"; the Assign
 * rider dialog offered "Add a new rider" and the handler refused it). Editing
 * or deactivating a rider stays with managers and admins (`riders.manage`).
 */
function requireOrderUser(): AuthenticatedUser {
  const session = getCurrentSession();
  if (!session) throw new IpcGuardError({ code: 'unauthenticated', message: 'Not logged in' });
  if (!hasCapability(session.role, 'order.create')) {
    throw new IpcGuardError({ code: 'forbidden', message: 'Access denied' });
  }
  return session;
}

function requireRidersManage(): AuthenticatedUser {
  const session = getCurrentSession();
  if (!session) throw new IpcGuardError({ code: 'unauthenticated', message: 'Not logged in' });
  // Was `users.manage`, which only the admin holds — managers could not
  // touch the roster either.
  if (!hasCapability(session.role, 'riders.manage')) {
    throw new IpcGuardError({ code: 'forbidden', message: 'Manager/admin required' });
  }
  return session;
}

export function registerRidersHandlers(ctx: HandlerContext): void {
  defineHandler('riders:list', ctx, (_ctx, payload) => {
    requireOrderUser();
    return ok(listRiders(ctx.db, payload ?? {}));
  });

  defineHandler('riders:create', ctx, (_ctx, payload) => {
    const s = requireOrderUser();
    try {
      const rider = createRider(ctx.db, payload, { userId: s.id, deviceId: ctx.deviceId });
      return ok(rider);
    } catch (e) {
      throw new IpcGuardError({
        code: 'precondition_failed',
        message: e instanceof Error ? e.message : 'Create rider failed',
      });
    }
  });

  defineHandler('riders:update', ctx, (_ctx, payload) => {
    const s = requireRidersManage();
    try {
      const rider = updateRider(ctx.db, payload, { userId: s.id, deviceId: ctx.deviceId });
      return ok(rider);
    } catch (e) {
      throw new IpcGuardError({
        code: 'precondition_failed',
        message: e instanceof Error ? e.message : 'Update rider failed',
      });
    }
  });

  defineHandler('riders:deactivate', ctx, (_ctx, payload) => {
    const s = requireRidersManage();
    try {
      deactivateRider(ctx.db, payload.id, { userId: s.id, deviceId: ctx.deviceId });
      return ok({ id: payload.id });
    } catch (e) {
      throw new IpcGuardError({
        code: 'precondition_failed',
        message: e instanceof Error ? e.message : 'Deactivate rider failed',
      });
    }
  });
}
