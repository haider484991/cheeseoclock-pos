import { revalidatePath } from 'next/cache';
import { feeItemsProblem, type PublishMenuResult } from '@cheeseoclock/shared-types';
import { isBridgeAuthorized, unauthorized } from '@/lib/bridge-auth';
import { SettingsAloneSchema } from '@/lib/menu-schema';
import { storeSettingsAlone } from '@/lib/publish-settings';

export const dynamic = 'force-dynamic';

/**
 * Bridge: a till sends the owner's settings block ALONE (shared-types
 * web-bridge.ts, THE BLOCK ALONE) — what it does by itself after a Save of
 * the delivery areas or the pick-up offer. The website stores the block with
 * the menu it already holds (the last one published), with only the fee
 * items the block's areas charge put in: a Save on the till never publishes
 * the till's menu changes.
 *  - 400 validation: a malformed body, or a fee item that is not one an
 *    active area of the block charges (never food, never another price);
 *  - 400 settings_invalid: the block does not fit the stored menu with its
 *    fee items (the reason, in the owner's words) — nothing stored;
 *  - 409 menu_not_published: no menu yet (the owner's Publish sends it);
 *  - 200 with what the website holds now (PublishMenuResult), an older
 *    block writing nothing ('ignored_older').
 * The pages that print fees and areas are ISR: revalidated after a store.
 */
export async function PUT(req: Request): Promise<Response> {
  if (!isBridgeAuthorized(req)) return unauthorized();
  try {
    const parsed = SettingsAloneSchema.safeParse(await req.json());
    if (!parsed.success) {
      return Response.json({ ok: false, error: 'validation', details: parsed.error.flatten() }, { status: 400 });
    }
    const { settings, feeItems } = parsed.data;
    const wrongItem = feeItemsProblem(settings, feeItems);
    if (wrongItem) {
      return Response.json({ ok: false, error: 'validation', message: wrongItem }, { status: 400 });
    }
    const r = await storeSettingsAlone(settings, feeItems);
    if (r.kind === 'no_menu') {
      return Response.json(
        { ok: false, error: 'menu_not_published', message: 'The website has no menu yet: publish the menu once.' },
        { status: 409 },
      );
    }
    if (r.kind === 'invalid') {
      return Response.json({ ok: false, error: 'settings_invalid', message: r.problem }, { status: 400 });
    }
    if (r.outcome === 'stored') {
      // Outside a Next request (a test) this throws; the block still stands.
      try {
        revalidatePath('/', 'layout');
      } catch (e) {
        console.warn('revalidatePath after a settings publish failed', e);
      }
    }
    const data: PublishMenuResult = {
      categories: r.categories,
      items: r.items,
      settings: r.outcome,
      settingsAt: r.held?.settingsAt ?? null,
      settingsRev: r.held?.settingsRev ?? null,
      settingsTie: r.held?.settingsTie ?? null,
      settingsDeviceId: r.held?.settingsDeviceId ?? null,
      settingsProblem: r.held?.settingsProblem ?? null,
      // This website keeps the block's messages and the items' pickupOnly (an older one drops them).
      websiteMessages: true,
      // This website keeps the items' noDiscount and prices pick-ups without them (an older one strips it).
      noDiscountItems: true,
      // This website keeps pickup.alsoDelivery and takes the % off a delivery's food (v0.7.37).
      deliveryDiscount: true,
    };
    return Response.json({ ok: true, data });
  } catch (e) {
    console.error('PUT /api/bridge/settings failed', e);
    return Response.json({ ok: false, error: 'internal' }, { status: 500 });
  }
}
