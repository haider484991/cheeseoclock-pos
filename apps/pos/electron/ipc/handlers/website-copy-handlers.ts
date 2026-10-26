import { z } from 'zod';
import { ok, type WebsiteCopyStatus } from '@cheeseoclock/shared-types';
import type { AppDatabase } from '../../db/connection.js';
import { writeAudit } from '../../db/repositories/audit-repo.js';
import { WebsiteCopyError, websiteCopyService, type WebsiteCopyService } from '../../services/website-copy-service.js';
import type { HandlerContext } from '../registry.js';
import { defineHandler, IpcGuardError } from '../registry.js';
import { requireAdmin, requireSettingsManage } from '../guards.js';

/**
 * The website's own data kept on this till (27 Oct 2026; services/website-copy-service.ts), Settings → Backups:
 *
 *  - websiteCopy:status / takeNow — manager or owner (settings.manage), like "Back up now";
 *  - websiteCopy:restore — the OWNER alone (admin login): it writes to the website. Audited on this till.
 */

/** Before the web bridge has started (it always has in the app): nothing known. */
function notStarted(): WebsiteCopyStatus {
  return { linked: false, lastAt: null, lastError: null, copies: [], replaced: null, lastRestore: null, busy: false };
}

function service(): WebsiteCopyService {
  const s = websiteCopyService();
  if (!s) throw new IpcGuardError({ code: 'precondition_failed', message: 'Set up the website link first (Settings → Online orders).' });
  return s;
}

function plainly(e: unknown): never {
  if (e instanceof WebsiteCopyError) throw new IpcGuardError({ code: 'precondition_failed', message: e.message, retryable: true });
  throw e;
}

function audit(db: AppDatabase, actorUserId: string, after: Record<string, unknown>): void {
  db.transaction(() =>
    writeAudit(db, { entityType: 'website_copy', entityId: String(after['fileName'] ?? ''), action: 'website_copy_restored', actorUserId, before: null, after }),
  )();
}

const RestoreSchema = z.object({ fileName: z.string().min(1).max(200).optional() }).strict();

export function registerWebsiteCopyHandlers(ctx: HandlerContext): void {
  defineHandler('websiteCopy:status', ctx, () => {
    requireSettingsManage();
    const s = websiteCopyService();
    return ok(s ? s.status() : notStarted());
  });

  defineHandler('websiteCopy:takeNow', ctx, async () => {
    requireSettingsManage();
    try {
      return ok(await service().take());
    } catch (e) {
      plainly(e);
    }
  });

  defineHandler('websiteCopy:restore', ctx, async (_ctx, payload) => {
    const owner = requireAdmin('Putting the website’s data back');
    const r = RestoreSchema.safeParse(payload ?? {});
    if (!r.success) throw new IpcGuardError({ code: 'validation_failed', message: 'That is not one of the till’s website copies.' });
    try {
      const result = await service().restore(r.data.fileName, 'owner');
      audit(ctx.db, owner.id, { fileName: result.fileName, inserted: result.inserted });
      return ok(result);
    } catch (e) {
      plainly(e);
    }
  });
}
