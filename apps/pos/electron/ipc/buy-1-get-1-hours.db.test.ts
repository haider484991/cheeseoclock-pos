/**
 * Buy 1 Get 1 deals are sold from 1 PM up to 7 PM, Karachi time (the owner, 7 Oct 2026), at the counter: the check
 * behind orders:addItem and Edit order (ipc/buy-1-get-1-hours.ts), on a real SQLite database built from every
 * migration. A deal outside the hours is refused in the cashier's words, unless its order was started inside them;
 * nothing else on the menu is touched. node's own `node:sqlite` stands in for better-sqlite3 (built for Electron);
 * skipped where it is missing. Every name and amount is made up.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BUY_1_GET_1_CLOSED_MESSAGE } from '@cheeseoclock/shared-types';
import { CASHIER, DEV, DatabaseSync, MANAGER, OWNER, openMigrated } from '../db/costing-shop.fixture.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

vi.mock('./registry.js', () => {
  class IpcGuardError extends Error {
    readonly apiError: { code: string; message: string };
    constructor(apiError: { code: string; message: string }) {
      super(apiError.message);
      this.apiError = apiError;
      this.name = 'IpcGuardError';
    }
  }
  return { IpcGuardError, defineHandler: () => {} };
});
vi.mock('electron-log/main', () => ({ default: { info: () => {}, warn: () => {}, error: () => {} } }));
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  app: { getPath: () => '', getVersion: () => '0.0.0-test' },
  safeStorage: { isEncryptionAvailable: () => false },
}));

/** A moment on 7 Oct 2026, Karachi time (UTC+5): `karachi(13, 0)` = 1:00 PM. */
const karachi = (hour: number, minute: number) => Date.UTC(2026, 9, 7, hour - 5, minute);
const iso = (ms: number) => new Date(ms).toISOString();

const d = DatabaseSync ? describe : describe.skip;

d('Buy 1 Get 1 deals at the counter: 1 PM to 7 PM only', () => {
  let db: ReturnType<typeof openMigrated>;
  let dealId: string;
  let pizzaId: string;
  let orderId: string;
  let assertBuy1Get1Hours: typeof import('./buy-1-get-1-hours.js').assertBuy1Get1Hours;

  /** The order as if it was started at `ms` (the till writes created_at once, when the order begins). */
  const startedAt = (ms: number) => db.prepare('UPDATE orders SET created_at = ? WHERE id = ?').run(iso(ms), orderId);
  const refusal = (fn: () => void): string | null => {
    try {
      fn();
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  };

  beforeEach(async () => {
    db = openMigrated();
    const user = db.prepare(
      `INSERT INTO users (id, full_name, pin_hash, role, created_at, updated_at, device_id) VALUES (?, ?, 'x', ?, 'x', 'x', ?)`,
    );
    user.run(CASHIER.userId, 'Test Cashier', 'cashier', DEV);
    user.run(MANAGER.userId, 'Test Manager', 'manager', DEV);
    user.run(OWNER.userId, 'Test Owner', 'admin', DEV);
    const { createTaxCategory } = await import('../db/repositories/tax-category-repo.js');
    const { createCategory } = await import('../db/repositories/category-repo.js');
    const { createMenuItem } = await import('../db/repositories/menu-item-repo.js');
    const { createOrder } = await import('../db/repositories/order-repo.js');
    ({ assertBuy1Get1Hours } = await import('./buy-1-get-1-hours.js'));

    const tax = createTaxCategory(db, { name: 'Test tax', rateBps: 0 }, MANAGER);
    const deals = createCategory(db, { name: 'Buy 1 Get 1 Deals', displayOrder: 0, colorHex: '#aa5500' }, MANAGER);
    const pizzas = createCategory(db, { name: 'Pizza', displayOrder: 1, colorHex: '#aa5500' }, MANAGER);
    dealId = createMenuItem(db, { categoryId: deals.id, name: 'Large + Free Medium', basePriceCents: 100_000, taxCategoryId: tax.id }, MANAGER).id;
    pizzaId = createMenuItem(db, { categoryId: pizzas.id, name: 'Test Pizza — Large', basePriceCents: 100_000, taxCategoryId: tax.id }, MANAGER).id;
    orderId = createOrder(db, { mode: 'takeaway' }, CASHIER).id;
    startedAt(karachi(11, 0)); // started before the hours: only the clock now decides
  });

  it('lets a deal on from 1:00 PM up to 6:59 PM', () => {
    expect(refusal(() => assertBuy1Get1Hours(db, orderId, [dealId], karachi(13, 0)))).toBeNull();
    expect(refusal(() => assertBuy1Get1Hours(db, orderId, [dealId], karachi(16, 30)))).toBeNull();
    expect(refusal(() => assertBuy1Get1Hours(db, orderId, [dealId], karachi(18, 59)))).toBeNull();
  });

  it('refuses one before 1 PM and from 7 PM, in the cashier\'s words', () => {
    expect(refusal(() => assertBuy1Get1Hours(db, orderId, [dealId], karachi(12, 59)))).toBe(BUY_1_GET_1_CLOSED_MESSAGE);
    expect(refusal(() => assertBuy1Get1Hours(db, orderId, [dealId], karachi(19, 0)))).toBe(BUY_1_GET_1_CLOSED_MESSAGE);
    expect(refusal(() => assertBuy1Get1Hours(db, orderId, [dealId], karachi(23, 45)))).toBe(BUY_1_GET_1_CLOSED_MESSAGE);
    // An edit that adds a pizza AND a deal is refused for the deal.
    expect(refusal(() => assertBuy1Get1Hours(db, orderId, [pizzaId, dealId], karachi(21, 0)))).toBe(BUY_1_GET_1_CLOSED_MESSAGE);
  });

  it('keeps the deal for an order started inside the hours (begun at 6:58 PM, deal at 7:02)', () => {
    startedAt(karachi(18, 58));
    expect(refusal(() => assertBuy1Get1Hours(db, orderId, [dealId], karachi(19, 2)))).toBeNull();
  });

  it('never touches the rest of the menu, or an edit that adds nothing', () => {
    expect(refusal(() => assertBuy1Get1Hours(db, orderId, [pizzaId], karachi(23, 45)))).toBeNull();
    expect(refusal(() => assertBuy1Get1Hours(db, orderId, [], karachi(23, 45)))).toBeNull();
  });
});
