import log from 'electron-log/main';
import { hasCapability, ok, type AuthenticatedUser, type MenuDeployView } from '@cheeseoclock/shared-types';
import { MAX_MENU_FILE_VERSION } from '@cheeseoclock/shared-schemas';
import { menuDeployPhaseMessage } from '@cheeseoclock/pos-domain';
import type { HandlerContext } from '../registry.js';
import { defineHandler, IpcGuardError } from '../registry.js';
import { requireAdmin } from '../guards.js';
import { getCurrentSession } from '../../services/auth-service.js';
import { MenuDeployError, menuPackageService, type MenuPackageService } from '../../services/menu-package-service.js';
import { MenuImportRefusedError } from '../../db/repositories/menu-import-repo.js';

/**
 * Menu files from the costing PC (v0.7.32; services/menu-package-service.ts):
 *
 *  - menuDeploy:getStatus / checkNow / preview / apply — whoever manages the
 *    menu (menu.manage: a manager or the owner), like Menu → Import. Taking a
 *    file over from a till that stopped halfway (`takeOver`) is the owner's
 *    alone: the menu may end up with doubled items.
 *  - menuDeploy:createKey — the owner alone (admin login). The key is
 *    returned once and never stored, logged or put in an error.
 *
 * A counter login is refused every one, in the main process.
 */

const REFUSED_MENU = 'Only a manager or the owner can manage the menu.';

function requireMenuManage(): AuthenticatedUser {
  const session = getCurrentSession();
  if (!session) throw new IpcGuardError({ code: 'unauthenticated', message: 'Not logged in' });
  if (!hasCapability(session.role, 'menu.manage')) throw new IpcGuardError({ code: 'forbidden', message: REFUSED_MENU });
  return session;
}

/** The till's one service; the web bridge makes it at start-up. */
function service(): MenuPackageService {
  const s = menuPackageService();
  if (!s) {
    throw new IpcGuardError({
      code: 'precondition_failed',
      message: menuDeployPhaseMessage('not_linked', { maxFormatVersion: MAX_MENU_FILE_VERSION }),
    });
  }
  return s;
}

/** Before the web bridge has started (it always has in the app): not linked, nothing known. */
function notStarted(): MenuDeployView {
  return {
    websiteLinked: false,
    phase: 'not_linked',
    message: menuDeployPhaseMessage('not_linked', { maxFormatVersion: MAX_MENU_FILE_VERSION }),
    scope: 'own',
    mode: 'auto',
    key: null,
    package: null,
    appliedHere: null,
    canApplyNow: false,
    applyNeedsOwner: false,
    lastCheckedAt: null,
    nextCheckAt: null,
    lastError: null,
  };
}

/** A refusal in the service's plain words, shown as it is; anything else stays hidden (defineHandler). */
function plainly(e: unknown): never {
  if (e instanceof MenuDeployError || e instanceof MenuImportRefusedError) {
    throw new IpcGuardError({ code: 'precondition_failed', message: e.message });
  }
  throw e;
}

function packageIdOf(payload: unknown): string {
  const id = (payload as { packageId?: unknown } | undefined)?.packageId;
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) {
    throw new IpcGuardError({ code: 'validation_failed', message: 'Which menu file?' });
  }
  return id.toLowerCase();
}

export function registerMenuDeployHandlers(ctx: HandlerContext): void {
  defineHandler('menuDeploy:getStatus', ctx, async (_ctx, payload) => {
    requireMenuManage();
    const s = menuPackageService();
    if (!s) return ok(notStarted());
    return ok(payload?.withHistory === true ? await s.viewWithHistory() : s.view());
  });

  defineHandler('menuDeploy:checkNow', ctx, async () => {
    requireMenuManage();
    const s = menuPackageService();
    if (!s) return ok(notStarted());
    return ok(await s.checkNow());
  });

  defineHandler('menuDeploy:createKey', ctx, async () => {
    const owner = requireAdmin('Making an upload key for the costing PC');
    try {
      return ok(await service().createKey(owner.id));
    } catch (e) {
      // Never the key in a log line or a message: the service's refusals do not carry it.
      if (!(e instanceof MenuDeployError)) log.warn('Upload key not made');
      return plainly(e);
    }
  });

  defineHandler('menuDeploy:preview', ctx, async (_ctx, payload) => {
    requireMenuManage();
    const packageId = packageIdOf(payload);
    try {
      return ok(await service().preview(packageId));
    } catch (e) {
      return plainly(e);
    }
  });

  defineHandler('menuDeploy:apply', ctx, async (_ctx, payload) => {
    const takeOver = payload?.takeOver === true;
    // Taking a file over from a till that stopped halfway may double items: the owner's call.
    const s = takeOver ? requireAdmin('Taking a menu file over from the other till') : requireMenuManage();
    const packageId = packageIdOf(payload);
    try {
      return ok(await service().apply(packageId, { userId: s.id, deviceId: ctx.deviceId }, { takeOver, retry: payload?.retry === true }));
    } catch (e) {
      return plainly(e);
    }
  });
}
