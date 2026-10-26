/**
 * The till's cloud copies in the website's Blob store (lib/backup-objects.ts; 27 Oct 2026: the database hit its
 * monthly limit and took the copies down with it): the POS's own upload/download code
 * (apps/pos/electron/services/cloud-copy-chunks.ts) against the route handlers, with the Blob store in memory and
 * a real Postgres (PGlite) for the copies made before the store —
 *  - a copy goes into the Blob store, never into the database, and comes back byte for byte;
 *  - each chunk is stored once (the next day sends only what changed);
 *  - a copy made before the store (in the database) is still listed and restored;
 *  - with the database not answering, the Blob store's copies are still listed and restored;
 *  - a record is never overwritten.
 */
import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  chunkBuffer,
  downloadChunkedCopy,
  uploadChunkedCopy,
  type BridgeApi,
} from '../../../pos/electron/services/cloud-copy-chunks';

const db = vi.hoisted(() => ({
  pg: null as unknown as { query: (t: string, v: unknown[]) => Promise<{ rows: unknown[] }> },
  down: false,
}));
vi.mock('@/lib/db', () => ({
  sql: () => (strings: TemplateStringsArray, ...values: unknown[]) => {
    if (db.down) return Promise.reject(new Error('NeonDbError: Your account or project has exceeded the quota'));
    return db.pg.query(strings.reduce((acc, s, i) => acc + (i > 0 ? `$${i}` : '') + s, ''), values).then((r) => r.rows);
  },
}));

const backups = await import('@/app/api/bridge/backups/route');
const backupById = await import('@/app/api/bridge/backups/[id]/route');
const chunkUpload = await import('@/app/api/bridge/backup-chunks/route');
const chunkMissing = await import('@/app/api/bridge/backup-chunks/missing/route');
const chunkFetch = await import('@/app/api/bridge/backup-chunks/fetch/route');
const objectsModule = await import('@/lib/backup-objects');

const SECRET = 'test-bridge-secret-0123456789';

const api: BridgeApi = async (path, init) => {
  const req = new Request(`https://site.test${path}`, {
    method: init?.method ?? 'GET',
    headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' },
    body: init?.body,
  });
  let res: Response;
  let m: RegExpMatchArray | null;
  if (path === '/api/bridge/backup-chunks/missing') res = await chunkMissing.POST(req);
  else if (path === '/api/bridge/backup-chunks/fetch') res = await chunkFetch.POST(req);
  else if (path === '/api/bridge/backup-chunks') res = await chunkUpload.POST(req);
  else if (path === '/api/bridge/backups') res = init?.method === 'POST' ? await backups.POST(req) : await backups.GET(req);
  else if ((m = path.match(/^\/api\/bridge\/backups\/(.+)$/))) res = await backupById.GET(req, { params: { id: m[1]! } });
  else throw new Error(`no route ${path}`);
  return { status: res.status, json: await res.json() };
};

function fakeDb(bytes: number, seed = 1): Buffer {
  const out = Buffer.alloc(bytes);
  let x = seed >>> 0;
  for (let i = 0; i < bytes; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    out[i] = i % 4096 < 3000 ? (x >>> 16) & 0xff : 0;
  }
  return out;
}

const count = async (table: string) =>
  ((await db.pg.query(`SELECT COUNT(*)::int AS n FROM ${table}`, [])).rows[0] as { n: number }).n;
const copy = (deviceId = 'till-1') => ({ deviceId, fileName: 'auto.db', meta: { reason: 'scheduled' } });
type Rec = { id: string; format: string; chunks: string[]; sha256: string; sizeBytes: number };
const record = async (id: string) => ((await api(`/api/bridge/backups/${id}`)).json as { data: Rec }).data;
const listed = async () => ((await api('/api/bridge/backups')).json as { data: Array<{ id: string }> }).data.map((c) => c.id);

const blob = objectsModule.memoryObjects();
let oldId = '';
let oldRaw: Buffer = Buffer.alloc(0);

