/**
 * The Customers screen and the delivery-address writes against a real SQLite
 * database built from every migration (0025's orders→customer index
 * included).
 *
 * better-sqlite3 here is built for Electron's ABI and will not open under
 * plain node, so this uses node's own `node:sqlite` (Node 22.5+), with a
 * small `transaction()` shim in better-sqlite3's shape, and skips itself
 * where node:sqlite is missing. Every name and number is made up.
 */
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it, vi } from 'vitest';

// Builds a real database from every migration and loads the repositories on
// first use: seconds on a slow CI runner, well past the 5 s default.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

vi.mock('electron-log/main', () => ({ default: { info: () => {}, warn: () => {}, error: () => {} } }));
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));

interface Stmt {
  run(...p: unknown[]): unknown;
  all(...p: unknown[]): Array<Record<string, unknown>>;
  get(...p: unknown[]): Record<string, unknown> | undefined;
}
interface RawDb {
  exec(sql: string): void;
  prepare(sql: string): Stmt;
}

function openSqlite(): RawDb | null {
  try {
    const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
      DatabaseSync: new (path: string) => RawDb;
    };
    return new DatabaseSync(':memory:');
  } catch {
    return null;
  }
}

/** better-sqlite3's `db.transaction(fn)`: BEGIN at the outside, SAVEPOINTs inside. */
function withTransactions(raw: RawDb) {
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
  };
}

const raw = openSqlite();
const db = (raw ? withTransactions(raw) : null) as never;
const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), 'migrations');
const actor = { userId: 'u1', deviceId: 'd1' };

const repo = () => import('./repositories/customer-repo.js');

function count(sql: string, ...p: unknown[]): number {
  return Number(raw!.prepare(sql).get(...p)?.n ?? 0);
}

let orderNo = 0;
function order(customerId: string, status: string, createdAt: string): void {
  orderNo += 1;
  raw!
    .prepare(
      `INSERT INTO orders (id, order_number, mode, status, cashier_id, customer_id, total_cents,
                           created_at, updated_at, device_id)
       VALUES (?, ?, 'delivery', ?, 'u1', ?, 100000, ?, 'x', 'd1')`,
    )
    .run(`o${orderNo}`, `20260926-${String(orderNo).padStart(4, '0')}`, status, customerId, createdAt);
}

const ids = { ali: '', sara: '', omar: '', hina: '', zain: '', bilal: '' };

beforeAll(async () => {
  if (!raw) return;
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(join(MIGRATIONS, f), 'utf8'));
  }
  raw.exec('PRAGMA foreign_keys=OFF');
  raw
    .prepare(
      `INSERT INTO users (id, full_name, pin_hash, role, created_at, updated_at, device_id)
       VALUES ('u1', 'Cashier One', 'x', 'cashier', 'x', 'x', 'd1')`,
    )
    .run();

  const { createCustomer, createAddress } = await repo();
  const add = (name: string, phone: string, line: string, area: string | null) => {
    const c = createCustomer(db, { name, phone }, actor);
    createAddress(db, { customerId: c.id, addressLine: line, area, city: 'Karachi' }, actor);
    return c.id;
  };
  ids.ali = add('Ali Test', '03001110001', 'House 41-C, Lane 3', 'Rahat Commercial, DHA Phase 6');
  ids.sara = add('Sara Test', '03001110002', 'Flat 7, Sea Breeze', 'Clifton Block 2');
  ids.omar = add('Omar Test', '03001110003', 'House 12, Street 9', 'phase 6'); // typed on an older till
  ids.hina = add('Hina Test', '03001110004', 'House 3', 'DHA Phase 7 Extension');
  ids.zain = add('Zain Test', '03001110005', 'House 88', 'Khayaban-e-Ittehad, DHA'); // phase not asked yet
  ids.bilal = add('Bilal Test', '03001110006', 'Plot 5', 'Gulshan Block 13'); // outside the zones

  order(ids.ali, 'paid', '2026-09-20T10:00:00.000Z');
  order(ids.ali, 'delivered', '2026-09-25T10:00:00.000Z');
  order(ids.ali, 'open', '2026-09-26T10:00:00.000Z'); // a cart, not an order
  order(ids.ali, 'void', '2026-09-26T11:00:00.000Z'); // cancelled
  order(ids.sara, 'paid', '2026-09-26T09:00:00.000Z');
});

