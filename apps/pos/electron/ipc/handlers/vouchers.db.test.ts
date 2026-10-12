/**
 * Vouchers (v0.7.48; the owner, 12 Oct 2026: "we are giving these vouchers
 * to abhi company … can you add it to pos system so we can track it").
 * Through the real IPC handlers and repositories on a real SQLite database
 * built from every migration:
 *   - the owner adds a client's vouchers (a list as printed, or made codes);
 *     a code already on another voucher, or a number twice, is refused;
 *   - the cashier types a voucher's number and code: one of the item it is
 *     for comes off (up to what it covers), extras are paid; the bill can be
 *     Rs 0 and is completed with nothing to pay;
 *   - the voucher is then used, on that order, and is refused anywhere else;
 *     taking it off, cancelling or deleting the order frees it again;
 *   - its line taken off: it moves to another pizza, or comes off;
 *   - one discount per order: F3 waits for the voucher to come off; an
 *     automatic offer steps aside and comes back;
 *   - vouchers and their use travel to the other till.
 *
 * Only `defineHandler` (captured), the signed-in session, the printer
 * spooler and the FBR worker are stood in for. node's own `node:sqlite`
 * stands in for better-sqlite3 (built for Electron); skipped where it is
 * missing. Every name, id, code and amount is made up.
 */
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeEscPos, renderReceipt } from '@cheeseoclock/printer-core';
import type {
  AuthenticatedUser,
  ChannelOffer,
  OrderSnapshot,
  UUID,
  VoucherBatchDetail,
  VoucherBatchSummary,
  VoucherCheck,
  VoucherFor,
} from '@cheeseoclock/shared-types';
import { verifyAuditChain, type AuditChainRow } from '../../db/audit-chain.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

type Handler = (ctx: unknown, payload: unknown) => unknown;
const h = vi.hoisted(() => ({
  handlers: new Map<string, (ctx: unknown, payload: unknown) => unknown>(),
  session: null as unknown,
}));

vi.mock('../registry.js', () => {
  class IpcGuardError extends Error {
    readonly apiError: { code: string; message: string };
    constructor(apiError: { code: string; message: string }) {
      super(apiError.message);
      this.apiError = apiError;
      this.name = 'IpcGuardError';
    }
  }
  return {
    IpcGuardError,
    defineHandler: (channel: string, _ctx: unknown, fn: Handler) => {
      h.handlers.set(channel, fn);
    },
  };
});
vi.mock('electron-log/main', () => ({
  default: { info: () => {}, warn: () => {}, error: () => {} },
}));
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  app: { getPath: () => '', getVersion: () => '0.0.0-test' },
  dialog: {},
  safeStorage: { isEncryptionAvailable: () => false },
  Notification: class {
    static isSupported() {
      return false;
    }
  },
}));
vi.mock('../../services/auth-service.js', () => ({
  getCurrentSession: () => h.session,
  verifyManagerPin: async () => {
    throw new Error("That is not a manager's PIN or password");
  },
}));
vi.mock('../../services/print-spooler.js', () => ({
  printSpooler: new Proxy({}, { get: () => () => undefined }),
}));
vi.mock('../../services/fbr-worker.js', () => ({
  fbrWorker: { kick: () => {}, resetAdapter: () => {} },
}));
vi.mock('../../services/website-settings-events.js', () => ({
  websiteSettingsChanged: () => {},
  onWebsiteSettingsChanged: () => () => {},
}));

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
    return (
      createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: new (path: string) => RawDb }
    ).DatabaseSync;
  } catch {
    return null;
  }
})();
const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(HERE, '..', '..', 'db', 'migrations');

function openMigrated() {
  const raw = new Sqlite!(':memory:');
  for (const f of readdirSync(MIGRATIONS)
    .filter((x) => x.endsWith('.sql'))
    .sort()) {
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
  };
}

const DEV = 'dev-till-1';
const TILL_2 = 'dev-till-2';
const T0 = '2026-01-01T00:00:00.000Z';
const session = (id: string, role: AuthenticatedUser['role']): AuthenticatedUser => ({
  id: id as UUID,
  fullName: id,
  role,
  sessionId: 'sess' as UUID,
});
const CASHIER = session('u_cash', 'cashier');
const MANAGER = session('u_mgr', 'manager');
const OWNER = session('u_admin', 'admin');

type Db = ReturnType<typeof openMigrated>;
let db: Db;
let menu: { large: string; premium: string; medium: string; signature: string; coke: string; bigTwo: string; pizzas: string; signatures: string };

type Outcome = { ok: true; data: unknown } | { ok: false; code: string; message: string };

