import type { HandlerContext } from '../registry.js';
import { defineHandler, IpcGuardError } from '../registry.js';
import { ok } from '@cheeseoclock/shared-types';
import { requireSettingsManage } from '../guards.js';
import { licenceService } from '../../services/licence/licence-service.js';

export function registerLicenceHandlers(ctx: HandlerContext): void {
  // Readable before login: the banner on the PIN screen shows the trial or
  // grace countdown too. Nothing secret here — the key itself is never sent.
  defineHandler('licence:status', ctx, () => ok(licenceService.status()));

  // Owner only (settings.manage). A refused key is not stored; the reason is
  // the error message, so the card can show it in place.
  defineHandler('licence:activate', ctx, (_ctx, payload) => {
    const owner = requireSettingsManage();
    const token = typeof payload?.token === 'string' ? payload.token.trim() : '';
    if (!token) {
      throw new IpcGuardError({ code: 'validation_failed', message: 'Paste the licence key first.' });
    }
    const result = licenceService.activate(token, owner.id);
    if (!result.ok) {
      throw new IpcGuardError({ code: 'precondition_failed', message: result.problem });
    }
    return ok(result.status);
  });

  // Owner only: "the date and time are right now" — the licence counts from
  // this clock again after the PC's clock was set wrong. Audited.
  defineHandler('licence:resetClock', ctx, () => {
    const owner = requireSettingsManage();
    return ok(licenceService.resetClock(owner.id));
  });
}
