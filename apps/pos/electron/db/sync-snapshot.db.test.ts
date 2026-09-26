/**
 * The second-till queue against real SQLite databases built from every
 * migration:
 *   - unsent entries are cleared only while the link is Off, a window of rows
 *     at a time, and clearing them marks that everything is owed once;
 *   - "send everything once" queues an image of every row, read at one
 *     moment through a second connection, so sales during the build never
 *     reach the other till before what they point at;
 *   - the other till applies what arrives, into an empty database and into
 *     one with rows of its own; what cannot be saved is kept, retried and
 *     counted, never dropped unseen and never blocking the rest.
 *
 * better-sqlite3 here is built for Electron's ABI and will not open under
 * plain node, so this uses node's own `node:sqlite` (Node 22.5+), with a
 * small `transaction()` shim in better-sqlite3's shape, and skips itself
 * where node:sqlite is missing. The sending till is a WAL file on disk like
 * the real one, so the full send can read through a second connection.
 * Every name and amount is made up.
 */
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { SyncChange, SyncCursor } from '@cheeseoclock/sync-core';

// Builds several real databases from every migration: seconds on a slow CI
// runner, well past the 5 s default.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

vi.mock('electron-log/main', () => ({ default: { info: () => {}, warn: () => {}, error: () => {} } }));
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  safeStorage: { isEncryptionAvailable: () => false },
  app: { getPath: () => '.' },
}));

/** The sync server as the worker sees it (the sync worker tests drive it). */
const fakeServer = vi.hoisted(() => ({
  answers: true,
  pulls: 0,
  answered: 0,
  pushes: [] as SyncChange[][],
  reset() {
    this.answers = true;
    this.pulls = 0;
    this.answered = 0;
    this.pushes = [];
  },
}));
vi.mock('../adapters/sync/factory.js', () => ({
  makeSyncAdapter: () => ({
    mode: 'cloud' as const,
    async pushChanges(changes: SyncChange[], cursor: SyncCursor) {
      fakeServer.pushes.push(changes);
      return {
        accepted: changes.map((c) => c.entityId),
        rejected: [],
        newCursor: { ...cursor, lastPushedAt: new Date().toISOString() },
      };
    },
    async pullChanges(cursor: SyncCursor) {
      fakeServer.pulls++;
      if (!fakeServer.answers) return { changes: [], newCursor: cursor };
      const t = new Date(Date.parse('2026-09-26T00:00:00.000Z') + ++fakeServer.answered * 1000).toISOString();
      return { changes: [], newCursor: { ...cursor, lastPulledAt: t } };
    },
    subscribeRemote: () => ({ unsubscribe: () => {} }),
  }),
}));
// The worker's full send opens a second, read-only connection with
// better-sqlite3 (built for Electron here): node:sqlite stands in.
vi.mock('better-sqlite3', async () => {
  const { createRequire: req } = await import('node:module');
  const { DatabaseSync } = req(import.meta.url)('node:sqlite') as {
    DatabaseSync: new (path: string, opts?: Record<string, unknown>) => object;
  };
  return {
    default: class {
      constructor(file: string) {
        try {
          return new DatabaseSync(file, { readOnly: true });
        } catch {
          return new DatabaseSync(file);
        }
      }
    },
  };
});

interface Stmt {
  run(...p: unknown[]): { changes: number | bigint };
  all(...p: unknown[]): Array<Record<string, unknown>>;
  get(...p: unknown[]): Record<string, unknown> | undefined;
}
interface RawDb {
  exec(sql: string): void;
  prepare(sql: string): Stmt;
  close(): void;
}
type SqliteCtor = new (path: string, opts?: Record<string, unknown>) => RawDb;

const Sqlite: SqliteCtor | null = (() => {
  try {
    return (createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: SqliteCtor }).DatabaseSync;
  } catch {
    return null;
  }
})();

/** better-sqlite3's `db.transaction(fn)`: BEGIN at the outside, SAVEPOINTs inside. */
function withTransactions(raw: RawDb, name: string | null = null) {
  let depth = 0;
  return {
    /** better-sqlite3's `db.name`: the file (the worker opens its reader from it). */
    name,
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
}

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), 'migrations');
const MIGRATION_SQL = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => readFileSync(join(MIGRATIONS, f), 'utf8'));
const DIR = Sqlite ? mkdtempSync(join(tmpdir(), 'coc-sync-test-')) : '';
const opened: RawDb[] = [];
let fileNo = 0;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- FIXME(any): the shim stands in for better-sqlite3's Database
type Db = any;

/** A database from every migration, foreign keys on (as connection.ts sets them). */
function makeDb(onDisk = false): { raw: RawDb; db: Db; file: string | null } {
  const file = onDisk ? join(DIR, `till-${++fileNo}.sqlite`) : null;
  const raw = new Sqlite!(file ?? ':memory:');
  opened.push(raw);
  if (file) raw.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
  for (const sql of MIGRATION_SQL) raw.exec(sql);
  raw.exec('PRAGMA foreign_keys = ON');
  return { raw, db: withTransactions(raw, file), file };
}

/** The full send's second connection, read-only where node:sqlite allows it. */
function readerFor(file: string) {
  return () => {
    let r: RawDb;
    try {
      r = new Sqlite!(file, { readOnly: true });
    } catch {
      r = new Sqlite!(file);
    }
    opened.push(r);
    return r;
  };
}

afterAll(() => {
  for (const r of opened) {
    try {
      r.close();
    } catch {
      // already closed
    }
  }
  if (DIR) {
    try {
      rmSync(DIR, { recursive: true, force: true });
    } catch {
      // Windows may still hold a file for a moment; the OS temp cleaner gets it.
    }
  }
});

const T0 = '2026-01-01T00:00:00.000Z';
const OLD = '2026-01-02T00:00:00.000Z';
const actor = { userId: 'u1', deviceId: 'dev-A' };
const noPause = async () => {};

function setLink(raw: RawDb, cfg: Record<string, unknown> | null): void {
  if (cfg === null) {
    raw.prepare(`DELETE FROM settings WHERE key = 'sync.config'`).run();
    return;
  }
  raw
    .prepare(
      `INSERT INTO settings (key, value_json, updated_at) VALUES ('sync.config', ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`,
    )
    .run(JSON.stringify(cfg), T0);
}
const HTTP = { mode: 'http', baseUrl: 'https://sync.example.test' };

function addUser(raw: RawDb, id = 'u1', device = 'dev-A'): void {
  raw
    .prepare(
      `INSERT INTO users (id, full_name, pin_hash, role, created_at, updated_at, device_id)
       VALUES (?, 'Test Manager', 'x', 'manager', ?, ?, ?)`,
    )
    .run(id, T0, T0, device);
}

function n(raw: RawDb, sql: string, ...p: unknown[]): number {
  return Number(raw.prepare(sql).get(...p)?.n ?? 0);
}

function auditState(raw: RawDb) {
  return {
    count: n(raw, `SELECT COUNT(*) AS n FROM audit_log`),
    head: raw.prepare(`SELECT row_hash FROM audit_log ORDER BY rowid DESC LIMIT 1`).get()?.row_hash ?? null,
  };
}

async function auditChainOk(raw: RawDb): Promise<boolean> {
  const { verifyAuditChain } = await import('./audit-chain.js');
  const rows = raw
    .prepare(
      `SELECT rowid, id, entity_type AS entityType, entity_id AS entityId, action,
              actor_user_id AS actorUserId, before_json AS beforeJson, after_json AS afterJson,
              ip, created_at AS createdAt, prev_hash AS prevHash, row_hash AS rowHash
         FROM audit_log ORDER BY rowid`,
    )
    .all() as never[];
  return verifyAuditChain(rows).ok;
}

const mods = async () => ({
  ...(await import('./repositories/sync-repo.js')),
  ...(await import('./repositories/apply-remote.js')),
  ...(await import('./replicable-schema.js')),
  ...(await import('../services/sync-snapshot.js')),
  ...(await import('../services/housekeeping.js')),
  ...(await import('../services/sync-config.js')),
  ...(await import('@cheeseoclock/sync-core')),
});