async function call(channel: string, payload?: unknown): Promise<Outcome> {
  const fn = h.handlers.get(channel);
  if (!fn) throw new Error(`No handler for ${channel}`);
  try {
    const r = (await fn({ db, deviceId: DEV }, payload)) as
      | { ok: true; data: unknown }
      | { ok: false; error: { code: string; message: string } };
    return r.ok ? { ok: true, data: r.data } : { ok: false, code: r.error.code, message: r.error.message };
  } catch (e) {
    const api = (e as { apiError?: { code: string; message: string } }).apiError;
    if (api) return { ok: false, code: api.code, message: api.message };
    return { ok: false, code: 'threw', message: e instanceof Error ? e.message : String(e) };
  }
}
async function data<T = unknown>(channel: string, payload?: unknown): Promise<T> {
  const o = await call(channel, payload);
  if (!o.ok) throw new Error(`${channel} refused: ${o.code} ${o.message}`);
  return o.data as T;
}

function addUsersAndTill(d: Db, deviceId: string): void {
  const user = d.prepare(
    `INSERT INTO users (id, full_name, pin_hash, role, created_at, updated_at, device_id) VALUES (?, ?, 'x', ?, ?, ?, ?)`,
  );
  user.run('u_admin', 'Test Owner', 'admin', T0, T0, DEV);
  user.run('u_cash', 'Test Cashier', 'cashier', T0, T0, DEV);
  user.run('u_mgr', 'Test Manager', 'manager', T0, T0, DEV);
  d.prepare(`INSERT INTO device_info (id, device_id, display_name, registered_at) VALUES ('singleton', ?, ?, ?)`).run(deviceId, deviceId, T0);
}

async function seedTill(d: Db): Promise<typeof menu> {
  addUsersAndTill(d, DEV);
  const x = d as never;
  const mgr = { userId: 'u_mgr', deviceId: DEV };
  const { openShift } = await import('../../db/repositories/shift-repo.js');
  const { createTaxCategory } = await import('../../db/repositories/tax-category-repo.js');
  const { createCategory } = await import('../../db/repositories/category-repo.js');
  const { createMenuItem } = await import('../../db/repositories/menu-item-repo.js');
  openShift(x, { openingCashCents: 0, notes: null }, mgr);
  const tax = createTaxCategory(x, { name: 'Test GST', rateBps: 1_600, digitalRateBps: 800 }, mgr);
  const pizzas = createCategory(x, { name: 'Pizza', displayOrder: 1, colorHex: '#aa5500' }, mgr);
  const drinks = createCategory(x, { name: 'Drinks', displayOrder: 2, colorHex: '#0055aa' }, mgr);
  // Never discounted by its name (0047): its lines are value deals.
  const deals = createCategory(x, { name: 'Value Deals', displayOrder: 3, colorHex: '#00aa55' }, mgr);
  const signatures = createCategory(x, { name: 'Signature Pizzas', displayOrder: 4, colorHex: '#aa0055' }, mgr);
  const item = (categoryId: string, name: string, cents: number) =>
    createMenuItem(x, { categoryId, name, basePriceCents: cents, taxCategoryId: tax.id }, mgr).id;
  return {
    large: item(pizzas.id, 'Test Fajita Pizza — Large', 189_900),
    premium: item(pizzas.id, 'Test Royal Pizza — Large', 249_900),
    medium: item(pizzas.id, 'Test Fajita Pizza — Medium', 149_900),
    signature: item(signatures.id, 'Test Shawarma Pizza — Large', 219_900),
    coke: item(drinks.id, 'Test Cola', 15_000),
    bigTwo: item(deals.id, 'Test Big Two', 399_900),
    pizzas: pizzas.id,
    signatures: signatures.id,
  };
}

beforeEach(async () => {
  if (!Sqlite) return;
  h.handlers.clear();
  h.session = null;
  db = openMigrated();
  menu = await seedTill(db);
  const ctx = { db, deviceId: DEV } as never;
  (await import('./orders-handlers.js')).registerOrdersHandlers(ctx);
  (await import('./settings-handlers.js')).registerSettingsHandlers(ctx);
  (await import('./vouchers-handlers.js')).registerVouchersHandlers(ctx);
});

const ABHI: { name: string; gives: string; coversCents: number; goodUntil: string | null } = {
  name: 'abhi',
  gives: 'One Large pizza from the Regular menu',
  coversCents: 189_900,
  goodUntil: null,
};
const LIST = [
  { number: 1, code: 'AB3C' },
  { number: 2, code: 'XK7P' },
  { number: 3, code: 'RT9D' },
];

