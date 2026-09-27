/**
 * The Reports worker's read connection and the till closing (costing spec
 * Phase 3), on a real WAL database file with node:sqlite (better-sqlite3
 * here is built for Electron; skips where node:sqlite is missing).
 *
 * The till's own connection folds the write-ahead log into the database
 * file when it closes, but only as the LAST connection open. The worker is
 * therefore told to close its read connection first (worker-client.ts
 * `stop`): after that, the .sqlite file on its own holds every sale.
 * The worker runs here over a MessageChannel, exactly as in its thread.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MessageChannel, type MessagePort } from 'node:worker_threads';
import { DatabaseSync } from '../../db/costing-shop.fixture.js';
import { WORKER_TAG, type WorkerReply } from './worker-protocol.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });
vi.mock('electron-log/main', () => ({ default: { info: () => {}, warn: () => {}, error: () => {} } }));
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));

const live = describe.skipIf(!DatabaseSync);

interface Raw {
  exec(sql: string): void;
  prepare(sql: string): { run(...p: unknown[]): unknown; get(...p: unknown[]): unknown };
  close(): void;
}
type RawCtor = new (file: string, opts?: { readOnly?: boolean }) => Raw;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** A till's database file in WAL mode, with made-up sales still in the -wal. */
function tillFile(sales: number): { file: string; till: Raw } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coc-worker-'));
  dirs.push(dir);
  const file = path.join(dir, 'cheeseoclock.sqlite');
  const till = new (DatabaseSync as unknown as RawCtor)(file);
  till.exec('PRAGMA journal_mode = WAL');
  till.exec('CREATE TABLE orders (id TEXT PRIMARY KEY, total_cents INTEGER NOT NULL)');
  // The tables have long been in the file; the day's sales are in the -wal.
  till.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const add = till.prepare('INSERT INTO orders (id, total_cents) VALUES (?, ?)');
  for (let i = 0; i < sales; i++) add.run(`o${i}`, 1000 + i);
  return { file, till };
}

/** The worker's side started on `port`; resolves once it has said ready. */
async function startWorker(file: string): Promise<{ main: MessagePort; closed: Promise<void> }> {
  const { serve } = await import('./worker.js');
  const { port1: main, port2: inWorker } = new MessageChannel();
  const closed = new Promise<void>((resolve) => main.once('close', () => resolve()));
  const ready = new Promise<WorkerReply>((resolve) => main.once('message', (m: WorkerReply) => resolve(m)));
  serve(inWorker, { tag: WORKER_TAG, dbPath: file, driver: 'node:sqlite' });
  expect(await ready).toMatchObject({ type: 'ready', journalMode: 'wal' });
  return { main, closed };
}

/** What a copy of the .sqlite file alone (no -wal beside it) holds. */
function salesInFileAlone(file: string): number {
  const copy = `${file}.copy`;
  fs.copyFileSync(file, copy);
  const db = new (DatabaseSync as unknown as RawCtor)(copy);
  try {
    return (db.prepare('SELECT COUNT(*) AS n FROM orders').get() as { n: number }).n;
  } finally {
    db.close();
  }
}

live('the Reports worker and the till closing', () => {
  it('told to close, the worker closes its read connection: the till closes last and every sale is in the .sqlite file', async () => {
    const { file, till } = tillFile(40);
    expect(fs.existsSync(`${file}-wal`)).toBe(true);
    const { main, closed } = await startWorker(file);
    // The till closing: the worker first ...
    main.postMessage({ type: 'close' });
    await closed;
    // ... then the till's own connection, now the last one open.
    till.close();
    expect(fs.existsSync(`${file}-wal`)).toBe(false);
    expect(salesInFileAlone(file)).toBe(40);
  });

  it('(why it matters) with the read connection still open, the till closing leaves its sales in the -wal', async () => {
    const { file, till } = tillFile(40);
    const { main, closed } = await startWorker(file);
    till.close();
    main.postMessage({ type: 'close' });
    await closed;
    // A read-only connection cannot fold the log in: the .sqlite alone is short.
    expect(fs.existsSync(`${file}-wal`)).toBe(true);
    expect(salesInFileAlone(file)).toBe(0);
  });

  it('told a stock take was finished, the worker answers nothing, and one it cannot work out never stops it', async () => {
    // Only an orders table here: the stock-take comparison can't be worked out — quietly left to the card.
    const { file, till } = tillFile(1);
    const { main, closed } = await startWorker(file);
    const replies: Array<{ type: string; id?: number }> = [];
    const answered = new Promise<void>((resolve) =>
      main.on('message', (m: { type: string; id?: number }) => {
        replies.push(m);
        if (m.type === 'result') resolve();
      }),
    );
    main.postMessage({ type: 'warm', link: { on: false, stale: false, lastHeardAt: null }, nowIso: '2026-09-26T10:00:00.000Z' });
    main.postMessage({ type: 'run', id: 7, kind: 'overview', request: { sinceIso: '2026-09-26T00:00:00.000Z', untilIso: '2026-09-27T00:00:00.000Z' }, nowIso: '2026-09-26T10:00:00.000Z' });
    await answered;
    // One answer, for the tab asked; nothing for the warm-up.
    expect(replies.map((r) => [r.type, r.id])).toEqual([['result', 7]]);
    main.postMessage({ type: 'close' });
    await closed;
    till.close();
  });

  it('after closing, the worker answers nothing more', async () => {
    const { file, till } = tillFile(1);
    const { main, closed } = await startWorker(file);
    const replies: unknown[] = [];
    main.on('message', (m) => replies.push(m));
    main.postMessage({ type: 'close' });
    main.postMessage({ type: 'run', id: 1, kind: 'overview', request: { sinceIso: '2026-09-26T00:00:00.000Z', untilIso: '2026-09-27T00:00:00.000Z' }, nowIso: '2026-09-26T10:00:00.000Z' });
    await closed;
    expect(replies).toEqual([]);
    till.close();
  });
});