const repos = async () => ({
  ...(await import('./seed.js')),
  ...(await import('./repositories/category-repo.js')),
  ...(await import('./repositories/tax-category-repo.js')),
  ...(await import('./repositories/customer-repo.js')),
  ...(await import('./repositories/shift-repo.js')),
  ...(await import('./repositories/order-repo.js')),
  ...(await import('./repositories/rider-repo.js')),
  ...(await import('./repositories/table-repo.js')),
  ...(await import('./repositories/procurement-repo.js')),
  ...(await import('./repositories/ingredient-repo.js')),
  ...(await import('./repositories/stock-movement-repo.js')),
});

/** A small shop's worth of history, through the repositories (every table the till writes). */
async function buildShop(raw: RawDb, db: Db) {
  const r = await repos();
  addUser(raw);
  r.ensureSeedMenu(db, 'dev-A');
  const cust = r.createCustomer(db, { name: 'Test Customer', phone: '03001234567' }, actor);
  r.createAddress(db, { customerId: cust.id, addressLine: 'House 1, Test Street', area: 'Test Area', isDefault: true }, actor);
  const office = r.createAddress(db, { customerId: cust.id, addressLine: 'Office 2, Test Road', area: 'Test Area' }, actor);
  r.deleteAddress(db, office.id, actor);
  const spare = r.createCategory(db, { name: 'Spare Test', displayOrder: 9, colorHex: '#123456' }, actor);
  r.deleteCategory(db, spare.id, actor);
  r.openShift(db, { openingCashCents: 5_000 }, actor);
  r.recordCashMovement(db, { type: 'payin', amountCents: 700, reason: 'Test change' }, actor);
  r.createRider(db, { name: 'Test Rider', phone: '03009876543' }, actor);
  const section = r.createFloorSection(db, { name: 'Test Hall', sortOrder: 1 }, actor);
  r.createTable(db, { floorSectionId: section.id, label: 'T1', capacity: 4 }, actor);
  const supplier = raw.prepare(`SELECT id FROM suppliers ORDER BY rowid LIMIT 1`).get()!.id as string;
  const ingredient = raw.prepare(`SELECT id FROM ingredients ORDER BY rowid LIMIT 1`).get()!.id as string;
  r.createPurchaseOrder(db, { supplierId: supplier, items: [{ ingredientId: ingredient, qtyOrdered: 10, unitCostCents: 50 }] }, actor);
  const order = await sell(raw, db, 2);
  return { cust, office, spare, order };
}

/** Ring up, pay and send one order of the first recipe item (stock moves). */
async function sell(raw: RawDb, db: Db, quantity: number) {
  const r = await repos();
  const item = raw
    .prepare(
      `SELECT m.id FROM menu_items m WHERE m.deleted_at IS NULL AND m.is_active = 1
          AND EXISTS (SELECT 1 FROM recipes r WHERE r.menu_item_id = m.id AND r.deleted_at IS NULL)
        ORDER BY m.rowid LIMIT 1`,
    )
    .get()!.id as string;
  const customer = raw.prepare(`SELECT id FROM customers WHERE deleted_at IS NULL ORDER BY rowid LIMIT 1`).get()!.id as string;
  const order = r.createOrder(db, { mode: 'takeaway' }, actor);
  r.snapshotCustomerOntoOrder(db, { orderId: order.id, customerId: customer, addressId: null }, actor);
  r.addOrderItem(db, { orderId: order.id, menuItemId: item, quantity, modifierIds: [] }, actor);
  r.applyDiscount(db, { orderId: order.id, discountType: 'flat', value: 100, reason: 'Test' }, actor);
  const total = r.findOrder(db, order.id)!.totalCents;
  r.tenderOrder(db, { orderId: order.id, payments: [{ method: 'cash', amountCents: total, tenderedCents: total }] }, actor);
  r.sendOrderToKitchen(db, order.id, actor);
  return order;
}

/** Every replicable row, as the receiver would compare it (synced_at is each till's own). */
async function tableDump(raw: RawDb, db: Db, skip: Record<string, string[]> = {}) {
  const { replicableTables } = await mods();
  const out: Record<string, Array<Record<string, unknown>>> = {};
  for (const name of [...replicableTables(db).keys()].sort()) {
    out[name] = raw
      .prepare(`SELECT * FROM "${name}" ORDER BY id`)
      .all()
      .map((row) => {
        const plain: Record<string, unknown> = { ...row };
        delete plain['synced_at'];
        for (const c of skip[name] ?? []) delete plain[c];
        return plain;
      });
  }
  return out;
}

function pendingChanges(raw: RawDb, deviceId: string): SyncChange[] {
  const rows = raw
    .prepare(
      `SELECT id, entity_type, entity_id, op, payload_json, created_at FROM sync_queue
        WHERE synced_at IS NULL ORDER BY created_at, rowid`,
    )
    .all();
  return JSON.parse(
    JSON.stringify(
      rows.map((r) => {
        const payload = JSON.parse(String(r.payload_json)) as Record<string, unknown>;
        return {
          entityType: r.entity_type,
          entityId: r.entity_id,
          op: r.op,
          payload,
          updatedAt: typeof payload['updatedAt'] === 'string' ? payload['updatedAt'] : r.created_at,
          deviceId,
          version: typeof payload['version'] === 'number' ? payload['version'] : 1,
        };
      }),
    ),
  ) as SyncChange[];
}

/** A sender that has history, has cleared it while off, and now owes everything. */
async function shopThatClearedItsQueue() {
  const { pruneUnsentWhileOff, isSnapshotNeeded } = await mods();
  const s = makeDb(true);
  const built = await buildShop(s.raw, s.db);
  s.raw.prepare(`UPDATE sync_queue SET created_at = ?`).run(OLD);
  expect(await pruneUnsentWhileOff(s.db, { pause: noPause })).toBeGreaterThan(0);
  expect(isSnapshotNeeded(s.db)).toBe(true);
  setLink(s.raw, HTTP);
  return { ...s, ...built };
}

// ---------------------------------------------------------------------------

