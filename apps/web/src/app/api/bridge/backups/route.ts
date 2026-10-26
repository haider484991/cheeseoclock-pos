import { createHash } from 'node:crypto';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { sql } from '@/lib/db';
import { isBridgeAuthorized, unauthorized } from '@/lib/bridge-auth';
import { selectBackupsToDelete } from '@/lib/backup-retention';
import { backupObjects, type BackupObjects, type CopyRecord } from '@/lib/backup-objects';
import {
  CHUNKS_FORMAT,
  CHUNK_GRACE_HOURS,
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
  deviceId: z.string().min(1).max(200),
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
 * cannot game (see lib/backup-retention.ts). With a Blob store
 * (lib/backup-objects.ts) a chunked copy is recorded there, out of the
 * database, so the database's limits and outages never take the copies with it.
 */
export async function POST(req: Request): Promise<Response> {
  if (!isBridgeAuthorized(req)) return unauthorized();
  try {
    const body: unknown = await req.json();
    const objects = backupObjects();
    if ((body as { format?: unknown } | null)?.format === CHUNKS_FORMAT && objects) return await recordInBlob(objects, body);
    await ensureBackupSchema();
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

/** The same, recorded in the Blob store: its chunks must be stored there. */
async function recordInBlob(objects: BackupObjects, body: unknown): Promise<Response> {
  const parsed = ChunkedUploadSchema.safeParse(body);
  if (!parsed.success) return Response.json({ ok: false, error: 'validation' }, { status: 400 });
  const { deviceId, fileName, chunks, sha256, rawBytes, meta } = parsed.data;
  const have = await objects.chunks();
  const missing = [...new Set(chunks)].filter((h) => !have.has(h));
  if (missing.length > 0) {
    return Response.json(
      { ok: false, error: 'missing_chunks', message: 'Some chunks are not on the site yet.', missing },
      { status: 409 },
    );
  }
  const total = chunks.reduce((n, h) => n + (have.get(h)?.rawBytes ?? 0), 0);
  if (total !== rawBytes) {
    return Response.json(
      { ok: false, error: 'size_mismatch', message: 'The chunks do not add up to the copy size.' },
      { status: 400 },
    );
  }
  const record: CopyRecord = {
    id: uuidv7(),
    deviceId,
    fileName,
    sizeBytes: rawBytes,
    sha256,
    meta: (meta as Record<string, unknown> | undefined) ?? null,
    chunks,
    createdAt: new Date().toISOString(),
  };
  await objects.putCopy(record);
  await applyRetentionWithBlob(objects, deviceId);
  return Response.json({ ok: true, data: { id: record.id, sizeBytes: rawBytes, sha256 } });
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
 * One rotation over this device's copies in both places — the Blob store's and the ones made before it, still in the
 * database — so the old ones rotate out as new ones arrive and the database empties of copies by itself. A database
 * that does not answer leaves its copies for the next time; the Blob store's rotate on their own.
 */
async function applyRetentionWithBlob(objects: BackupObjects, deviceId: string): Promise<void> {
  const allBlob = await objects.copies();
  const blob = allBlob.filter((r) => r.deviceId === deviceId);
  let dbRows: Array<{ id: string; created_at: string; reason: string | null }> | null = null;
  try {
    await ensureBackupSchema();
    dbRows = (await sql()`
      SELECT id, created_at, meta_json->>'reason' AS reason FROM pos_backups WHERE device_id = ${deviceId}
    `) as Array<{ id: string; created_at: string; reason: string | null }>;
  } catch (e) {
    console.warn('backups: the database did not answer; rotating the Blob store copies only', e);
  }
  const reasonOf = (r: CopyRecord) => (typeof r.meta?.['reason'] === 'string' ? (r.meta['reason'] as string) : null);
  const toDelete = new Set(
    selectBackupsToDelete([
      ...blob.map((r) => ({ id: r.id, createdAt: r.createdAt, reason: reasonOf(r) })),
      ...(dbRows ?? []).map((r) => ({ id: r.id, createdAt: r.created_at, reason: r.reason })),
    ]),
  );
  const goneBlob = blob.filter((r) => toDelete.has(r.id));
  await objects.deleteCopies(goneBlob);
  const goneDb = (dbRows ?? []).filter((r) => toDelete.has(r.id)).map((r) => r.id);
  if (goneDb.length > 0) {
    await sql()`DELETE FROM pos_backups WHERE device_id = ${deviceId} AND id = ANY(${goneDb}::uuid[])`;
  }
  if (dbRows) await collectUnusedChunks();
  // Chunks no Blob copy names any more, once they have also sat a grace period (a copy being recorded right now
  // names chunks uploaded a moment ago).
  const gone = new Set(goneBlob.map((r) => r.id));
  const live = new Set(allBlob.filter((r) => !gone.has(r.id)).flatMap((r) => r.chunks));
  const cutoff = Date.now() - CHUNK_GRACE_HOURS * 3_600_000;
  const unused = [...(await objects.chunks()).values()].filter((c) => !live.has(c.hash) && c.uploadedAt.getTime() < cutoff);
  await objects.deleteChunks(unused);
}

type ListedCopy = {
  id: string;
  deviceId: string;
  fileName: string;
  sizeBytes: number;
  createdAt: string;
  sha256: string | null;
  meta: Record<string, unknown> | null;
};

/**
 * Bridge: list every copy the site holds, from every till (metadata only — no
 * blobs). A reinstalled PC has a new device id and would otherwise never see
 * the copies its predecessor made. With a Blob store: its copies and the ones
 * made before it (while the database answers).
 */
export async function GET(req: Request): Promise<Response> {
  if (!isBridgeAuthorized(req)) return unauthorized();
  try {
    const objects = backupObjects();
    const fromBlob: ListedCopy[] = objects
      ? (await objects.copies()).map((r) => ({
          id: r.id,
          deviceId: r.deviceId,
          fileName: r.fileName,
          sizeBytes: r.sizeBytes,
          createdAt: r.createdAt,
          sha256: r.sha256,
          meta: r.meta,
        }))
      : [];
    let fromDb: ListedCopy[] = [];
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
      fromDb = rows.map((r) => ({
        id: r.id,
        deviceId: r.device_id,
        fileName: r.file_name,
        sizeBytes: r.size_bytes,
        createdAt: new Date(r.created_at).toISOString(),
        sha256: r.sha256,
        meta: r.meta_json,
      }));
    } catch (e) {
      if (!objects) throw e;
      console.warn('GET /api/bridge/backups: the database did not answer; listing the Blob store copies only', e);
    }
    const all = [...fromBlob, ...fromDb].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 200);
    return Response.json({ ok: true, data: all });
  } catch (e) {
    console.error('GET /api/bridge/backups failed', e);
    return Response.json({ ok: false, error: 'internal' }, { status: 500 });
  }
}
