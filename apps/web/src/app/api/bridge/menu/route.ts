import { z } from 'zod';
import { sql } from '@/lib/db';
import { isBridgeAuthorized, unauthorized } from '@/lib/bridge-auth';

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
});

/** Bridge: POS publishes (replaces) the live menu. */
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
    await sql()`
      INSERT INTO site_menu (id, menu_json, published_at)
      VALUES (1, ${JSON.stringify(parsed.data)}, now())
      ON CONFLICT (id) DO UPDATE
        SET menu_json = EXCLUDED.menu_json, published_at = now()
    `;
    const itemCount = parsed.data.categories.reduce((s, c) => s + c.items.length, 0);
    return Response.json({ ok: true, data: { categories: parsed.data.categories.length, items: itemCount } });
  } catch (e) {
    console.error('PUT /api/bridge/menu failed', e);
    return Response.json({ ok: false, error: 'internal' }, { status: 500 });
  }
}
