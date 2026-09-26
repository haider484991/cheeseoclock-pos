/**
 * drawer-open-repo on a real database built from every migration (0028
 * included), foreign keys on: each manual drawer open is one row, one sync
 * entry and one hash-chained audit entry, written together — and the audit
 * chain still verifies afterwards.
 *
 * Uses node's own `node:sqlite` (better-sqlite3 here is built for Electron),
 * and skips itself where that is missing. Names and ids are made up.
 */
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDatabase } from './connection.js';
import { verifyAuditChain, type AuditChainRow } from './audit-chain.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });
vi.mock('electron-log/main', () => ({ default: { info: () => {}, warn: () => {}, error: () => {} } }));

interface Stmt {
  run(...p: unknown[]): unknown;
  all(...p: unknown[]): Array<Record<string, unknown>>;
  get(...p: unknown[]): Record<string, unknown> | undefined;
}
interface RawDb {
  exec(sql: string): void;
  prepare(sql: string): Stmt;
}
type RawDbCtor = new (path: string) => RawDb;
let DatabaseSync: RawDbCtor | null = null;
try {
  DatabaseSync = (createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: RawDbCtor }).DatabaseSync;
} catch {
  DatabaseSync = null;
}
const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

function openMigrated(): AppDatabase {
  if (!DatabaseSync) throw new Error('node:sqlite unavailable');
  const raw = new DatabaseSync(':memory:');
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(join(MIGRATIONS, f), 'utf8'));
  }
  raw.exec('PRAGMA foreign_keys = ON');
  let depth = 0;
  return {
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
  } as unknown as AppDatabase;
}

const DEV = 'dev-till-1';
const T0 = '2026-01-01T00:00:00.000Z';
const CASHIER = { userId: 'u_cash', deviceId: DEV };
const MANAGER = { userId: 'u_mgr', deviceId: DEV };

let db: AppDatabase;
beforeEach(() => {
  if (!DatabaseSync) return;
  db = openMigrated();
  const user = db.prepare(
    `INSERT INTO users (id, full_name, pin_hash, role, created_at, updated_at, device_id) VALUES (?, ?, 'x', ?, ?, ?, ?)`,
  );
  user.run('u_cash', 'Test Cashier', 'cashier', T0, T0, DEV);
  user.run('u_mgr', 'Test Manager', 'manager', T0, T0, DEV);
});

const repo = () => import('./repositories/drawer-open-repo.js');
type Row = Record<string, unknown>;
const count = (sql: string, ...p: unknown[]) => Number((db.prepare(sql).get(...p) as Row)['n']);

function auditRows(): AuditChainRow[] {
  return db
    .prepare(
      `SELECT rowid, id, entity_type AS entityType, entity_id AS entityId, action,
              actor_user_id AS actorUserId, before_json AS beforeJson, after_json AS afterJson,
              ip, created_at AS createdAt, prev_hash AS prevHash, row_hash AS rowHash
         FROM audit_log ORDER BY rowid`,
    )
    .all() as unknown as AuditChainRow[];
}

describe.skipIf(!DatabaseSync)('drawer opens: row + sync + audit together', () => {
  it('saves a cashier no-sale open with the approving manager, on the open shift', async () => {
    const { openShift } = await import('./repositories/shift-repo.js');
    const shift = openShift(db, { openingCashCents: 500_000 }, MANAGER);
    const { recordDrawerOpen } = await repo();
    const open = recordDrawerOpen(db, { kind: 'no_sale', reason: '  Change  ', approvedByUserId: 'u_mgr' }, CASHIER);

    expect(open).toMatchObject({
      kind: 'no_sale',
      reason: 'Change',
      shiftId: shift.id,
      userId: 'u_cash',
      approvedByUserId: 'u_mgr',
    });
    const row = db.prepare(`SELECT * FROM drawer_opens WHERE id = ?`).get(open.id) as Row;
    expect(row).toMatchObject({
      shift_id: shift.id,
      kind: 'no_sale',
      reason: 'Change',
      user_id: 'u_cash',
      approved_by_user_id: 'u_mgr',
      device_id: DEV,
      version: 1,
    });
    expect(count(`SELECT COUNT(*) AS n FROM sync_queue WHERE entity_type = 'drawer_opens' AND entity_id = ?`, open.id)).toBe(1);

    const audit = db
      .prepare(`SELECT action, actor_user_id AS actor, after_json AS after FROM audit_log WHERE entity_id = ?`)
      .get(open.id) as Row;
    expect(audit['action']).toBe('drawer_no_sale');
    expect(audit['actor']).toBe('u_cash');
    expect(JSON.parse(String(audit['after']))).toMatchObject({
      shiftId: shift.id,
      kind: 'no_sale',
      reason: 'Change',
      userId: 'u_cash',
      approvedByUserId: 'u_mgr',
      deviceId: DEV,
    });
    expect(verifyAuditChain(auditRows()).ok).toBe(true);
  });

  it('with no shift open it is still saved, under the person’s name', async () => {
    const { recordDrawerOpen } = await repo();
    const open = recordDrawerOpen(db, { kind: 'no_sale' }, MANAGER);
    expect(open.shiftId).toBeNull();
    expect(open.reason).toBeNull();
    expect(open.approvedByUserId).toBeNull();
    expect(count(`SELECT COUNT(*) AS n FROM drawer_opens WHERE shift_id IS NULL`)).toBe(1);
  });

  it('a shift gets one "count"; any more are no-sale opens', async () => {
    const { openShift } = await import('./repositories/shift-repo.js');
    openShift(db, { openingCashCents: 0 }, MANAGER);
    const { recordDrawerOpen } = await repo();
    expect(recordDrawerOpen(db, { kind: 'count' }, MANAGER).kind).toBe('count');
    const again = recordDrawerOpen(db, { kind: 'count' }, MANAGER);
    expect(again.kind).toBe('no_sale');
    expect(again.reason).toBe('Opened again to count');
    expect(auditRows().map((r) => r.action).filter((a) => a.startsWith('drawer_'))).toEqual([
      'drawer_count',
      'drawer_no_sale',
    ]);
  });

  it('keeps a reason short and on one line', async () => {
    const { cleanDrawerReason, DRAWER_REASON_MAX } = await repo();
    expect(cleanDrawerReason('  Check\n\tnotes  ')).toBe('Check notes');
    expect(cleanDrawerReason('   ')).toBeNull();
    expect(cleanDrawerReason(null)).toBeNull();
    expect(cleanDrawerReason('x'.repeat(200))).toHaveLength(DRAWER_REASON_MAX);
  });

  it('refuses an unknown kind and writes nothing', async () => {
    const { recordDrawerOpen } = await repo();
    const before = auditRows().length;
    expect(() => recordDrawerOpen(db, { kind: 'party' as never }, MANAGER)).toThrow('Unknown drawer open');
    expect(count(`SELECT COUNT(*) AS n FROM drawer_opens`)).toBe(0);
    expect(auditRows()).toHaveLength(before);
  });

  it('refuses an approver who is not a user (foreign key), writing nothing', async () => {
    const { recordDrawerOpen } = await repo();
    const before = auditRows().length;
    expect(() => recordDrawerOpen(db, { kind: 'no_sale', approvedByUserId: 'nobody' }, CASHIER)).toThrow();
    expect(count(`SELECT COUNT(*) AS n FROM drawer_opens`)).toBe(0);
    expect(count(`SELECT COUNT(*) AS n FROM sync_queue WHERE entity_type = 'drawer_opens'`)).toBe(0);
    expect(auditRows()).toHaveLength(before);
  });
});
