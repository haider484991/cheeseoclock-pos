import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import type { PublishShopResult } from '@cheeseoclock/shared-types';
import { isBridgeAuthorized, unauthorized } from '@/lib/bridge-auth';
import { checkShopBlock, storeShopAlone } from '@/lib/publish-settings';

export const dynamic = 'force-dynamic';

/** PUT /api/bridge/shop: { shop } (PublishShopBody) — the block itself is checked apart (checkShopBlock). */
const ShopAloneSchema = z.object({ shop: z.unknown().refine((v) => v !== undefined, { message: 'shop is required' }) });

/**
 * Bridge: a till sends the shop block ALONE (shared-types web-bridge.ts, THE
 * SHOP BLOCK: THE BLOCK ALONE) — what it does by itself after a Save of one
 * of the shop's details on either till, or at start-up when the website
 * needs it. The website puts the block on the row it holds and changes
 * nothing else (the menu, the settings block):
 *  - 400 validation: a body that is not { shop };
 *  - 400 shop_invalid: the block out of its bounds, or stamped far ahead of
 *    this clock (the reason, in the owner's words) — nothing stored;
 *  - 409 menu_not_published: no menu yet (the owner's Publish sends both);
 *  - 200 with what the website holds now (PublishShopResult), an older
 *    block writing nothing ('ignored_older').
 * A website older than this route answers 404: the till says it needs its
 * update. Every page shows the shop's details: revalidated after a store.
 */
export async function PUT(req: Request): Promise<Response> {
  if (!isBridgeAuthorized(req)) return unauthorized();
  try {
    const parsed = ShopAloneSchema.safeParse(await req.json());
    if (!parsed.success) {
      return Response.json({ ok: false, error: 'validation', details: parsed.error.flatten() }, { status: 400 });
    }
    const checked = checkShopBlock(parsed.data.shop);
    if (!checked.ok) {
      return Response.json({ ok: false, error: 'shop_invalid', message: checked.problem }, { status: 400 });
    }
    const r = await storeShopAlone(checked.shop);
    if (r.kind === 'no_menu') {
      return Response.json(
        { ok: false, error: 'menu_not_published', message: 'The website has no menu yet: publish the menu once.' },
        { status: 409 },
      );
    }
    if (r.shop === 'stored') {
      // Outside a Next request (a test) this throws; the block still stands.
      try {
        revalidatePath('/', 'layout');
      } catch (e) {
        console.warn('revalidatePath after a shop details publish failed', e);
      }
    }
    const data: PublishShopResult = {
      shop: r.shop,
      shopRev: r.shopRev,
      shopAt: r.shopAt,
      shopTie: r.shopTie,
      shopDeviceId: r.shopDeviceId,
      homeMissing: r.homeMissing,
    };
    return Response.json({ ok: true, data });
  } catch (e) {
    console.error('PUT /api/bridge/shop failed', e);
    return Response.json({ ok: false, error: 'internal' }, { status: 500 });
  }
}
