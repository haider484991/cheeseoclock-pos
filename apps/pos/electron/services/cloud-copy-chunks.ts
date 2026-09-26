/**
 * Cloud copies in content-defined chunks.
 *
 * A single gzip upload hit the website's ~3 MB request cap within a week at
 * 100 orders a day, and every upload re-sent the whole history. Instead the
 * copy (a row export — see cloud-copy-rows.ts) is cut at content-defined
 * boundaries (a rolling "gear" hash, so new rows only disturb the chunks
 * around them), each chunk is named by the SHA-256 of its bytes, and only
 * chunks the website does not hold yet are uploaded. A day's upload is about
 * a day's new rows, and a copy of any size works.
 *
 * Integrity: the website checks every chunk's hash on arrival; a restore
 * checks every chunk again and the SHA-256 of the whole reassembled copy.
 *
 * No Electron imports: the transfer takes a plain `BridgeApi` so it can be
 * tested against the website's route handlers directly.
 */

import { createHash } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';

/**
 * Chunk sizes: never under 8 KiB, about 32 KiB on average, never over
 * 128 KiB. Measured on a week of simulated trade (800 orders), a day's
 * upload was ~350 KB of gzip — the day's rows — at this size; 256 KiB
 * chunks sent 50% more.
 */
export const CHUNK_MIN_BYTES = 8 * 1024;
const CHUNK_AVG_BITS = 15;
/** The website refuses chunks larger than its MAX_CHUNK_RAW_BYTES (256 KiB). */
export const CHUNK_MAX_BYTES = 128 * 1024;
export const CHUNKS_FORMAT = 'chunks-v1';
/** Keep each upload request well under the host's 4.5 MB body limit. */
const UPLOAD_BATCH_BASE64_CHARS = 2_500_000;

/**
 * 256 fixed pseudo-random words. They must never change: a different table
 * cuts at different places, and every chunk the website already holds would
 * stop matching (still correct, just a full re-upload).
 */
const GEAR = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    t[i] = createHash('sha256').update(`cheeseoclock-gear-${i}`).digest().readUInt32BE(0);
  }
  return t;
})();

export interface Chunk {
  offset: number;
  length: number;
  /** SHA-256 of the raw chunk bytes, hex. */
  hash: string;
}

export function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Cut `buf` at content-defined boundaries. Concatenating the chunks gives
 * `buf` back. The cut test uses the hash's HIGH bits: the gear hash shifts
 * left, so its low bits only ever depend on the last few bytes, and
 * repetitive data (rows that look alike) almost never cut on them.
 */
export function chunkBuffer(buf: Buffer): Chunk[] {
  const cutter = new ChunkCutter(buf);
  cutter.scan(buf.length);
  return cutter.finish();
}

/**
 * Bytes scanned between event-loop turns by chunkBufferAsync. The scan runs at
 * about 1 ns a byte (a second per 100 MB) on the till's main process.
 */
const ASYNC_SLICE_BYTES = 4 * 1024 * 1024;

