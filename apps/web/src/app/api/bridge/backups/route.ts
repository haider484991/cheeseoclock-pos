import { createHash } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { sql } from '@/lib/db';
import { isBridgeAuthorized, unauthorized } from '@/lib/bridge-auth';
import { selectBackupsToDelete } from '@/lib/backup-retention';
import {
  CHUNKS_FORMAT,
  CHUNK_HASH_RE,
  MAX_CHUNKS_PER_COPY,
  collectUnusedChunks,
  ensureBackupSchema,
} from '@/lib/backup-store';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';
export const revalidate = 0;
export const maxDuration = 30;

/** ~3MB binary after gzip → ~4MB base64, inside Vercel's 4.5MB body limit. */
const MAX_BASE64_CHARS = 4_000_000;

/** Older tills: the whole copy in one request (≤ ~3 MB of gzip). */
const LegacyUploadSchema = z.object({
  deviceId: z.string().min(1),
  fileName: z.string().min(1).max(200),
  /** gzipped SQLite file, base64-encoded. */
  dataBase64: z.string().min(1).max(MAX_BASE64_CHARS),
  /** SHA-256 of the gzip bytes as the POS computed it; must match what arrives. */
  sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  /** What the copy says about itself (device name, order count, audit chain head…). */
  meta: z.record(z.unknown()).optional(),
});

/** Current tills: the copy as an ordered list of chunks already uploaded (see lib/backup-store.ts). */
const ChunkedUploadSchema = z.object({
  format: z.literal(CHUNKS_FORMAT),
  deviceId: z.string().min(1),
  fileName: z.string().min(1).max(200),
  chunks: z.array(z.string().regex(CHUNK_HASH_RE)).min(1).max(MAX_CHUNKS_PER_COPY),
  /** SHA-256 of the whole copy (the POS's row export); a restore checks the reassembled copy against it. */
  sha256: z.string().regex(CHUNK_HASH_RE),
  rawBytes: z.number().int().positive(),
  meta: z.record(z.unknown()).optional(),
});

/**
 * Bridge: POS uploads a database backup. The server records its own SHA-256
 * of the bytes and its own clock for created_at; there is no endpoint to
 * modify or delete a copy, and rotation follows a policy a burst of uploads
 * cannot game (see lib/backup-retention.ts).
 */
export async function POST(req: Request): Promise<Response> {
  if (!isBridgeAuthorized(req)) return unauthorized();
  try {
    await ensureBackupSchema();
    const body: unknown = await req.json();
    if ((body as { format?: unknown } | null)?.format === CHUNKS_FORMAT) return await recordChunkedCopy(body);
    const parsed = LegacyUploadSchema.safeParse(body);
    if (!parsed.success) {
      const tooBig = parsed.error.errors.some((e) => e.code === 'too_big');
      return Response.json(
        {
          ok: false,
          error: tooBig ? 'backup_too_large' : 'validation',
          ...(tooBig
            ? { message: 'Backup exceeds the 3MB cloud limit — keep using local backups and contact support.' }
            : {}),
        },
        { status: 400 },
      );
    }
    const { deviceId, fileName, dataBase64, meta } = parsed.data;
    const bytes = Buffer.from(dataBase64, 'base64');
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (parsed.data.sha256 && parsed.data.sha256 !== digest) {
      return Response.json(
        { ok: false, error: 'checksum_mismatch', message: 'The upload arrived damaged; try again.' },
        { status: 400 },
      );
    }
    const id = uuidv7();
    const metaJson = JSON.stringify(meta ?? null);

    await sql()`
      INSERT INTO pos_backups (id, device_id, file_name, size_bytes, data_base64, sha256, meta_json)
      VALUES (${id}, ${deviceId}, ${fileName}, ${bytes.length}, ${dataBase64}, ${digest}, ${metaJson}::jsonb)
    `;
    await applyRetention(deviceId);
    return Response.json({ ok: true, data: { id, sizeBytes: bytes.length, sha256: digest } });
  } catch (e) {
    console.error('POST /api/bridge/backups failed', e);
    return Response.json({ ok: false, error: 'internal' }, { status: 500 });
  }
}