describe.skipIf(!raw)('Customers screen (pageCustomers)', () => {
  it('counts placed orders only and knows the last one', async () => {
    const { pageCustomers } = await repo();
    const ali = pageCustomers(db, { search: 'ali test' }).rows[0];
    expect(ali).toMatchObject({ orderCount: 2, lastOrderAt: '2026-09-25T10:00:00.000Z', area: 'Rahat Commercial, DHA Phase 6' });
  });

  it('finds a customer by name, by a phone typed the local way, or by house number', async () => {
    const { pageCustomers } = await repo();
    expect(pageCustomers(db, { search: 'sara' }).rows.map((r) => r.id)).toEqual([ids.sara]);
    expect(pageCustomers(db, { search: '0300 1110003' }).rows.map((r) => r.id)).toEqual([ids.omar]);
    expect(pageCustomers(db, { search: '41-C' }).rows.map((r) => r.id)).toEqual([ids.ali]);
  });

  it('filters by delivery zone, whatever format the area was saved in', async () => {
    const { pageCustomers } = await repo();
    const zone = (zoneIds: string[]) => new Set(pageCustomers(db, { zoneIds }).rows.map((r) => r.id));
    expect(zone(['dha-6'])).toEqual(new Set([ids.ali, ids.omar]));
    // Phase 7 is not Phase 7 Extension.
    expect(zone(['dha-7'])).toEqual(new Set());
    expect(zone(['dha-7-ext'])).toEqual(new Set([ids.hina]));
    // "All of DHA" also takes an address whose phase was never asked.
    const dha = ['dha-1', 'dha-2', 'dha-2-ext', 'dha-3', 'dha-4', 'dha-5', 'dha-6', 'dha-7', 'dha-7-ext', 'dha-8', 'emaar', 'creek-vista'];
    expect(zone(dha)).toEqual(new Set([ids.ali, ids.omar, ids.hina, ids.zain]));
    expect(zone(['clifton-2'])).toEqual(new Set([ids.sara]));
  });

  it('sorts by the last order and pages with a true total', async () => {
    const { pageCustomers } = await repo();
    const recent = pageCustomers(db, { sort: 'recent', limit: 2 });
    expect(recent.total).toBe(6);
    expect(recent.rows.map((r) => r.id)).toEqual([ids.sara, ids.ali]);
    const byOrders = pageCustomers(db, { sort: 'orders', limit: 1 });
    expect(byOrders.rows[0]?.id).toBe(ids.ali);
    const all = pageCustomers(db, { sort: 'name', limit: 4 });
    const rest = pageCustomers(db, { sort: 'name', limit: 4, offset: 4 });
    expect(all.rows).toHaveLength(4);
    expect(rest.rows).toHaveLength(2);
    expect(new Set([...all.rows, ...rest.rows].map((r) => r.id)).size).toBe(6);
  });

  it('uses the orders→customer index', () => {
    const plan = raw!
      .prepare(`EXPLAIN QUERY PLAN SELECT COUNT(*) FROM orders o WHERE o.customer_id = ? AND o.deleted_at IS NULL`)
      .all('x')
      .map((r) => String(r.detail))
      .join(' ');
    expect(plan).toContain('idx_orders_customer');
  });
});