describe.skipIf(!Sqlite)('clearing unsent second-till rows', () => {
  async function smallQueue() {
    const { markSyncedIds } = await mods();
    const r = await repos();
    const s = makeDb();
    addUser(s.raw);
    r.createCategory(s.db, { name: 'Old A', displayOrder: 1, colorHex: '#111111' }, actor);
    r.createCategory(s.db, { name: 'Old B', displayOrder: 2, colorHex: '#222222' }, actor);
    const delivered = r.createCategory(s.db, { name: 'Delivered', displayOrder: 3, colorHex: '#333333' }, actor);
    s.raw.prepare(`UPDATE sync_queue SET created_at = ?`).run(OLD);
    const deliveredEntry = s.raw.prepare(`SELECT id FROM sync_queue WHERE entity_id = ?`).get(delivered.id)!.id as string;
    markSyncedIds(s.db, [deliveredEntry]);
    const fresh = r.createCategory(s.db, { name: 'Fresh', displayOrder: 4, colorHex: '#444444' }, actor);
    return { ...s, fresh, deliveredEntry };
  }

  it.each([
    ['on', { ...HTTP }],
    ['on and paused', { ...HTTP, paused: true }],
    ['developer test', { mode: 'mock' }],
    ['developer test, paused', { mode: 'mock', paused: true }],
  ])('never while the link is %s', async (_label, cfg) => {
    const { pruneUnsentWhileOff, isSnapshotNeeded, getPendingCount } = await mods();
    const s = await smallQueue();
    setLink(s.raw, cfg);
    const before = getPendingCount(s.db);
    expect(await pruneUnsentWhileOff(s.db, { pause: noPause })).toBe(0);
    expect(getPendingCount(s.db)).toBe(before);
    expect(isSnapshotNeeded(s.db)).toBe(false);
  });

  it.each([
    ['off and paused', { mode: 'off', paused: true }],
    ['never set up', null],
    ['unreadable (treated as off, like the sync worker does)', { mode: 'http', pollIntervalMs: 5 }],
  ])('clears old unsent rows when the link is %s', async (_label, cfg) => {
    const { pruneUnsentWhileOff, readSnapshotMarker, getPendingCount } = await mods();
    const s = await smallQueue();
    setLink(s.raw, cfg);
    const audit = auditState(s.raw);

    expect(await pruneUnsentWhileOff(s.db, { pause: noPause })).toBe(2);

    const left = s.raw.prepare(`SELECT id, entity_id, synced_at FROM sync_queue ORDER BY rowid`).all();
    expect(left.map((r) => r.id)).toContain(s.deliveredEntry);
    expect(left.filter((r) => r.synced_at === null).map((r) => r.entity_id)).toEqual([s.fresh.id]);
    expect(getPendingCount(s.db)).toBe(1);
    expect(readSnapshotMarker(s.db)?.reason).toBe('unsent_cleared');
    // The audit trail is never touched.
    expect(auditState(s.raw)).toEqual(audit);
    expect(await auditChainOk(s.raw)).toBe(true);
  });

  it('goes a window at a time and stops as soon as the link is switched on', async () => {
    const { enqueueSync, pruneUnsentWhileOff, getPendingCount } = await mods();
    const fill = (db: Db) =>
      db.transaction(() => {
        for (let i = 0; i < 5_000; i++) {
          enqueueSync(db, { entityType: 'test_kind', entityId: `t${i}`, op: 'upsert', payload: { i }, createdAt: OLD });
        }
      })();

    const a = makeDb();
    fill(a.db);
    let pauses = 0;
    const removed = await pruneUnsentWhileOff(a.db, { batchRows: 1_000, pause: async () => void pauses++ });
    expect(removed).toBe(5_000);
    expect(pauses).toBeGreaterThanOrEqual(5);
    expect(getPendingCount(a.db)).toBe(0);

    const b = makeDb();
    fill(b.db);
    let calls = 0;
    const stopped = await pruneUnsentWhileOff(b.db, {
      batchRows: 1_000,
      pause: async () => {
        if (++calls === 2) setLink(b.raw, HTTP);
      },
    });
    const left = getPendingCount(b.db);
    expect(stopped).toBeGreaterThan(0);
    expect(left).toBeGreaterThan(0);
    expect(stopped + left).toBe(5_000);
  });

  it('clears entries stamped days ahead by a wrong PC clock, and the queue clock follows the PC again', async () => {
    const { pruneUnsentWhileOff, readSnapshotMarker } = await mods();
    const r = await repos();
    const s = makeDb();
    addUser(s.raw);
    const stampOf = (id: string) =>
      Date.parse(String(s.raw.prepare(`SELECT created_at AS c FROM sync_queue WHERE entity_id = ? ORDER BY rowid DESC LIMIT 1`).get(id)!.c));
    const nowMs = Date.now();
    const a = r.createCategory(s.db, { name: 'Wrong date', displayOrder: 1, colorHex: '#000001' }, actor);
    s.raw.prepare(`UPDATE sync_queue SET created_at = ? WHERE entity_id = ?`).run(new Date(nowMs + 90 * 86_400_000).toISOString(), a.id);
    // The date was put right; the queue clock still stamps after that entry.
    const b = r.createCategory(s.db, { name: 'After it', displayOrder: 2, colorHex: '#000002' }, actor);
    expect(stampOf(b.id)).toBeGreaterThan(nowMs + 89 * 86_400_000);
    // A PC an hour fast is not a wrong date: that entry is fresh and stays.
    const c = r.createCategory(s.db, { name: 'Fresh', displayOrder: 3, colorHex: '#000003' }, actor);
    s.raw.prepare(`UPDATE sync_queue SET created_at = ? WHERE entity_id = ?`).run(new Date(nowMs + 3_600_000).toISOString(), c.id);

    expect(await pruneUnsentWhileOff(s.db, { pause: noPause })).toBe(2);
    expect(s.raw.prepare(`SELECT entity_id FROM sync_queue WHERE synced_at IS NULL`).all().map((x) => x.entity_id)).toEqual([c.id]);
    expect(readSnapshotMarker(s.db)?.reason).toBe('unsent_cleared');
    const d = r.createCategory(s.db, { name: 'Next', displayOrder: 4, colorHex: '#000004' }, actor);
    expect(stampOf(d.id)).toBeLessThan(nowMs + 2 * 3_600_000);
  });

  it('removes delivered rows a batch at a time and keeps recent and unsent ones', async () => {
    const { enqueueSync, purgeDeliveredQueue } = await mods();
    const s = makeDb();
    const now = Date.parse('2026-09-26T12:00:00.000Z');
    const daysAgo = (d: number) => new Date(now - d * 86_400_000).toISOString();
    s.db.transaction(() => {
      for (let i = 0; i < 3_000; i++) {
        enqueueSync(s.db, { entityType: 'test_kind', entityId: `old${i}`, op: 'upsert', payload: {}, createdAt: daysAgo(50) });
      }
      for (let i = 0; i < 10; i++) {
        enqueueSync(s.db, { entityType: 'test_kind', entityId: `recent${i}`, op: 'upsert', payload: {}, createdAt: daysAgo(12) });
      }
      for (let i = 0; i < 5; i++) {
        enqueueSync(s.db, { entityType: 'test_kind', entityId: `unsent${i}`, op: 'upsert', payload: {}, createdAt: daysAgo(50) });
      }
    })();
    s.raw.prepare(`UPDATE sync_queue SET synced_at = ? WHERE entity_id LIKE 'old%'`).run(daysAgo(40));
    s.raw.prepare(`UPDATE sync_queue SET synced_at = ? WHERE entity_id LIKE 'recent%'`).run(daysAgo(10));
    let pauses = 0;
    expect(await purgeDeliveredQueue(s.db, { now, batchRows: 1_000, pause: async () => void pauses++ })).toBe(3_000);
    expect(pauses).toBeGreaterThanOrEqual(4);
    expect(n(s.raw, `SELECT COUNT(*) AS n FROM sync_queue`)).toBe(15);
  });
});

describe.skipIf(!Sqlite)('live queue entries are row images', () => {
  it('stores the row as written, with its own version and time; the audit row keeps the domain object', async () => {
    const { isRowImage } = await mods();
    const r = await repos();
    const s = makeDb();
    const cat = r.createCategory(s.db, { name: 'Pies', displayOrder: 1, colorHex: '#aa0000' }, actor);
    r.updateCategory(s.db, { id: cat.id, name: 'Pies 2' }, actor);
    r.updateCategory(s.db, { id: cat.id, name: 'Pies 3' }, actor);
    const last = JSON.parse(
      String(s.raw.prepare(`SELECT payload_json AS p FROM sync_queue WHERE entity_id = ? ORDER BY rowid DESC LIMIT 1`).get(cat.id)!.p),
    );
    const row = s.raw.prepare(`SELECT * FROM categories WHERE id = ?`).get(cat.id)!;
    expect(isRowImage(last)).toBe(true);
    expect(last).toMatchObject({ id: cat.id, name: 'Pies 3', version: row.version, updatedAt: row.updated_at, createdAt: row.created_at });
    expect(row.version).toBe(3);
    const audit = JSON.parse(
      String(s.raw.prepare(`SELECT after_json AS a FROM audit_log WHERE entity_id = ? ORDER BY rowid DESC LIMIT 1`).get(cat.id)!.a),
    );
    expect(audit.name).toBe('Pies 3');
    expect(audit).not.toHaveProperty('__rowImage');
  });

  it('a soft delete goes out as the deleted row', async () => {
    const r = await repos();
    const s = makeDb();
    const cat = r.createCategory(s.db, { name: 'Gone', displayOrder: 1, colorHex: '#000000' }, actor);
    r.deleteCategory(s.db, cat.id, actor);
    const last = s.raw.prepare(`SELECT op, payload_json AS p FROM sync_queue WHERE entity_id = ? ORDER BY rowid DESC LIMIT 1`).get(cat.id)!;
    expect(last.op).toBe('delete');
    expect(JSON.parse(String(last.p))).toMatchObject({ __rowImage: 1, id: cat.id, name: 'Gone' });
    expect(JSON.parse(String(last.p)).deletedAt).toEqual(expect.any(String));
  });

  it('never puts a change before one written earlier, even with the clock behind', async () => {
    const r = await repos();
    const s = makeDb();
    const a = r.createCategory(s.db, { name: 'A', displayOrder: 1, colorHex: '#000001' }, actor);
    const ahead = '2099-01-01T00:00:00.000Z';
    s.raw.prepare(`UPDATE sync_queue SET created_at = ? WHERE entity_id = ?`).run(ahead, a.id);
    const b = r.createCategory(s.db, { name: 'B', displayOrder: 2, colorHex: '#000002' }, actor);
    const bAt = String(s.raw.prepare(`SELECT created_at AS c FROM sync_queue WHERE entity_id = ?`).get(b.id)!.c);
    expect(bAt > ahead).toBe(true);
  });
});

