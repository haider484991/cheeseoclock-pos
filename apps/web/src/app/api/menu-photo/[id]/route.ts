import { createHash } from 'node:crypto';
import { sql } from '@/lib/db';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';
export const revalidate = 0;

/**
 * Public: the till's photo of a published menu item, as an image (sweep B2).
 * The home page features items the owner picks (Settings → Home page); one
 * without a shop photo of its own shows the till's, linked here as
 * /api/menu-photo/<posItemId>?v=<version> (lib/home-lineup tillPhotoSrc) —
 * never inlined: the till sends each photo as a data URL of up to ~300 KB,
 * and the home page is a static page every visitor downloads.
 *
 * Only what the published menu already shows (GET /api/menu carries the same
 * data URLs): a raster image (PNG, JPEG, WebP, GIF, AVIF — never SVG, which
 * can carry script), sent as its bytes with nosniff. `v` is the first 12 of
 * the data URL's md5 (lib/site-facts): while it matches, the photo is cached
 * for good (a new photo gets a new `v`); otherwise for a minute.
 */
const DATA_IMAGE = /^data:(image\/(?:png|jpeg|jpg|webp|gif|avif));base64,([A-Za-z0-9+/=\s]+)$/;

function notFound(): Response {
  return Response.json({ ok: false, error: 'not_found' }, { status: 404, headers: { 'Cache-Control': 'no-store' } });
}

export async function GET(req: Request, { params }: { params: { id: string } }): Promise<Response> {
  const id = params.id;
  if (!id || id.length > 100 || !process.env['DATABASE_URL']) return notFound();
  let image: string | null = null;
  try {
    const rows = (await sql()`
      SELECT p.v ->> 'imageUrl' AS image
        FROM site_menu,
             jsonb_array_elements(COALESCE(site_menu.menu_json -> 'categories', '[]'::jsonb)) AS q(v),
             jsonb_array_elements(COALESCE(q.v -> 'items', '[]'::jsonb)) AS p(v)
       WHERE site_menu.id = 1 AND p.v ->> 'posItemId' = ${id}
       LIMIT 1
    `) as Array<{ image: string | null }>;
    image = rows[0]?.image ?? null;
  } catch (e) {
    console.error('GET /api/menu-photo failed', e);
    return Response.json({ ok: false, error: 'internal' }, { status: 500, headers: { 'Cache-Control': 'no-store' } });
  }
  const m = image ? DATA_IMAGE.exec(image) : null;
  if (!image || !m) return notFound();
  const type = m[1] === 'image/jpg' ? 'image/jpeg' : m[1]!;
  const bytes = Buffer.from(m[2]!.replace(/\s+/g, ''), 'base64');
  const version = createHash('md5').update(image).digest('hex').slice(0, 12);
  const current = new URL(req.url).searchParams.get('v') === version;
  return new Response(bytes, {
    headers: {
      'Content-Type': type,
      'Content-Length': String(bytes.length),
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': current ? 'public, max-age=31536000, immutable' : 'public, max-age=60, s-maxage=60',
    },
  });
}
