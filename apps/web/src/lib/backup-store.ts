import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { sql } from '@/lib/db';

/**
 * Cloud copies stored as content-addressed chunks (format "chunks-v1").
 *
 * The POS exports each snapshot row by row, cuts that at content-defined
 * boundaries and names every
 * chunk by the SHA-256 of its raw bytes; a copy is the ordered list of those
 * names. A chunk is stored once no matter how many copies use it, so a daily
 * upload adds roughly one day of data, and no single request carries the
 * whole database (the old one-blob upload stopped at ~3 MB of gzip).
 *
 * Nothing trusts the POS's word: every chunk is un-gzipped and re-hashed on
 * arrival, and a copy is only recorded once every chunk it names is here.
 */

export const CHUNKS_FORMAT = 'chunks-v1';
/** Twice the POS's CHUNK_MAX_BYTES (apps/pos/electron/services/cloud-copy-chunks.ts), for headroom. */
export const MAX_CHUNK_RAW_BYTES = 256 * 1024;
/** 256 KiB that does not compress at all, as base64, with headroom. */
export const MAX_CHUNK_BASE64_CHARS = 400_000;
/** One upload request: under the host's 4.5 MB body limit. */
export const MAX_UPLOAD_BATCH_BASE64_CHARS = 3_500_000;
/** One download response: under the host's 4.5 MB response limit. */
export const FETCH_BATCH_STORED_BYTES = 2_500_000;
/** ~6 GB of copy at 32 KiB a chunk; far past anything a till makes. */
export const MAX_CHUNKS_PER_COPY = 200_000;
export const CHUNK_HASH_RE = /^[0-9a-f]{64}$/;
/**
 * A chunk nothing refers to is only removed once it has also gone unused this
 * long, so a chunk uploaded (or confirmed present) a moment ago for a copy
 * that is still being recorded is never collected from under it.
 */
export const CHUNK_GRACE_HOURS = 24;

let schemaReady: Promise<void> | null = null;

/**
 * Columns and tables added after launch. Idempotent, run once per server
 * instance, so nobody has to migrate the production database by hand.
 */
export function ensureBackupSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      const q = sql();
      await q`ALTER TABLE pos_backups ADD COLUMN IF NOT EXISTS sha256 TEXT`;
      await q`ALTER TABLE pos_backups ADD COLUMN IF NOT EXISTS meta_json JSONB`;
      await q`ALTER TABLE pos_backups ADD COLUMN IF NOT EXISTS format TEXT`;
      await q`ALTER TABLE pos_backups ADD COLUMN IF NOT EXISTS chunk_hashes JSONB`;
      await q`ALTER TABLE pos_backups ALTER COLUMN data_base64 DROP NOT NULL`;
      await q`
        CREATE TABLE IF NOT EXISTS pos_backup_chunks (
          hash          TEXT PRIMARY KEY,
          size_raw      INT NOT NULL,
          size_stored   INT NOT NULL,
          data          BYTEA NOT NULL,
          created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
          last_used_at  TIMESTAMPTZ NOT NULL DEFAULT now()
        )`;
    })().catch((e) => {
      schemaReady = null;
      throw e;
    });
  }
  return schemaReady;
}

export type ChunkCheck =
  | { ok: true; gz: Buffer; rawBytes: number }
  | { ok: false; error: 'bad_gzip' | 'too_large' | 'checksum_mismatch' };

/** Un-gzip (bounded) and confirm the chunk really is what its name says. */
export function checkChunk(hash: string, dataBase64: string): ChunkCheck {
  const gz = Buffer.from(dataBase64, 'base64');
  let raw: Buffer;
  try {
    raw = gunzipSync(gz, { maxOutputLength: MAX_CHUNK_RAW_BYTES });
  } catch (e) {
    const tooBig = e instanceof RangeError || (e as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE';
    return { ok: false, error: tooBig ? 'too_large' : 'bad_gzip' };
  }
  if (createHash('sha256').update(raw).digest('hex') !== hash) return { ok: false, error: 'checksum_mismatch' };
  return { ok: true, gz, rawBytes: raw.length };
}

/** Of these chunk names, the ones not stored here. Marks the others as just used. */
export async function missingChunks(hashes: string[]): Promise<string[]> {
  if (hashes.length === 0) return [];
  const rows = (await sql()`
    UPDATE pos_backup_chunks SET last_used_at = now()
     WHERE hash = ANY(${hashes}::text[])
    RETURNING hash
  `) as Array<{ hash: string }>;
  const have = new Set(rows.map((r) => r.hash));
  return hashes.filter((h) => !have.has(h));
}

/**
 * Remove chunks no copy refers to any more (after retention dropped their
 * copies) and that have sat unused for the grace period.
 */
export async function collectUnusedChunks(): Promise<number> {
  const rows = (await sql()`
    WITH live AS (
      SELECT DISTINCT jsonb_array_elements_text(chunk_hashes) AS hash
        FROM pos_backups WHERE chunk_hashes IS NOT NULL
    )
    DELETE FROM pos_backup_chunks c
     WHERE c.last_used_at < now() - make_interval(hours => ${CHUNK_GRACE_HOURS})
       AND NOT EXISTS (SELECT 1 FROM live WHERE live.hash = c.hash)
    RETURNING c.hash
  `) as Array<{ hash: string }>;
  return rows.length;
}
