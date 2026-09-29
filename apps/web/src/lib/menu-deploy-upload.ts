import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import {
  MENU_DEPLOY_UPLOADS_PER_DAY,
  MENU_FILE_MAX_BYTES,
  MENU_IMPORT_FILE_FORMAT,
  MENU_UPLOAD_MAX_BODY_BYTES,
} from '@cheeseoclock/shared-types';
import { MENU_DEPLOY_CONTROL_CHARS, menuDeployUploadBodySchema } from '@cheeseoclock/shared-schemas/menu-deploy';
import { logFailure, noStore, refuseUnlessUploadKey } from '@/lib/menu-deploy-auth';
import { countUploadsToday, insertPackage, pruneAfterUpload, readLatestPackage } from '@/lib/menu-deploy-store';
import { clientIpHash } from '@/lib/rate-limit';

/**
 * POST /api/menu-deploy: the costing PC uploads one generated menu file
 * (deploy_menu.py, with the upload key). The website checks only that it is
 * what the PC says it is (gzip, length, SHA-256) and that it looks like a
 * menu import file; the full check is each till's (its import is the same as
 * Menu → Import). Answers:
 *   201 { ok, duplicate: false, package }  stored; the tills pick it up
 *   200 { ok, duplicate: true, package }   this exact file is already the newest (whatever
 *                                          became of it: put in, waiting, refused, given up)
 *   400 validation | bad_gzip | size_mismatch | checksum_mismatch | not_json | not_a_menu_file
 *   409 older_than_current { current }     the website holds a file made later (force to send anyway)
 *   413 too_large                          over the body or file limit
 *   429 too_many_uploads                   30 in 24 hours
 *   401 / 429 rate_limited / 503           the key (menu-deploy-auth.ts)
 * Nothing of the file is ever logged or sent back.
 */
export async function handleMenuUpload(req: Request): Promise<Response> {
  const declared = Number(req.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > MENU_UPLOAD_MAX_BODY_BYTES) {
    return noStore({ ok: false, error: 'too_large' }, 413);
  }
  const refused = await refuseUnlessUploadKey(req);
  if (refused) return refused;
  try {
    const text = await req.text();
    if (Buffer.byteLength(text, 'utf8') > MENU_UPLOAD_MAX_BODY_BYTES) {
      return noStore({ ok: false, error: 'too_large' }, 413);
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return noStore({ ok: false, error: 'validation' }, 400);
    }
    const parsed = menuDeployUploadBodySchema.safeParse(json);
    if (!parsed.success) return noStore({ ok: false, error: 'validation' }, 400);
    const body = parsed.data;

    let raw: Buffer;
    try {
      raw = gunzipSync(Buffer.from(body.contentGzB64, 'base64'), { maxOutputLength: MENU_FILE_MAX_BYTES });
    } catch (e) {
      const tooBig = e instanceof RangeError || (e as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE';
      return noStore({ ok: false, error: tooBig ? 'too_large' : 'bad_gzip' }, tooBig ? 413 : 400);
    }
    if (raw.length !== body.sizeBytes) return noStore({ ok: false, error: 'size_mismatch' }, 400);
    if (createHash('sha256').update(raw).digest('hex') !== body.sha256) {
      return noStore({ ok: false, error: 'checksum_mismatch' }, 400);
    }

    let file: unknown;
    try {
      const text = raw.toString('utf8');
      // A file saved with a byte-order mark (utf-8-sig) reads the same.
      file = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    } catch {
      return noStore({ ok: false, error: 'not_json' }, 400);
    }
    const shape = menuFileShape(file);
    if (!shape) return noStore({ ok: false, error: 'not_a_menu_file' }, 400);

    if ((await countUploadsToday()) >= MENU_DEPLOY_UPLOADS_PER_DAY) {
      return noStore({ ok: false, error: 'too_many_uploads' }, 429, { 'Retry-After': '3600' });
    }

    const newest = await readLatestPackage();
    if (newest) {
      // The same bytes again change nothing — also after a till refused them or gave up on them
      // (the answer says so; a new copy would only be refused again, or tried 5 more times).
      if (newest.sha256 === body.sha256 && newest.state !== 'superseded') {
        return noStore({ ok: true, duplicate: true, package: newest }, 200);
      }
      if (!body.force && Date.parse(body.generatedAt) < Date.parse(newest.generatedAt)) {
        return noStore(
          {
            ok: false,
            error: 'older_than_current',
            current: { fileName: newest.fileName, generatedAt: newest.generatedAt, uploadedAt: newest.uploadedAt },
          },
          409,
        );
      }
    }

    const pkg = await insertPackage({
      fileName: body.fileName,
      sha256: body.sha256,
      sizeBytes: body.sizeBytes,
      formatVersion: shape.version,
      source: shape.source,
      generatedAt: new Date(body.generatedAt).toISOString(),
      uploader: body.uploader ?? null,
      itemCount: shape.itemCount,
      ingredientCount: shape.ingredientCount,
      contentGzB64: body.contentGzB64,
      ipHash: clientIpHash(req),
    });
    try {
      await pruneAfterUpload();
    } catch (e) {
      logFailure('menu-deploy: pruning after an upload failed (the upload stands)', e);
    }
    return noStore({ ok: true, duplicate: false, package: pkg }, 201);
  } catch (e) {
    logFailure('POST /api/menu-deploy failed', e);
    return noStore({ ok: false, error: 'internal' }, 500);
  }
}

/**
 * The website's only look inside the file: the format name, a whole-number
 * version, and the three lists. `source` is kept only when it is a string
 * (cut to 300 characters); nothing else is read.
 */
export function menuFileShape(
  file: unknown,
): { version: number; source: string | null; itemCount: number; ingredientCount: number } | null {
  if (file === null || typeof file !== 'object' || Array.isArray(file)) return null;
  const f = file as Record<string, unknown>;
  if (f['format'] !== MENU_IMPORT_FILE_FORMAT) return null;
  const version = f['version'];
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1 || version > 99) return null;
  const items = f['items'];
  const ingredients = f['ingredients'];
  if (!Array.isArray(f['categories']) || !Array.isArray(items) || !Array.isArray(ingredients)) return null;
  // No control characters: the costing PC's --status prints it.
  const source = typeof f['source'] === 'string' ? f['source'].replace(new RegExp(MENU_DEPLOY_CONTROL_CHARS.source, 'g'), ' ').slice(0, 300) : null;
  return { version, source, itemCount: items.length, ingredientCount: ingredients.length };
}
