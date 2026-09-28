import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { PublishMenuResult } from '@cheeseoclock/shared-types';
import { publishedSettingsSchema } from '@cheeseoclock/shared-schemas/web-settings';
import { isBridgeAuthorized, unauthorized } from '@/lib/bridge-auth';
import { storePublishedMenu, websiteBlockProblem } from '@/lib/publish-settings';

export const dynamic = 'force-dynamic';
// Menu publishes can carry data-URL images — allow a bigger body.
export const maxDuration = 30;

const ModifierSchema = z.object({
  posModifierId: z.string(),
  name: z.string(),
  priceDeltaCents: z.number().int(),
  isDefault: z.boolean(),
  sortOrder: z.number(),
});
const GroupSchema = z.object({
  posGroupId: z.string(),
  name: z.string(),
  selectionType: z.enum(['single', 'multi']),
  minSelect: z.number().int().min(0),
  maxSelect: z.number().int().min(0),
  isRequired: z.boolean(),
  sortOrder: z.number(),
  modifiers: z.array(ModifierSchema),
});
const ItemSchema = z.object({
  posItemId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  basePriceCents: z.number().int().min(0),
  taxRateBps: z.number().int().min(0),
  imageUrl: z.string().nullable(),
  sortOrder: z.number(),
  modifierGroups: z.array(GroupSchema),
});
const MenuSchema = z.object({
  categories: z.array(
    z.object({
      posCategoryId: z.string(),
      name: z.string(),
      displayOrder: z.number(),
      items: z.array(ItemSchema),
    }),
  ),
  publishedAt: z.string(),
  store: z.object({
    name: z.string(),
    phone: z.string().nullable(),
    whatsapp: z.string().nullable(),
    addressLine: z.string().nullable(),
    tagline: z.string().nullable(),
  }),
  /**
   * The owner's settings (Settings step 3): delivery areas and fees, the
   * pick-up offer. Absent from a till older than the block. Checked with the
   * menu: a malformed block fails the whole publish ('validation').
   */
  settings: publishedSettingsSchema.optional(),
});

/**
 * Bridge: a till publishes (replaces) the live menu, with the owner's
 * settings block once one is saved (shared-types web-bridge.ts, THE SETTINGS
 * BLOCK). Menu and block are stored together or not at all:
 *  - a block that fails its checks against this very menu → 400
 *    settings_invalid with the reason, and NOTHING is stored (the till sends
 *    the menu again without the block, and shows the owner the reason);
 *  - otherwise lib/publish-settings storePublishedMenu keeps, ignores or
 *    stores the block in the same statement as the menu, and the answer says
 *    which (data.settings) and which block the website now holds.
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
    };
    return Response.json({ ok: true, data });
  } catch (e) {
    console.error('PUT /api/bridge/menu failed', e);
    return Response.json({ ok: false, error: 'internal' }, { status: 500 });
  }
}
