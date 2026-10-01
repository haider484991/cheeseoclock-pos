/**
 * Settings → foodpanda (v0.7.22) meets the owner's "Delete test order"
 * (0043) and the cash drawer log (0042), through the real orders, shifts and
 * reports IPC handlers and the real repositories, on a database built from
 * every migration with the made-up costing shop:
 *
 *   R1 × v0.7.22
 *   - a foodpanda test order the owner deleted is in none of foodpanda's
 *     figures: not the Channels tab's foodpanda block, not "foodpanda orders
 *     to check", not Reports → Profit's foodpanda commission — main thread
 *     and Reports worker alike;
 *   - its terms kept at payment (order_channel_terms) are soft-deleted with
 *     it, through the repository: synced as their row image, audited with
 *     the row as it was, the chain whole; the other till applies them. And
 *     were that row still live somewhere (the other till before the row's
 *     own delete lands), Reports still leave the order out: every reader
 *     joins the table from the ORDER and counts only live orders;
 *   - its foodpanda deal is not under Team & leakage → "Standing offers";
 *   - the delete preview: paid through foodpanda, no cash of any shift, no
 *     drawer touched.
 *   R2 × v0.7.22
 *   - a foodpanda order never opens the drawer and writes no drawer-log row:
 *     paid, collected at pick-up, part refunded or refunded in full — and a
 *     refund screen that asks for its money back in cash is refused in the
 *     main process, nothing written.
 *
 * Only `defineHandler` (captured), the signed-in session, the PIN checks, the
 * printer spooler, the FBR worker and the website's shift pause are stood in
 * for. node:sqlite behind better-sqlite3's shape; skipped where it is
 * missing. Every name, price, percentage and amount is made up.
 */
import { beforeEach, expect, it, vi, describe } from 'vitest';
import type {
  AuthenticatedUser,
  BusinessReportRequest,
  FoodpandaDeal,
  FoodpandaFees,
  Order,
  OrderSnapshot,
  TestDeletePreview,
  UUID,
} from '@cheeseoclock/shared-types';
import type { AppDatabase } from '../../db/connection.js';
import { verifyAuditChain, type AuditChainRow } from '../../db/audit-chain.js';
import { CASHIER, DEV, DatabaseSync, MANAGER, OWNER, openCostingShop, openMigrated, type Line } from '../../db/costing-shop.fixture.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

type Handler = (ctx: unknown, payload: unknown) => unknown;

const h = vi.hoisted(() => ({
  handlers: new Map<string, (ctx: unknown, payload: unknown) => unknown>(),
  session: null as AuthenticatedUser | null,
  spool: [] as Array<{ method: string; args: unknown[] }>,
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
vi.mock('electron-log/main', () => ({ default: { info: () => {}, warn: () => {}, error: () => {} } }));
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  app: { getPath: () => '' },
  safeStorage: { isEncryptionAvailable: () => false },
  Notification: class {
    static isSupported() {
      return false;
    }
  },
}));
vi.mock('../../services/auth-service.js', () => ({
  getCurrentSession: () => h.session,
  verifyManagerPin: async (_db: unknown, pin: string) => {
    if (pin === 'Manager-pass-7') return { approverUserId: 'u_mgr', approverName: 'Test Manager' };
    throw new Error("That is not a manager's PIN or password");
  },
  verifyOwnerSecret: async (_db: unknown, secret: string) => {
    if (secret === 'Owner-pass-9') return { ownerUserId: 'u_admin', ownerName: 'Test Owner' };
    throw new Error("That is not the owner's PIN or password.");
  },
}));
// The spooler records what it was asked and prints nothing: a pulse is only ever asked for a drawer row.
vi.mock('../../services/print-spooler.js', () => ({
  printSpooler: new Proxy(
    {},
    {
      get:
        (_t, method) =>
        (...args: unknown[]) => {
          h.spool.push({ method: String(method), args });
          return method === 'kickDrawerNow' ? Promise.resolve({ ok: true, durationMs: 1 }) : undefined;
        },
    },
  ),
}));
vi.mock('../../services/fbr-worker.js', () => ({ fbrWorker: { kick: () => {}, resetAdapter: () => {} } }));
vi.mock('../../services/web-orders-shift-pause.js', () => ({
  followShiftForWebOrders: () => {},
  closeWouldPauseWebOrders: () => false,
}));

