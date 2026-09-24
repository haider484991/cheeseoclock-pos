/**
 * Chunked cloud copies, end to end: the POS's own upload/download code
 * (apps/pos/electron/services/cloud-copy-chunks.ts) against these route
 * handlers, on a real Postgres (PGlite, in memory) — so the two sides are
 * proven to agree, not just each against a mock.
 */
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import {
  chunkBuffer,
  downloadChunkedCopy,
  uploadChunkedCopy,
  type BridgeApi,
} from '../../../pos/electron/services/cloud-copy-chunks';

const db = vi.hoisted(() => ({ pg: null as unknown as { query: (t: string, v: unknown[]) => Promise<{ rows: unknown[] }> } }));
vi.mock('@/lib/db', () => ({
  // The Neon client is a tagged template returning rows; PGlite takes $n params.
  sql: () => (strings: TemplateStringsArray, ...values: unknown[]) =>
    db.pg.query(strings.reduce((acc, s, i) => acc + (i > 0 ? `$${i}` : '') + s, ''), values).then((r) => r.rows),
}));

const backups = await import('@/app/api/bridge/backups/route');
const backupById = await import('@/app/api/bridge/backups/[id]/route');
const chunkUpload = await import('@/app/api/bridge/backup-chunks/route');
const chunkMissing = await import('@/app/api/bridge/backup-chunks/missing/route');
const chunkFetch = await import('@/app/api/bridge/backup-chunks/fetch/route');
const store = await import('@/lib/backup-store');

const SECRET = 'test-bridge-secret-0123456789';

/** Call the route handlers the way the POS calls the site. */
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

beforeAll(async () => {
  process.env['BRIDGE_SECRET'] = SECRET;
  db.pg = new PGlite() as unknown as typeof db.pg;
  // The production table as it was before chunked copies (data_base64 NOT NULL).
  await (db.pg as unknown as PGlite).exec(`
    CREATE TABLE pos_backups (
      id UUID PRIMARY KEY, device_id TEXT NOT NULL, file_name TEXT NOT NULL,
      size_bytes INT NOT NULL, data_base64 TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );`);
});

const copy = (deviceId = 'till-1') => ({ deviceId, fileName: 'auto.db', meta: { reason: 'scheduled' } });

