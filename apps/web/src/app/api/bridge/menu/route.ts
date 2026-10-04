import { revalidatePath } from 'next/cache';
import type { PublishMenuResult, PublishedShop } from '@cheeseoclock/shared-types';
import { isBridgeAuthorized, unauthorized } from '@/lib/bridge-auth';
import { MenuSchema } from '@/lib/menu-schema';
import { checkShopBlock, storePublishedMenu, websiteBlockProblem } from '@/lib/publish-settings';

export const dynamic = 'force-dynamic';
// Menu publishes can carry data-URL images — allow a bigger body.
export const maxDuration = 30;

/**
 * Bridge: a till publishes (replaces) the live menu, with the owner's
 * settings block once one is saved (shared-types web-bridge.ts, THE SETTINGS
 * BLOCK) and the shop block once one of the shop's details is (THE SHOP
 * BLOCK). Menu and blocks are stored together or not at all:
 *  - a settings block that fails its checks against this very menu → 400
 *    settings_invalid with the reason, and NOTHING is stored (the till sends
 *    the menu again without the block, and shows the owner the reason);
 *  - a shop block that fails its bounds, or is stamped far ahead of this
 *    clock → 400 shop_invalid with the reason, NOTHING stored (the till
 *    sends the menu again without it); never 'validation' for it;
 *  - otherwise lib/publish-settings storePublishedMenu keeps, ignores or
 *    stores each block in the same statement as the menu, and the answer says
 *    which (data.settings, data.shop), which blocks the website now holds,
 *    whether the settings block fits the menu just stored (settingsProblem:
 *    a kept block may name a fee item a till behind on the link does not
 *    have yet), and the home page's featured items this menu lacks
 *    (homeMissing). data.shop is ALWAYS there: its absence tells a till the
 *    website is older than the shop block.
 * Every page reads the menu or the blocks: all revalidated here.
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
    const { settings, shop: rawShop, ...menu } = parsed.data;
    if (settings) {
      const problem = websiteBlockProblem(settings, menu);
      if (problem) {
        return Response.json({ ok: false, error: 'settings_invalid', message: problem }, { status: 400 });
      }
    }
    let shop: PublishedShop | undefined;
    if (rawShop !== undefined) {
      const checked = checkShopBlock(rawShop);
      if (!checked.ok) {
        return Response.json({ ok: false, error: 'shop_invalid', message: checked.problem }, { status: 400 });
      }
      shop = checked.shop;
    }

    const { held, outcome, shopAnswer } = await storePublishedMenu(menu, settings, shop);

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
      // This website keeps the block's messages and the items' pickupOnly (an older one drops them).
      websiteMessages: true,
      // This website keeps the items' noDiscount and prices pick-ups without them (an older one strips it).
      noDiscountItems: true,
      // This website keeps pickup.alsoDelivery and takes the % off a delivery's food (v0.7.37).
      deliveryDiscount: true,
      // THE SHOP BLOCK: what it did with this publish's (or the stored one), what it holds now.
      ...shopAnswer,
    };
    return Response.json({ ok: true, data });
  } catch (e) {
    console.error('PUT /api/bridge/menu failed', e);
    return Response.json({ ok: false, error: 'internal' }, { status: 500 });
  }
}
