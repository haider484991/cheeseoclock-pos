/**
 * The till's cloud copies in the Worker's R2 bucket (lib/backup-objects.ts; 27 Oct 2026, the website on Cloudflare: the
 * user, "Yes, move the till's cloud backups to Cloudflare R2"): the POS's own upload/download code
 * (apps/pos/electron/services/cloud-copy-chunks.ts) against the route handlers, with the bucket handed over the way
 * cloudflare/worker.mjs does it and the database not answering —
 *  - a copy goes into the bucket and comes back byte for byte;
 *  - each chunk is stored once (the next day sends only what changed);
 *  - a record is never overwritten;
 *  - a listing longer than one page and a delete of more than 1000 names are both whole.
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  chunkBuffer,
  downloadChunkedCopy,
  uploadChunkedCopy,
  type BridgeApi,
} from '../../../pos/electron/services/cloud-copy-chunks';
import type { R2BucketLike } from './backup-objects';

vi.mock('@/lib/db', () => ({
  sql: () => () => Promise.reject(new Error('the database is not answering')),
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

/** A Workers R2 bucket in memory: lists in pages of 3 (so the cursor is followed), deletes at most 1000 names a call. */
function memoryBucket() {
  const objects = new Map<string, { bytes: Uint8Array; uploaded: Date }>();
  const deleteCalls: number[] = [];
  const bucket: R2BucketLike = {
    async head(key) {
      return objects.has(key) ? { key } : null;
    },
    async get(key) {
      const o = objects.get(key);
      return o ? { arrayBuffer: async () => o.bytes.slice().buffer } : null;
    },
    async put(key, value) {
      objects.set(key, { bytes: typeof value === 'string' ? new TextEncoder().encode(value) : Uint8Array.from(value), uploaded: new Date() });
      return {};
    },
    async delete(keys) {
      if (keys.length > 1000) throw new Error('R2 deletes at most 1000 keys a call');
      deleteCalls.push(keys.length);
      for (const k of keys) objects.delete(k);
    },
    async list({ prefix, cursor }) {
      const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
      const from = cursor ? Number(cursor) : 0;
      const page = keys.slice(from, from + 3);
      const truncated = from + 3 < keys.length;
      return {
        objects: page.map((key) => ({ key, size: objects.get(key)!.bytes.length, uploaded: objects.get(key)!.uploaded })),
        truncated,
        ...(truncated ? { cursor: String(from + 3) } : {}),
      };
    },
  };
  return { bucket, objects, deleteCalls };
}

function fakeDb(bytes: number, seed = 1): Buffer {
  const out = Buffer.alloc(bytes);
  let x = seed >>> 0;
  for (let i = 0; i < bytes; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    out[i] = i % 4096 < 3000 ? (x >>> 16) & 0xff : 0;
  }
  return out;
}

const copy = (deviceId = 'till-1') => ({ deviceId, fileName: 'auto.db', meta: { reason: 'scheduled' } });
type Rec = { id: string; format: string; chunks: string[]; sha256: string; sizeBytes: number };
const record = async (id: string) => ((await api(`/api/bridge/backups/${id}`)).json as { data: Rec }).data;
const listed = async () => ((await api('/api/bridge/backups')).json as { data: Array<{ id: string }> }).data.map((c) => c.id);

const BUCKET = Symbol.for('site.backups-bucket');
const r2 = memoryBucket();
const chunkNames = () => [...r2.objects.keys()].filter((k) => k.startsWith('pos-backups/chunks/'));
const recordNames = () => [...r2.objects.keys()].filter((k) => k.startsWith('pos-backups/copies/'));

beforeAll(() => {
  process.env['BRIDGE_SECRET'] = SECRET;
  delete process.env['BLOB_STORE_ID'];
  delete process.env['BLOB_READ_WRITE_TOKEN'];
  objectsModule.setBackupObjectsForTests(undefined);
  (globalThis as Record<symbol, unknown>)[BUCKET] = r2.bucket;
});

afterAll(() => {
  delete (globalThis as Record<symbol, unknown>)[BUCKET];
});

describe("cloud copies in the Worker's R2 bucket (POS client ↔ site routes)", () => {
  it('uses the bucket the Worker hands over', () => {
    expect(objectsModule.backupObjects()).not.toBeNull();
    expect(objectsModule.backupObjects()).not.toBe(objectsModule.vercelBlobObjects);
  });

  it('stores a copy in the bucket and gives it back byte for byte, with the database down', async () => {
    const raw = fakeDb(2_000_000, 11);
    const up = await uploadChunkedCopy(api, raw, copy());
    expect(up.newChunkCount).toBe(new Set(chunkBuffer(raw).map((c) => c.hash)).size);
    expect(chunkNames()).toHaveLength(up.newChunkCount);
    expect(recordNames()).toEqual([`pos-backups/copies/till-1/${up.id}.json`]);
    expect(await listed()).toEqual([up.id]);
    const rec = await record(up.id!);
    expect(rec).toMatchObject({ format: 'chunks-v1', sizeBytes: raw.length });
    const back = await downloadChunkedCopy(api, rec);
    expect(back.equals(raw)).toBe(true);
    expect(createHash('sha256').update(back).digest('hex')).toBe(rec.sha256);
  });

  it('stores each chunk once: the next day sends only the new data', async () => {
    const before = chunkNames().length;
    const day2 = Buffer.concat([fakeDb(2_000_000, 11), fakeDb(120_000, 12)]);
    const up = await uploadChunkedCopy(api, day2, copy());
    expect(up.newChunkCount).toBeLessThan(15);
    expect(chunkNames().length - before).toBe(up.newChunkCount);
    expect((await downloadChunkedCopy(api, await record(up.id!))).equals(day2)).toBe(true);
    expect(await listed()).toHaveLength(2);
  });

  it('never overwrites a record', async () => {
    const store = objectsModule.backupObjects()!;
    const [first] = await store.copies();
    await expect(store.putCopy(first!)).rejects.toThrow();
  });

  it('lists past one page and deletes more than 1000 names in batches', async () => {
    const local = memoryBucket();
    const store = objectsModule.r2Objects(local.bucket);
    const many = Array.from({ length: 2500 }, (_, i) => createHash('sha256').update(String(i)).digest('hex'));
    for (const h of many) await store.putChunk(h, 10, Buffer.from('x'));
    const all = await store.chunks();
    expect(all.size).toBe(2500);
    await store.deleteChunks([...all.values()]);
    expect(local.deleteCalls).toEqual([1000, 1000, 500]);
    expect(local.objects.size).toBe(0);
  });
});
