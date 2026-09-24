import { randomBytes, createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  CHUNK_MAX_BYTES,
  CHUNK_MIN_BYTES,
  ChunksUnsupportedError,
  chunkBuffer,
  downloadChunkedCopy,
  sha256Hex,
  uploadChunkedCopy,
  type BridgeApi,
} from './cloud-copy-chunks.js';

/** Deterministic "database-like" bytes: random runs mixed with repeated rows and zero padding. */
function fakeDb(bytes: number, seed = 1): Buffer {
  const out = Buffer.alloc(bytes);
  let x = seed >>> 0;
  for (let i = 0; i < bytes; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0; // 32-bit LCG; plain * loses bits past 2^53
    out[i] = i % 4096 < 3000 ? (x >>> 16) & 0xff : 0;
  }
  return out;
}

/** The website's chunk semantics, in memory. */
function fakeSite() {
  const chunks = new Map<string, Buffer>();
  const copies = new Map<string, { chunks: string[]; sha256: string }>();
  const log: string[] = [];
  const api: BridgeApi = async (path, init) => {
    log.push(path);
    const body = init?.body ? JSON.parse(init.body) : null;
    if (path === '/api/bridge/backup-chunks/missing') {
      return { status: 200, json: { ok: true, data: { missing: body.hashes.filter((h: string) => !chunks.has(h)) } } };
    }
    if (path === '/api/bridge/backup-chunks') {
      for (const c of body.chunks as Array<{ hash: string; dataBase64: string }>) {
        const gz = Buffer.from(c.dataBase64, 'base64');
        if (sha256Hex(gunzipSync(gz)) !== c.hash) return { status: 400, json: { ok: false, error: 'checksum_mismatch' } };
        chunks.set(c.hash, gz);
      }
      return { status: 200, json: { ok: true } };
    }
    if (path === '/api/bridge/backup-chunks/fetch') {
      // Hand back at most 3 per call, to exercise the "rest" loop.
      const want: string[] = body.hashes;
      const have = want.filter((h) => chunks.has(h));
      const take = have.slice(0, 3);
      return {
        status: 200,
        json: {
          ok: true,
          data: {
            chunks: take.map((h) => ({ hash: h, dataBase64: chunks.get(h)!.toString('base64') })),
            missing: want.filter((h) => !chunks.has(h)),
            rest: have.slice(3),
          },
        },
      };
    }
    if (path === '/api/bridge/backups') {
      const missing = [...new Set<string>(body.chunks)].filter((h) => !chunks.has(h));
      if (missing.length) return { status: 409, json: { ok: false, error: 'missing_chunks', missing } };
      const id = `copy-${copies.size + 1}`;
      copies.set(id, { chunks: body.chunks, sha256: body.sha256 });
      return { status: 200, json: { ok: true, data: { id } } };
    }
    return { status: 404, json: {} };
  };
  return { api, chunks, copies, log };
}

describe('chunkBuffer', () => {
  it('cuts into pieces that join back to the exact bytes, within the size bounds', () => {
    const buf = fakeDb(5_000_000);
    const chunks = chunkBuffer(buf);
    expect(Buffer.concat(chunks.map((c) => buf.subarray(c.offset, c.offset + c.length))).equals(buf)).toBe(true);
    chunks.slice(0, -1).forEach((c) => {
      expect(c.length).toBeGreaterThanOrEqual(CHUNK_MIN_BYTES);
      expect(c.length).toBeLessThanOrEqual(CHUNK_MAX_BYTES);
    });
    expect(chunks.length).toBeGreaterThan(5);
  });

  it('cuts the same bytes the same way every time', () => {
    const buf = fakeDb(2_000_000, 9);
    expect(chunkBuffer(buf).map((c) => c.hash)).toEqual(chunkBuffer(Buffer.from(buf)).map((c) => c.hash));
  });

  it('keeps most chunks when bytes are inserted near the start (boundaries follow content)', () => {
    const before = fakeDb(6_000_000, 3);
    const after = Buffer.concat([before.subarray(0, 100_000), randomBytes(3_000), before.subarray(100_000)]);
    const old = new Set(chunkBuffer(before).map((c) => c.hash));
    const now = chunkBuffer(after);
    const reused = now.filter((c) => old.has(c.hash)).length;
    expect(reused / now.length).toBeGreaterThan(0.8);
  });

  it('handles empty and tiny inputs', () => {
    expect(chunkBuffer(Buffer.alloc(0))).toEqual([]);
    expect(chunkBuffer(Buffer.from('hi'))).toHaveLength(1);
  });
});