describe('chunked cloud copies (POS client ↔ site routes, real Postgres)', () => {
  it('uploads, lists and restores a copy byte for byte', async () => {
    const raw = fakeDb(3_000_000, 11);
    const up = await uploadChunkedCopy(api, raw, copy());
    expect(up.id).toBeTruthy();
    expect(up.newChunkCount).toBe(new Set(chunkBuffer(raw).map((c) => c.hash)).size);

    const one = await api(`/api/bridge/backups/${up.id}`);
    const rec = (one.json as { data: { format: string; chunks: string[]; sha256: string; sizeBytes: number } }).data;
    expect(rec.format).toBe('chunks-v1');
    expect(rec.sizeBytes).toBe(raw.length);

    const restored = await downloadChunkedCopy(api, rec);
    expect(restored.equals(raw)).toBe(true);
  });

  it('stores each chunk once: the next day sends only the new data', async () => {
    const before = await count('pos_backup_chunks');
    const day2 = Buffer.concat([fakeDb(3_000_000, 11), fakeDb(150_000, 12)]);
    const up = await uploadChunkedCopy(api, day2, copy());
    expect(up.newChunkCount).toBeLessThan(15);
    expect((await count('pos_backup_chunks')) - before).toBe(up.newChunkCount);
    const rec = ((await api(`/api/bridge/backups/${up.id}`)).json as { data: { chunks: string[]; sha256: string } }).data;
    expect((await downloadChunkedCopy(api, rec)).equals(day2)).toBe(true);
  });

  it('refuses a chunk whose bytes do not match its name', async () => {
    const res = await api('/api/bridge/backup-chunks', {
      method: 'POST',
      body: JSON.stringify({ chunks: [{ hash: 'a'.repeat(64), dataBase64: gzipSync(Buffer.from('not that')).toString('base64') }] }),
    });
    expect(res.status).toBe(400);
    expect((res.json as { error: string }).error).toBe('checksum_mismatch');
  });

  it('refuses a gzip bomb', async () => {
    const big = Buffer.alloc(store.MAX_CHUNK_RAW_BYTES + 1);
    const hash = createHash('sha256').update(big).digest('hex');
    const res = await api('/api/bridge/backup-chunks', {
      method: 'POST',
      body: JSON.stringify({ chunks: [{ hash, dataBase64: gzipSync(big).toString('base64') }] }),
    });
    expect(res.status).toBe(400);
    expect((res.json as { error: string }).error).toBe('too_large');
  });

  it('will not record a copy until every chunk is here, and checks the size adds up', async () => {
    const unknown = createHash('sha256').update('nope').digest('hex');
    const missing = await api('/api/bridge/backups', {
      method: 'POST',
      body: JSON.stringify({ format: 'chunks-v1', ...copy(), chunks: [unknown], sha256: unknown, rawBytes: 4 }),
    });
    expect(missing.status).toBe(409);
    expect((missing.json as { missing: string[] }).missing).toEqual([unknown]);

    const raw = fakeDb(200_000, 5);
    const up = await uploadChunkedCopy(api, raw, copy());
    const rec = ((await api(`/api/bridge/backups/${up.id}`)).json as { data: { chunks: string[]; sha256: string } }).data;
    const wrongSize = await api('/api/bridge/backups', {
      method: 'POST',
      body: JSON.stringify({ format: 'chunks-v1', ...copy(), chunks: rec.chunks, sha256: rec.sha256, rawBytes: raw.length + 1 }),
    });
    expect(wrongSize.status).toBe(400);
  });

  it('still takes and returns one-blob copies from older tills', async () => {
    const gz = gzipSync(Buffer.from('SQLite format 3\0 old till'));
    const res = await api('/api/bridge/backups', {
      method: 'POST',
      body: JSON.stringify({ ...copy('old-till'), dataBase64: gz.toString('base64') }),
    });
    expect(res.status).toBe(200);
    const id = (res.json as { data: { id: string } }).data.id;
    const got = (await api(`/api/bridge/backups/${id}`)).json as { data: { format: string; dataBase64: string; sha256: string } };
    expect(got.data.format).toBe('blob');
    expect(Buffer.from(got.data.dataBase64, 'base64').equals(gz)).toBe(true);
    expect(got.data.sha256).toBe(createHash('sha256').update(gz).digest('hex'));
  });

  it('removes chunks no copy uses once they have been idle a day — never a used or fresh one', async () => {
    const orphanOld = createHash('sha256').update('orphan-old').digest('hex');
    const orphanNew = createHash('sha256').update('orphan-new').digest('hex');
    const pg = db.pg;
    await pg.query(
      `INSERT INTO pos_backup_chunks (hash, size_raw, size_stored, data, last_used_at)
       VALUES ($1, 1, 1, '\\x00', now() - interval '3 days'), ($2, 1, 1, '\\x00', now())`,
      [orphanOld, orphanNew],
    );
    const used = ((await pg.query(`SELECT jsonb_array_elements_text(chunk_hashes) AS h FROM pos_backups WHERE chunk_hashes IS NOT NULL LIMIT 1`, [])).rows[0] as { h: string }).h;
    await pg.query(`UPDATE pos_backup_chunks SET last_used_at = now() - interval '3 days' WHERE hash = $1`, [used]);

    const removed = await store.collectUnusedChunks();
    const left = new Set(((await pg.query(`SELECT hash FROM pos_backup_chunks`, [])).rows as Array<{ hash: string }>).map((r) => r.hash));
    expect(removed).toBe(1);
    expect(left.has(orphanOld)).toBe(false);
    expect(left.has(orphanNew)).toBe(true);
    expect(left.has(used)).toBe(true);
  });

  it('hands a big copy back over several fetches', async () => {
    // ~3 MB of incompressible data: more than one fetch response can carry.
    const raw = Buffer.concat(Array.from({ length: 24 }, (_, i) => createHash('sha512').update(`r${i}`).digest()).flatMap((seed) =>
      Array.from({ length: 2_000 }, (_, j) => createHash('sha512').update(seed).update(String(j)).digest()),
    ));
    const up = await uploadChunkedCopy(api, raw, copy('big-till'));
    const rec = ((await api(`/api/bridge/backups/${up.id}`)).json as { data: { chunks: string[]; sha256: string } }).data;
    const first = await api('/api/bridge/backup-chunks/fetch', { method: 'POST', body: JSON.stringify({ hashes: rec.chunks }) });
    expect(((first.json as { data: { rest: string[] } }).data.rest.length)).toBeGreaterThan(0);
    expect((await downloadChunkedCopy(api, rec)).equals(raw)).toBe(true);
  });

  it('turns away callers without the bridge secret', async () => {
    const res = await chunkMissing.POST(new Request('https://site.test/x', { method: 'POST', body: '{"hashes":[]}' }));
    expect(res.status).toBe(401);
  });
});
