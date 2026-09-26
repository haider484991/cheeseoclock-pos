/**
 * Order History against a real SQLite database built from every migration.
 *
 * better-sqlite3 here is built for Electron's ABI and will not open under
 * plain node, so this uses node's own `node:sqlite` (Node 22.5+) and skips
 * itself where that is missing. The statements are the ones the till runs.
 */
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it, vi } from 'vitest';

// Builds a real database from every migration and loads the repositories on
// first use: seconds on a slow CI runner, well past the 5 s default.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });
import type { OrderHistoryFilter } from '@cheeseoclock/shared-types';

vi.mock('electron-log/main', () => ({ default: { info: () => {}, warn: () => {}, error: () => {} } }));

interface RawDb {
  exec(sql: string): void;
  prepare(sql: string): {
    run(...p: unknown[]): unknown;
    all(...p: unknown[]): Array<Record<string, unknown>>;
    get(...p: unknown[]): Record<string, unknown> | undefined;
  };
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

const raw = openSqlite();
const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

function insert(table: string, row: Record<string, unknown>): void {
  if (!raw) return;
  const cols = raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
    type: string;
    notnull: number;
    dflt_value: unknown;
  }>;
  const full: Record<string, unknown> = { ...row };
  for (const c of cols) {
    if (c.name in full || !c.notnull || c.dflt_value !== null) continue;
    full[c.name] = /INT/i.test(c.type) ? 0 : 'x';
  }
  const keys = Object.keys(full);
  raw
    .prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
    .run(...keys.map((k) => full[k]));
}

const at = (hhmm: string) => `2026-09-26T${hhmm}:00.000Z`;
let n = 0;
function order(status: string, over: Record<string, unknown> = {}): string {
  n += 1;
  const id = `o${n}`;
  insert('orders', {
    id,
    order_number: `20260926-${String(n).padStart(4, '0')}`,
    mode: 'takeaway',
    status,
    cashier_id: 'u1',
    total_cents: 100_000,
    created_at: at(`10:${String(n).padStart(2, '0')}`),
    updated_at: 'x',
    device_id: 'd1',
    ...over,
  });
  return id;
}
function pay(orderId: string, method: string, amount: number): void {
  insert('payments', {
    id: `${orderId}-${method}-${amount}`,
    order_id: orderId,
    method,
    amount_cents: amount,
    received_by_user_id: 'u1',
    paid_at: at('12:00'),
    created_at: 'x',
    updated_at: 'x',
    device_id: 'd1',
  });
}
function voidAudit(orderId: string, fromStatus: string): void {
  insert('audit_log', {
    id: `a-${orderId}`,
    entity_type: 'orders',
    entity_id: orderId,
    action: 'void',
    before_json: JSON.stringify({ id: orderId, status: fromStatus }),
    after_json: JSON.stringify({ id: orderId, status: 'void' }),
    created_at: 'x',
  });
}

const ids: Record<string, string> = {};

beforeAll(() => {
  if (!raw) return;
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(join(MIGRATIONS, f), 'utf8'));
  }
  raw.exec('PRAGMA foreign_keys=OFF');
  insert('users', { id: 'u1', full_name: 'Cashier One', role: 'cashier' });
  insert('riders', { id: 'r1', name: 'Bilal', phone: '03211234567' });

  ids.cart = order('open'); // a cart still being rung up
  ids.prepaid = order('sent_to_kitchen', {
    paid_at: at('10:02'),
    customer_name_snapshot: 'Ali Khan',
    customer_phone_snapshot: '0300-1234567',
  });
  pay(ids.prepaid, 'cash', 100_000);
  for (const [iid, qty, parent] of [['i1', 2, null], ['i2', 1, null], ['i3', 1, 'i2']] as const) {
    insert('order_items', {
      id: iid,
      order_id: ids.prepaid,
      menu_item_id: 'm',
      menu_item_name: 'Pizza',
      quantity: qty,
      unit_price_cents: 100,
      line_total_cents: 100 * qty,
      tax_category_id: 't',
      tax_rate_bps_snapshot: 0,
      prep_station_snapshot: 'kitchen',
      parent_order_item_id: parent,
      created_at: 'x',
      updated_at: 'x',
      device_id: 'd1',
    });
  }
  ids.cod = order('out_for_delivery', {
    mode: 'delivery',
    assigned_rider_id: 'r1',
    customer_phone_snapshot: '+923001112222',
  });
  ids.partRefund = order('paid', { total_cents: 150_000, paid_at: 'x' });
  pay(ids.partRefund, 'card', 150_000);
  pay(ids.partRefund, 'cash', -30_000);
  ids.refunded = order('refunded', { total_cents: 80_000, paid_at: 'x' });
  pay(ids.refunded, 'cash', 80_000);
  pay(ids.refunded, 'cash', -80_000);
  ids.cancelled = order('void');
  voidAudit(ids.cancelled, 'sent_to_kitchen');
  ids.cancelledCart = order('void');
  voidAudit(ids.cancelledCart, 'open');
  ids.webUnpaid = order('served', { source: 'web' });
  ids.deleted = order('paid', { deleted_at: 'x' });
  ids.foodpanda = order('paid', { mode: 'foodpanda', total_cents: 200_000, paid_at: 'x' });
  pay(ids.foodpanda, 'foodpanda', 200_000);
  ids.yesterday = order('paid', {
    order_number: '20260925-0001',
    total_cents: 50_000,
    paid_at: 'x',
    created_at: '2026-09-25T20:00:00.000Z',
  });
  pay(ids.yesterday, 'cash', 50_000);
});

