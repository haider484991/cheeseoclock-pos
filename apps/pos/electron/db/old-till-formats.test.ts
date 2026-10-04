/**
 * Both tills are updated the same day, but for a while one may still be
 * v0.7.29. What that till (its own schemas, frozen in
 * old-till-v0729.fixture.ts) makes of the two shop rules this version writes
 * in format 2 — 'discounts.approval' (reasonRequired) and 'foodpanda.checks'
 * (tabletToleranceCents) — and what this version makes of the format-1
 * values it saves. Every value is made up.
 *
 * And a till still on v0.7.33 (0001..0046: no cash_movements.order_id) when
 * this version pays an outside rider from the drawer (migration 0049): the
 * payout's image, orderId and all, is written there as a plain payout —
 * nothing left waiting — and that till's own expected-cash maths (v0.7.33's,
 * frozen below) gives the number this till gives. node's own `node:sqlite`
 * stands in for better-sqlite3 there; skipped where it is missing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BUSINESS_SETTING_READ_SCHEMAS, BUSINESS_SETTING_SCHEMAS, storedFormatIsNewer } from '@cheeseoclock/shared-schemas';
import { DEFAULT_DISCOUNT_APPROVAL, DEFAULT_FOODPANDA_CHECKS, SHOP_SETTING_FORMAT } from '@cheeseoclock/shared-types';
import type { AppDatabase } from './connection.js';
import { DatabaseSync, openMigrated } from './costing-shop.fixture.js';
import { TEST_USERS, iAm, openTill } from './two-tills.fixture.js';
import * as OLD from './old-till-v0729.fixture.js';

vi.mock('electron-log/main', () => ({ default: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } }));
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
vi.mock('../services/print-spooler.js', () => ({
  printSpooler: new Proxy({}, { get: () => () => undefined }),
  drawerFailureText: () => '',
}));
vi.mock('../services/fbr-worker.js', () => ({ fbrWorker: { kick: () => {}, resetAdapter: () => {} } }));
vi.mock('../services/order-alerts-hub.js', () => ({ orderAlerts: { orderReceived: () => {}, importFailed: () => {} } }));

type Key = 'discounts.approval' | 'foodpanda.checks';
const WRITTEN_HERE: ReadonlyArray<readonly [Key, Record<string, unknown>]> = [
  ['discounts.approval', { v: 2, percentOver: 10, flatOverCents: 50_000, reasonRequired: true }],
  ['discounts.approval', { ...DEFAULT_DISCOUNT_APPROVAL }],
  ['foodpanda.checks', { v: 2, orderCode: 'required', tabletTotal: 'optional', tabletToleranceCents: 0 }],
  ['foodpanda.checks', { ...DEFAULT_FOODPANDA_CHECKS }],
];

describe('a v0.7.29 till and the values this version writes', () => {
  it('the frozen code is v0.7.29’s format (1 for both), and this version writes format 2', () => {
    expect(OLD.SHOP_SETTING_FORMAT).toEqual({ 'foodpanda.checks': 1, 'discounts.approval': 1 });
    expect([SHOP_SETTING_FORMAT['discounts.approval'], SHOP_SETTING_FORMAT['foodpanda.checks']]).toEqual([2, 2]);
  });

  for (const [key, value] of WRITTEN_HERE) {
    it(`${key} ${JSON.stringify(value)}: written here; the old till reads what it knows, shows it read-only and never saves over it`, () => {
      // This version takes it as written.
      expect(BUSINESS_SETTING_SCHEMAS[key].safeParse(value).success).toBe(true);
      // The old till reads the fields it knows (the new one dropped)…
      const read = OLD.BUSINESS_SETTING_READ_SCHEMAS[key].safeParse(value);
      const known = { ...value };
      delete known['reasonRequired'];
      delete known['tabletToleranceCents'];
      expect(read).toEqual({ success: true, data: known });
      // …shows the card read-only (a newer format)…
      expect(OLD.storedFormatIsNewer(key, value)).toBe(true);
      // …and its own write schema refuses a format-2 value: it cannot save over it and drop the new field.
      expect(OLD.BUSINESS_SETTING_SCHEMAS[key].safeParse(value).success).toBe(false);
    });
  }

  it('the other way: what the old till saves (format 1) reads here with today’s behaviour — a reason optional, Rs 1 — and is not "newer"', () => {
    const oldApproval = { v: 1, percentOver: 10, flatOverCents: 50_000 };
    const oldChecks = { v: 1, orderCode: 'optional', tabletTotal: 'optional' };
    expect(OLD.BUSINESS_SETTING_SCHEMAS['discounts.approval'].safeParse(oldApproval).success).toBe(true);
    expect(OLD.BUSINESS_SETTING_SCHEMAS['foodpanda.checks'].safeParse(oldChecks).success).toBe(true);
    expect(BUSINESS_SETTING_READ_SCHEMAS['discounts.approval'].safeParse(oldApproval)).toMatchObject({ success: true, data: { reasonRequired: false } });
    expect(BUSINESS_SETTING_READ_SCHEMAS['foodpanda.checks'].safeParse(oldChecks)).toMatchObject({ success: true, data: { tabletToleranceCents: 100 } });
    expect(storedFormatIsNewer('discounts.approval', oldApproval)).toBe(false);
    expect(storedFormatIsNewer('foodpanda.checks', oldChecks)).toBe(false);
  });
});

describe('the two keys of the menu files from the costing PC (v0.7.32)', () => {
  const marker = {
    v: 1,
    packageId: '0b8f6c8e-8f8a-4c8a-9d2e-1c6a7d2b9e10',
    seq: 4,
    sha256: 'a'.repeat(64),
    fileName: 'test-menu.json',
    appliedByDevice: 'till-1',
    appliedAt: '2026-09-29T09:00:00.000Z',
    automatic: true,
    counts: { newItems: 3, updatedItems: 5 },
  };

  it('menu.lastPackage: written strictly; a newer till’s marker (a higher format, a field this one does not know) still reads — never as "none"', () => {
    expect(BUSINESS_SETTING_SCHEMAS['menu.lastPackage'].safeParse(marker).success).toBe(true);
    expect(BUSINESS_SETTING_SCHEMAS['menu.lastPackage'].safeParse({ ...marker, fromTheFuture: 1 }).success).toBe(false);
    expect(BUSINESS_SETTING_SCHEMAS['menu.lastPackage'].safeParse({ ...marker, v: 2 }).success).toBe(false);
    const newer = BUSINESS_SETTING_READ_SCHEMAS['menu.lastPackage'].safeParse({ ...marker, v: 2, fromTheFuture: { x: 1 } });
    expect(newer).toMatchObject({ success: true, data: { v: 2, packageId: marker.packageId, seq: 4, appliedByDevice: 'till-1' } });
    // The counts are numbers only; a count it does not know is dropped, a missing one is 0.
    expect(newer.success && newer.data.counts).toEqual({
      newItems: 3,
      updatedItems: 5,
      priceChanges: 0,
      newIngredients: 0,
      updatedIngredients: 0,
      newCategories: 0,
      recipesSet: 0,
      choiceGroupsChanged: 0,
      batchRecipesSet: 0,
      skipped: 0,
    });
    // Not a shop rule: never "newer" for a card.
    expect(storedFormatIsNewer('menu.lastPackage', { ...marker, v: 2 })).toBe(false);
  });

  it('menu.autoUpdate: format 1 as written here; a newer till’s value reads what it knows and shows the card read-only', () => {
    expect(SHOP_SETTING_FORMAT['menu.autoUpdate']).toBe(1);
    expect(BUSINESS_SETTING_SCHEMAS['menu.autoUpdate'].safeParse({ v: 1, mode: 'ask' }).success).toBe(true);
    expect(BUSINESS_SETTING_READ_SCHEMAS['menu.autoUpdate'].safeParse({ v: 2, mode: 'ask', later: true })).toEqual({ success: true, data: { v: 2, mode: 'ask' } });
    expect(storedFormatIsNewer('menu.autoUpdate', { v: 2, mode: 'ask' })).toBe(true);
    expect(storedFormatIsNewer('menu.autoUpdate', { v: 1, mode: 'ask', later: true })).toBe(true);
    expect(storedFormatIsNewer('menu.autoUpdate', { v: 1, mode: 'auto' })).toBe(false);
  });
});

// ---- a v0.7.33 till and an outside rider's payouts (migration 0049) --------

const live = describe.skipIf(!DatabaseSync);

type Row = Record<string, unknown>;

/**
 * FROZEN: a v0.7.33 till's expected cash for a shift (release v0.7.33,
 * shift-repo.ts getShiftSummary and cashMovementTotals): opening + cash
 * sales − cash refunds + pay-ins − every payout and tip-out. Never edited to
 * follow this version.
 */