const live = describe.skipIf(!DatabaseSync);
const session = (id: string, fullName: string, role: AuthenticatedUser['role']): AuthenticatedUser => ({
  id: id as UUID,
  fullName,
  role,
  sessionId: `sess_${id}` as UUID,
});
const CASHIER_LOGIN = session(CASHIER.userId, 'Test Cashier', 'cashier');
const MANAGER_LOGIN = session(MANAGER.userId, 'Test Manager', 'manager');
const OWNER_LOGIN = session(OWNER.userId, 'Test Owner', 'admin');
const PIN = 'Manager-pass-7';
const OWNER_SECRET = 'Owner-pass-9';
const ALL_TIME: BusinessReportRequest = { sinceIso: '2000-01-01T00:00:00.000Z', untilIso: '2100-01-01T00:00:00.000Z' };
const FLOAT = 500_000;

/** The owner's made-up foodpanda deal (20% off, the shop pays half) and terms (25% commission, confirmed). */
const DEAL: FoodpandaDeal = { v: 1, percent: 20, shopPercent: 10, minOrderCents: null, maxOffCents: null, startsOn: null, endsOn: null };
const FEES: FoodpandaFees = {
  v: 1,
  commissionBps: 2_500,
  confirmed: true,
  base: 'after_deal',
  fixedFeeCents: 0,
  commissionTaxBps: 0,
  upliftBps: 0,
  paymentFeeBps: 0,
};

let db: ReturnType<typeof openMigrated>;
let shop: Awaited<ReturnType<typeof openCostingShop>>;

async function call<T>(channel: string, payload?: unknown): Promise<T> {
  const fn = h.handlers.get(channel);
  if (!fn) throw new Error(`No handler for ${channel}`);
  const r = (await fn({ db, deviceId: DEV }, payload)) as { ok: boolean; data: T };
  if (!r.ok) throw new Error(`${channel} said no: ${JSON.stringify(r)}`);
  return r.data;
}
async function refusal(channel: string, payload?: unknown): Promise<{ code: string; message: string } | undefined> {
  try {
    const r = (await h.handlers.get(channel)!({ db, deviceId: DEV }, payload)) as { ok: boolean; error?: { code: string; message: string } };
    if (r.ok) throw new Error(`${channel} was not refused`);
    return r.error;
  } catch (e) {
    return (e as { apiError?: { code: string; message: string } }).apiError;
  }
}
const row = <T = Record<string, unknown>>(sql: string, ...p: unknown[]) => db.prepare(sql).get(...p) as T;
const rows = <T = Record<string, unknown>>(sql: string, ...p: unknown[]) => db.prepare(sql).all(...p) as T[];
const count = (sql: string, ...p: unknown[]) => Number((db.prepare(sql).get(...p) as { n: number }).n);
/** The open shift's expected cash in the drawer (shift-repo getShiftSummary). */
async function expectedCash(): Promise<number> {
  const { getShiftSummary } = await import('../../db/repositories/shift-repo.js');
  const shiftId = row<{ id: string }>(`SELECT id FROM shifts WHERE closed_at IS NULL`).id;
  return getShiftSummary(db, shiftId).expectedCashCents;
}

/** Every row the drawer log holds, of any kind. */
const drawerRows = () => rows<{ kind: string; order_id: string | null; amount_cents: number | null }>(`SELECT kind, order_id, amount_cents FROM drawer_opens ORDER BY rowid`);
/** Everything that says money moved or was recorded: business rows, the sync queue, the audit trail. */
const written = () => ({
  payments: count(`SELECT COUNT(*) AS n FROM payments`),
  drawer: count(`SELECT COUNT(*) AS n FROM drawer_opens`),
  sync: count(`SELECT COUNT(*) AS n FROM sync_queue`),
  audit: count(`SELECT COUNT(*) AS n FROM audit_log`),
});
/** The spooler calls about one order's money: what drawer row (if any) each was asked to pulse for. */
const spooled = (orderId: string) =>
  h.spool
    .filter((c) => c.method === 'onOrderEvent' && c.args[0] === orderId)
    .map((c) => ({ event: c.args[1], drawerOpenId: (c.args[2] as { drawerOpenId?: string | null } | undefined)?.drawerOpenId ?? null }));