/** The owner adds the abhi vouchers (three of them, as printed). */
async function addAbhi(extra: Partial<typeof ABHI> & { for?: VoucherFor | null } = {}): Promise<VoucherBatchSummary> {
  h.session = OWNER;
  return data<VoucherBatchSummary>('vouchers:addBatch', { ...ABHI, ...extra, from: 'list', vouchers: LIST });
}
/** A takeaway with these items (one of each), rung up by the cashier: its snapshot. */
async function takeaway(...items: string[]): Promise<OrderSnapshot> {
  h.session = CASHIER;
  const order = await data<{ id: string }>('orders:create', { mode: 'takeaway' });
  for (const menuItemId of items) await data('orders:addItem', { orderId: order.id, menuItemId, quantity: 1 });
  return snap(order.id);
}
const snap = async (id: string) => {
  h.session = CASHIER;
  return (await data<OrderSnapshot | null>('orders:get', { id }))!;
};
const lineOf = (s: OrderSnapshot, menuItemId: string) => s.items.find((i) => i.menuItemId === menuItemId)!.id;
const useVoucher = (s: OrderSnapshot, menuItemId: string, number = 1, code = 'AB3C') => {
  h.session = CASHIER;
  return call('orders:applyVoucher', { orderId: s.order.id, number, code, lineId: lineOf(s, menuItemId) });
};
const totals = (s: OrderSnapshot) => ({
  subtotal: s.order.subtotalCents,
  discount: s.order.discountCents,
  tax: s.order.taxCents,
  total: s.order.totalCents,
});
async function batchDetail(id: string): Promise<VoucherBatchDetail> {
  h.session = MANAGER;
  return data<VoucherBatchDetail>('vouchers:getBatch', { id });
}
const stateOf = async (batchId: string, number: number) => (await batchDetail(batchId)).vouchers.find((v) => v.number === number)!;
const receiptRows = (s: OrderSnapshot) =>
  decodeEscPos(renderReceipt(s, { branding: { storeName: 'Test Shop' } })).map((r) => r.text.replace(/\s+/g, ' ').trim());
const count = (sql: string, ...p: unknown[]) => Number((db.prepare(sql).get(...p) as { n: number }).n);
function chainOk(d: Db): boolean {
  const rows = (
    d
      .prepare(
        `SELECT rowid, id, entity_type AS entityType, entity_id AS entityId, action, actor_user_id AS actorUserId,
                before_json AS beforeJson, after_json AS afterJson, ip, created_at AS createdAt,
                prev_hash AS prevHash, row_hash AS rowHash
           FROM audit_log ORDER BY rowid`,
      )
      .all() as unknown as AuditChainRow[]
  ).map((r) => ({ ...r, rowid: Number(r.rowid) }));
  return verifyAuditChain(rows).ok;
}

describe.skipIf(!Sqlite)('Vouchers: adding a client’s vouchers', () => {
  it('the owner adds them as printed: the batch and each voucher, each row synced, one audit row; the chain verifies', async () => {
    const batch = await addAbhi();
    expect(batch).toMatchObject({ name: 'abhi', count: 3, used: 0, onOrder: 0, notUsed: 3, firstNumber: 1, lastNumber: 3, createdByName: 'Test Owner' });
    expect(count(`SELECT COUNT(*) AS n FROM vouchers WHERE batch_id = ? AND deleted_at IS NULL`, batch.id)).toBe(3);
    expect(count(`SELECT COUNT(*) AS n FROM sync_queue WHERE entity_type = 'vouchers'`)).toBe(3);
    expect(count(`SELECT COUNT(*) AS n FROM sync_queue WHERE entity_type = 'voucher_batches' AND entity_id = ?`, batch.id)).toBe(1);
    expect(count(`SELECT COUNT(*) AS n FROM audit_log WHERE entity_type = 'voucher_batches' AND action = 'add_voucher_batch'`)).toBe(1);
    expect(chainOk(db)).toBe(true);
    const detail = await batchDetail(batch.id);
    expect(detail.vouchers.map((v) => [v.number, v.code, v.state])).toEqual([
      [1, 'AB3C', 'not_used'],
      [2, 'XK7P', 'not_used'],
      [3, 'RT9D', 'not_used'],
    ]);
  });

  it('codes are typed any way and stored in capitals; a number twice, a code twice or a code already on a voucher is refused, nothing written', async () => {
    h.session = OWNER;
    const lower = await data<VoucherBatchSummary>('vouchers:addBatch', { ...ABHI, from: 'list', vouchers: [{ number: 9, code: 'ab-cd' }] });
    expect((await batchDetail(lower.id)).vouchers[0]).toMatchObject({ number: 9, code: 'ABCD' });
    h.session = OWNER;
    const before = count(`SELECT COUNT(*) AS n FROM vouchers`);
    expect(await call('vouchers:addBatch', { ...ABHI, from: 'list', vouchers: [{ number: 1, code: 'AAAA' }, { number: 1, code: 'BBBB' }] })).toMatchObject({
      ok: false,
      message: 'Number 001 is on the list twice.',
    });
    expect(await call('vouchers:addBatch', { ...ABHI, from: 'list', vouchers: [{ number: 1, code: 'AAAA' }, { number: 2, code: 'AAAA' }] })).toMatchObject({
      ok: false,
      message: 'The code AAAA is on the list twice: every voucher needs its own code.',
    });
    expect(await call('vouchers:addBatch', { ...ABHI, from: 'list', vouchers: [{ number: 1, code: 'ABCD' }] })).toMatchObject({
      ok: false,
      message: 'This code is already on other vouchers: ABCD (No. 009 of abhi). Every voucher needs its own code.',
    });
    expect(count(`SELECT COUNT(*) AS n FROM vouchers`)).toBe(before);
  });

  it('the till makes codes: as many as asked, numbered on, none already on a voucher', async () => {
    await addAbhi();
    h.session = OWNER;
    const made = await data<VoucherBatchSummary>('vouchers:addBatch', { ...ABHI, name: 'Next client', from: 'make', count: 50, firstNumber: 101 });
    expect(made).toMatchObject({ count: 50, firstNumber: 101, lastNumber: 150, notUsed: 50 });
    const codes = (await batchDetail(made.id)).vouchers.map((v) => v.code);
    expect(new Set(codes).size).toBe(50);
    for (const c of codes) expect(c).toMatch(/^[ACDEFGHJKLMNPQRTUVWXY34679]{4}$/);
    expect(codes.some((c) => LIST.some((l) => l.code === c))).toBe(false);
  });

  it('the page is the owner’s and the managers’; a cashier can only check a voucher at the till', async () => {
    const batch = await addAbhi();
    h.session = CASHIER;
    for (const [channel, payload] of [
      ['vouchers:listBatches', undefined],
      ['vouchers:getBatch', { id: batch.id }],
      ['vouchers:addBatch', { ...ABHI, from: 'make', count: 1, firstNumber: 1 }],
      ['vouchers:updateBatch', { id: batch.id, ...ABHI }],
      ['vouchers:removeBatch', { id: batch.id }],
    ] as const) {
      expect(await call(channel, payload)).toEqual({ ok: false, code: 'forbidden', message: 'Only a manager or the owner can see or add vouchers.' });
    }
    expect(await call('vouchers:check', { number: 1, code: 'ab3c' })).toMatchObject({ ok: true, data: { ok: true, number: 1, code: 'AB3C' } });
    h.session = MANAGER;
    expect((await data<VoucherBatchSummary[]>('vouchers:listBatches')).map((b) => b.name)).toEqual(['abhi']);
  });
});