function expectedCashV0733(db: AppDatabase, shiftId: string): number {
  const shift = db.prepare(`SELECT opening_cash_cents FROM shifts WHERE id = ?`).get(shiftId) as { opening_cash_cents: number };
  const cash = db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN p.amount_cents > 0 THEN p.amount_cents ELSE 0 END), 0) AS sales,
              COALESCE(SUM(CASE WHEN p.amount_cents < 0 THEN -p.amount_cents ELSE 0 END), 0) AS refunds
         FROM payments p
         JOIN orders o ON o.id = p.order_id
        WHERE COALESCE(p.shift_id, o.shift_id) = ? AND p.deleted_at IS NULL AND o.deleted_at IS NULL AND p.method = 'cash'`,
    )
    .get(shiftId) as { sales: number; refunds: number };
  const moves = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN type = 'payin' THEN amount_cents ELSE 0 END), 0) AS inCents,
         COALESCE(SUM(CASE WHEN type IN ('payout', 'tip_out') THEN amount_cents ELSE 0 END), 0) AS outCents
        FROM cash_movements WHERE shift_id = ? AND deleted_at IS NULL`,
    )
    .get(shiftId) as { inCents: number; outCents: number };
  return Number(shift.opening_cash_cents) + Number(cash.sales) - Number(cash.refunds) + Number(moves.inCents) - Number(moves.outCents);
}

