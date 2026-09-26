import type { HandlerContext } from '../registry.js';
import { defineHandler } from '../registry.js';
import { ok, err, hasCapability } from '@cheeseoclock/shared-types';
import {
  createUserInputSchema,
  updateUserInputSchema,
} from '@cheeseoclock/shared-schemas';
import type { ZodError } from 'zod';
import {
  listUsers,
  createUser,
  updateUser,
  deactivateUser,
} from '../../db/repositories/user-repo.js';
import { getCurrentSession } from '../../services/auth-service.js';

/**
 * The message for a refused create/update: the PIN or password rule that was
 * broken, in plain words ("A PIN is 4 to 12 numbers"), else a generic one.
 * The details never carry what was typed (zod issues hold paths and messages).
 */
function validationMessage(error: ZodError): string {
  const pinIssue = error.issues.find((i) => i.path[0] === 'pin');
  return pinIssue?.message ?? 'Invalid input';
}

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
        message: validationMessage(parsed.error),
        details: parsed.error.flatten(),
      });
    }
    const actor = getCurrentSession();
    try {
      const user = await createUser(ctx.db, parsed.data, {
        userId: actor?.id ?? null,
        deviceId: ctx.deviceId,
      });
      return ok(user);
    } catch (e) {
      // e.g. "That password is already used by someone else" — the admin
      // needs the reason, not a correlation id.
      return err({
        code: 'precondition_failed',
        message: e instanceof Error ? e.message : 'Create user failed',
      });
    }
  });

  defineHandler('users:update', ctx, async (_ctx, payload) => {
    const session = requireAdmin();
    if ('ok' in session && !session.ok) return session;

    const parsed = updateUserInputSchema.safeParse(payload);
    if (!parsed.success) {
      return err({
        code: 'validation_failed',
        message: validationMessage(parsed.error),
        details: parsed.error.flatten(),
      });
    }
    const actor = getCurrentSession();
    try {
      const user = await updateUser(ctx.db, parsed.data, {
        userId: actor?.id ?? null,
        deviceId: ctx.deviceId,
      });
      return ok(user);
    } catch (e) {
      // Repo preconditions ("Cannot remove the last admin", "User not found")
      // are user-facing; surface the real message instead of a correlation id.
      return err({
        code: 'precondition_failed',
        message: e instanceof Error ? e.message : 'Update user failed',
      });
    }
  });

  defineHandler('users:deactivate', ctx, (_ctx, payload) => {
    const session = requireAdmin();
    if ('ok' in session && !session.ok) return session;
    const actor = getCurrentSession();
    if (actor && payload.id === actor.id) {
      return err({
        code: 'precondition_failed',
        message: 'You cannot deactivate your own account',
      });
    }
    try {
      deactivateUser(ctx.db, payload.id, {
        userId: actor?.id ?? null,
        deviceId: ctx.deviceId,
      });
      return ok({ id: payload.id });
    } catch (e) {
      return err({
        code: 'precondition_failed',
        message: e instanceof Error ? e.message : 'Deactivate user failed',
      });
    }
  });
}
