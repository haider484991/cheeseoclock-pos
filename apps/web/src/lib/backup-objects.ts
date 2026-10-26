import { del, get, list, put } from '@vercel/blob';

/**
 * Where the till's cloud copies live once the website has a Blob store (27 Oct 2026; the user, after the database
 * hit its monthly limit and took the till's copies down with it: "the till's backups moved out of the database to
 * free storage"). A private Vercel Blob store: every read and write needs this website's own credentials (Vercel's
 * OIDC token on the functions), there is no public link to any file, and nothing is ever overwritten.
 *
 *   pos-backups/chunks/<sha256>-<rawBytes>.gz   one chunk, gzip as the till sent it (content-addressed, stored once)
 *   pos-backups/copies/<deviceId>/<id>.json     one copy's record: its chunk list, checksum, manifest, server time
 *
 * Without a store (BLOB_STORE_ID / BLOB_READ_WRITE_TOKEN unset) the routes keep the database tables, as before.
 * Copies already in the database stay readable from there and rotate out as new ones arrive.
 */

export interface CopyRecord {
  id: string;
  deviceId: string;
  fileName: string;
  /** The whole copy's raw size (the till's row export). */
  sizeBytes: number;
  sha256: string;
  meta: Record<string, unknown> | null;
  chunks: string[];
  /** The website's own clock when the copy was recorded. */
  createdAt: string;
}

export interface StoredChunk {
  hash: string;
  rawBytes: number;
  storedBytes: number;
  uploadedAt: Date;
}

export interface BackupObjects {
  /** Every chunk stored, by name. */
  chunks(): Promise<Map<string, StoredChunk>>;
  putChunk(hash: string, rawBytes: number, gz: Buffer): Promise<void>;
  getChunk(chunk: StoredChunk): Promise<Buffer | null>;
  deleteChunks(chunks: readonly StoredChunk[]): Promise<void>;
  putCopy(record: CopyRecord): Promise<void>;
  /** Every copy recorded (records in full), newest first. */
  copies(): Promise<CopyRecord[]>;
  deleteCopies(records: readonly CopyRecord[]): Promise<void>;
}

const CHUNK_PREFIX = 'pos-backups/chunks/';
const COPY_PREFIX = 'pos-backups/copies/';
const CHUNK_PATH = /^pos-backups\/chunks\/([0-9a-f]{64})-(\d+)\.gz$/;

const chunkPath = (hash: string, rawBytes: number) => `${CHUNK_PREFIX}${hash}-${rawBytes}.gz`;
const copyPath = (r: Pick<CopyRecord, 'deviceId' | 'id'>) => `${COPY_PREFIX}${encodeURIComponent(r.deviceId)}/${r.id}.json`;

async function listAll(prefix: string): Promise<Array<{ pathname: string; size: number; uploadedAt: Date }>> {
  const out: Array<{ pathname: string; size: number; uploadedAt: Date }> = [];
  let cursor: string | undefined;
  do {
    const page = await list({ prefix, cursor, limit: 1000 });
    for (const b of page.blobs) out.push({ pathname: b.pathname, size: b.size, uploadedAt: b.uploadedAt });
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return out;
}

async function readAll(pathname: string): Promise<Buffer | null> {
  const got = await get(pathname, { access: 'private', useCache: false });
  if (!got || !got.stream) return null;
  return Buffer.from(await new Response(got.stream).arrayBuffer());
}

/** The private Vercel Blob store connected to this project. */
export const vercelBlobObjects: BackupObjects = {
  async chunks() {
    const out = new Map<string, StoredChunk>();
    for (const b of await listAll(CHUNK_PREFIX)) {
      const m = CHUNK_PATH.exec(b.pathname);
      if (m) out.set(m[1]!, { hash: m[1]!, rawBytes: Number(m[2]), storedBytes: b.size, uploadedAt: b.uploadedAt });
    }
    return out;
  },
  async putChunk(hash, rawBytes, gz) {
    // Content-addressed: the same name always holds the same bytes, so a second upload is harmless.
    await put(chunkPath(hash, rawBytes), gz, {
      access: 'private',
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: 'application/gzip',
    });
  },
  async getChunk(c) {
    return readAll(chunkPath(c.hash, c.rawBytes));
  },
  async deleteChunks(cs) {
    if (cs.length > 0) await del(cs.map((c) => chunkPath(c.hash, c.rawBytes)));
  },
  async putCopy(r) {
    // A record is written once and never changed (allowOverwrite stays off).
    await put(copyPath(r), JSON.stringify(r), { access: 'private', addRandomSuffix: false, contentType: 'application/json' });
  },
  async copies() {
    const out: CopyRecord[] = [];
    for (const b of await listAll(COPY_PREFIX)) {
      const raw = await readAll(b.pathname);
      if (!raw) continue;
      try {
        out.push(JSON.parse(raw.toString('utf8')) as CopyRecord);
      } catch {
        // A record that does not read is left out, never guessed at.
      }
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  },
  async deleteCopies(rs) {
    if (rs.length > 0) await del(rs.map(copyPath));
  },
};

/** In memory, for tests: the same contract as the Blob store. */
export function memoryObjects(clock: () => Date = () => new Date()): BackupObjects & {
  chunkBytes: Map<string, Buffer>;
  records: Map<string, CopyRecord>;
} {
  const chunkBytes = new Map<string, Buffer>();
  const chunkInfo = new Map<string, StoredChunk>();
  const records = new Map<string, CopyRecord>();
  return {
    chunkBytes,
    records,
    async chunks() {
      return new Map(chunkInfo);
    },
    async putChunk(hash, rawBytes, gz) {
      chunkBytes.set(hash, Buffer.from(gz));
      if (!chunkInfo.has(hash)) chunkInfo.set(hash, { hash, rawBytes, storedBytes: gz.length, uploadedAt: clock() });
    },
    async getChunk(c) {
      return chunkBytes.get(c.hash) ?? null;
    },
    async deleteChunks(cs) {
      for (const c of cs) {
        chunkBytes.delete(c.hash);
        chunkInfo.delete(c.hash);
      }
    },
    async putCopy(r) {
      if (records.has(r.id)) throw new Error('a copy record is never overwritten');
      records.set(r.id, structuredClone(r));
    },
    async copies() {
      return [...records.values()].map((r) => structuredClone(r)).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
    async deleteCopies(rs) {
      for (const r of rs) records.delete(r.id);
    },
  };
}

let override: BackupObjects | null | undefined;

/** Tests choose the store (null = the database only, as before); undefined = back to the environment's. */
export function setBackupObjectsForTests(objects: BackupObjects | null | undefined): void {
  override = objects;
}

/** The Blob store when this website has one, else null (the copies stay in the database tables). */
export function backupObjects(): BackupObjects | null {
  if (override !== undefined) return override;
  return process.env['BLOB_STORE_ID'] || process.env['BLOB_READ_WRITE_TOKEN'] ? vercelBlobObjects : null;
}