live('a v0.7.33 till and the payouts to an outside rider', () => {
  const TILL_A = 'till-a';
  const TILL_B = 'till-b';
  const CASHIER = { userId: 'u_cash', deviceId: TILL_A };
  const MANAGER = { userId: 'u_mgr', deviceId: TILL_A };
  /** Till A's float, and till B's. */
  const FLOAT_A = 500_000;
  const FLOAT_B = 300_000;
  /** The area's delivery charge as sold: what the outside rider keeps. */
  const KEEP = 20_000;
  const at = (iso: string) => vi.setSystemTime(new Date(iso));

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a payout image with orderId on a cash_movements without order_id: a plain payout, nothing waiting, and that till’s expected-cash maths gives the same number', async () => {
    const r = await import('./repositories/order-repo.js');
    const c = await import('./repositories/customer-repo.js');
    const { createTaxCategory } = await import('./repositories/tax-category-repo.js');
    const { createCategory } = await import('./repositories/category-repo.js');
    const { createMenuItem } = await import('./repositories/menu-item-repo.js');
    const { getShiftSummary, openShift } = await import('./repositories/shift-repo.js');
    const sync = await import('./repositories/sync-repo.js');
    const { applyRemoteBatch } = await import('./repositories/apply-remote.js');

    // Till A, this version: a 15% tax, a Rs 3,900 pizza, the area's Rs 200 charge, a shift on a Rs 5,000 float.
    at('2026-10-02T13:00:00.000Z');
    const a = openTill(TILL_A);
    const tax = createTaxCategory(a, { name: 'Test GST', rateBps: 1_500 }, MANAGER);
    const food = createCategory(a, { name: 'Test Pizzas', displayOrder: 1, colorHex: '#aa5500' }, MANAGER);
    const fees = createCategory(a, { name: 'Delivery Charges', displayOrder: 2, colorHex: '#555555' }, MANAGER);
    const pizza = createMenuItem(a, { categoryId: food.id, name: 'Test Family Pizza', basePriceCents: 390_000, taxCategoryId: tax.id }, MANAGER).id;
    const charge = createMenuItem(a, { categoryId: fees.id, name: 'Delivery Charge (Rs 200)', basePriceCents: KEEP, taxCategoryId: tax.id }, MANAGER).id;
    const shiftA = openShift(a, { openingCashCents: FLOAT_A }, MANAGER).id;
    const delivery = (startedAt: string) => {
      at(startedAt);
      const o = r.createOrder(a, { mode: 'delivery' }, CASHIER);
      r.addOrderItem(a, { orderId: o.id, menuItemId: pizza, quantity: 1, modifierIds: [] }, CASHIER);
      r.addOrderItem(a, { orderId: o.id, menuItemId: charge, quantity: 1, modifierIds: [] }, CASHIER);
      return o.id;
    };

    // (1) Prepaid by card at the counter, sent out: the drawer pays the rider his Rs 200 — the kept payout.
    const prepaid = delivery('2026-10-02T14:00:00.000Z');
    const customer = c.createCustomer(a, { name: 'Test Customer', phone: '03001234567' }, CASHIER);
    const address = c.createAddress(a, { customerId: customer.id, addressLine: 'House 1, Test Street', area: 'Test Block' }, CASHIER);
    c.snapshotCustomerOntoOrder(a, { orderId: prepaid, customerId: customer.id, addressId: address.id }, CASHIER);
    const total = r.findOrder(a, prepaid)!.totalCents as number;
    r.tenderOrder(a, { orderId: prepaid, payments: [{ method: 'card', amountCents: total, tenderedCents: null }] }, CASHIER);
    at('2026-10-02T14:45:00.000Z');
    r.markOrderReady(a, prepaid, CASHIER);
    at('2026-10-02T14:50:00.000Z');
    expect(r.sendOutOrder(a, prepaid, CASHIER).riderKeepsCents).toBe(KEEP);

    // (2) Sent out unpaid, cancelled at the door: the rider is paid for his trip — the trip payout.
    const wasted = delivery('2026-10-02T14:10:00.000Z');
    r.sendOrderToKitchen(a, wasted, CASHIER);
    at('2026-10-02T14:55:00.000Z');
    r.markOrderReady(a, wasted, CASHIER);
    r.sendOutOrder(a, wasted, CASHIER);
    at('2026-10-02T15:05:00.000Z');
    r.voidOrder(a, { orderId: wasted, reason: 'Customer refused at the door', approverUserId: MANAGER.userId, payRiderForTrip: true }, CASHIER);

    const linked = a.prepare(`SELECT * FROM cash_movements WHERE order_id IS NOT NULL ORDER BY created_at, id`).all() as Row[];
    expect(linked.map((m) => [m['order_id'], m['type'], m['amount_cents'], m['shift_id']])).toEqual([
      [prepaid, 'payout', KEEP, shiftA],
      [wasted, 'payout', KEEP, shiftA],
    ]);
    const aSummary = getShiftSummary(a, shiftA);
    expect(aSummary).toMatchObject({ cashSalesCents: 0, cashOutCents: 2 * KEEP, riderChargesCents: 2 * KEEP, riderChargeCount: 2 });
    expect(aSummary.expectedCashCents).toBe(FLOAT_A - 2 * KEEP);

    // Till B on v0.7.33: 0001..0046, the same made-up users, its own shift with a payout typed by hand.
    const b = openMigrated({ stopBefore: '0047' }) as unknown as AppDatabase;
    expect((b.prepare(`PRAGMA table_info(cash_movements)`).all() as Row[]).map((col) => col['name'])).not.toContain('order_id');
    const user = b.prepare(`INSERT INTO users (id, full_name, pin_hash, role, created_at, updated_at, device_id) VALUES (?, ?, 'x', ?, 'x', 'x', ?)`);
    for (const u of Object.values(TEST_USERS)) user.run(u.userId, u.name, u.role, TILL_A);
    iAm(b, TILL_B);
    const T = '2026-10-02T13:00:00.000Z';
    b.prepare(
      `INSERT INTO shifts (id, device_id, opened_by_user_id, opened_at, opening_cash_cents, created_at, updated_at) VALUES ('s_b', ?, 'u_mgr', ?, ?, ?, ?)`,
    ).run(TILL_B, T, FLOAT_B, T, T);
    b.prepare(
      `INSERT INTO cash_movements (id, shift_id, type, amount_cents, reason, user_id, created_at, updated_at, device_id)
       VALUES ('m_b_gas', 's_b', 'payout', 10000, 'Test gas cylinder', 'u_mgr', ?, ?, ?)`,
    ).run(T, T, TILL_B);
    const bOwn = expectedCashV0733(b, 's_b');
    expect(bOwn).toBe(FLOAT_B - 10_000);

    // A's shift and its cash movements reach B as the link sends them: each payout's image carries orderId.
    const pending = sync.listPendingSync(a, 1_000_000).filter((p) => p.entityType === 'shifts' || p.entityType === 'cash_movements');
    const changes = pending.map((p) => sync.pendingToChange(p, TILL_A));
    expect(changes.filter((ch) => ch.entityType === 'cash_movements').map((ch) => (ch.payload as Row)['orderId'])).toEqual([prepaid, wasted]);
    at('2026-10-02T15:10:00.000Z');
    const res = await applyRemoteBatch(b, changes, { pause: async () => {} });

    // Written, nothing waiting for a later pull.
    expect(res).toMatchObject({ applied: changes.length, waiting: 0, dropped: 0 });
    expect(sync.readParked(b)).toEqual([]);
    // Each a plain payout there: every column B has, as A has it.
    for (const m of linked) {
      const { order_id: _orderId, ...asOnB } = m;
      expect(b.prepare(`SELECT * FROM cash_movements WHERE id = ?`).get(String(m['id']))).toEqual(asOnB);
    }
    // B's maths for A's shift gives A's number (the riders' payouts are cash taken out, as they are on A)…
    expect(expectedCashV0733(b, shiftA)).toBe(aSummary.expectedCashCents);
    expect(expectedCashV0733(a, shiftA)).toBe(aSummary.expectedCashCents);
    // …and B's own shift is as it was.
    expect(expectedCashV0733(b, 's_b')).toBe(bOwn);
  });
});