/**
 * Record a chunked copy — only once every chunk it names is stored (each was
 * hash-checked on arrival). A chunk that vanished in between comes back as
 * 409 missing_chunks; the POS re-sends those and records again.
 */
async function recordChunkedCopy(body: unknown): Promise<Response> {
  const parsed = ChunkedUploadSchema.safeParse(body);
  if (!parsed.success) return Response.json({ ok: false, error: 'validation' }, { status: 400 });
  const { deviceId, fileName, chunks, sha256, rawBytes, meta } = parsed.data;
  const unique = [...new Set(chunks)];
  const present = (await sql()`
    UPDATE pos_backup_chunks SET last_used_at = now()
     WHERE hash = ANY(${unique}::text[])
    RETURNING hash, size_raw
  `) as Array<{ hash: string; size_raw: number }>;
  const sizeOf = new Map(present.map((r) => [r.hash, r.size_raw]));
  const missing = unique.filter((h) => !sizeOf.has(h));
  if (missing.length > 0) {
    return Response.json(
      { ok: false, error: 'missing_chunks', message: 'Some chunks are not on the site yet.', missing },
      { status: 409 },
    );
  }
  const total = chunks.reduce((n, h) => n + (sizeOf.get(h) ?? 0), 0);
  if (total !== rawBytes) {
    return Response.json(
      { ok: false, error: 'size_mismatch', message: 'The chunks do not add up to the copy size.' },
      { status: 400 },
    );
  }
  const id = uuidv7();
  await sql()`
    INSERT INTO pos_backups (id, device_id, file_name, size_bytes, data_base64, sha256, meta_json, format, chunk_hashes)
    VALUES (${id}, ${deviceId}, ${fileName}, ${rawBytes}, NULL, ${sha256},
            ${JSON.stringify(meta ?? null)}::jsonb, ${CHUNKS_FORMAT}, ${JSON.stringify(chunks)}::jsonb)
  `;
  await applyRetention(deviceId);
  return Response.json({ ok: true, data: { id, sizeBytes: rawBytes, sha256 } });
}

/** Rotate this device's copies (lib/backup-retention.ts), then drop chunks nothing uses. */
async function applyRetention(deviceId: string): Promise<void> {
  const rows = (await sql()`
    SELECT id, created_at, meta_json->>'reason' AS reason
      FROM pos_backups
     WHERE device_id = ${deviceId}
  `) as Array<{ id: string; created_at: string; reason: string | null }>;
  const toDelete = selectBackupsToDelete(
    rows.map((r) => ({ id: r.id, createdAt: r.created_at, reason: r.reason })),
  );
  if (toDelete.length > 0) {
    await sql()`
      DELETE FROM pos_backups
       WHERE device_id = ${deviceId} AND id = ANY(${toDelete}::uuid[])
    `;
  }
  await collectUnusedChunks();
}

/**
 * Bridge: list every copy the site holds, from every till (metadata only — no
 * blobs). A reinstalled PC has a new device id and would otherwise never see
 * the copies its predecessor made.
 */
export async function GET(req: Request): Promise<Response> {
  if (!isBridgeAuthorized(req)) return unauthorized();
  try {
    await ensureBackupSchema();
    const rows = (await sql()`
      SELECT id, device_id, file_name, size_bytes, created_at, sha256, meta_json
        FROM pos_backups
       ORDER BY created_at DESC
       LIMIT 200
    `) as Array<{
      id: string;
      device_id: string;
      file_name: string;
      size_bytes: number;
      created_at: string;
      sha256: string | null;
      meta_json: Record<string, unknown> | null;
    }>;
    return Response.json({
      ok: true,
      data: rows.map((r) => ({
        id: r.id,
        deviceId: r.device_id,
        fileName: r.file_name,
        sizeBytes: r.size_bytes,
        createdAt: r.created_at,
        sha256: r.sha256,
        meta: r.meta_json,
      })),
    });
  } catch (e) {
    console.error('GET /api/bridge/backups failed', e);
    return Response.json({ ok: false, error: 'internal' }, { status: 500 });
  }
}
