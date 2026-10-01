import log from 'electron-log/main';
import { ok, type TillPowerStatus } from '@cheeseoclock/shared-types';
import type { HandlerContext } from '../registry.js';
import { defineHandler, IpcGuardError } from '../registry.js';
import { requireSettingsManage } from '../guards.js';
import { tillPowerStatus, turnTillPowerBackOn } from '../../services/till-power-hub.js';

/**
 * "This computer" (Settings → Online orders; services/till-power.ts): is it
 * held awake now, will Windows open the till at sign-in, when it last slept,
 * and "Turn it back on". The owner alone (requireSettingsManage), like the
 * other "this till" cards; the choices themselves are the 'pc.power' till
 * setting (settings:getTill / settings:setTill).
 */
export function registerPowerHandlers(ctx: HandlerContext): void {
  defineHandler('power:getStatus', ctx, () => {
    requireSettingsManage();
    return ok(started(tillPowerStatus()));
  });

  defineHandler('power:turnBackOn', ctx, () => {
    const s = requireSettingsManage();
    log.info('This computer: "Turn it back on"', { by: s.id });
    return ok(started(turnTillPowerBackOn()));
  });
}

function started(s: TillPowerStatus | null): TillPowerStatus {
  if (!s) throw new IpcGuardError({ code: 'precondition_failed', message: 'The till is still starting: try again in a moment.' });
  return s;
}
