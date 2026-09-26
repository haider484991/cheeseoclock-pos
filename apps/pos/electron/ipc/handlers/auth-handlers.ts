import type { HandlerContext } from '../registry.js';
import { defineHandler } from '../registry.js';
import { ok, err } from '@cheeseoclock/shared-types';
import { SECRET_MISSING, loginInputSchema } from '@cheeseoclock/shared-schemas';
import {
  WRONG_SECRET,
  getCurrentSession,
  login,
  logout,
  noteActivity,
  verifyManagerPin,
} from '../../services/auth-service.js';

export function registerAuthHandlers(ctx: HandlerContext): void {
  defineHandler('auth:login', ctx, async (_ctx, payload) => {
    // A PIN or a password; the one set of rules is in shared-schemas. Only
    // the rule that was broken goes back, never what was typed.
    const parsed = loginInputSchema.safeParse(payload);
    if (!parsed.success) {
      return err({
        code: 'validation_failed',
        message: parsed.error.issues[0]?.message ?? SECRET_MISSING,
      });
    }
    try {
      const session = await login(ctx.db, parsed.data.pin, ctx.deviceId);
      return ok(session);
    } catch (e) {
      return err({
        code: 'unauthenticated',
        message: e instanceof Error ? e.message : WRONG_SECRET,
      });
    }
  });

  defineHandler('auth:logout', ctx, () => {
    logout(ctx.db);
    return ok({ loggedOut: true });
  });

  defineHandler('auth:currentSession', ctx, () => ok(getCurrentSession()));

  // A key press or click on the till. Only human input keeps an owner or
  // manager login alive — the screens that poll on their own must not.
  defineHandler('auth:activity', ctx, () => {
    if (getCurrentSession()) noteActivity();
    return ok(null);
  });

  defineHandler('auth:verifyManagerPin', ctx, async (_ctx, payload) => {
    // Manager approval only makes sense on top of a cashier's session; without
    // this the channel is a second, un-gated PIN oracle on the login screen.
    if (!getCurrentSession()) {
      return err({ code: 'unauthenticated', message: 'Not logged in' });
    }
    const parsed = loginInputSchema.safeParse(payload);
    if (!parsed.success) {
      return err({
        code: 'validation_failed',
        message: parsed.error.issues[0]?.message ?? SECRET_MISSING,
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