describe.skipIf(!Sqlite)('send everything once', () => {
  it('queues every row as an image that rebuilds an empty till exactly', async () => {
    const m = await mods();
    const r = await repos();
    const s = await shopThatClearedItsQueue();

    expect(s.raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    const tables = m.replicableTables(s.db);
    const totalRows = [...tables.keys()].reduce((sum, t) => sum + n(s.raw, `SELECT COUNT(*) AS n FROM "${t}"`), 0);
    const nonEmpty = [...tables.keys()].filter((t) => n(s.raw, `SELECT COUNT(*) AS n FROM "${t}"`) > 0);
    expect(nonEmpty.length).toBeGreaterThanOrEqual(15);

    // A fresh, still-queued change: the full send replaces it.
    r.updateCategory(s.db, { id: s.raw.prepare(`SELECT id FROM categories WHERE deleted_at IS NULL ORDER BY rowid LIMIT 1`).get()!.id as string, displayOrder: 7 }, actor);
    expect(m.getPendingCount(s.db)).toBe(1);

    expect(
      await m.sendEverythingOnce(s.db, { openReader: readerFor(s.file!), shouldContinue: () => true, batchRows: 50, pause: noPause }),
    ).toBe('done');
    expect(m.isSnapshotNeeded(s.db)).toBe(false);
    expect(m.getSyncState(s.db, m.SYNC_SNAPSHOT_KEYS.lastRows)).toBe(String(totalRows));
    expect(s.raw.prepare(`SELECT action FROM audit_log ORDER BY rowid DESC LIMIT 1`).get()!.action).toBe('full_send_queued');

    const pending = m.listPendingSync(s.db, 1_000_000);
    expect(pending.length).toBe(totalRows);
    expect(pending.every((p) => m.isRowImage(p.payload))).toBe(true);
    expect(new Set(pending.map((p) => `${p.entityType}:${p.entityId}`)).size).toBe(totalRows);
    const order = m.snapshotOrder(s.db);
    const positions = pending.map((p) => order.indexOf(p.entityType));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(pending.some((p) => Object.hasOwn(p.payload as object, 'pinHash'))).toBe(false);
    // A deleted row goes as a 'delete', as a live soft delete does: a till on
    // the previous version turns an 'upsert' of it back into a live row.
    const opOf = (id: string) => pending.find((p) => p.entityId === id)!.op;
    expect(opOf(s.office.id)).toBe('delete');
    expect(opOf(s.spare.id)).toBe('delete');
    const deletedAt = (p: { payload: unknown }) => (p.payload as { deletedAt?: unknown }).deletedAt ?? null;
    expect(pending.filter((p) => p.op === 'delete').every((p) => deletedAt(p) !== null)).toBe(true);
    expect(pending.filter((p) => p.op === 'upsert').every((p) => deletedAt(p) === null)).toBe(true);

    // Through the wire and into an empty till with foreign keys on.
    const changes = JSON.parse(JSON.stringify(pending.map((p) => m.pendingToChange(p, 'dev-A')))) as SyncChange[];
    const rx = makeDb();
    const results = changes.map((c) => m.applyRemoteChange(rx.db, c));
    expect(results.filter((x) => !x.applied)).toEqual([]);
    expect(rx.raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);

    const sent = await tableDump(s.raw, s.db, { users: ['pin_hash'] });
    const got = await tableDump(rx.raw, rx.db, { users: ['pin_hash'] });
    expect(got).toEqual(sent);
    expect(rx.raw.prepare(`SELECT pin_hash FROM users WHERE id = 'u1'`).get()!.pin_hash).toBe(m.PIN_NOT_SHARED);
    // Deleted rows stay deleted.
    expect(rx.raw.prepare(`SELECT deleted_at FROM customer_addresses WHERE id = ?`).get(s.office.id)!.deleted_at).not.toBeNull();
    expect(rx.raw.prepare(`SELECT deleted_at FROM categories WHERE id = ?`).get(s.spare.id)!.deleted_at).not.toBeNull();

    // A second delivery changes nothing.
    expect(changes.map((c) => m.applyRemoteChange(rx.db, c).reason)).toEqual(changes.map(() => 'stale'));
  });

  // Tables go out parents first: categories … menu_items … users … orders …
  // order_items, payments … stock_movements. A sale landing after `orders`
  // went out is the case where an unpinned read would send the new order's
  // lines, payment and stock rows ahead of the order itself; one landing after
  // `categories` points at menu items and a user not sent yet.
  it.each(['categories', 'orders', 'recipes'])(
    'a sale during the build (after %s went out) reaches the other till after what it points at',
    async (after) => {
    const m = await mods();
    const r = await repos();
    const s = await shopThatClearedItsQueue();
    const rowsBefore = n(s.raw, `SELECT COUNT(*) AS n FROM "${after}"`);
    const cat = s.raw.prepare(`SELECT id FROM categories WHERE deleted_at IS NULL ORDER BY rowid LIMIT 1`).get()!.id as string;
    let fired = false;
    let newOrder = '';

    const result = await m.sendEverythingOnce(s.db, {
      openReader: readerFor(s.file!),
      shouldContinue: () => true,
      batchRows: 40,
      pause: async () => {
        // A whole new sale (stock moved) and a menu edit, while the build goes on.
        if (fired || n(s.raw, `SELECT COUNT(*) AS n FROM sync_queue WHERE entity_type = ?`, after) < rowsBefore) return;
        fired = true;
        newOrder = (await sell(s.raw, s.db, 3)).id;
        r.updateCategory(s.db, { id: cat, name: 'Renamed mid-send' }, actor);
      },
    });
    expect(result).toBe('done');
    expect(fired).toBe(true);
    expect(n(s.raw, `SELECT COUNT(*) AS n FROM stock_movements WHERE ref_order_id = ?`, newOrder)).toBeGreaterThan(0);

    const rx = makeDb();
    const results = pendingChanges(s.raw, 'dev-A').map((c) => m.applyRemoteChange(rx.db, c));
    expect(results.filter((x) => !x.applied && x.reason !== 'stale')).toEqual([]);
    expect(rx.raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(rx.raw.prepare(`SELECT name FROM categories WHERE id = ?`).get(cat)!.name).toBe('Renamed mid-send');
    expect(n(rx.raw, `SELECT COUNT(*) AS n FROM order_items WHERE order_id = ?`, newOrder)).toBe(1);
    expect(n(rx.raw, `SELECT COUNT(*) AS n FROM payments WHERE order_id = ?`, newOrder)).toBe(1);
    expect(n(rx.raw, `SELECT COUNT(*) AS n FROM stock_movements WHERE ref_order_id = ?`, newOrder)).toBeGreaterThan(0);

    // Everything matches, except each till's own running stock count: the
    // other till's sale arrived as its stock movement rows, and this till's
    // count stays its own (taken from the other till only for a new row).
    const skip = { users: ['pin_hash'], ingredients: ['current_qty'] };
    expect(await tableDump(rx.raw, rx.db, skip)).toEqual(await tableDump(s.raw, s.db, skip));
    const moved = s.raw.prepare(`SELECT ingredient_id AS id, delta_qty AS d FROM stock_movements WHERE ref_order_id = ? LIMIT 1`).get(newOrder)!;
    const qty = (raw: RawDb) => Number(raw.prepare(`SELECT current_qty AS q FROM ingredients WHERE id = ?`).get(moved.id)!.q);
    expect(qty(rx.raw)).toBe(qty(s.raw) - Number(moved.d));
    },
  );

  it('starts again from the top after it was stopped, with one image per row', async () => {
    const m = await mods();
    const s = await shopThatClearedItsQueue();
    const tables = m.replicableTables(s.db);
    const totalRows = [...tables.keys()].reduce((sum, t) => sum + n(s.raw, `SELECT COUNT(*) AS n FROM "${t}"`), 0);
    const onePerRow = () =>
      n(s.raw, `SELECT COUNT(*) AS n FROM (SELECT entity_type, entity_id FROM sync_queue WHERE synced_at IS NULL GROUP BY 1, 2 HAVING COUNT(*) > 1)`) === 0;

    let steps = 0;
    expect(
      await m.sendEverythingOnce(s.db, { openReader: readerFor(s.file!), shouldContinue: () => ++steps < 6, batchRows: 20, pause: noPause }),
    ).toBe('stopped');
    const partial = m.getPendingCount(s.db);
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThan(totalRows);
    expect(m.isSnapshotNeeded(s.db)).toBe(true);

    expect(await m.sendEverythingOnce(s.db, { openReader: readerFor(s.file!), shouldContinue: () => true, pause: noPause })).toBe('done');
    expect(m.getPendingCount(s.db)).toBe(totalRows);
    expect(onePerRow()).toBe(true);

    // Stopped again, switched off, the partial images cleared by housekeeping:
    // the next build still gives exactly one image per row.
    m.markSnapshotNeeded(s.db, 'asked');
    steps = 0;
    expect(
      await m.sendEverythingOnce(s.db, { openReader: readerFor(s.file!), shouldContinue: () => ++steps < 4, batchRows: 20, pause: noPause }),
    ).toBe('stopped');
    setLink(s.raw, { mode: 'off' });
    s.raw.prepare(`UPDATE sync_queue SET created_at = ?`).run(OLD);
    expect(await m.pruneUnsentWhileOff(s.db, { pause: noPause })).toBeGreaterThan(0);
    setLink(s.raw, HTTP);
    expect(await m.sendEverythingOnce(s.db, { openReader: readerFor(s.file!), shouldContinue: () => true, pause: noPause })).toBe('done');
    expect(m.getPendingCount(s.db)).toBe(totalRows);
    expect(onePerRow()).toBe(true);
  });

  it('keeps the marker when a new request came in while it was building', async () => {
    const m = await mods();
    const s = await shopThatClearedItsQueue();
    let asked = false;
    const result = await m.sendEverythingOnce(s.db, {
      openReader: readerFor(s.file!),
      shouldContinue: () => true,
      pause: async () => {
        if (!asked) m.markSnapshotNeeded(s.db, 'asked');
        asked = true;
      },
    });
    expect(result).toBe('done');
    expect(m.readSnapshotMarker(s.db)?.reason).toBe('asked');
  });

  it('replaces entries stamped days ahead by a wrong PC clock too', async () => {
    const m = await mods();
    const r = await repos();
    const s = await shopThatClearedItsQueue();
    const cat = s.raw.prepare(`SELECT id FROM categories WHERE deleted_at IS NULL ORDER BY rowid LIMIT 1`).get()!.id as string;
    r.updateCategory(s.db, { id: cat, displayOrder: 8 }, actor);
    s.raw.prepare(`UPDATE sync_queue SET created_at = ? WHERE synced_at IS NULL`).run(new Date(Date.now() + 90 * 86_400_000).toISOString());
    r.updateCategory(s.db, { id: cat, displayOrder: 9 }, actor);
    expect(m.getPendingCount(s.db)).toBe(2);
    const totalRows = [...m.replicableTables(s.db).keys()].reduce((sum, t) => sum + n(s.raw, `SELECT COUNT(*) AS n FROM "${t}"`), 0);

    expect(await m.sendEverythingOnce(s.db, { openReader: readerFor(s.file!), shouldContinue: () => true, pause: noPause })).toBe('done');
    expect(m.getPendingCount(s.db)).toBe(totalRows);
    const catImage = m.listPendingSync(s.db, 1_000_000).filter((p) => p.entityId === cat);
    expect(catImage.map((p) => (p.payload as { displayOrder: number }).displayOrder)).toEqual([9]);
  });

  it('does nothing when nothing is owed', async () => {
    const m = await mods();
    const s = makeDb(true);
    expect(await m.sendEverythingOnce(s.db, { openReader: readerFor(s.file!), shouldContinue: () => true, pause: noPause })).toBe('none');
  });
});

describe.skipIf(!Sqlite)('where the link points', () => {
  it('marks a full send for the first place ever and for a different place than before', async () => {
    const m = await mods();
    const s = makeDb();
    const key = (baseUrl: string, deviceSecret?: string) =>
      m.syncDestinationKey({ mode: 'http', baseUrl, ...(deviceSecret ? { deviceSecret } : {}) });

    // First link ever (or a till linked before this update): the queue cannot
    // be trusted to hold everything in a shape the other till can apply.
    expect(m.noteSyncDestination(s.db, key('https://sync.example.test', 's1'))).toBe(true);
    expect(m.readSnapshotMarker(s.db)?.reason).toBe('first_link');
    m.deleteSyncState(s.db, m.SYNC_SNAPSHOT_KEYS.needed);
    // The same place again.
    expect(m.noteSyncDestination(s.db, key('https://sync.example.test', 's1'))).toBe(false);
    expect(m.isSnapshotNeeded(s.db)).toBe(false);
    // Same place written differently.
    expect(m.noteSyncDestination(s.db, key('HTTPS://Sync.Example.test:443/', 's1'))).toBe(false);
    expect(m.isSnapshotNeeded(s.db)).toBe(false);
    // Another server.
    expect(m.noteSyncDestination(s.db, key('https://other.example.test', 's1'))).toBe(true);
    expect(m.readSnapshotMarker(s.db)?.reason).toBe('new_destination');
    // Same address, set up again with a new password.
    m.deleteSyncState(s.db, m.SYNC_SNAPSHOT_KEYS.needed);
    expect(m.noteSyncDestination(s.db, key('https://other.example.test', 's2'))).toBe(true);
    // The password itself is never stored.
    expect(m.getSyncState(s.db, m.SYNC_SNAPSHOT_KEYS.destination)).not.toContain('s2');
    // Developer test mode → a real server is a new place too.
    m.deleteSyncState(s.db, m.SYNC_SNAPSHOT_KEYS.needed);
    expect(m.noteSyncDestination(s.db, m.syncDestinationKey({ mode: 'mock' }))).toBe(true);
  });

  it('keeps a full send already owed when the first place is recorded', async () => {
    const m = await mods();
    const s = makeDb();
    m.markSnapshotNeeded(s.db, 'unsent_cleared');
    const before = m.readSnapshotMarker(s.db);
    expect(m.noteSyncDestination(s.db, m.syncDestinationKey({ mode: 'mock' }))).toBe(true);
    expect(m.readSnapshotMarker(s.db)).toEqual(before);
  });

  it('stores the place only sealed, and a place it cannot read back counts as new', async () => {
    const m = await mods();
    const s = makeDb();
    const k = m.syncDestinationKey({ mode: 'http', baseUrl: 'https://sync.example.test', deviceSecret: 'test-secret' });
    const fingerprint = k.split('|')[2]!;
    expect(fingerprint).toMatch(/^[0-9a-f]{12}$/);
    let readable = true;
    const codec = {
      seal: (key: string) => `sealed:${Buffer.from(key).toString('base64')}`,
      open: (stored: string) =>
        readable && stored.startsWith('sealed:') ? Buffer.from(stored.slice(7), 'base64').toString() : null,
    };
    m.noteSyncDestination(s.db, k, codec);
    m.deleteSyncState(s.db, m.SYNC_SNAPSHOT_KEYS.needed);
    const stored = m.getSyncState(s.db, m.SYNC_SNAPSHOT_KEYS.destination)!;
    expect(stored.startsWith('sealed:')).toBe(true);
    expect(stored).not.toContain(fingerprint);
    expect(m.noteSyncDestination(s.db, k, codec)).toBe(false);
    // Restored onto another PC: the sealed value cannot be opened there.
    readable = false;
    expect(m.noteSyncDestination(s.db, k, codec)).toBe(true);
    expect(m.readSnapshotMarker(s.db)?.reason).toBe('new_destination');

    // The app's own seal reads back what it wrote (plain here: no OS keychain in tests).
    const t = makeDb();
    expect(m.noteSyncDestination(t.db, k, m.destinationSeal)).toBe(true);
    expect(m.noteSyncDestination(t.db, k, m.destinationSeal)).toBe(false);
  });

  it('after an update, the first link replaces queue entries in the older shape with row images', async () => {
    const m = await mods();
    const s = makeDb(true);
    await buildShop(s.raw, s.db);
    const tables = m.replicableTables(s.db);
    const totalRows = [...tables.keys()].reduce((sum, t) => sum + n(s.raw, `SELECT COUNT(*) AS n FROM "${t}"`), 0);
    // What a till on the previous version queued: its repositories' domain
    // objects, often partial. The link was off and nothing was ever cleared.
    s.raw.prepare(`UPDATE sync_queue SET payload_json = json_object('id', entity_id, 'amountCents', 100)`).run();
    expect(m.isSnapshotNeeded(s.db)).toBe(false);

    // Switched on (within minutes of the update, before any clearing ran).
    setLink(s.raw, HTTP);
    expect(m.noteSyncDestination(s.db, m.syncDestinationKey(m.getSyncConfig(s.db)))).toBe(true);
    expect(
      await m.sendEverythingOnce(s.db, { openReader: readerFor(s.file!), shouldContinue: () => true, pause: noPause }),
    ).toBe('done');
    const pending = m.listPendingSync(s.db, 1_000_000);
    expect(pending.length).toBe(totalRows);
    expect(pending.every((p) => m.isRowImage(p.payload))).toBe(true);

    // The other till gets all of it.
    const rx = makeDb();
    const r = await m.applyRemoteBatch(rx.db, pendingChanges(s.raw, 'dev-A'), { pause: noPause });
    expect(r).toMatchObject({ applied: totalRows, waiting: 0, dropped: 0 });
    expect(rx.raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
});

describe.skipIf(!Sqlite)('what the other till accepts', () => {
  const image = (entityType: string, payload: Record<string, unknown>, version = 1): SyncChange => ({
    entityType,
    entityId: String(payload['id']),
    op: 'upsert',
    payload: { __rowImage: 1, ...payload },
    updatedAt: T0,
    deviceId: 'dev-B',
    version,
  });

  it('refuses row images for anything but replicable tables', async () => {
    const m = await mods();
    const rx = makeDb();
    for (const t of ['settings', 'audit_log', 'sync_state', 'sync_queue', 'no_such_table']) {
      expect(m.applyRemoteChange(rx.db, image(t, { id: 'x1', key: 'x', value: 'y' }))).toEqual({
        applied: false,
        reason: 'unknown_entity',
      });
    }
  });

  it('never takes a PIN from the other till', async () => {
    const m = await mods();
    const rx = makeDb();
    const user = { id: 'u9', fullName: 'Remote User', role: 'cashier', isActive: 1, createdAt: T0, updatedAt: T0, deviceId: 'dev-B', pinHash: 'attacker' };
    expect(m.applyRemoteChange(rx.db, image('users', user)).applied).toBe(true);
    expect(rx.raw.prepare(`SELECT pin_hash FROM users WHERE id = 'u9'`).get()!.pin_hash).toBe(m.PIN_NOT_SHARED);
    const audit = rx.raw.prepare(`SELECT action, after_json AS a FROM audit_log ORDER BY rowid DESC LIMIT 1`).get()!;
    expect(audit.action).toBe('remote_apply');
    expect(String(audit.a)).not.toContain('attacker');

    addUser(rx.raw, 'u8', 'dev-A');
    rx.raw.prepare(`UPDATE users SET pin_hash = 'kept-hash' WHERE id = 'u8'`).run();
    expect(m.applyRemoteChange(rx.db, image('users', { ...user, id: 'u8', role: 'manager' }, 2)).applied).toBe(true);
    expect(rx.raw.prepare(`SELECT pin_hash, role FROM users WHERE id = 'u8'`).get()).toEqual({ pin_hash: 'kept-hash', role: 'manager' });
  });

  it('still applies the older domain-shaped payloads', async () => {
    const m = await mods();
    const rx = makeDb();
    const r = m.applyRemoteChange(rx.db, {
      entityType: 'categories',
      entityId: 'c-legacy',
      op: 'upsert',
      payload: { id: 'c-legacy', name: 'Legacy', displayOrder: 3, colorHex: '#abcdef', isActive: true },
      updatedAt: T0,
      deviceId: 'dev-B',
      version: 1,
    });
    expect(r.applied).toBe(true);
    expect(rx.raw.prepare(`SELECT name, is_active FROM categories WHERE id = 'c-legacy'`).get()).toEqual({ name: 'Legacy', is_active: 1 });
  });

  it('keeps what cannot be saved, counts it, and saves it once it can', async () => {
    const m = await mods();
    const r = await repos();
    const s = await shopThatClearedItsQueue();
    await m.sendEverythingOnce(s.db, { openReader: readerFor(s.file!), shouldContinue: () => true, pause: noPause });
    const changes = pendingChanges(s.raw, 'dev-A');

    // A till that was set up on its own first: an owner, a tax rate, and
    // the same customer phone number typed in here.
    const rx = makeDb();
    addUser(rx.raw, 'owner-B', 'dev-B');
    r.createTaxCategory(rx.db, { name: 'Local Tax', rateBps: 1600 }, { userId: 'owner-B', deviceId: 'dev-B' });
    r.createCustomer(rx.db, { name: 'Same Phone', phone: '03001234567' }, { userId: 'owner-B', deviceId: 'dev-B' });

    const first = await m.applyRemoteBatch(rx.db, changes, { chunk: 37, pause: noPause });
    // The clashing customer and its two addresses wait; everything else is in.
    expect(first.waiting).toBe(3);
    expect(first.applied).toBe(changes.length - 3);
    expect(m.notSavedCount(rx.db)).toBe(3);
    expect(m.readParked(rx.db).map((p) => p.change.entityType).sort()).toEqual(['customer_addresses', 'customer_addresses', 'customers']);

    // Nothing new, nothing fixed: still waiting, tried again.
    const again = await m.applyRemoteBatch(rx.db, [], { pause: noPause });
    expect(again.waiting).toBe(3);
    expect(m.readParked(rx.db)[0]!.tries).toBe(2);

    // The clash is sorted out here; the next pull saves them.
    rx.raw.prepare(`UPDATE customers SET phone = '03000000000' WHERE name = 'Same Phone'`).run();
    const fixed = await m.applyRemoteBatch(rx.db, [], { pause: noPause });
    expect(fixed).toMatchObject({ applied: 3, waiting: 0 });
    expect(m.notSavedCount(rx.db)).toBe(0);
    expect(rx.raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });

  it('past the waiting cap keeps the parent, not the rows that point at it; Clear forgets what was dropped', async () => {
    const m = await mods();
    const r = await repos();
    const s = makeDb();
    addUser(s.raw);
    const cust = r.createCustomer(s.db, { name: 'Test Customer', phone: '03001234567' }, actor);
    const extra = m.PARKED_MAX + 40;
    for (let i = 0; i < extra; i++) {
      r.createAddress(s.db, { customerId: cust.id, addressLine: `House ${i}, Test Street`, area: 'Test Area' }, actor);
    }
    const changes = pendingChanges(s.raw, 'dev-A');
    const failing = changes.length; // the customer and everything that points at it

    // The same phone number was typed in on this till first.
    const rx = makeDb();
    addUser(rx.raw);
    r.createCustomer(rx.db, { name: 'Same Phone', phone: '03001234567' }, { userId: 'u1', deviceId: 'dev-B' });
    const first = await m.applyRemoteBatch(rx.db, changes, { pause: noPause });
    expect(first).toMatchObject({ applied: 0, waiting: m.PARKED_MAX, dropped: failing - m.PARKED_MAX });
    expect(m.readParked(rx.db)[0]!.change.entityId).toBe(cust.id);
    expect(m.notSavedCount(rx.db)).toBe(failing);

    // The clash is sorted out here: the parent and the rows kept with it go in.
    rx.raw.prepare(`UPDATE customers SET phone = '03000000000' WHERE name = 'Same Phone'`).run();
    const fixed = await m.applyRemoteBatch(rx.db, [], { pause: noPause });
    expect(fixed).toMatchObject({ applied: m.PARKED_MAX, waiting: 0 });
    expect(m.notSavedCount(rx.db)).toBe(failing - m.PARKED_MAX);

    // The other till sends everything again: the dropped ones arrive too.
    const again = await m.applyRemoteBatch(rx.db, changes, { pause: noPause });
    expect(again).toMatchObject({ applied: failing - m.PARKED_MAX, waiting: 0 });
    expect(n(rx.raw, `SELECT COUNT(*) AS n FROM customer_addresses WHERE customer_id = ?`, cust.id)).toBe(extra);

    // Then a manager presses Clear: the count goes, with an audit row.
    const audit = auditState(rx.raw).count;
    expect(m.clearDroppedCount(rx.db, 'u1')).toBe(failing - m.PARKED_MAX);
    expect(m.notSavedCount(rx.db)).toBe(0);
    expect(auditState(rx.raw).count).toBe(audit + 1);
    expect(rx.raw.prepare(`SELECT action, actor_user_id AS a FROM audit_log ORDER BY rowid DESC LIMIT 1`).get()).toEqual({
      action: 'not_saved_cleared',
      a: 'u1',
    });
    expect(await auditChainOk(rx.raw)).toBe(true);
  });

  it('saves a row that arrives before its parent, in the same pull or a later one', async () => {
    const m = await mods();
    const s = await shopThatClearedItsQueue();
    await m.sendEverythingOnce(s.db, { openReader: readerFor(s.file!), shouldContinue: () => true, pause: noPause });
    const changes = pendingChanges(s.raw, 'dev-A');

    // Same pull: an order line first, its order later.
    const lineAt = changes.findIndex((c) => c.entityType === 'order_items');
    const swapped = [changes[lineAt]!, ...changes.filter((_, i) => i !== lineAt)];
    const a = makeDb();
    expect(await m.applyRemoteBatch(a.db, swapped, { pause: noPause })).toMatchObject({ applied: changes.length, waiting: 0 });

    // A later pull: the orders arrive after everything that points at them.
    const b = makeDb();
    const orders = changes.filter((c) => c.entityType === 'orders');
    const first = await m.applyRemoteBatch(b.db, changes.filter((c) => c.entityType !== 'orders'), { pause: noPause });
    expect(first.waiting).toBeGreaterThan(0);
    const second = await m.applyRemoteBatch(b.db, orders, { pause: noPause });
    expect(second.waiting).toBe(0);
    expect(first.applied + second.applied).toBe(changes.length);
    expect(b.raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
  });
});

describe.skipIf(!Sqlite)('the schema the images are built from', () => {
  it('names every column once, and carries every key the older payload handlers read', async () => {
    const m = await mods();
    const s = makeDb();
    for (const t of m.replicableTables(s.db).values()) {
      const keys = t.columns.map((c) => m.columnKey(c.name));
      expect(new Set(keys).size).toBe(keys.length);
      expect(keys).not.toContain(m.ROW_IMAGE_KEY);
    }
    const legacy: Record<string, string[]> = {
      tax_categories: ['name', 'rateBps', 'createdAt'],
      categories: ['name', 'displayOrder', 'colorHex', 'isActive', 'createdAt'],
      menu_items: ['categoryId', 'name', 'description', 'basePriceCents', 'sku', 'barcode', 'imageUrl', 'isActive', 'prepStation', 'taxCategoryId', 'sortOrder', 'currentStock', 'lowStockThreshold', 'createdAt'],
      customers: ['name', 'phone', 'email', 'notes', 'loyaltyPoints', 'isActive', 'createdAt'],
      customer_addresses: ['customerId', 'label', 'addressLine', 'area', 'city', 'notes', 'isDefault'],
    };
    for (const [table, keys] of Object.entries(legacy)) {
      const cols = m.replicableTables(s.db).get(table)!.columns.map((c) => m.columnKey(c.name));
      expect(cols).toEqual(expect.arrayContaining(keys));
    }
  });

  it('orders tables parents first', async () => {
    const m = await mods();
    const s = makeDb();
    const order = m.snapshotOrder(s.db);
    expect(order.length).toBe(m.replicableTables(s.db).size);
    for (const t of m.replicableTables(s.db).values()) {
      for (const p of t.parents) expect(order.indexOf(p)).toBeLessThan(order.indexOf(t.name));
    }
  });

  it('reads the queue in order from its index, with no sort', async () => {
    const s = makeDb();
    const plan = (sql: string) =>
      s.raw
        .prepare(`EXPLAIN QUERY PLAN ${sql}`)
        .all()
        .map((r) => String(r.detail))
        .join(' | ');
    const push = plan(
      `SELECT id FROM sync_queue WHERE synced_at IS NULL ORDER BY created_at, rowid LIMIT 500`,
    );
    expect(push).toContain('idx_sync_queue_pending');
    expect(push).not.toContain('TEMP B-TREE');
    const clock = plan(`SELECT created_at FROM sync_queue WHERE synced_at IS NULL ORDER BY created_at DESC LIMIT 1`);
    expect(clock).toContain('idx_sync_queue_pending');
    expect(clock).not.toContain('TEMP B-TREE');
  });
});

describe.skipIf(!Sqlite)('giving freed space back', () => {
  it('rebuilds the file at start only when a lot is free and the disk has room', async () => {
    const m = await mods();
    const s = makeDb(true);
    const blob = 'x'.repeat(1_000);
    s.db.transaction(() => {
      for (let i = 0; i < 20_000; i++) {
        m.enqueueSync(s.db, { entityType: 'test_kind', entityId: `b${i}`, op: 'upsert', payload: { blob }, createdAt: OLD });
      }
    })();
    expect(m.compactIfWorthIt(s.db, { freeDiskBytes: () => 1e12 })).toEqual({ compacted: false, why: 'little to give back' });
    s.raw.prepare(`DELETE FROM sync_queue`).run();
    expect(m.compactIfWorthIt(s.db, { freeDiskBytes: () => 0 })).toEqual({ compacted: false, why: 'not enough free disk space' });
    const done = m.compactIfWorthIt(s.db, { freeDiskBytes: () => 1e12 });
    expect(done.compacted).toBe(true);
    if (done.compacted) expect(done.afterBytes).toBeLessThan(done.beforeBytes / 2);
    expect(m.compactIfWorthIt(s.db, { freeDiskBytes: () => 1e12 })).toEqual({ compacted: false, why: 'little to give back' });
  });
});

describe.skipIf(!Sqlite)('stock counts between tills', () => {
  /** Two tills holding the same shop: A built it and sent everything, B applied it. */
  async function twoTills() {
    const m = await mods();
    const a = await shopThatClearedItsQueue();
    await m.sendEverythingOnce(a.db, { openReader: readerFor(a.file!), shouldContinue: () => true, pause: noPause });
    const b = makeDb();
    expect((await m.applyRemoteBatch(b.db, pendingChanges(a.raw, 'dev-A'), { pause: noPause })).waiting).toBe(0);
    a.raw.prepare(`UPDATE sync_queue SET synced_at = ? WHERE synced_at IS NULL`).run(T0);
    return { a, b };
  }
  /** Each till gets what the other queued since, as a pull would bring it. */
  async function exchange(a: { raw: RawDb; db: Db }, b: { raw: RawDb; db: Db }) {
    const m = await mods();
    const fromA = pendingChanges(a.raw, 'dev-A');
    const fromB = pendingChanges(b.raw, 'dev-B');
    expect((await m.applyRemoteBatch(a.db, fromB, { pause: noPause })).waiting).toBe(0);
    expect((await m.applyRemoteBatch(b.db, fromA, { pause: noPause })).waiting).toBe(0);
    for (const t of [a, b]) t.raw.prepare(`UPDATE sync_queue SET synced_at = ? WHERE synced_at IS NULL`).run(T0);
  }

  it('an ingredient edit on one till survives a sale on the other made before it arrived', async () => {
    const r = await repos();
    const { a, b } = await twoTills();
    // The ingredient the next sale uses.
    const target = a.raw
      .prepare(
        `SELECT r.ingredient_id AS id FROM recipes r
          WHERE r.deleted_at IS NULL AND r.menu_item_id = (
            SELECT m.id FROM menu_items m WHERE m.deleted_at IS NULL AND m.is_active = 1
               AND EXISTS (SELECT 1 FROM recipes x WHERE x.menu_item_id = m.id AND x.deleted_at IS NULL)
             ORDER BY m.rowid LIMIT 1)
          ORDER BY r.rowid LIMIT 1`,
      )
      .get()!.id as string;
    const row = (raw: RawDb) =>
      raw.prepare(`SELECT low_threshold AS low, current_qty AS qty, version FROM ingredients WHERE id = ?`).get(target)!;

    // A manager on B changes the low-stock alert; before A hears of it, A sells.
    r.updateIngredient(b.db, { id: target, lowThreshold: 777 }, { userId: 'u1', deviceId: 'dev-B' });
    const qtyBefore = Number(row(a.raw).qty);
    await sell(a.raw, a.db, 2);
    const qtyAfterSale = Number(row(a.raw).qty);
    expect(qtyAfterSale).toBeLessThan(qtyBefore);

    await exchange(a, b);
    // The edit stands on both tills, and each keeps its own count.
    expect(row(a.raw)).toMatchObject({ low: 777, qty: qtyAfterSale });
    expect(row(b.raw)).toMatchObject({ low: 777, qty: qtyBefore });
    expect(row(a.raw).version).toBe(row(b.raw).version);
  });

  it("a unit converted on the other till rescales this till's own count", async () => {
    const r = await repos();
    const { a, b } = await twoTills();
    const flour = r.createIngredient(a.db, { name: 'Test Flour', unit: 'kg', currentQty: 5 }, actor);
    await exchange(a, b);
    const qty = (raw: RawDb) => raw.prepare(`SELECT unit, current_qty AS q FROM ingredients WHERE id = ?`).get(flour.id)!;
    expect(qty(b.raw)).toEqual({ unit: 'kg', q: 5 });
    // B throws away a kilo; A converts to grams.
    r.recordStockMovement(b.db, { ingredientId: flour.id, deltaQty: -1, reason: 'waste' }, { userId: 'u1', deviceId: 'dev-B' });
    r.convertIngredientToBaseUnit(a.db, flour.id, actor);
    await exchange(a, b);
    expect(qty(a.raw)).toEqual({ unit: 'g', q: 5_000 });
    expect(qty(b.raw)).toEqual({ unit: 'g', q: 4_000 });
  });
});

describe.skipIf(!Sqlite)('emptying the WAL file', () => {
  it('never waits on a reader holding an older moment (the full send), and finishes once it is gone', async () => {
    const m = await mods();
    const s = makeDb(true);
    s.raw.exec('PRAGMA busy_timeout = 5000'); // as connection.ts sets it
    const fill = (from: number, count: number, createdAt?: string) =>
      s.db.transaction(() => {
        for (let i = from; i < from + count; i++) {
          m.enqueueSync(s.db, {
            entityType: 'test_kind',
            entityId: `w${i}`,
            op: 'upsert',
            payload: { i },
            ...(createdAt ? { createdAt } : {}),
          });
        }
      })();
    fill(0, 500);
    // The full send's reader: one read transaction, left open across steps.
    const reader = readerFor(s.file!)();
    reader.exec('BEGIN');
    reader.prepare('SELECT COUNT(*) AS n FROM sync_queue').get();
    fill(500, 500);

    let t0 = performance.now();
    expect(m.checkpointWithoutWaiting(s.db, 'Test')).toBe(false);
    expect(performance.now() - t0).toBeLessThan(1_000);
    expect(Number(s.raw.prepare('PRAGMA busy_timeout').get()!.timeout)).toBe(5_000);

    // The daily tidy after a big delete, while that reader is still open.
    const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
    fill(1_000, 10_000, old);
    s.raw.prepare(`UPDATE sync_queue SET synced_at = ? WHERE created_at = ?`).run(old, old);
    t0 = performance.now();
    await m.tidySyncQueue(s.db, { pause: noPause });
    expect(performance.now() - t0).toBeLessThan(4_000);
    expect(n(s.raw, `SELECT COUNT(*) AS n FROM sync_queue`)).toBe(1_000);
    expect(Number(s.raw.prepare('PRAGMA busy_timeout').get()!.timeout)).toBe(5_000);

    reader.exec('COMMIT');
    reader.close();
    expect(m.checkpointWithoutWaiting(s.db, 'Test')).toBe(true);
    expect(statSync(`${s.file!}-wal`).size).toBe(0);
  });
});

describe.skipIf(!Sqlite)('the sync worker switching the link on', () => {
  it('checks the server first, waits out the start, builds, and only then pushes, copies first', async () => {
    const m = await mods();
    const { SyncWorker, RESUME_QUIET_MS } = await import('../services/sync-worker.js');
    fakeServer.reset();
    const s = makeDb(true);
    await buildShop(s.raw, s.db);
    s.raw.prepare(`UPDATE sync_queue SET created_at = ?`).run(OLD);
    const totalRows = [...m.replicableTables(s.db).keys()].reduce((sum, t) => sum + n(s.raw, `SELECT COUNT(*) AS n FROM "${t}"`), 0);

    const w = new SyncWorker();
    w.init(s.db, 'dev-A');
    w.stop();
    const tick = async () => {
      await w.tick();
      w.stop();
    };

    // Off: nothing is noted, nothing asked of the server.
    setLink(s.raw, { mode: 'off' });
    await tick();
    expect(m.getSyncState(s.db, m.SYNC_SNAPSHOT_KEYS.destination)).toBeNull();
    expect(fakeServer.pulls).toBe(0);
    expect(await m.pruneUnsentWhileOff(s.db, { pause: noPause })).toBeGreaterThan(0);
    const leftover = m.getPendingCount(s.db);

    // Switched on, server not answering: nothing is built or pushed.
    setLink(s.raw, HTTP);
    fakeServer.answers = false;
    await tick();
    expect(fakeServer.pulls).toBe(1);
    expect(fakeServer.pushes).toEqual([]);
    expect(m.getPendingCount(s.db)).toBe(leftover);
    expect(m.getSyncState(s.db, 'sync.last_error')).toBe('The sync server did not answer');
    expect(m.getSyncState(s.db, m.SYNC_SNAPSHOT_KEYS.destination)).not.toBeNull();
    expect(m.readSnapshotMarker(s.db)?.reason).toBe('unsent_cleared');

    // It answers: that pass only checks.
    fakeServer.answers = true;
    await tick();
    expect(fakeServer.pulls).toBe(2);
    expect(fakeServer.pushes).toEqual([]);
    expect(m.getPendingCount(s.db)).toBe(leftover);

    // Owed from before this start: it waits out the first minutes.
    await tick();
    expect(fakeServer.pushes).toEqual([]);
    expect(m.isSnapshotNeeded(s.db)).toBe(true);
    expect(m.getPendingCount(s.db)).toBe(leftover);

    // After them: the build, and still no push in that pass.
    (w as unknown as { startedAt: number }).startedAt = Date.now() - RESUME_QUIET_MS - 1_000;
    await tick();
    expect(m.isSnapshotNeeded(s.db)).toBe(false);
    expect(fakeServer.pushes).toEqual([]);
    expect(m.getPendingCount(s.db)).toBe(totalRows);
    expect(w.status()).toMatchObject({ pending: totalRows, sendingEverything: false });

    // Now the copies go out, parents first.
    await tick();
    expect(fakeServer.pushes.length).toBe(1);
    const first = fakeServer.pushes[0]!;
    expect(first.length).toBeGreaterThan(0);
    expect(first.every((c) => m.isRowImage(c.payload))).toBe(true);
    const order = m.snapshotOrder(s.db);
    const positions = first.map((c) => order.indexOf(c.entityType));
    expect(positions).toEqual([...positions].sort((x, y) => x - y));
    expect(m.getPendingCount(s.db)).toBe(totalRows - first.length);
  });

  it('a person switching the link on later in the session starts the build without the wait', async () => {
    const m = await mods();
    const { SyncWorker } = await import('../services/sync-worker.js');
    fakeServer.reset();
    const s = makeDb(true);
    await buildShop(s.raw, s.db);
    const w = new SyncWorker();
    w.init(s.db, 'dev-A');
    w.stop();
    const tick = async () => {
      await w.tick();
      w.stop();
    };
    // A minute after start (still inside the quiet minutes), a manager switches the link on.
    (w as unknown as { startedAt: number }).startedAt = Date.now() - 60_000;
    setLink(s.raw, HTTP);
    await tick(); // notes the first place (everything is owed) and checks the server
    expect(m.readSnapshotMarker(s.db)?.reason).toBe('first_link');
    expect(fakeServer.pushes).toEqual([]);
    await tick(); // builds
    expect(m.isSnapshotNeeded(s.db)).toBe(false);
    expect(fakeServer.pushes).toEqual([]);
    await tick(); // pushes
    expect(fakeServer.pushes.length).toBe(1);
    expect(fakeServer.pushes[0]!.every((c) => m.isRowImage(c.payload))).toBe(true);
  });
});