async function history(filter?: OrderHistoryFilter) {
  const { listOrderHistory } = await import('./repositories/order-repo.js');
  return listOrderHistory(raw as never, filter);
}
const idSet = (page: { rows: Array<{ id: string }> }) => new Set(page.rows.map((r) => r.id));

describe.skipIf(!raw)('Order History on a real database', () => {
  it('lists placed orders only: never a cart, a cancelled cart, or a deleted order', async () => {
    const page = await history();
    expect(page.total).toBe(8);
    expect(idSet(page)).toEqual(
      new Set([ids.prepaid, ids.cod, ids.partRefund, ids.refunded, ids.cancelled, ids.webUnpaid, ids.foodpanda, ids.yesterday]),
    );
    // Newest first.
    expect(page.rows[0]?.id).toBe(ids.foodpanda);
  });

  it('adds the totals up across every page, the same way Reports does', async () => {
    const { summary } = await history({ limit: 1 });
    expect(summary).toMatchObject({
      orderCount: 8,
      paidCount: 4,
      salesCents: 100_000 + (150_000 - 30_000) + 200_000 + 50_000,
      notPaidCount: 2,
      notPaidCents: 200_000,
      cancelledCount: 1,
      cancelledCents: 100_000,
      refundCount: 2,
      refundedCents: 110_000,
    });
    expect(Object.fromEntries(summary.byMethod.map((m) => [m.method, m.netCents]))).toEqual({
      foodpanda: 200_000,
      card: 150_000,
      cash: 120_000,
    });
  });

  it('fills each row', async () => {
    const page = await history({ search: 'ali' });
    expect(page.rows).toHaveLength(1);
    expect(page.rows[0]).toMatchObject({
      id: ids.prepaid,
      cashierName: 'Cashier One',
      itemCount: 3, // 2 + 1; the deal part is not counted again
      paymentMethods: ['cash'],
      refundedCents: 0,
    });
    const cod = (await history({ channel: 'delivery' })).rows[0];
    expect(cod).toMatchObject({ id: ids.cod, riderName: 'Bilal', paymentMethods: [] });
    const part = (await history({ statusGroup: 'refunded' })).rows.find((r) => r.id === ids.partRefund);
    expect(part).toMatchObject({ refundedCents: 30_000, paymentMethods: ['card'] });
  });

  it('filters by day, status, type and payment', async () => {
    const today = { sinceIso: '2026-09-26T00:00:00.000Z', untilIso: '2026-09-27T00:00:00.000Z' };
    expect((await history(today)).total).toBe(7);
    expect(idSet(await history({ statusGroup: 'in_progress' }))).toEqual(new Set([ids.prepaid, ids.cod]));
    expect(idSet(await history({ statusGroup: 'done' }))).toEqual(
      new Set([ids.partRefund, ids.webUnpaid, ids.foodpanda, ids.yesterday]),
    );
    expect(idSet(await history({ statusGroup: 'not_paid' }))).toEqual(new Set([ids.cod, ids.webUnpaid]));
    expect(idSet(await history({ statusGroup: 'cancelled' }))).toEqual(new Set([ids.cancelled]));
    expect(idSet(await history({ statusGroup: 'refunded' }))).toEqual(new Set([ids.partRefund, ids.refunded]));
    expect(idSet(await history({ channel: 'web' }))).toEqual(new Set([ids.webUnpaid]));
    expect(idSet(await history({ paymentMethod: 'cash' }))).toEqual(
      new Set([ids.prepaid, ids.refunded, ids.yesterday]),
    );
  });

  it('finds an order by number, phone or name', async () => {
    expect(idSet(await history({ search: '#2' }))).toEqual(new Set([ids.prepaid]));
    expect(idSet(await history({ search: '+92 300 1234567' }))).toEqual(new Set([ids.prepaid]));
    expect(idSet(await history({ search: '20260926-0003' }))).toEqual(new Set([ids.cod]));
    expect((await history({ search: 'nobody' })).total).toBe(0);
  });

  it('pages newest first', async () => {
    const p1 = await history({ limit: 3, offset: 0 });
    const p2 = await history({ limit: 3, offset: 3 });
    expect(p1.total).toBe(8);
    expect(p1.rows).toHaveLength(3);
    expect(p2.rows).toHaveLength(3);
    expect([...idSet(p1)].some((id) => idSet(p2).has(id))).toBe(false);
  });
});