describe('v0.7.37: the website offer ‘discounts.websitePickup’ in format 2 (alsoDelivery)', () => {
  it('this version writes format 2 with alsoDelivery, and nothing else', () => {
    expect(SHOP_SETTING_FORMAT['discounts.websitePickup']).toBe(2);
    const write = BUSINESS_SETTING_SCHEMAS['discounts.websitePickup'];
    expect(write.safeParse({ v: 2, offered: true, percent: 10, alsoDelivery: true }).success).toBe(true);
    // A format-1 value (a v0.7.36 till's) is not what this version writes; nor a value missing the field.
    expect(write.safeParse({ v: 1, offered: true, percent: 10 }).success).toBe(false);
    expect(write.safeParse({ v: 2, offered: true, percent: 10 }).success).toBe(false);
    expect(write.safeParse({ v: 2, offered: true, percent: 10, alsoDelivery: 'yes' }).success).toBe(false);
  });

  it('a format-1 value (saved by a v0.7.36 till) reads with alsoDelivery false: deliveries pay full price, as before', () => {
    const read = BUSINESS_SETTING_READ_SCHEMAS['discounts.websitePickup'];
    expect(read.parse({ v: 1, offered: false, percent: 15 })).toEqual({ v: 1, offered: false, percent: 15, alsoDelivery: false });
    // An unreadable field falls back alone, never taking the % down with it.
    expect(read.parse({ v: 2, offered: true, percent: 10, alsoDelivery: 'nonsense' })).toEqual({ v: 2, offered: true, percent: 10, alsoDelivery: false });
    expect(read.parse({ v: 2, offered: true, percent: 10, alsoDelivery: true })).toMatchObject({ alsoDelivery: true });
  });

  it('format 2 is this version’s own (the card stays editable); a higher format or an unknown field reads as newer', () => {
    // A v0.7.36 till runs the same check with format 1 and fields v/offered/percent: this version's
    // value is newer to it, so its card is read-only there and it never saves over the tick box.
    expect(storedFormatIsNewer('discounts.websitePickup', { v: 2, offered: true, percent: 10, alsoDelivery: true })).toBe(false);
    expect(storedFormatIsNewer('discounts.websitePickup', { v: 3, offered: true, percent: 10, alsoDelivery: true })).toBe(true);
    expect(storedFormatIsNewer('discounts.websitePickup', { v: 2, offered: true, percent: 10, alsoDelivery: true, extra: 1 })).toBe(true);
  });
});