const auditRows = (d: AppDatabase = db) =>
  d
    .prepare(
      `SELECT rowid, id, entity_type AS entityType, entity_id AS entityId, action,
              actor_user_id AS actorUserId, before_json AS beforeJson, after_json AS afterJson,
              ip, created_at AS createdAt, prev_hash AS prevHash, row_hash AS rowHash
         FROM audit_log ORDER BY rowid`,
    )
    .all() as unknown as AuditChainRow[];

/**
 * A foodpanda order rung at the counter (orders:create — the owner's deal
 * goes on by itself) and paid through foodpanda at Pay (orders:tender: to the
 * kitchen prepaid, the terms kept then), as the cashier.
 */
async function foodpandaSale(lines: Line[], extra: { code?: string | null; tablet?: number | null } = {}): Promise<string> {
  h.session = CASHIER_LOGIN;
  const o = await call<Order>('orders:create', { mode: 'foodpanda' });
  for (const [it, quantity, picks = []] of lines) {
    shop.r.addOrderItem(db, { orderId: o.id, menuItemId: shop.item[it], quantity, modifierIds: picks.map((p) => shop.choice[p]), notes: null }, CASHIER);
  }
  const total = shop.r.findOrder(db, o.id)!.totalCents;
  // Paid at Pay: the order goes to the kitchen prepaid, its stock taken.
  await call<OrderSnapshot>('orders:tender', {
    orderId: o.id,
    payments: [{ method: 'foodpanda', amountCents: total, referenceNo: extra.code ?? null }],
    foodpanda: { tabletTotalCents: extra.tablet ?? null },
  });
  return o.id;
}

/** The owner deletes it as a test (orders:testDeletePreview, then orders:deleteTest with their PIN typed again). */
async function deleteAsOwner(orderId: string, restock: boolean | null): Promise<{ preview: TestDeletePreview; done: { deleteStock: string } }> {
  const was = h.session;
  h.session = OWNER_LOGIN;
  try {
    const preview = await call<TestDeletePreview>('orders:testDeletePreview', { orderId });
    const done = await call<{ deleteStock: string }>('orders:deleteTest', {
      orderId,
      reason: 'Printer test',
      restock,
      ownerSecret: OWNER_SECRET,
      expectStatus: preview.status,
    });
    return { preview, done };
  } finally {
    h.session = was;
  }
}

async function tabs() {
  return import('../../services/analytics/report-tabs.js');
}
/** foodpanda's figures as Reports shows them: the Channels block (with its orders to check), Profit's commission, the Standing offers. */
async function foodpandaFigures() {
  const t = await tabs();
  const channels = t.buildReportTab(db as never, 'channels', ALL_TIME);
  const profit = t.buildReportTab(db as never, 'profit', ALL_TIME);
  const team = t.buildReportTab(db as never, 'team', ALL_TIME);
  return {
    foodpanda: channels.foodpanda,
    commission: profit.steps.find((s) => s.key === 'commission')?.cents ?? 0,
    profitFoodpanda: profit.channels.find((c) => c.channel === 'foodpanda') ?? null,
    discounts: team.discounts,
  };
}
/** The same, as the Reports worker hands them over (its own bundle, the same code). */
async function foodpandaFiguresViaWorker() {
  const worker = await import('../../services/analytics/worker.js');
  const run = (kind: string) => {
    const reply = worker.handleRunRequest(db as never, { type: 'run', id: 1, kind: kind as never, request: ALL_TIME, nowIso: new Date().toISOString() });
    if (reply.type !== 'result' || !reply.ok) throw new Error(`worker said no: ${JSON.stringify(reply)}`);
    return structuredClone(reply.data) as Record<string, unknown>;
  };
  const channels = run('channels') as { foodpanda: unknown };
  const profit = run('profit') as { steps: Array<{ key: string; cents: number }> };
  const team = run('team') as { discounts: unknown };
  return {
    foodpanda: channels.foodpanda,
    commission: profit.steps.find((s) => s.key === 'commission')?.cents ?? 0,
    discounts: team.discounts,
  };
}

