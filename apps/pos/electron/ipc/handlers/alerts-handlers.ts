import type { HandlerContext } from '../registry.js';
import { defineHandler, IpcGuardError } from '../registry.js';
import { ok, hasCapability, type AuthenticatedUser } from '@cheeseoclock/shared-types';
import { getCurrentSession } from '../../services/auth-service.js';
import { getAlertSoundSettings, setAlertSoundSettings } from '../../services/alert-sounds-config.js';
import { attachOrderAlertsDb, orderAlerts, showAttention } from '../../services/order-alerts-hub.js';

/**
 * Settings → Sounds and the till's pending order alerts.
 *
 * Reading the sounds and the pending alerts needs no login: the PIN screen
 * rings for a website order too, and anyone at the counter can tap Seen (like
 * a doorbell). Changing the sounds is for managers and the owner, the same
 * people who set up this till's printers; cashiers cannot mute the till.
 */
function requireSoundsManage(): AuthenticatedUser {
  const session = getCurrentSession();
  if (!session) throw new IpcGuardError({ code: 'unauthenticated', message: 'Not logged in' });
  if (!hasCapability(session.role, 'printer.manage')) {
    throw new IpcGuardError({ code: 'forbidden', message: 'Sound settings need a manager or the owner' });
  }
  return session;
}

export function registerAlertsHandlers(ctx: HandlerContext): void {
  attachOrderAlertsDb(ctx.db);

  defineHandler('alerts:getSounds', ctx, () => ok(getAlertSoundSettings(ctx.db)));

  defineHandler('alerts:setSounds', ctx, (_ctx, payload) => {
    const s = requireSoundsManage();
    return ok(setAlertSoundSettings(ctx.db, payload, s.id));
  });

  defineHandler('alerts:getPending', ctx, () => ok(orderAlerts.pending()));

  defineHandler('alerts:acknowledge', ctx, (_ctx, payload) =>
    ok(orderAlerts.acknowledge(payload ?? {}, { loggedIn: getCurrentSession() !== null })),
  );

  defineHandler('alerts:testNotice', ctx, () => {
    requireSoundsManage();
    const shown = showAttention(
      {
        kind: 'test',
        title: 'CheeseOclock POS — test notice',
        body: 'A new online order shows up here when the till is behind another window. Click to bring the till back.',
      },
      { force: true },
    );
    return ok({ shown });
  });
}
