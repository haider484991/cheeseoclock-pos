import { app } from 'electron';
import type { HandlerContext } from '../registry.js';
import { defineHandler, IpcGuardError } from '../registry.js';
import { ok } from '@cheeseoclock/shared-types';
import { onboardingAdminSchema } from '@cheeseoclock/shared-schemas';
import { ensureDeviceInfo } from '../../db/repositories/device-repo.js';
import { createUser } from '../../db/repositories/user-repo.js';
import { createTaxCategory } from '../../db/repositories/tax-category-repo.js';
import { getReceiptBranding, setReceiptBranding } from '../../services/printer-config.js';
import { readShopSetting } from '../../db/business-settings-read.js';
import { tillClose } from '../../services/till-close-hub.js';

/** The close question's id, as the screen sent it back. */
function closeRequestId(payload: unknown): string {
  const id = (payload as { requestId?: unknown } | null | undefined)?.requestId;
  if (typeof id !== 'string' || !id) {
    throw new IpcGuardError({ code: 'validation_failed', message: 'Missing request' });
  }
  return id;
}

export function registerSystemHandlers(ctx: HandlerContext): void {
  // The PIN screen shows the shop's own name and logo. It read them through
  // printer:getConfig, which needs a login, so the login screen never had them.
  // Only what is printed on every receipt anyway — nothing else leaks here —
  // and the shop's name as the website shows it (public: it is on every page).
  defineHandler('system:getBranding', ctx, () => {
    const b = getReceiptBranding(ctx.db);
    // The website's shop name only once the owner saved one: the built-in
    // default is the first shop's, and must never show on another shop's till.
    const profile = readShopSetting(ctx.db, 'shop.profile');
    return ok({
      storeName: b.storeName,
      storeTagline: b.storeTagline ?? null,
      logoUrl: b.logoUrl ?? null,
      ...(profile.isDefault ? {} : { shopName: profile.value.name }),
    });
  });

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
   * "Close the till?" (till-close.ts): the screen says the question is up,
   * and gives the answer. No login on purpose: the PIN screen asks too, and
   * anyone at the counter can already press X — the question stops a slip,
   * it is not a lock.
   */
  defineHandler('system:closeShown', ctx, (_ctx, payload) => ok(tillClose.shown(closeRequestId(payload))));

  defineHandler('system:closeAnswer', ctx, (_ctx, payload) => {
    const requestId = closeRequestId(payload);
    const close = (payload as { close?: unknown } | null | undefined)?.close;
    if (typeof close !== 'boolean') {
      throw new IpcGuardError({ code: 'validation_failed', message: 'Missing answer' });
    }
    return ok(tillClose.answer(requestId, close));
  });

  /**
   * One-shot onboarding endpoint — creates the first admin user, writes
   * branding, optionally seeds tax categories, all in one transaction.
   * Refuses to run a second time.
   *
   * Auth gate: anyone can call this BEFORE the first user exists. Once there's
   * a user, the next call throws (the only path to create more users is via
   * users:create which requires a logged-in admin).
   *
   * The owner's name and PIN or password are checked first, before anything
   * is written: this used to save branding and tax categories, then fail on
   * the PIN, and a retry added the tax categories a second time. The user,
   * branding and tax now land together or not at all, and two calls at once
   * cannot both make an owner (createUser firstUserOnly re-checks inside).
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

    const admin = onboardingAdminSchema.safeParse(payload.admin);
    if (!admin.success) {
      throw new IpcGuardError({
        code: 'validation_failed',
        message: admin.error.issues[0]?.message ?? 'Check your name and your PIN or password',
      });
    }

    const info = ensureDeviceInfo(ctx.db);
    const actor = { userId: null, deviceId: info.deviceId };

    // First admin user — createUser hashes the PIN or password with argon2id
    // (async), then writes the user, branding and tax in one transaction.
    const adminUser = await createUser(
      ctx.db,
      {
        fullName: admin.data.fullName,
        role: 'admin',
        pin: admin.data.pin,
      },
      actor,
      {
        firstUserOnly: true,
        inSameTransaction: () => {
          // Branding
          setReceiptBranding(ctx.db, {
            storeName: payload.storeName.trim() || 'My Store',
            ...(payload.storeTagline ? { storeTagline: payload.storeTagline } : {}),
            ...(payload.branchLine ? { branchLine: payload.branchLine } : {}),
            ...(payload.phoneLine ? { phoneLine: payload.phoneLine } : {}),
            ...(payload.footerLine ? { footerLine: payload.footerLine } : {}),
            ...(payload.logoUrl ? { logoUrl: payload.logoUrl } : {}),
            // Always stored, so no till ever prints another shop's site by default.
            websiteLine: (payload.websiteLine ?? '').trim().slice(0, 60),
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
        },
      },
    );

    return ok({ adminUserId: adminUser.id });
  });
}