beforeAll(async () => {
  process.env['BRIDGE_SECRET'] = SECRET;
  db.pg = new PGlite() as unknown as typeof db.pg;
  await (db.pg as unknown as PGlite).exec(`
    CREATE TABLE pos_backups (
      id UUID PRIMARY KEY, device_id TEXT NOT NULL, file_name TEXT NOT NULL,
      size_bytes INT NOT NULL, data_base64 TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );`);
  // A copy made before the website had a Blob store: in the database.
  objectsModule.setBackupObjectsForTests(null);
  oldRaw = fakeDb(400_000, 3);
  oldId = (await uploadChunkedCopy(api, oldRaw, copy())).id!;
  objectsModule.setBackupObjectsForTests(blob);
});

afterAll(() => objectsModule.setBackupObjectsForTests(undefined));

describe('cloud copies in the Blob store (POS client ↔ site routes)', () => {
  it('stores a copy in the Blob store, not the database, and gives it back byte for byte', async () => {
    const chunksInDb = await count('pos_backup_chunks');
    const raw = fakeDb(2_000_000, 11);
    const up = await uploadChunkedCopy(api, raw, copy());
    expect(up.newChunkCount).toBe(new Set(chunkBuffer(raw).map((c) => c.hash)).size);
    expect(blob.records.has(up.id!)).toBe(true);
    expect(blob.chunkBytes.size).toBe(up.newChunkCount);
    expect(await count('pos_backup_chunks')).toBe(chunksInDb);
    expect(await count('pos_backups')).toBe(1);
    const rec = await record(up.id!);
    expect(rec).toMatchObject({ format: 'chunks-v1', sizeBytes: raw.length });
    expect((await downloadChunkedCopy(api, rec)).equals(raw)).toBe(true);
  });

  it('stores each chunk once: the next day sends only the new data', async () => {
    const before = blob.chunkBytes.size;
    const day2 = Buffer.concat([fakeDb(2_000_000, 11), fakeDb(120_000, 12)]);
    const up = await uploadChunkedCopy(api, day2, copy());
    expect(up.newChunkCount).toBeLessThan(15);
    expect(blob.chunkBytes.size - before).toBe(up.newChunkCount);
    expect((await downloadChunkedCopy(api, await record(up.id!))).equals(day2)).toBe(true);
  });

  it('still lists and restores the copy made before the Blob store (from the database)', async () => {
    expect(await listed()).toContain(oldId);
    const rec = await record(oldId);
    expect(rec.format).toBe('chunks-v1');
    expect((await downloadChunkedCopy(api, rec)).equals(oldRaw)).toBe(true);
  });

  it('with the database not answering, the Blob store copies are still listed and restored', async () => {
    const ids = [...blob.records.keys()];
    db.down = true;
    try {
      const now = await listed();
      for (const id of ids) expect(now).toContain(id);
      expect(now).not.toContain(oldId);
      const rec = await record(ids[0]!);
      const raw = await downloadChunkedCopy(api, rec);
      expect(createHash('sha256').update(raw).digest('hex')).toBe(rec.sha256);
      // A new copy still goes in: the chunks, the record, the rotation.
      const up = await uploadChunkedCopy(api, fakeDb(300_000, 21), copy());
      expect(blob.records.has(up.id!)).toBe(true);
    } finally {
      db.down = false;
    }
  });

  it('will not record a copy until every chunk is in the Blob store', async () => {
    const unknown = createHash('sha256').update('nope').digest('hex');
    const missing = await api('/api/bridge/backups', {
      method: 'POST',
      body: JSON.stringify({ format: 'chunks-v1', ...copy(), chunks: [unknown], sha256: unknown, rawBytes: 4 }),
    });
    expect(missing.status).toBe(409);
    expect((missing.json as { missing: string[] }).missing).toEqual([unknown]);
  });

  it('never overwrites a record', async () => {
    const [first] = await blob.copies();
    await expect(blob.putCopy(first!)).rejects.toThrow();
  });
});