beforeEach(async () => {
  if (!DatabaseSync) return;
  h.handlers.clear();
  h.session = null;
  h.spool.length = 0;
  db = openMigrated();
  shop = await openCostingShop(db);
  const { setBusinessSetting } = await import('../../db/repositories/business-settings-repo.js');
  setBusinessSetting(db, 'foodpanda.deal', DEAL, OWNER);
  setBusinessSetting(db, 'foodpanda.fees', FEES, OWNER);
  const ctx = { db, deviceId: DEV } as never;
  (await import('./orders-handlers.js')).registerOrdersHandlers(ctx);
  (await import('./shifts-handlers.js')).registerShiftsHandlers(ctx);
  (await import('./reports-handlers.js')).registerReportsHandlers(ctx);
  h.session = MANAGER_LOGIN;
  await call('shifts:open', { openingCashCents: FLOAT, notes: 'Evening shift' });
});

live('R1 × v0.7.22: a foodpanda test order the owner deleted is in none of foodpanda’s figures', () => {
  it('Channels’ foodpanda block, "foodpanda orders to check", Profit’s commission and the Standing offers: as if it was never rung — main thread and worker', async () => {
    // A real foodpanda order, its number typed at Pay.
    await foodpandaSale([['fajitaM', 1]], { code: 'FP-1001' });
    const realOnly = await foodpandaFigures();
    const realOnlyViaWorker = await foodpandaFiguresViaWorker();
    expect(realOnly.foodpanda).toMatchObject({ orderCount: 1, missingCodeCount: 0 });
    expect(realOnly.commission).toBeLessThan(0);
    expect(realOnly.discounts.standing).toMatchObject([{ name: 'foodpanda deal (set by the owner)', count: 1 }]);

    // A test of Pay: no foodpanda number, a tablet total that does not match — the kind of order the list to check flags.
    const test = await foodpandaSale([['fajitaM', 2]], { code: null, tablet: 1_000 });
    const withTest = await foodpandaFigures();
    // It counted before the delete (so the checks below mean something)…
    expect(withTest.foodpanda).toMatchObject({ orderCount: 2, missingCodeCount: 1, tabletDiffCount: 1 });
    expect(withTest.foodpanda!.toCheck.map((l) => l.orderId)).toContain(test);
    expect(withTest.commission).toBeLessThan(realOnly.commission);
    expect(withTest.profitFoodpanda?.orderCount).toBe(2);
    expect(withTest.discounts.standing).toMatchObject([{ count: 2 }]);
    expect(withTest.discounts.totalCents).toBeGreaterThan(realOnly.discounts.totalCents);

    await deleteAsOwner(test, true);

    // …and after it: every one of foodpanda's figures is the real order's alone, to the paisa.
    expect(await foodpandaFigures()).toEqual(realOnly);
    expect(await foodpandaFiguresViaWorker()).toEqual(realOnlyViaWorker);
  });

  it('its kept terms are soft-deleted with it through the repository: synced as their row image, audited with the row as it was; the chain is whole', async () => {
    const test = await foodpandaSale([['fajitaM', 1]], { code: 'FP-2002' });
    const terms = row<Record<string, unknown>>(`SELECT * FROM order_channel_terms WHERE order_id = ?`, test);
    expect(terms).toMatchObject({ channel: 'foodpanda', deleted_at: null, version: 1 });
    const termsId = String(terms['id']);

    await deleteAsOwner(test, true);

    const after = row<Record<string, unknown>>(`SELECT * FROM order_channel_terms WHERE id = ?`, termsId);
    const deletedAt = row<{ d: string }>(`SELECT deleted_at AS d FROM orders WHERE id = ?`, test).d;
    // Soft-deleted when the order was, its version bumped; nothing else about it changed.
    expect(after).toEqual({ ...terms, deleted_at: deletedAt, updated_at: deletedAt, version: 2 });
    // Synced: its row image, deleted.
    const queued = rows<{ op: string; payload_json: string }>(`SELECT op, payload_json FROM sync_queue WHERE entity_type = 'order_channel_terms' AND entity_id = ? ORDER BY rowid`, termsId);
    expect(queued.map((q) => q.op)).toEqual(['upsert', 'delete']);
    expect(JSON.parse(queued[1]!.payload_json)).toMatchObject({ id: termsId, orderId: test, deletedAt, version: 2 });
    // Audited: the row as it was, by the owner, with the order's own delete row naming it.
    const audit = rows<{ actor: string; b: string; a: string }>(
      `SELECT actor_user_id AS actor, before_json AS b, after_json AS a FROM audit_log WHERE entity_type = 'order_channel_terms' AND entity_id = ? AND action = 'delete_test_order'`,
      termsId,
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actor).toBe(OWNER.userId);
    expect(JSON.parse(audit[0]!.b)).toMatchObject({ id: termsId, order_id: test, commission_cents: terms['commission_cents'], deleted_at: null });
    expect(JSON.parse(audit[0]!.a)).toEqual({ deletedAt });
    const orderAudit = row<{ a: string }>(`SELECT after_json AS a FROM audit_log WHERE entity_type = 'orders' AND entity_id = ? AND action = 'delete_test_order'`, test);
    expect(JSON.parse(orderAudit.a)).toMatchObject({ channelTermsIds: [termsId] });
    // An order that kept no terms (not foodpanda) names none.
    h.session = CASHIER_LOGIN;
    const takeaway = shop.ring([['bakedWings', 1]]);
    const total = shop.r.findOrder(db, takeaway)!.totalCents;
    await call('orders:tender', { orderId: takeaway, payments: [{ method: 'card', amountCents: total }] });
    await deleteAsOwner(takeaway, true);
    const takeawayAudit = row<{ a: string }>(`SELECT after_json AS a FROM audit_log WHERE entity_type = 'orders' AND entity_id = ? AND action = 'delete_test_order'`, takeaway);
    expect(JSON.parse(takeawayAudit.a)).toMatchObject({ channelTermsIds: [] });
    expect(verifyAuditChain(auditRows()).ok).toBe(true);
  });

  it('and were its terms row still live (the other till, before the row’s own delete lands), Reports still leave the order out', async () => {
    await foodpandaSale([['fajitaM', 1]], { code: 'FP-3003' });
    const realOnly = await foodpandaFigures();
    const test = await foodpandaSale([['fajitaM', 1]], { code: null });
    await deleteAsOwner(test, true);
    // The order is deleted; its terms row as a till would hold it before the row's delete arrived.
    db.prepare(`UPDATE order_channel_terms SET deleted_at = NULL WHERE order_id = ?`).run(test);
    expect(await foodpandaFigures()).toEqual(realOnly);
  });

  it('the other till applies the delete: the order, its payment and its terms all deleted there, and its Reports leave it out', async () => {
    const { listPendingSync, pendingToChange, markSyncedIds } = await import('../../db/repositories/sync-repo.js');
    const { applyRemoteBatch } = await import('../../db/repositories/apply-remote.js');
    const { getFoodpanda } = await import('../../services/business-report.js');
    const TILL_2 = 'till-2';
    const db2 = openMigrated();
    const user = db2.prepare(`INSERT INTO users (id, full_name, pin_hash, role, created_at, updated_at, device_id) VALUES (?, ?, 'x', ?, 'x', 'x', ?)`);
    user.run(CASHIER.userId, 'Test Cashier', 'cashier', DEV);
    user.run(MANAGER.userId, 'Test Manager', 'manager', DEV);
    user.run(OWNER.userId, 'Test Owner', 'admin', DEV);
    const iAm = (d: AppDatabase, id: string) =>
      d.prepare(`INSERT INTO device_info (id, device_id, display_name, registered_at) VALUES ('singleton', ?, ?, ?)`).run(id, `Test ${id}`, new Date().toISOString());
    iAm(db, DEV);
    iAm(db2, TILL_2);
    const push = async () => {
      const pending = listPendingSync(db, 1_000_000);
      const r = await applyRemoteBatch(db2, pending.map((p) => pendingToChange(p, DEV)), { pause: async () => {} });
      markSyncedIds(db, pending.map((p) => p.id));
      expect(r.waiting).toBe(0);
    };

    const test = await foodpandaSale([['fajitaM', 1]], { code: 'FP-4004' });
    await push();
    const live2 = (sql: string) => Number((db2.prepare(sql).get(test) as { n: number }).n);
    expect(live2(`SELECT COUNT(*) AS n FROM order_channel_terms WHERE order_id = ? AND deleted_at IS NULL`)).toBe(1);
    expect(getFoodpanda(db2, ALL_TIME)).toMatchObject({ orderCount: 1 });

    await deleteAsOwner(test, true);
    await push();
    expect(live2(`SELECT COUNT(*) AS n FROM orders WHERE id = ? AND deleted_at IS NULL`)).toBe(0);
    expect(live2(`SELECT COUNT(*) AS n FROM payments WHERE order_id = ? AND deleted_at IS NULL`)).toBe(0);
    expect(live2(`SELECT COUNT(*) AS n FROM order_channel_terms WHERE order_id = ? AND deleted_at IS NULL`)).toBe(0);
    expect(live2(`SELECT COUNT(*) AS n FROM order_channel_terms WHERE order_id = ? AND deleted_at IS NOT NULL`)).toBe(1);
    expect(getFoodpanda(db2, ALL_TIME)).toBeNull();
    expect(verifyAuditChain(auditRows(db2)).ok).toBe(true);
  });

  it('the delete preview: paid through foodpanda, no cash of any shift; the delete leaves the drawer and the shift’s expected cash alone', async () => {
    const test = await foodpandaSale([['fajitaM', 1]], { code: 'FP-5005' });
    const total = shop.r.findOrder(db, test)!.totalCents;
    expect(await expectedCash()).toBe(FLOAT);
    const drawerBefore = drawerRows();
    const spoolBefore = h.spool.length;

    const { preview } = await deleteAsOwner(test, true);
    expect(preview).toMatchObject({
      orderId: test,
      mode: 'foodpanda',
      totalCents: total,
      paid: [{ method: 'foodpanda', netCents: total }],
      cash: [],
      refusal: null,
      web: false,
    });
    // The order is gone; the drawer was never asked to open, and the shift's cash never moved.
    expect(shop.r.findOrder(db, test)).toBeNull();
    expect(drawerRows()).toEqual(drawerBefore);
    expect(h.spool.slice(spoolBefore).filter((c) => c.method === 'kickDrawerNow' || c.method === 'openDrawer')).toEqual([]);
    expect(await expectedCash()).toBe(FLOAT);
  });
});

