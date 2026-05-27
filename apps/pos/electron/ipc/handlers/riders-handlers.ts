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
 * Riders are dispatch-flow records. Any cashier can read the roster (to assign
 * on a delivery), but only managers/admins can mutate it.
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
  // Riders are a roster — reuse `users.manage` since it's already the bar for
  // staff management. (Cashiers can assign but not create.)
  if (!hasCapability(session.role, 'users.manage')) {
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
    const s = requireRidersManage();
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
