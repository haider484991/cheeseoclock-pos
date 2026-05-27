import type { HandlerContext } from '../registry.js';
import { defineHandler } from '../registry.js';
import { ok, err, hasCapability } from '@cheeseoclock/shared-types';
import {
  createUserInputSchema,
  updateUserInputSchema,
} from '@cheeseoclock/shared-schemas';
import {
  listUsers,
  createUser,
  updateUser,
  deactivateUser,
} from '../../db/repositories/user-repo.js';
import { getCurrentSession } from '../../services/auth-service.js';

function requireAdmin() {
  const session = getCurrentSession();
  if (!session) {
    return err({ code: 'unauthenticated', message: 'Not logged in' });
  }
  if (!hasCapability(session.role, 'users.manage')) {
    return err({ code: 'forbidden', message: 'Admin role required' });
  }
  return session;
}

export function registerUsersHandlers(ctx: HandlerContext): void {
  defineHandler('users:list', ctx, () => {
    const session = requireAdmin();
    if ('ok' in session && !session.ok) return session;
    return ok(listUsers(ctx.db));
  });

  defineHandler('users:create', ctx, async (_ctx, payload) => {
    const session = requireAdmin();
    if ('ok' in session && !session.ok) return session;

    const parsed = createUserInputSchema.safeParse(payload);
    if (!parsed.success) {
      return err({
        code: 'validation_failed',
        message: 'Invalid input',
        details: parsed.error.flatten(),
      });
    }
    const actor = getCurrentSession();
    const user = await createUser(ctx.db, parsed.data, {
      userId: actor?.id ?? null,
      deviceId: ctx.deviceId,
    });
    return ok(user);
  });

  defineHandler('users:update', ctx, async (_ctx, payload) => {
    const session = requireAdmin();
    if ('ok' in session && !session.ok) return session;

    const parsed = updateUserInputSchema.safeParse(payload);
    if (!parsed.success) {
      return err({
        code: 'validation_failed',
        message: 'Invalid input',
        details: parsed.error.flatten(),
      });
    }
    const actor = getCurrentSession();
    const user = await updateUser(ctx.db, parsed.data, {
      userId: actor?.id ?? null,
      deviceId: ctx.deviceId,
    });
    return ok(user);
  });

  defineHandler('users:deactivate', ctx, (_ctx, payload) => {
    const session = requireAdmin();
    if ('ok' in session && !session.ok) return session;
    const actor = getCurrentSession();
    deactivateUser(ctx.db, payload.id, {
      userId: actor?.id ?? null,
      deviceId: ctx.deviceId,
    });
    return ok({ id: payload.id });
  });
}
