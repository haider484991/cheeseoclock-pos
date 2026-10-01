import type { HandlerContext } from '../registry.js';
import { defineHandler, IpcGuardError } from '../registry.js';
import { ok, hasCapability, type AuthenticatedUser, type PendingAlerts } from '@cheeseoclock/shared-types';
import { getCurrentSession } from '../../services/auth-service.js';
import { getAlertSoundSettings, setAlertSoundSettings } from '../../services/alert-sounds-config.js';
import { readAlertWatch } from '../../services/alert-watch.js';
import { attachOrderAlertsDb, orderAlerts, showAttention } from '../../services/order-alerts-hub.js';

/**
 * Settings → Sounds and the till's pending order alerts.
 *
 * Reading the sounds, the pending alerts and the watch needs no login: the
 * PIN screen rings for a website order too, anyone at the counter can tap
 * Seen (like a doorbell), and the PIN screen says when website orders are
 * paused on this till. The watch carries order numbers, statuses, minutes,
 * times and whether a shift is open only — no customer, money, website
 * address or password (alert-watch.ts). While nobody is signed in, the pending list goes out
 * without the customers' phone numbers: the PIN screen says "Sign in to see
 * the phone number", and the number comes back on the first read after a
 * sign-in. Changing the sounds is for managers and the owner, the
 * same owner, who sets up this till's printers (managers lost Settings on
 * 2026-09-27); cashiers and managers cannot mute the till.
 */
function requireSoundsManage(): AuthenticatedUser {
  const session = getCurrentSession();
  if (!session) throw new IpcGuardError({ code: 'unauthenticated', message: 'Not logged in' });
  if (!hasCapability(session.role, 'printer.manage')) {
    throw new IpcGuardError({ code: 'forbidden', message: 'Only the owner can change the order sounds.' });
  }
  return session;
}

/** The pending list as the screen may see it now: no phone numbers while nobody is signed in. */
function forScreen(pending: PendingAlerts): PendingAlerts {
  if (getCurrentSession() !== null) return pending;
  return { ...pending, failures: pending.failures.map((f) => ({ ...f, customerPhone: null })) };
}

export function registerAlertsHandlers(ctx: HandlerContext): void {
  attachOrderAlertsDb(ctx.db);

  defineHandler('alerts:getSounds', ctx, () => ok(getAlertSoundSettings(ctx.db)));

  defineHandler('alerts:setSounds', ctx, (_ctx, payload) => {
    const s = requireSoundsManage();
    return ok(setAlertSoundSettings(ctx.db, payload, s.id));
  });

  defineHandler('alerts:getPending', ctx, () => ok(forScreen(orderAlerts.pending())));

  // Seen and closed are kept across a restart (the hub saves them).
  defineHandler('alerts:acknowledge', ctx, (_ctx, payload) =>
    ok(forScreen(orderAlerts.acknowledge(payload ?? {}, { loggedIn: getCurrentSession() !== null }))),
  );

  defineHandler('alerts:getWatch', ctx, () => ok(readAlertWatch(ctx.db, Date.now(), ctx.deviceId)));

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