describe.skipIf(!Sqlite)('Vouchers at the till', () => {
  it('the Large pizza comes off, tax and all: Rs 0 to pay, completed with nothing to pay; the voucher is then used, on that order', async () => {
    const batch = await addAbhi();
    const s = await takeaway(menu.large);
    const r = await useVoucher(s, menu.large);
    expect(r.ok).toBe(true);
    const on = r.ok ? (r.data as OrderSnapshot) : s;
    expect(totals(on)).toEqual({ subtotal: 189_900, discount: 189_900, tax: 0, total: 0 });
    expect(on.discounts).toEqual([
      expect.objectContaining({
        source: 'voucher',
        reason: 'Voucher No. 001 · abhi',
        amountCents: 189_900,
        approvedByUserId: 'u_admin',
        voucher: expect.objectContaining({ number: 1, batchName: 'abhi', lineId: lineOf(s, menu.large) }),
      }),
    ]);
    // On the order, not paid yet.
    expect(await stateOf(batch.id, 1)).toMatchObject({ state: 'on_order', use: { orderNumber: s.order.orderNumber, paidAt: null } });
    // The bill names it (the printer writes the dot as a dash).
    expect(receiptRows(on)).toContainEqual('Voucher No. 001 - abhi - 1,899.00');
    expect(receiptRows(on)).toContainEqual('TOTAL Rs 0.00');

    h.session = CASHIER;
    await data('orders:tender', { orderId: s.order.id, payments: [] });
    const used = await stateOf(batch.id, 1);
    expect(used).toMatchObject({
      state: 'used',
      use: { orderNumber: s.order.orderNumber, item: 'Test Fajita Pizza — Large', amountCents: 189_900, staffName: 'Test Cashier', refunded: false },
      alsoOn: [],
    });
    expect(used.use?.paidAt).not.toBeNull();
    h.session = CASHIER;
    expect(await call('vouchers:listBatches')).toMatchObject({ ok: false, code: 'forbidden' });
    h.session = OWNER;
    expect((await data<VoucherBatchSummary[]>('vouchers:listBatches'))[0]).toMatchObject({ used: 1, onOrder: 0, notUsed: 2 });
    expect(chainOk(db)).toBe(true);
  });

  it('used once, refused on the next order, in words; a wrong code or number is refused too', async () => {
    await addAbhi();
    const first = await takeaway(menu.large);
    await useVoucher(first, menu.large);
    h.session = CASHIER;
    await data('orders:tender', { orderId: first.order.id, payments: [] });

    const next = await takeaway(menu.large);
    const again = await useVoucher(next, menu.large);
    expect(again).toMatchObject({ ok: false });
    expect(again.ok ? '' : again.message).toMatch(/^Voucher No\. 001 was already used: order #\S+ on \d\d\/\d\d\/\d{4} \d\d:\d\d\.$/);
    expect(await useVoucher(next, menu.large, 1, 'XK7P')).toMatchObject({
      ok: false,
      message: 'No voucher No. 001 with the code XK7P. Check the number and the code on the voucher.',
    });
    h.session = CASHIER;
    expect(await data<VoucherCheck>('vouchers:check', { number: 1, code: 'AB3C', orderId: next.order.id })).toMatchObject({ ok: false, problem: 'used' });
    // Nothing came off the second order.
    expect(totals(await snap(next.order.id))).toMatchObject({ discount: 0 });
  });

  it('on another order not paid yet: refused until that order lets it go', async () => {
    const batch = await addAbhi();
    const first = await takeaway(menu.large);
    await useVoucher(first, menu.large);
    const second = await takeaway(menu.large);
    const r = await useVoucher(second, menu.large);
    expect(r.ok ? '' : r.message).toMatch(/^Voucher No\. 001 is on order #\S+ on .+, not paid yet\. Cancel that order or take the voucher off it first\.$/);
    // Taken off the first order: free again, and it goes on the second.
    h.session = CASHIER;
    const off = await data<OrderSnapshot>('orders:clearDiscount', { orderId: first.order.id });
    expect(off.discounts).toEqual([]);
    expect(totals(off).total).toBeGreaterThan(0);
    expect((await stateOf(batch.id, 1)).state).toBe('not_used');
    expect((await useVoucher(second, menu.large)).ok).toBe(true);
    expect(count(`SELECT COUNT(*) AS n FROM audit_log WHERE entity_type = 'order_discounts' AND action = 'clear'`)).toBe(1);
  });

  it('extras are paid as usual: the pizza comes off, the drink is paid with its tax', async () => {
    await addAbhi();
    const s = await takeaway(menu.large, menu.coke);
    const r = await useVoucher(s, menu.large);
    const on = r.ok ? (r.data as OrderSnapshot) : s;
    // Rs 1,899 + Rs 150; off Rs 1,899; 16% on the Rs 150 left = Rs 24.
    expect(totals(on)).toEqual({ subtotal: 204_900, discount: 189_900, tax: 2_400, total: 17_400 });
  });

  it('one of the line’s pizzas, up to what the voucher covers: two on a line, one is free; a dearer pizza, the rest is paid', async () => {
    await addAbhi();
    const two = await takeaway();
    h.session = CASHIER;
    await data('orders:addItem', { orderId: two.order.id, menuItemId: menu.large, quantity: 2 });
    const s2 = await snap(two.order.id);
    const r2 = await useVoucher(s2, menu.large);
    expect(r2.ok && totals(r2.data as OrderSnapshot)).toMatchObject({ subtotal: 379_800, discount: 189_900 });

    const dear = await takeaway(menu.premium);
    const r3 = await useVoucher(dear, menu.premium, 2, 'XK7P');
    expect(r3.ok && totals(r3.data as OrderSnapshot)).toMatchObject({ subtotal: 249_900, discount: 189_900, total: 69_600 });
  });

  it('never off a value deal; one voucher per order', async () => {
    await addAbhi();
    const s = await takeaway(menu.bigTwo, menu.large);
    expect(await useVoucher(s, menu.bigTwo)).toMatchObject({
      ok: false,
      message: 'A voucher can’t come off that line. Pick a food item, not a value deal or the delivery charge.',
    });
    expect((await useVoucher(s, menu.large)).ok).toBe(true);
    expect(await useVoucher(s, menu.large, 2, 'XK7P')).toMatchObject({
      ok: false,
      message: 'This order already has a voucher. One voucher per order: start a new order for the next one.',
    });
    expect(await useVoucher(s, menu.large, 1, 'AB3C')).toMatchObject({ ok: false, message: 'Voucher No. 001 is already on this order.' });
  });

  it('its pizza swapped for another: the voucher follows it; no pizza left, it comes off (never onto the drink) and is free again', async () => {
    const batch = await addAbhi();
    const s = await takeaway(menu.large, menu.coke);
    await useVoucher(s, menu.large);
    h.session = CASHIER;
    await data('orders:addItem', { orderId: s.order.id, menuItemId: menu.premium, quantity: 1 });
    const swapped = await data<OrderSnapshot>('orders:removeItem', { orderId: s.order.id, orderItemId: lineOf(s, menu.large) });
    expect(swapped.discounts).toEqual([expect.objectContaining({ source: 'voucher', amountCents: 189_900, voucher: expect.objectContaining({ lineId: lineOf(swapped, menu.premium) }) })]);
    expect(count(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'voucher_moved'`)).toBe(1);

    // Only the drink left: the voucher comes off — a pizza voucher never pays for the drink.
    const noPizza = await data<OrderSnapshot>('orders:removeItem', { orderId: s.order.id, orderItemId: lineOf(swapped, menu.premium) });
    expect(noPizza.discounts).toEqual([]);
    expect(totals(noPizza)).toEqual({ subtotal: 15_000, discount: 0, tax: 2_400, total: 17_400 });
    expect(count(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'voucher_off_no_item'`)).toBe(1);
    expect((await stateOf(batch.id, 1)).state).toBe('not_used');
  });

  it('cancelled or discarded, the order gives its voucher back; a refunded one keeps it', async () => {
    const batch = await addAbhi();
    // Cancelled (void) by a manager.
    const a = await takeaway(menu.large);
    await useVoucher(a, menu.large);
    const { voidOrder } = await import('../../db/repositories/order-repo.js');
    voidOrder(db as never, { orderId: a.order.id, reason: 'Customer left', approverUserId: 'u_mgr' }, { userId: 'u_mgr', deviceId: DEV });
    expect((await stateOf(batch.id, 1)).state).toBe('not_used');
    // A draft discarded at the till.
    const b = await takeaway(menu.large);
    await useVoucher(b, menu.large);
    h.session = CASHIER;
    await data('orders:discardDraft', { orderId: b.order.id });
    expect((await stateOf(batch.id, 1)).state).toBe('not_used');
    // Used, paid with a drink, then refunded: still used (the pizza was eaten), marked refunded.
    const c = await takeaway(menu.large, menu.coke);
    await useVoucher(c, menu.large);
    h.session = CASHIER;
    await data('orders:tender', { orderId: c.order.id, payments: [{ method: 'cash', amountCents: 17_400, tenderedCents: 17_400 }] });
    const { refundOrder } = await import('../../db/repositories/order-repo.js');
    refundOrder(db as never, { orderId: c.order.id, reason: 'Cold drink', approverUserId: 'u_mgr', foodMade: 'made' }, { userId: 'u_mgr', deviceId: DEV });
    expect(await stateOf(batch.id, 1)).toMatchObject({ state: 'used', use: { refunded: true } });
  });

  it('past its last day: refused', async () => {
    await addAbhi({ goodUntil: '2020-12-31' });
    const s = await takeaway(menu.large);
    expect(await useVoucher(s, menu.large)).toMatchObject({ ok: false, message: 'Voucher No. 001 could be used until 31/12/2020. It has ended.' });
  });

  it('one discount per order: F3 waits for the voucher to come off; the voucher replaces an automatic offer, which comes back when it is taken off', async () => {
    await addAbhi();
    h.session = OWNER;
    const offer: ChannelOffer = {
      id: 'menu10',
      name: 'Test 10% off',
      on: true,
      cameBy: 'any',
      orderTypes: ['takeaway', 'delivery'],
      type: 'percent',
      value: 10,
      minOrderCents: null,
      maxOffCents: null,
      days: [0, 1, 2, 3, 4, 5, 6],
      hours: null,
      startsOn: null,
      endsOn: null,
      oncePerCustomerPerDay: false,
    };
    await data('settings:setBusiness', { key: 'discounts.offers', value: { v: 1, askCameBy: false, offers: [offer] } });
    const s = await takeaway(menu.large, menu.coke);
    expect(s.discounts.map((d) => d.source)).toEqual(['offer']);
    const r = await useVoucher(s, menu.large);
    expect(r.ok && (r.data as OrderSnapshot).discounts.map((d) => d.source)).toEqual(['voucher']);
    expect(count(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'replaced_by_voucher'`)).toBe(1);
    // Another item: the offer stays off while the voucher is on.
    h.session = CASHIER;
    const more = await data<OrderSnapshot>('orders:addItem', { orderId: s.order.id, menuItemId: menu.coke, quantity: 1 });
    expect(more.discounts.map((d) => d.source)).toEqual(['voucher']);
    // F3: refused, in words, before any PIN.
    expect(await call('orders:applyDiscount', { orderId: s.order.id, discountType: 'percent', value: 5 })).toEqual({
      ok: false,
      code: 'precondition_failed',
      message: 'Voucher No. 001 is on this order. Take the voucher off first (the × beside it), then add a discount.',
    });
    // The × takes the voucher off: the offer comes back.
    const off = await data<OrderSnapshot>('orders:clearDiscount', { orderId: s.order.id });
    expect(off.discounts.map((d) => d.source)).toEqual(['offer']);
  });

  it('an order that becomes foodpanda loses its voucher, which is free again; a voucher never goes on one', async () => {
    const batch = await addAbhi();
    const s = await takeaway(menu.large);
    await useVoucher(s, menu.large);
    h.session = CASHIER;
    const fp = await data<{ id: string }>('orders:setMode', { orderId: s.order.id, mode: 'foodpanda' });
    void fp;
    const after = await snap(s.order.id);
    expect(after.discounts.some((d) => d.source === 'voucher')).toBe(false);
    expect((await stateOf(batch.id, 1)).state).toBe('not_used');
    expect(await useVoucher(after, menu.large)).toMatchObject({ ok: false, message: 'A voucher is for the shop’s own orders, not a foodpanda order.' });
  });

  it('a batch is deleted only while none of its vouchers is on an order; its words and cover can change', async () => {
    const batch = await addAbhi();
    const s = await takeaway(menu.large);
    await useVoucher(s, menu.large);
    h.session = OWNER;
    expect(await call('vouchers:removeBatch', { id: batch.id })).toMatchObject({
      ok: false,
      message: 'Some of these vouchers are on orders, so the batch stays. Take them off those orders (or cancel the orders) first.',
    });
    const changed = await data<VoucherBatchSummary>('vouchers:updateBatch', { id: batch.id, ...ABHI, coversCents: 150_000, goodUntil: '2027-06-30' });
    expect(changed).toMatchObject({ coversCents: 150_000, goodUntil: '2027-06-30' });
    // The order it is already on keeps the cover frozen on it.
    h.session = CASHIER;
    const more = await data<OrderSnapshot>('orders:addItem', { orderId: s.order.id, menuItemId: menu.coke, quantity: 1 });
    expect(more.order.discountCents).toBe(189_900);
    await data('orders:clearDiscount', { orderId: s.order.id });
    h.session = OWNER;
    expect(await call('vouchers:removeBatch', { id: batch.id })).toEqual({ ok: true, data: { id: batch.id } });
    expect(count(`SELECT COUNT(*) AS n FROM vouchers WHERE batch_id = ? AND deleted_at IS NULL`, batch.id)).toBe(0);
    expect(await data<VoucherBatchSummary[]>('vouchers:listBatches')).toEqual([]);
    h.session = CASHIER;
    expect(await data<VoucherCheck>('vouchers:check', { number: 1, code: 'AB3C' })).toMatchObject({ ok: false, problem: 'not_found' });
  });
});

describe.skipIf(!Sqlite)('What a voucher is for (Settings → Vouchers, v0.7.50)', () => {
  const LARGE_REGULAR = () => ({ categoryIds: [menu.pizzas], size: 'Large' as const, wholeItem: true });

  it('a Large regular pizza voucher comes off a Large regular pizza only — the whole of it, a dearer one too', async () => {
    await addAbhi({ for: LARGE_REGULAR(), gives: 'One Large pizza from the Regular menu' });
    const s = await takeaway(menu.medium, menu.signature, menu.coke, menu.premium);
    for (const wrong of [menu.medium, menu.signature, menu.coke]) {
      expect(await useVoucher(s, wrong)).toMatchObject({
        ok: false,
        message: 'Voucher No. 001 is for: One Large pizza from the Regular menu. Pick that item, or add it to the order first.',
      });
    }
    // The whole Large at its menu price, though it is dearer than the Rs 1,899 the batch says it covers.
    const r = await useVoucher(s, menu.premium);
    expect(r.ok && (r.data as OrderSnapshot).order.discountCents).toBe(249_900);
    expect(r.ok && (r.data as OrderSnapshot).discounts[0]?.voucher).toMatchObject({ lineId: lineOf(s, menu.premium) });
  });

  it('the till is told which lines a voucher can come off, the dearest first, with what each takes off', async () => {
    await addAbhi({ for: LARGE_REGULAR() });
    const s = await takeaway(menu.medium, menu.large, menu.coke, menu.premium);
    h.session = CASHIER;
    const check = await data<VoucherCheck>('vouchers:check', { number: 1, code: 'AB3C', orderId: s.order.id });
    expect(check).toMatchObject({
      ok: true,
      batch: { for: LARGE_REGULAR(), forCategoryNames: ['Pizza'] },
      lines: [
        { lineId: lineOf(s, menu.premium), amountCents: 249_900 },
        { lineId: lineOf(s, menu.large), amountCents: 189_900 },
      ],
    });
  });

  it('its pizza swapped for a Medium: it moves to the other Large if there is one, else comes off', async () => {
    const batch = await addAbhi({ for: LARGE_REGULAR() });
    const s = await takeaway(menu.large, menu.medium);
    await useVoucher(s, menu.large);
    h.session = CASHIER;
    const off = await data<OrderSnapshot>('orders:removeItem', { orderId: s.order.id, orderItemId: lineOf(s, menu.large) });
    expect(off.discounts).toEqual([]);
    expect((await stateOf(batch.id, 1)).state).toBe('not_used');
  });

  it('changed in Settings: the next order follows it; an order it is already on keeps what it was for', async () => {
    const batch = await addAbhi();
    const s = await takeaway(menu.medium);
    // No rule yet (a batch added before 0.7.50): any food, up to Rs 1,899.
    expect((await useVoucher(s, menu.medium)).ok).toBe(true);
    h.session = OWNER;
    const changed = await data<VoucherBatchSummary>('vouchers:updateBatch', { id: batch.id, ...ABHI, for: LARGE_REGULAR() });
    expect(changed).toMatchObject({ for: LARGE_REGULAR(), forCategoryNames: ['Pizza'] });
    // The order it is on keeps it (frozen); another item added re-works it the old way.
    h.session = CASHIER;
    const more = await data<OrderSnapshot>('orders:addItem', { orderId: s.order.id, menuItemId: menu.coke, quantity: 1 });
    expect(more.discounts[0]).toMatchObject({ source: 'voucher', amountCents: 149_900 });
    // The next voucher of the batch: a Large regular pizza only.
    const next = await takeaway(menu.medium);
    expect(await useVoucher(next, menu.medium, 2, 'XK7P')).toMatchObject({ ok: false });
    // Back to any food (no rule).
    h.session = OWNER;
    expect(await data<VoucherBatchSummary>('vouchers:updateBatch', { id: batch.id, ...ABHI, for: null })).toMatchObject({ for: null, forCategoryNames: [] });
    expect((await useVoucher(next, menu.medium, 2, 'XK7P')).ok).toBe(true);
  });

  it('what it is for travels to the other till with the batch', async () => {
    const batch = await addAbhi({ for: LARGE_REGULAR() });
    const other = openMigrated();
    addUsersAndTill(other, TILL_2);
    // The same menu categories on both tills (they sync too): copy them across first, then the batch.
    const sync = await import('../../db/repositories/sync-repo.js');
    const remote = await import('../../db/repositories/apply-remote.js');
    const pending = sync.listPendingSync(db as never, 10_000);
    expect(await remote.applyRemoteBatch(other as never, pending.map((p) => sync.pendingToChange(p, DEV)), { pause: async () => {} })).toMatchObject({
      waiting: 0,
      dropped: 0,
    });
    const read = await import('../../db/vouchers-read.js');
    expect(read.findVoucherBatch(other as never, batch.id)).toMatchObject({ for: LARGE_REGULAR(), forCategoryNames: ['Pizza'] });
  });
});

describe.skipIf(!Sqlite)('Vouchers in Reports', () => {
  it('a used voucher is listed apart, by its client, never against the cashier; the shift report says Vouchers', async () => {
    await addAbhi();
    const s = await takeaway(menu.large, menu.coke);
    await useVoucher(s, menu.large);
    h.session = CASHIER;
    await data('orders:tender', { orderId: s.order.id, payments: [{ method: 'cash', amountCents: 17_400, tenderedCents: 17_400 }] });
    const br = await import('../../services/business-report.js');
    const team = br.buildTeamTab(db as never, { sinceIso: '2000-01-01T00:00:00.000Z', untilIso: '2100-01-01T00:00:00.000Z' });
    expect(team.discounts.standing).toEqual([{ name: 'Vouchers for abhi', count: 1, amountCents: 189_900 }]);
    expect(team.discounts.byPerson).toEqual([]);
    expect(team.discounts.recent).toEqual([]);
    const { shiftReportDiscountKind } = await import('@cheeseoclock/pos-domain');
    expect(shiftReportDiscountKind(189_900, 'voucher', 'pos')).toBe('voucher');
  });
});

describe.skipIf(!Sqlite)('Vouchers on two tills', () => {
  it('the vouchers and their use travel to the other till, which then refuses it too', async () => {
    const batch = await addAbhi();
    const s = await takeaway(menu.large);
    await useVoucher(s, menu.large);
    h.session = CASHIER;
    await data('orders:tender', { orderId: s.order.id, payments: [] });

    const other = openMigrated();
    addUsersAndTill(other, TILL_2);
    const sync = await import('../../db/repositories/sync-repo.js');
    const remote = await import('../../db/repositories/apply-remote.js');
    const pending = sync.listPendingSync(db as never, 10_000);
    const res = await remote.applyRemoteBatch(other as never, pending.map((p) => sync.pendingToChange(p, DEV)), { pause: async () => {} });
    expect(res).toMatchObject({ waiting: 0, dropped: 0 });

    const read = await import('../../db/vouchers-read.js');
    const there = read.listVouchersOfBatch(other as never, batch.id);
    expect(there.map((v) => [v.number, v.code, v.state])).toEqual([
      [1, 'AB3C', 'used'],
      [2, 'XK7P', 'not_used'],
      [3, 'RT9D', 'not_used'],
    ]);
    expect(read.checkVoucher(other as never, { number: 1, code: 'AB3C' }, '2026-10-12')).toMatchObject({ ok: false, problem: 'used' });
    expect(read.checkVoucher(other as never, { number: 2, code: 'XK7P' }, '2026-10-12')).toMatchObject({ ok: true });
  });
});