live('R2: a cash sale at Pay hands its drawer row to the spooler (the merged orders:tender)', () => {
  it('one "sale" row for the order, and the spooler is asked to pulse for exactly that row', async () => {
    h.session = CASHIER_LOGIN;
    const o = await call<Order>('orders:create', { mode: 'takeaway' });
    shop.r.addOrderItem(db, { orderId: o.id, menuItemId: shop.item.bakedWings, quantity: 1, modifierIds: [], notes: null }, CASHIER);
    const total = shop.r.findOrder(db, o.id)!.totalCents;
    await call<OrderSnapshot>('orders:tender', { orderId: o.id, payments: [{ method: 'cash', amountCents: total, tenderedCents: total }] });

    const sale = rows<{ id: string }>(`SELECT id FROM drawer_opens WHERE order_id = ? AND kind = 'sale'`, o.id);
    expect(sale).toHaveLength(1);
    // Without the row id the spooler never pulses: cash sales would stop opening the drawer.
    expect(spooled(o.id)).toEqual([{ event: 'paid', drawerOpenId: sale[0]!.id }]);
  });
});

live('R2 × v0.7.22: a foodpanda order never opens the drawer and writes no drawer-log row', () => {
  it('paid at Pay: no drawer row, the spooler asked for no pulse; a cash leg on it is refused and writes nothing', async () => {
    const before = drawerRows();
    const o = await foodpandaSale([['fajitaM', 1]], { code: 'FP-6006' });
    expect(drawerRows()).toEqual(before);
    expect(spooled(o)).toEqual([{ event: 'paid', drawerOpenId: null }]);

    // Pay with cash in it: refused in the main process, nothing written (no payment, no drawer row, no sync, no audit).
    h.session = CASHIER_LOGIN;
    const other = await call<Order>('orders:create', { mode: 'foodpanda' });
    shop.r.addOrderItem(db, { orderId: other.id, menuItemId: shop.item.bakedWings, quantity: 1, modifierIds: [], notes: null }, CASHIER);
    const total = shop.r.findOrder(db, other.id)!.totalCents;
    const was = written();
    expect(
      await refusal('orders:tender', {
        orderId: other.id,
        payments: [{ method: 'cash', amountCents: total, tenderedCents: total }],
      }),
    ).toEqual({ code: 'precondition_failed', message: 'Foodpanda orders are paid through Foodpanda — choose Foodpanda as the method' });
    expect(written()).toEqual(was);
    expect(spooled(other.id)).toEqual([]);
  });

  it('never collected later: an unpaid foodpanda order can’t go to the kitchen, so its money only ever comes in at Pay', async () => {
    h.session = CASHIER_LOGIN;
    const o = await call<Order>('orders:create', { mode: 'foodpanda' });
    shop.r.addOrderItem(db, { orderId: o.id, menuItemId: shop.item.bakedWings, quantity: 1, modifierIds: [], notes: null }, CASHIER);
    const was = written();
    expect(await refusal('orders:sendToKitchen', { orderId: o.id })).toEqual({
      code: 'precondition_failed',
      message: 'Foodpanda orders are paid and sent in one step — use Pay (F1)',
    });
    expect(written()).toEqual(was);
  });

  it('refunded: a part refund and the rest go back through foodpanda — no drawer row, no pulse; asked back in cash, refused and nothing written', async () => {
    const o = await foodpandaSale([['fajitaM', 2]], { code: 'FP-7007' });
    const total = shop.r.findOrder(db, o)!.totalCents;
    const before = drawerRows();
    h.spool.length = 0;
    h.session = CASHIER_LOGIN;

    // The refund screen offers foodpanda only; a caller that asks for cash is refused by the main process.
    const was = written();
    expect(await refusal('orders:refund', { orderId: o, reason: 'Cold pizza', approverPin: PIN, amountCents: 20_000, method: 'cash' })).toEqual({
      code: 'precondition_failed',
      message: 'Foodpanda orders are refunded through Foodpanda, never from the drawer — choose Foodpanda as the method',
    });
    expect(written()).toEqual(was);
    expect(drawerRows()).toEqual(before);
    expect(spooled(o)).toEqual([]);

    // A part refund, the method left to the till: foodpanda's.
    await call('orders:refund', { orderId: o, reason: 'Cold pizza', approverPin: PIN, amountCents: 20_000 });
    // The rest, in full.
    await call('orders:refund', { orderId: o, reason: 'Wrong order', approverPin: PIN, foodMade: 'made', expectStatus: 'sent_to_kitchen' });
    expect(rows<{ method: string; amount_cents: number }>(`SELECT method, amount_cents FROM payments WHERE order_id = ? ORDER BY rowid`, o)).toEqual([
      { method: 'foodpanda', amount_cents: total },
      { method: 'foodpanda', amount_cents: -20_000 },
      { method: 'foodpanda', amount_cents: -(total - 20_000) },
    ]);
    expect(drawerRows()).toEqual(before);
    // The spooler was asked for no pulse: each refund's paper, and the kitchen's CANCELLED slip.
    expect(spooled(o)).toEqual([
      { event: 'refunded', drawerOpenId: null },
      { event: 'refunded', drawerOpenId: null },
      { event: 'cancelled', drawerOpenId: null },
    ]);
    expect(await expectedCash()).toBe(FLOAT);
    // And a takeaway order is never refunded "through foodpanda".
    const takeaway = shop.ring([['bakedWings', 1]]);
    const t = shop.r.findOrder(db, takeaway)!.totalCents;
    await call('orders:tender', { orderId: takeaway, payments: [{ method: 'card', amountCents: t }] });
    expect(await refusal('orders:refund', { orderId: takeaway, reason: 'Test', approverPin: PIN, amountCents: 1_000, method: 'foodpanda' })).toEqual({
      code: 'precondition_failed',
      message: 'Foodpanda is only for foodpanda orders',
    });
  });

  it('the owner’s drawer log for the period: the float alone — no foodpanda order in it', async () => {
    await foodpandaSale([['fajitaM', 1]], { code: 'FP-8008' });
    h.session = OWNER_LOGIN;
    const log = await call<{ rows: Array<{ kind: string; orderNumber: string | null }>; counts: { total: number } }>('reports:drawerLog', {
      sinceIso: ALL_TIME.sinceIso,
      untilIso: ALL_TIME.untilIso,
    });
    expect(log.rows.map((r) => r.kind)).toEqual(['float']);
    expect(log.counts.total).toBe(1);
  });
});