describe.skipIf(!raw)('area usage (listAreaUsage)', () => {
  it('counts saved addresses per area text, busiest first', async () => {
    const { listAreaUsage, createAddress } = await repo();
    createAddress(db, { customerId: ids.omar, addressLine: 'Office 2', area: 'Clifton Block 2', city: 'Karachi' }, actor);
    const usage = listAreaUsage(db);
    expect(usage[0]).toEqual({ area: 'Clifton Block 2', count: 2 });
    expect(usage.find((u) => u.area === 'phase 6')?.count).toBe(1);
  });
});

describe.skipIf(!raw)('address writes keep sync and audit honest', () => {
  const syncRows = (id: string) => count(`SELECT COUNT(*) AS n FROM sync_queue WHERE entity_id = ?`, id);
  const auditRows = (id: string) => count(`SELECT COUNT(*) AS n FROM audit_log WHERE entity_id = ?`, id);
  const isDefault = (id: string) => Number(raw!.prepare(`SELECT is_default AS d FROM customer_addresses WHERE id = ?`).get(id)?.d);

  it('moving the default writes a sync + audit row for every address that changed', async () => {
    const { createAddress, setDefaultAddress } = await repo();
    const home = createAddress(db, { customerId: ids.hina, label: 'Home', addressLine: 'House 3A', area: 'DHA Phase 7', isDefault: true }, actor);
    const office = createAddress(db, { customerId: ids.hina, label: 'Office', addressLine: 'Office 9', area: 'DHA Phase 8' }, actor);
    const [homeSync, homeAudit, officeSync, officeAudit] = [syncRows(home.id), auditRows(home.id), syncRows(office.id), auditRows(office.id)];

    setDefaultAddress(db, office.id, actor);
    expect(isDefault(office.id)).toBe(1);
    expect(isDefault(home.id)).toBe(0);
    expect(syncRows(office.id)).toBe(officeSync + 1);
    expect(auditRows(office.id)).toBe(officeAudit + 1);
    expect(syncRows(home.id)).toBe(homeSync + 1);
    expect(auditRows(home.id)).toBe(homeAudit + 1);
    const payload = JSON.parse(
      String(raw!.prepare(`SELECT payload_json AS p FROM sync_queue WHERE entity_id = ? ORDER BY rowid DESC LIMIT 1`).get(home.id)?.p),
    );
    // The full post-image, not a partial { isDefault } patch: the row as
    // stored (a row image, see replicable-schema.ts).
    expect(payload).toMatchObject({ id: home.id, isDefault: 0, addressLine: 'House 3A', area: 'DHA Phase 7' });
  });

  it('re-saving an existing address as default goes through the ledgers too', async () => {
    const { createAddress } = await repo();
    const first = createAddress(db, { customerId: ids.sara, addressLine: 'Flat 7, Sea Breeze', area: 'Clifton Block 2', city: 'Karachi', isDefault: true }, actor);
    expect(first.isDefault).toBe(true);
    expect(isDefault(first.id)).toBe(1);
    expect(count(`SELECT COUNT(*) AS n FROM audit_log WHERE entity_id = ? AND action = 'set_default'`, first.id)).toBe(1);
  });

  it('deleting keeps what was deleted in the audit, and refuses an unknown address', async () => {
    const { createAddress, deleteAddress } = await repo();
    const a = createAddress(db, { customerId: ids.zain, addressLine: 'Old flat', area: 'Clifton Block 5' }, actor);
    deleteAddress(db, a.id, actor);
    const audit = raw!
      .prepare(`SELECT before_json AS b, after_json AS a FROM audit_log WHERE entity_id = ? AND action = 'delete'`)
      .get(a.id);
    expect(JSON.parse(String(audit?.b))).toMatchObject({ addressLine: 'Old flat' });
    expect(audit?.a).toBeNull();
    expect(raw!.prepare(`SELECT deleted_at AS d FROM customer_addresses WHERE id = ?`).get(a.id)?.d).toBeTruthy();
    expect(() => deleteAddress(db, a.id, actor)).toThrow('Address not found');
  });
});
