/**
 * The second copy of every backup outside this PC, against a real SQLite
 * database (node:sqlite with a small transaction() shim; skips where it is
 * missing) and real temporary folders: a folder must be a full path outside
 * the till's data folder and writable; a copy lands under the same name and
 * is recorded; the folder keeps the newest 14 of our files and nothing else;
 * a failure is recorded and never thrown; switching off keeps the files.
 */
import { mkdtempSync, mkdirSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { readFileSync, readdirSync as readMigrations } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDatabase } from '../db/connection.js';
import { getSettingRaw } from '../db/repositories/settings-repo.js';

vi.mock('electron-log/main', () => ({ default: { info: () => {}, warn: () => {}, error: () => {} } }));

import {
  KEEP_SECOND_COPIES,
  SECOND_COPY_ERROR_KEY,
  copyBackupToSecondFolder,
  getSecondCopyStatus,
  secondCopyFolderProblem,
  setSecondCopyDir,
} from './backup-second-copy.js';

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
  raw.exec('PRAGMA foreign_keys = ON');
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

const roots: string[] = [];
function tmp(name: string): string {
  const d = mkdtempSync(join(tmpdir(), `coc-${name}-`));
  roots.push(d);
  return d;
}
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

describe.skipIf(!Sqlite)('the second copy of every backup', () => {
  let db: AppDatabase;
  let userData: string;
  beforeEach(() => {
    db = openMigrated();
    userData = tmp('userdata');
  });

  it('a folder must be a full path, outside the till’s own data folder, and writable', () => {
    expect(secondCopyFolderProblem('Till backups', userData)).toMatch(/full folder path/);
    expect(secondCopyFolderProblem(join(userData, 'backups'), userData)).toMatch(/inside the till’s own data folder/);
    expect(secondCopyFolderProblem(userData, userData)).toMatch(/inside the till’s own data folder/);
    const file = join(tmp('notadir'), 'a-file.txt');
    writeFileSync(file, 'x');
    expect(secondCopyFolderProblem(join(file, 'sub'), userData)).toMatch(/cannot write in that folder/);
    const fresh = join(tmp('fresh'), 'new', 'deeper');
    expect(secondCopyFolderProblem(fresh, userData)).toBeNull();
    expect(readdirSync(dirname(fresh))).toContain('deeper');
  });

  it('nothing is written for a till whose owner never set a folder', async () => {
    expect(getSecondCopyStatus(db)).toEqual({ dir: null, lastAt: null, lastFileName: null, lastError: null });
    const src = join(tmp('src'), 'auto-2026-10-04T00-00-00-000Z.db');
    writeFileSync(src, 'db bytes');
    expect(await copyBackupToSecondFolder(db, src, 'auto-2026-10-04T00-00-00-000Z.db')).toBe(false);
    expect(getSettingRaw(db, 'backup.secondCopy.last')).toBeNull();
  });

  it('a backup is copied under its own name, recorded, and the folder keeps only the newest 14 of our files', async () => {
    const dir = join(tmp('dest'), 'Till backups');
    const status = setSecondCopyDir(db, dir, userData, 'u_owner');
    expect(status.dir).toBe(dir);
    const srcDir = tmp('src');
    // Older copies already in the folder, plus the owner's own unrelated file.
    for (let i = 0; i < 16; i += 1) {
      const name = `auto-2026-09-${String(i + 1).padStart(2, '0')}T00-00-00-000Z.db`;
      writeFileSync(join(dir, name), 'old');
      const t = new Date(2026, 8, i + 1).getTime() / 1000;
      utimesSync(join(dir, name), t, t);
    }
    writeFileSync(join(dir, 'owner-notes.txt'), 'keep me');
    const src = join(srcDir, 'manual-2026-10-04T10-00-00-000Z.db');
    writeFileSync(src, 'new backup bytes');

    expect(await copyBackupToSecondFolder(db, src, 'manual-2026-10-04T10-00-00-000Z.db')).toBe(true);
    const names = readdirSync(dir);
    expect(names).toContain('manual-2026-10-04T10-00-00-000Z.db');
    expect(names).toContain('owner-notes.txt');
    expect(names.filter((n) => n.endsWith('.db'))).toHaveLength(KEEP_SECOND_COPIES);
    expect(names).not.toContain('auto-2026-09-01T00-00-00-000Z.db');
    expect(names).not.toContain('auto-2026-09-02T00-00-00-000Z.db');
    expect(names.some((n) => n.endsWith('.part'))).toBe(false);
    expect(readFileSync(join(dir, 'manual-2026-10-04T10-00-00-000Z.db'), 'utf8')).toBe('new backup bytes');
    const after = getSecondCopyStatus(db);
    expect(after.lastFileName).toBe('manual-2026-10-04T10-00-00-000Z.db');
    expect(after.lastAt).not.toBeNull();
    expect(after.lastError).toBeNull();
  });

  it('a copy that cannot be written is recorded as a failure and never thrown; the next good copy clears it', async () => {
    const dir = join(tmp('dest2'), 'Till backups');
    setSecondCopyDir(db, dir, userData, 'u_owner');
    const src = join(tmp('src2'), 'auto-2026-10-04T00-00-00-000Z.db');
    writeFileSync(src, 'bytes');
    rmSync(dir, { recursive: true, force: true });
    writeFileSync(dir, 'a file where the folder was'); // mkdir of the folder now fails
    expect(await copyBackupToSecondFolder(db, src, 'auto-2026-10-04T00-00-00-000Z.db')).toBe(false);
    expect(getSecondCopyStatus(db).lastError?.message).toBeTruthy();
    rmSync(dir, { force: true });
    mkdirSync(dir, { recursive: true });
    expect(await copyBackupToSecondFolder(db, src, 'auto-2026-10-04T00-00-00-000Z.db')).toBe(true);
    expect(getSettingRaw(db, SECOND_COPY_ERROR_KEY)).toBeNull();
  });

  it('switching off keeps the files and forgets the error', async () => {
    const dir = join(tmp('dest3'), 'Till backups');
    setSecondCopyDir(db, dir, userData, 'u_owner');
    const src = join(tmp('src3'), 'auto-2026-10-04T00-00-00-000Z.db');
    writeFileSync(src, 'bytes');
    await copyBackupToSecondFolder(db, src, 'auto-2026-10-04T00-00-00-000Z.db');
    const off = setSecondCopyDir(db, null, userData, 'u_owner');
    expect(off.dir).toBeNull();
    expect(readdirSync(dir)).toContain('auto-2026-10-04T00-00-00-000Z.db');
    expect(await copyBackupToSecondFolder(db, src, 'auto-2026-10-04T00-00-00-000Z.db')).toBe(false);
  });
});
