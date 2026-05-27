import type { HandlerContext } from '../registry.js';
import { defineHandler } from '../registry.js';
import { ok, err } from '@cheeseoclock/shared-types';
import { loginInputSchema } from '@cheeseoclock/shared-schemas';
import {
  getCurrentSession,
  login,
  logout,
  verifyManagerPin,
} from '../../services/auth-service.js';

export function registerAuthHandlers(ctx: HandlerContext): void {
  defineHandler('auth:login', ctx, async (_ctx, payload) => {
    const parsed = loginInputSchema.safeParse(payload);
    if (!parsed.success) {
      return err({
        code: 'validation_failed',
        message: 'PIN must be 4-8 digits',
        details: parsed.error.flatten(),
      });
    }
    try {
      const session = await login(ctx.db, parsed.data.pin, ctx.deviceId);
      return ok(session);
    } catch (e) {
      return err({
        code: 'unauthenticated',
        message: e instanceof Error ? e.message : 'Invalid PIN',
      });
    }
  });

  defineHandler('auth:logout', ctx, () => {
    logout(ctx.db);
    return ok({ loggedOut: true });
  });

  defineHandler('auth:currentSession', ctx, () => ok(getCurrentSession()));

  defineHandler('auth:verifyManagerPin', ctx, async (_ctx, payload) => {
    const parsed = loginInputSchema.safeParse(payload);
    if (!parsed.success) {
      return err({
        code: 'validation_failed',
        message: 'PIN must be 4-8 digits',
      });
    }
    try {
      const result = await verifyManagerPin(ctx.db, parsed.data.pin);
      return ok(result);
    } catch (e) {
      return err({
        code: 'forbidden',
        message: e instanceof Error ? e.message : 'Manager approval failed',
      });
    }
  });
}