describe('uploadChunkedCopy / downloadChunkedCopy', () => {
  const copy = { deviceId: 'dev-1', fileName: 'x.db', meta: { reason: 'manual' } };

  it('round-trips a copy byte for byte, and a second day sends only what changed', async () => {
    const site = fakeSite();
    const day1 = fakeDb(4_000_000, 5);
    const first = await uploadChunkedCopy(site.api, day1, copy);
    expect(first.newChunkCount).toBe(new Set(chunkBuffer(day1).map((c) => c.hash)).size);

    const day2 = Buffer.concat([day1, fakeDb(200_000, 6)]); // the day's new rows
    const second = await uploadChunkedCopy(site.api, day2, copy);
    expect(second.newChunkCount).toBeLessThan(first.newChunkCount / 5);
    expect(second.uploadedBytes).toBeLessThan(first.uploadedBytes / 5);

    const restored = await downloadChunkedCopy(site.api, site.copies.get(second.id!)!);
    expect(restored.equals(day2)).toBe(true);
    expect(sha256Hex(restored)).toBe(second.sha256);
  });

  it('resends chunks the website lost between the check and the record', async () => {
    const site = fakeSite();
    const buf = fakeDb(1_000_000, 8);
    const realApi = site.api;
    let dropped = false;
    const api: BridgeApi = async (path, init) => {
      if (path === '/api/bridge/backups' && !dropped) {
        dropped = true;
        site.chunks.delete([...site.chunks.keys()][0]!); // clean-up ran in between
      }
      return realApi(path, init);
    };
    const res = await uploadChunkedCopy(api, buf, copy);
    expect(res.id).toBe('copy-1');
    expect((await downloadChunkedCopy(site.api, site.copies.get('copy-1')!)).equals(buf)).toBe(true);
  });

  it('refuses a copy the website has lost part of', async () => {
    const site = fakeSite();
    const res = await uploadChunkedCopy(site.api, fakeDb(400_000, 3), copy);
    site.chunks.delete(site.copies.get(res.id!)!.chunks[2]!);
    await expect(downloadChunkedCopy(site.api, site.copies.get(res.id!)!)).rejects.toThrow(/no longer has/);
  });

  it('refuses a copy with an altered chunk', async () => {
    const site = fakeSite();
    const buf = fakeDb(1_500_000, 2);
    const res = await uploadChunkedCopy(site.api, buf, copy);
    const victim = site.copies.get(res.id!)!.chunks[1]!;
    // Swap in another chunk's bytes under this chunk's name.
    const other = [...site.chunks.entries()].find(([h]) => h !== victim)![1];
    site.chunks.set(victim, other);
    await expect(downloadChunkedCopy(site.api, site.copies.get(res.id!)!)).rejects.toThrow(/checksum/);
  });

  it('refuses a copy whose whole-file checksum does not match', async () => {
    const site = fakeSite();
    const res = await uploadChunkedCopy(site.api, fakeDb(300_000, 4), copy);
    const rec = site.copies.get(res.id!)!;
    await expect(
      downloadChunkedCopy(site.api, { ...rec, sha256: createHash('sha256').update('x').digest('hex') }),
    ).rejects.toThrow(/checksum/);
  });

  it('reports an older website that has no chunk routes', async () => {
    const api: BridgeApi = async () => ({ status: 404, json: {} });
    await expect(uploadChunkedCopy(api, fakeDb(100_000), copy)).rejects.toBeInstanceOf(ChunksUnsupportedError);
  });
});