/** chunkBuffer, giving the event loop back every few MB. Same cuts, same hashes. */
export async function chunkBufferAsync(buf: Buffer, sliceBytes = ASYNC_SLICE_BYTES): Promise<Chunk[]> {
  const cutter = new ChunkCutter(buf);
  for (let to = Math.min(buf.length, sliceBytes); ; to = Math.min(buf.length, to + sliceBytes)) {
    cutter.scan(to);
    if (to >= buf.length) break;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return cutter.finish();
}

/** The gear-hash walk, resumable at any byte: its state is (start, h, i). */
class ChunkCutter {
  private readonly chunks: Chunk[] = [];
  private start = 0;
  private h = 0;
  private i = 0;

  constructor(private readonly buf: Buffer) {}

  /** Scan up to (not including) byte `to`. */
  scan(to: number): void {
    const { buf } = this;
    const shift = 32 - CHUNK_AVG_BITS;
    let h = this.h;
    for (let i = this.i; i < to; i++) {
      h = ((h << 1) + GEAR[buf[i]!]!) >>> 0;
      const len = i - this.start + 1;
      if ((len >= CHUNK_MIN_BYTES && h >>> shift === 0) || len >= CHUNK_MAX_BYTES) {
        this.cut(i + 1);
        h = 0;
      }
    }
    this.h = h;
    this.i = Math.max(this.i, to);
  }

  finish(): Chunk[] {
    if (this.start < this.buf.length) this.cut(this.buf.length);
    return this.chunks;
  }

  private cut(end: number): void {
    const { start } = this;
    this.chunks.push({ offset: start, length: end - start, hash: sha256Hex(this.buf.subarray(start, end)) });
    this.start = end;
  }
}

/** The website, as far as a cloud copy needs it: path + JSON body in, status + JSON out. */
export type BridgeApi = (
  path: string,
  init?: { method?: 'GET' | 'POST'; body?: string },
) => Promise<{ status: number; json: unknown }>;

/** The website predates chunked copies (no /backup-chunks routes yet). */
export class ChunksUnsupportedError extends Error {}

interface ApiEnvelope<T> {
  ok?: boolean;
  error?: string;
  message?: string;
  data?: T;
}

function fail(what: string, status: number, body: unknown): Error {
  const env = (body ?? {}) as ApiEnvelope<unknown>;
  return new Error(env.message ?? env.error ?? `${what} failed: HTTP ${status}`);
}

export interface ChunkedUploadResult {
  id: string | null;
  /** SHA-256 of the whole copy. */
  sha256: string;
  chunkCount: number;
  newChunkCount: number;
  /** Gzip bytes actually sent this time. */
  uploadedBytes: number;
}

/**
 * Upload a copy as chunks: ask which chunks the website lacks, send only
 * those (several per request), then record the copy as the ordered list of
 * chunk hashes. Chunks the website reports gone missing in between (its
 * clean-up ran) are sent again once.
 */
export async function uploadChunkedCopy(
  api: BridgeApi,
  raw: Buffer,
  copy: {
    deviceId: string;
    fileName: string;
    /** Stored beside the copy; given the chunk counts when it is a function. */
    meta:
      | Record<string, unknown>
      | ((sent: { chunkCount: number; newChunkCount: number; uploadedBytes: number }) => Record<string, unknown>);
  },
): Promise<ChunkedUploadResult> {
  const chunks = await chunkBufferAsync(raw);
  const sha256 = sha256Hex(raw);
  const byHash = new Map<string, Chunk>();
  for (const c of chunks) if (!byHash.has(c.hash)) byHash.set(c.hash, c);
  let uploadedBytes = 0;
  let newChunkCount = 0;

  const send = async (hashes: string[]) => {
    let batch: Array<{ hash: string; dataBase64: string }> = [];
    let batchChars = 0;
    const flush = async () => {
      if (batch.length === 0) return;
      const res = await api('/api/bridge/backup-chunks', { method: 'POST', body: JSON.stringify({ chunks: batch }) });
      if (res.status !== 200) throw fail('Chunk upload', res.status, res.json);
      batch = [];
      batchChars = 0;
    };
    for (const hash of hashes) {
      const c = byHash.get(hash);
      if (!c) throw new Error('The website asked for a chunk this copy does not contain');
      const gz = gzipSync(raw.subarray(c.offset, c.offset + c.length), { level: 6 });
      const dataBase64 = gz.toString('base64');
      if (batchChars + dataBase64.length > UPLOAD_BATCH_BASE64_CHARS) await flush();
      batch.push({ hash, dataBase64 });
      batchChars += dataBase64.length;
      uploadedBytes += gz.length;
      newChunkCount++;
    }
    await flush();
  };

  const ask = await api('/api/bridge/backup-chunks/missing', {
    method: 'POST',
    body: JSON.stringify({ hashes: [...byHash.keys()] }),
  });
  if (ask.status === 404) throw new ChunksUnsupportedError('The website does not take chunked copies yet');
  if (ask.status !== 200) throw fail('Chunk check', ask.status, ask.json);
  await send((ask.json as ApiEnvelope<{ missing: string[] }>).data?.missing ?? []);

  const record = () =>
    api('/api/bridge/backups', {
      method: 'POST',
      body: JSON.stringify({
        format: CHUNKS_FORMAT,
        deviceId: copy.deviceId,
        fileName: copy.fileName,
        chunks: chunks.map((c) => c.hash),
        sha256,
        rawBytes: raw.length,
        meta:
          typeof copy.meta === 'function'
            ? copy.meta({ chunkCount: chunks.length, newChunkCount, uploadedBytes })
            : copy.meta,
      }),
    });
  let res = await record();
  const env = res.json as ApiEnvelope<{ id: string }> & { missing?: string[] };
  if (res.status === 409 && env.error === 'missing_chunks' && env.missing?.length) {
    await send(env.missing);
    res = await record();
  }
  if (res.status !== 200) throw fail('Upload', res.status, res.json);
  const done = res.json as ApiEnvelope<{ id: string }>;
  return { id: done.data?.id ?? null, sha256, chunkCount: chunks.length, newChunkCount, uploadedBytes };
}

/**
 * Fetch every chunk of a chunked copy (in batches the website sizes), check
 * each against its name, join them, and check the whole against the copy's
 * SHA-256.
 */
export async function downloadChunkedCopy(
  api: BridgeApi,
  copy: { chunks: string[]; sha256: string },
): Promise<Buffer> {
  const got = new Map<string, Buffer>();
  let pending = [...new Set(copy.chunks)];
  while (pending.length > 0) {
    const res = await api('/api/bridge/backup-chunks/fetch', {
      method: 'POST',
      body: JSON.stringify({ hashes: pending }),
    });
    if (res.status !== 200) throw fail('Chunk download', res.status, res.json);
    const data = (res.json as ApiEnvelope<{ chunks: Array<{ hash: string; dataBase64: string }>; missing: string[]; rest: string[] }>).data;
    if (!data) throw new Error('Chunk download failed: bad response');
    if (data.missing.length > 0) {
      throw new Error(`The website no longer has ${data.missing.length} piece(s) of this cloud copy; pick another copy.`);
    }
    if (data.chunks.length === 0) throw new Error('Chunk download made no progress');
    for (const c of data.chunks) {
      const raw = gunzipSync(Buffer.from(c.dataBase64, 'base64'), { maxOutputLength: CHUNK_MAX_BYTES });
      if (sha256Hex(raw) !== c.hash) {
        throw new Error('A piece of the cloud copy does not match its checksum. It is damaged or was altered; refusing to restore it.');
      }
      got.set(c.hash, raw);
    }
    pending = data.rest;
  }
  const whole = Buffer.concat(copy.chunks.map((h) => {
    const b = got.get(h);
    if (!b) throw new Error('Chunk download incomplete');
    return b;
  }));
  if (sha256Hex(whole) !== copy.sha256) {
    throw new Error('The reassembled cloud copy does not match the checksum recorded at upload; refusing to restore it.');
  }
  return whole;
}
