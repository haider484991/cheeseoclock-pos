/**
 * Removing a person from the till, against a real SQLite database built from
 * every migration: the customer is blanked and hidden with every address,
 * through the replicable writes (sync queue + audit rows), and the export
 * query no longer lists them. Uses `node:sqlite` with a small `transaction()`
 * shim (better-sqlite3 is built for Electron's ABI) and skips itself where
 * node:sqlite is missing. Every person is made up.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { AppDatabase } from '../connection.js';

vi.mock('electron-log/main', () => ({ default: { info: () => {}, warn: () => {}, error: () => {} } }));

import { DELETED_CUSTOMER_NAME, deleteCustomer, exportCustomerRows, findCustomer, listAddresses } from './customer-repo.js';

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
const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

function openMigrated(): AppDatabase {
  const raw = new Sqlite!(':memory:');
  for (const f of readdirSync(MIGRATIONS).filter((x) => x.endsWith('.sql')).sort()) {
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

const T0 = '2026-10-01T10:00:00.000Z';
const DEV = 'dev-till-1';
const ACTOR = { userId: 'u_mgr', deviceId: DEV };

function seed(db: AppDatabase): void {
  const c = db.prepare(`INSERT INTO customers (id, name, phone, email, notes, created_at, updated_at, device_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  c.run('c1', 'Test Customer', '03000000001', 'c1@test.pk', 'allergic to nuts', T0, T0, DEV);
  c.run('c2', 'Other Customer', '03000000002', null, null, T0, T0, DEV);
  const a = db.prepare(
    `INSERT INTO customer_addresses (id, customer_id, label, address_line, area, city, is_default, created_at, updated_at, device_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  a.run('a1', 'c1', 'Home', '1 Test Street', 'Test Phase 1', 'Karachi', 1, T0, T0, DEV);
  a.run('a2', 'c1', 'Work', '2 Test Road', 'Test Block 3', 'Karachi', 0, T0, T0, DEV);
}

const count = (db: AppDatabase, sql: string) => (db.prepare(sql).get() as { n: number }).n;

describe.skipIf(!Sqlite)('removing a customer', () => {
  it('blanks and hides the person with every address, through the sync queue and the audit trail', () => {
    const db = openMigrated();
    seed(db);
    const syncBefore = count(db, 'SELECT COUNT(*) AS n FROM sync_queue');
    const auditBefore = count(db, 'SELECT COUNT(*) AS n FROM audit_log');

    deleteCustomer(db, 'c1', ACTOR);

    const row = db.prepare('SELECT name, phone, email, notes, is_active, deleted_at FROM customers WHERE id = ?').get('c1') as Record<string, unknown>;
    expect(row).toMatchObject({ name: DELETED_CUSTOMER_NAME, phone: null, email: null, notes: null, is_active: 0 });
    expect(row['deleted_at']).toBeTruthy();
    expect(findCustomer(db, 'c1')).toBeNull();
    expect(listAddresses(db, 'c1')).toEqual([]);
    expect(count(db, "SELECT COUNT(*) AS n FROM customer_addresses WHERE customer_id = 'c1' AND deleted_at IS NOT NULL")).toBe(2);
    // Two address deletes, the blanking and the hide: four replicable writes, each audited.
    expect(count(db, 'SELECT COUNT(*) AS n FROM sync_queue') - syncBefore).toBe(4);
    expect(count(db, 'SELECT COUNT(*) AS n FROM audit_log') - auditBefore).toBe(4);
    // The other customer is untouched.
    expect(findCustomer(db, 'c2')?.name).toBe('Other Customer');
  });

  it('a customer who is already gone cannot be removed again', () => {
    const db = openMigrated();
    seed(db);
    deleteCustomer(db, 'c1', ACTOR);
    expect(() => deleteCustomer(db, 'c1', ACTOR)).toThrow(/not found/);
  });
});

describe.skipIf(!Sqlite)('the export rows', () => {
  it('lists every live customer with each live address, a customer without one once, and no one removed', () => {
    const db = openMigrated();
    seed(db);
    const before = exportCustomerRows(db);
    expect(before.map((r) => [r.name, r.addressLabel, r.isDefaultAddress])).toEqual([
      ['Other Customer', null, null],
      ['Test Customer', 'Home', true],
      ['Test Customer', 'Work', false],
    ]);
    deleteCustomer(db, 'c1', ACTOR);
    expect(exportCustomerRows(db).map((r) => r.name)).toEqual(['Other Customer']);
  });
});
