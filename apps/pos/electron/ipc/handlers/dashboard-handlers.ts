import { z } from 'zod';
import {
  DASH_DISPLAY_NAME_MAX,
  DASH_ROLES,
  DASH_USERNAME_RE,
  normalizeDashUsername,
  ok,
  type AuthenticatedUser,
  type DashLoginView,
  type DashPushStatus,
} from '@cheeseoclock/shared-types';
import type { AppDatabase } from '../../db/connection.js';
import { writeAudit } from '../../db/repositories/audit-repo.js';
import { DashboardError, dashboardPushService, readPushOn, writePushOn, type DashboardPushService } from '../../services/dashboard-push.js';
import type { HandlerContext } from '../registry.js';
import { defineHandler, IpcGuardError } from '../registry.js';
import { requireAdmin, requireSettingsManage } from '../guards.js';

/**
 * The owner's phone dashboard (v0.7.40; services/dashboard-push.ts):
 *
 *  - dashboard:getStatus / pushNow — the owner's Settings (settings.manage);
 *  - dashboard:setOn — the owner's switch for this till, audited as a setting;
 *  - the sign-in list (list, add, change, new code, sign out everywhere,
 *    remove) — the OWNER alone (admin login), here in the main process. The
 *    list lives on the website; each change leaves an audit row on this till
 *    (never the setup code, which is returned once and kept nowhere).
 */

/** Before the web bridge has started (it always has in the app): nothing known. */
function notStarted(db: AppDatabase): DashPushStatus {
  return { on: readPushOn(db), phase: 'not_linked', lastSentAt: null, lastError: null, ordersSent: 0, dashboardUrl: null };
}

function service(): DashboardPushService {
  const s = dashboardPushService();
  if (!s) throw new IpcGuardError({ code: 'precondition_failed', message: 'Set up the website link first (Settings → Online orders).' });
  return s;
}

function plainly(e: unknown): never {
  if (e instanceof DashboardError) throw new IpcGuardError({ code: 'precondition_failed', message: e.message, retryable: true });
  throw e;
}

const displayName = z
  .string()
  .trim()
  .min(1, 'Type their name')
  .max(DASH_DISPLAY_NAME_MAX, `At most ${DASH_DISPLAY_NAME_MAX} characters`);
const username = z
  .string()
  .transform(normalizeDashUsername)
  .pipe(z.string().regex(DASH_USERNAME_RE, 'A username is 3–32 letters or numbers (dots, dashes and underscores too), no spaces'));
const role = z.enum(DASH_ROLES);
const id = z.string().uuid();

function parse<T>(schema: z.ZodType<T>, payload: unknown): T {
  const r = schema.safeParse(payload);
  if (!r.success) throw new IpcGuardError({ code: 'validation_failed', message: r.error.issues[0]?.message ?? 'Check what you typed' });
  return r.data;
}

/** One audit row for a change to the list (in its own transaction: there is no till row to change). */
function audit(db: AppDatabase, owner: AuthenticatedUser, action: string, entityId: string, after: Record<string, unknown>): void {
  db.transaction(() =>
    writeAudit(db, { entityType: 'dashboard_login', entityId, action, actorUserId: owner.id, before: null, after }),
  )();
}

const byId = (logins: DashLoginView[], loginId: string) => logins.find((l) => l.id === loginId);

export function registerDashboardHandlers(ctx: HandlerContext): void {
  defineHandler('dashboard:getStatus', ctx, () => {
    requireSettingsManage();
    const s = dashboardPushService();
    return ok(s ? s.status() : notStarted(ctx.db));
  });

  defineHandler('dashboard:setOn', ctx, (_ctx, payload) => {
    const owner = requireAdmin('Switching the phone dashboard on or off');
    const { on } = parse(z.object({ on: z.boolean() }).strict(), payload);
    writePushOn(ctx.db, on, owner.id);
    const s = dashboardPushService();
    s?.kick();
    return ok(s ? s.status() : notStarted(ctx.db));
  });

  defineHandler('dashboard:pushNow', ctx, () => {
    requireSettingsManage();
    const s = dashboardPushService();
    s?.kick();
    return ok(s ? s.status() : notStarted(ctx.db));
  });

  defineHandler('dashboard:listLogins', ctx, async () => {
    requireAdmin('Seeing who can sign in to the phone dashboard');
    try {
      return ok(await service().listLogins());
    } catch (e) {
      return plainly(e);
    }
  });

  defineHandler('dashboard:addLogin', ctx, async (_ctx, payload) => {
    const owner = requireAdmin('Adding a person to the phone dashboard');
    const input = parse(z.object({ username, displayName, role, seesReports: z.boolean() }).strict(), payload);
    try {
      const made = await service().withNewCode(
        (setupCodeHash) => ({ action: 'add', username: input.username, displayName: input.displayName, role: input.role, seesReports: input.seesReports, setupCodeHash }),
        owner.fullName,
        () => input.username,
      );
      const added = made.logins.find((l) => l.username === input.username);
      audit(ctx.db, owner, 'dashboard_login_added', added?.id ?? input.username, {
        username: input.username,
        displayName: input.displayName,
        role: input.role,
        seesReports: input.role === 'owner' || input.seesReports,
      });
      return ok(made);
    } catch (e) {
      return plainly(e);
    }
  });

  defineHandler('dashboard:updateLogin', ctx, async (_ctx, payload) => {
    const owner = requireAdmin('Changing a person on the phone dashboard');
    const input = parse(z.object({ id, displayName, role, seesReports: z.boolean() }).strict(), payload);
    try {
      const logins = await service().changeLogin({ action: 'update', ...input }, owner.fullName);
      audit(ctx.db, owner, 'dashboard_login_updated', input.id, {
        username: byId(logins, input.id)?.username ?? null,
        displayName: input.displayName,
        role: input.role,
        seesReports: input.role === 'owner' || input.seesReports,
      });
      return ok(logins);
    } catch (e) {
      return plainly(e);
    }
  });

  defineHandler('dashboard:newCode', ctx, async (_ctx, payload) => {
    const owner = requireAdmin('Making a setup code for the phone dashboard');
    const input = parse(z.object({ id }).strict(), payload);
    try {
      const made = await service().withNewCode(
        (setupCodeHash) => ({ action: 'newCode', id: input.id, setupCodeHash }),
        owner.fullName,
        (logins) => byId(logins, input.id)?.username ?? '',
      );
      audit(ctx.db, owner, 'dashboard_login_code_made', input.id, { username: made.username });
      return ok(made);
    } catch (e) {
      return plainly(e);
    }
  });

  defineHandler('dashboard:signOutAll', ctx, async (_ctx, payload) => {
    const owner = requireAdmin('Signing a person out of the phone dashboard');
    const input = parse(z.object({ id }).strict(), payload);
    try {
      const logins = await service().changeLogin({ action: 'signOutAll', id: input.id }, owner.fullName);
      audit(ctx.db, owner, 'dashboard_login_signed_out', input.id, { username: byId(logins, input.id)?.username ?? null });
      return ok(logins);
    } catch (e) {
      return plainly(e);
    }
  });

  defineHandler('dashboard:removeLogin', ctx, async (_ctx, payload) => {
    const owner = requireAdmin('Removing a person from the phone dashboard');
    const input = parse(z.object({ id }).strict(), payload);
    try {
      const logins = await service().changeLogin({ action: 'remove', id: input.id }, owner.fullName);
      audit(ctx.db, owner, 'dashboard_login_removed', input.id, {});
      return ok(logins);
    } catch (e) {
      return plainly(e);
    }
  });
}
