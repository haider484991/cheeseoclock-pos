import { revalidatePath } from 'next/cache';
import type { PublishMenuResult } from '@cheeseoclock/shared-types';
import { isBridgeAuthorized, unauthorized } from '@/lib/bridge-auth';
import { MenuSchema } from '@/lib/menu-schema';
import { storePublishedMenu, websiteBlockProblem } from '@/lib/publish-settings';

export const dynamic = 'force-dynamic';
// Menu publishes can carry data-URL images — allow a bigger body.
export const maxDuration = 30;

/**
 * Bridge: a till publishes (replaces) the live menu, with the owner's
 * settings block once one is saved (shared-types web-bridge.ts, THE SETTINGS
 * BLOCK). Menu and block are stored together or not at all:
 *  - a block that fails its checks against this very menu → 400
 *    settings_invalid with the reason, and NOTHING is stored (the till sends
 *    the menu again without the block, and shows the owner the reason);
 *  - otherwise lib/publish-settings storePublishedMenu keeps, ignores or
 *    stores the block in the same statement as the menu, and the answer says
 *    which (data.settings), which block the website now holds, and whether
 *    that block fits the menu just stored (settingsProblem: a kept block may
 *    name a fee item a till behind on the link does not have yet).
 * The pages that print fees and areas are ISR: revalidated here.
 */
export async function PUT(req: Request): Promise<Response> {
  if (!isBridgeAuthorized(req)) return unauthorized();
  try {
    const body: unknown = await req.json();
    const parsed = MenuSchema.safeParse(body);
    if (!parsed.success) {
      return Response.json(
        { ok: false, error: 'validation', details: parsed.error.flatten() },
        { status: 400 },
      );
    }
    const { settings, ...menu } = parsed.data;
    if (settings) {
      const problem = websiteBlockProblem(settings, menu);
      if (problem) {
        return Response.json({ ok: false, error: 'settings_invalid', message: problem }, { status: 400 });
      }
    }

    const { held, outcome } = await storePublishedMenu(menu, settings);

    // Refresh the fee and area pages now rather than within the hour.
    // Outside a Next request (a test) this throws; the publish still stands.
    try {
      revalidatePath('/', 'layout');
    } catch (e) {
      console.warn('revalidatePath after a menu publish failed', e);
    }

    const data: PublishMenuResult = {
      categories: menu.categories.length,
      items: menu.categories.reduce((s, c) => s + c.items.length, 0),
      settings: outcome,
      settingsAt: held?.settingsAt ?? null,
      settingsRev: held?.settingsRev ?? null,
      settingsTie: held?.settingsTie ?? null,
      settingsDeviceId: held?.settingsDeviceId ?? null,
      settingsProblem: held?.settingsProblem ?? null,
    };
    return Response.json({ ok: true, data });
  } catch (e) {
    console.error('PUT /api/bridge/menu failed', e);
    return Response.json({ ok: false, error: 'internal' }, { status: 500 });
  }
}
