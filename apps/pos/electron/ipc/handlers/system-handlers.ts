import { app } from 'electron';
import type { HandlerContext } from '../registry.js';
import { defineHandler, IpcGuardError } from '../registry.js';
import { ok } from '@cheeseoclock/shared-types';
import { ensureDeviceInfo } from '../../db/repositories/device-repo.js';
import { createUser } from '../../db/repositories/user-repo.js';
import { createTaxCategory } from '../../db/repositories/tax-category-repo.js';
import { setReceiptBranding } from '../../services/printer-config.js';

export function registerSystemHandlers(ctx: HandlerContext): void {
  defineHandler('system:getVersion', ctx, () =>
    ok({
      version: app.getVersion(),
      isDev: !app.isPackaged,
    }),
  );

  defineHandler('system:getDeviceInfo', ctx, () => {
    const info = ensureDeviceInfo(ctx.db);
    return ok({
      deviceId: info.deviceId,
      displayName: info.displayName,
      registeredAt: info.registeredAt,
    });
  });

  /**
   * Setup is "complete" once at least one user exists. The very first install
   * has zero users and we render the onboarding wizard instead of the login.
   */
  defineHandler('system:getSetupStatus', ctx, () => {
    const row = ctx.db
      .prepare(`SELECT COUNT(*) AS n FROM users WHERE deleted_at IS NULL`)
      .get() as { n: number };
    return ok({ completed: row.n > 0, userCount: row.n });
  });

  /**
   * One-shot onboarding endpoint — creates the first admin user, writes
   * branding, optionally seeds tax categories. Refuses to run a second time.
   *
   * Auth gate: anyone can call this BEFORE the first user exists. Once there's
   * a user, the next call throws (the only path to create more users is via
   * users:create which requires a logged-in admin).
   */
  defineHandler('system:completeOnboarding', ctx, async (_ctx, payload) => {
    const existing = ctx.db
      .prepare(`SELECT COUNT(*) AS n FROM users WHERE deleted_at IS NULL`)
      .get() as { n: number };
    if (existing.n > 0) {
      throw new IpcGuardError({
        code: 'precondition_failed',
        message: 'Setup is already complete',
      });
    }

    const info = ensureDeviceInfo(ctx.db);
    const actor = { userId: null, deviceId: info.deviceId };

    // Branding
    setReceiptBranding(ctx.db, {
      storeName: payload.storeName.trim() || 'My Store',
      ...(payload.storeTagline ? { storeTagline: payload.storeTagline } : {}),
      ...(payload.branchLine ? { branchLine: payload.branchLine } : {}),
      ...(payload.phoneLine ? { phoneLine: payload.phoneLine } : {}),
      ...(payload.footerLine ? { footerLine: payload.footerLine } : {}),
      ...(payload.logoUrl ? { logoUrl: payload.logoUrl } : {}),
    });

    // Tax categories — only insert if the user picked some
    for (const t of payload.taxCategories) {
      if (!t.name.trim()) continue;
      createTaxCategory(
        ctx.db,
        { name: t.name.trim(), rateBps: t.rateBps },
        actor,
      );
    }

    // First admin user — createUser hashes the PIN with argon2id (async).
    const adminUser = await createUser(
      ctx.db,
      {
        fullName: payload.admin.fullName.trim(),
        role: 'admin',
        pin: payload.admin.pin,
      },
      actor,
    );

    return ok({ adminUserId: adminUser.id });
  });
}
