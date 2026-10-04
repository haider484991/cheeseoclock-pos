/**
 * Housekeeping for the FBR dry-run ("noop") mode: finished noop rows older
 * than 30 days go, pending/failed rows and every sandbox or production row
 * stay; old payload files in userData/fbr-noop go, newest first kept, at most
 * a batch per run. Real SQLite (node:sqlite with a small transaction() shim;
 * skips where it is missing) and a real temporary folder.
 */
import { mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { readFileSync, readdirSync as readMigrations } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { AppDatabase } from '../db/connection.js';

vi.mock('electron-log/main', () => ({ default: { info: () => {}, warn: () => {}, error: () => {} } }));

import { FBR_NOOP_KEEP_DAYS, purgeOldNoopFiles, runHousekeeping } from './housekeeping.js';

interface Stmt {
  run(...p: unknown[]): unknown;
  all(...p: unknown[]): Array<Record<string, unknown>>;
  get(...p: unknown[]): Record<string, unknown> | undefined;
}
interface RawDb {
  exec(sql: string): void;
  prepare(sql: string): Stmt;
}
const Sqlite = (() => {
  try {
    return (createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: new (path: string) => RawDb }).DatabaseSync;
  } catch {
    return null;
  }
})();
const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');

function openMigrated(): AppDatabase {
  const raw = new Sqlite!(':memory:');
  for (const f of readMigrations(MIGRATIONS).filter((x) => x.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(join(MIGRATIONS, f), 'utf8'));
  }
  // Queue rows alone, without the orders they would point at.
  raw.exec('PRAGMA foreign_keys = OFF');
  let depth = 0;
  const db = {
    exec: (sql: string) => raw.exec(sql),
    prepare: (sql: string) => raw.prepare(sql),
    transaction:
      <A extends unknown[], R>(fn: (...args: A) => R) =>
      (...args: A): R => {
        const sp = `sp_${depth}`;
        raw.exec(depth === 0 ? 'BEGIN' : `SAVEPOINT ${sp}`);
        depth += 1;
        try {
          const out = fn(...args);
          depth -= 1;
          raw.exec(depth === 0 ? 'COMMIT' : `RELEASE ${sp}`);
          return out;
        } catch (e) {
          depth -= 1;
          if (depth === 0) raw.exec('ROLLBACK');
          else raw.exec(`ROLLBACK TO ${sp}; RELEASE ${sp}`);
          throw e;
        }
      },
  };
  return db as unknown as AppDatabase;
}

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-10-05T12:00:00.000Z');
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();

function queueRow(db: AppDatabase, id: string, mode: string, status: string, enqueuedAt: string): void {
  db.prepare(
    `INSERT INTO fbr_submission_queue (id, order_id, kind, ref_id, payload_json, status, attempts, enqueued_at, mode_at_enqueue, created_at, updated_at)
       VALUES (?, ?, 'sale', ?, '{}', ?, 0, ?, ?, ?, ?)`,
  ).run(id, `order-${id}`, `order-${id}`, status, enqueuedAt, mode, enqueuedAt, enqueuedAt);
}

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

describe.skipIf(!Sqlite)('housekeeping: FBR dry-run rows', () => {
  it('removes finished noop rows older than 30 days and nothing else', () => {
    const db = openMigrated();
    queueRow(db, 'old-noop-sent', 'noop', 'sent', ago(FBR_NOOP_KEEP_DAYS + 1));
    queueRow(db, 'old-noop-skipped', 'noop', 'skipped', ago(60));
    queueRow(db, 'new-noop-sent', 'noop', 'sent', ago(FBR_NOOP_KEEP_DAYS - 1));
    queueRow(db, 'old-noop-pending', 'noop', 'pending', ago(90));
    queueRow(db, 'old-noop-failed', 'noop', 'failed', ago(90));
    queueRow(db, 'old-sandbox-sent', 'sandbox', 'sent', ago(400));
    queueRow(db, 'old-production-sent', 'production', 'sent', ago(400));

    runHousekeeping(db, NOW);

    const left = (db.prepare('SELECT id FROM fbr_submission_queue ORDER BY id').all() as Array<{ id: string }>).map((r) => r.id);
    expect(left).toEqual(['new-noop-sent', 'old-noop-failed', 'old-noop-pending', 'old-production-sent', 'old-sandbox-sent']);
  });
});

describe('housekeeping: FBR dry-run payload files', () => {
  it('removes old payload files, keeps recent ones and other files, and stops at the batch size', () => {
    const dir = mkdtempSync(join(tmpdir(), 'coc-fbr-noop-'));
    roots.push(dir);
    const stamp = (i: number, old: boolean) => {
      const name = `${old ? '2026-01' : '2026-10'}-${String((i % 28) + 1).padStart(2, '0')}T00-00-00-000Z_INV-${i}.json`;
      writeFileSync(join(dir, name), '{}');
      const t = (old ? NOW - 200 * DAY : NOW - 1 * DAY) / 1000;
      utimesSync(join(dir, name), t, t);
    };
    for (let i = 0; i < 30; i += 1) stamp(i, true);
    for (let i = 100; i < 105; i += 1) stamp(i, false);
    writeFileSync(join(dir, 'notes.txt'), 'keep');
    const oldTxt = join(dir, 'notes.txt');
    utimesSync(oldTxt, (NOW - 400 * DAY) / 1000, (NOW - 400 * DAY) / 1000);

    expect(purgeOldNoopFiles(dir, NOW - FBR_NOOP_KEEP_DAYS * DAY, 12)).toBe(12);
    expect(purgeOldNoopFiles(dir, NOW - FBR_NOOP_KEEP_DAYS * DAY, 12)).toBe(12);
    expect(purgeOldNoopFiles(dir, NOW - FBR_NOOP_KEEP_DAYS * DAY, 12)).toBe(6);
    const left = readdirSync(dir);
    expect(left).toHaveLength(6);
    expect(left).toContain('notes.txt');
    expect(left.filter((n) => n.startsWith('2026-10-'))).toHaveLength(5);
    expect(purgeOldNoopFiles(join(dir, 'does-not-exist'), NOW)).toBe(0);
  });
});
