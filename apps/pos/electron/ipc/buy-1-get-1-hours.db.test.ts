/**
 * Buy 1 Get 1 deals at the counter follow the owner's rules (Settings → Money & discounts → "Buy 1 Get 1 deals";
 * the poster's 1 PM up to 7 PM, Karachi time, until changed — the owner, 7 Oct 2026): the check behind
 * orders:addItem and Edit order (ipc/buy-1-get-1-hours.ts), on a real SQLite database built from every migration.
 * A deal outside the hours, or while they are off, is refused in the cashier's words, unless its order was started
 * inside the hours; a Save counts at once; nothing else on the menu is touched. node's own `node:sqlite` stands in
 * for better-sqlite3 (built for Electron); skipped where it is missing. Every name and amount is made up.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buy1Get1ClosedMessage, DEFAULT_BUY_1_GET_1_RULES, type Buy1Get1Rules } from '@cheeseoclock/shared-types';
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
const karachi = (hour: number, minute: number, day = 7) => Date.UTC(2026, 9, day, hour - 5, minute);
const iso = (ms: number) => new Date(ms).toISOString();
const POSTER = buy1Get1ClosedMessage();

const d = DatabaseSync ? describe : describe.skip;

d('Buy 1 Get 1 deals at the counter: the owner’s rules (1 PM to 7 PM until changed)', () => {
  let db: ReturnType<typeof openMigrated>;
  let dealId: string;
  let pizzaId: string;
  let orderId: string;
  let assertBuy1Get1Hours: typeof import('./buy-1-get-1-hours.js').assertBuy1Get1Hours;
  let setBusinessSettings: typeof import('../db/repositories/business-settings-repo.js').setBusinessSettings;

  /** The order as if it was started at `ms` (the till writes created_at once, when the order begins). */
  const startedAt = (ms: number) => db.prepare('UPDATE orders SET created_at = ? WHERE id = ?').run(iso(ms), orderId);
  /** The owner saves the rules (Settings → Money & discounts), through the repository as the Save does. */
  const save = (rules: Partial<Buy1Get1Rules>) =>
    setBusinessSettings(db, [{ key: 'deals.buy1Get1', value: { v: 1, ...DEFAULT_BUY_1_GET_1_RULES, ...rules } }], OWNER);
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
    ({ setBusinessSettings } = await import('../db/repositories/business-settings-repo.js'));
    ({ assertBuy1Get1Hours } = await import('./buy-1-get-1-hours.js'));

    const tax = createTaxCategory(db, { name: 'Test tax', rateBps: 0 }, MANAGER);
    const deals = createCategory(db, { name: 'Buy 1 Get 1 Deals', displayOrder: 0, colorHex: '#aa5500' }, MANAGER);
    const pizzas = createCategory(db, { name: 'Pizza', displayOrder: 1, colorHex: '#aa5500' }, MANAGER);
    dealId = createMenuItem(db, { categoryId: deals.id, name: 'Large + Free Medium', basePriceCents: 100_000, taxCategoryId: tax.id }, MANAGER).id;
    pizzaId = createMenuItem(db, { categoryId: pizzas.id, name: 'Test Pizza — Large', basePriceCents: 100_000, taxCategoryId: tax.id }, MANAGER).id;
    orderId = createOrder(db, { mode: 'takeaway' }, CASHIER).id;
    startedAt(karachi(11, 0)); // started before the hours: only the clock now decides
  });

  it('never saved: lets a deal on from 1:00 PM up to 6:59 PM', () => {
    expect(refusal(() => assertBuy1Get1Hours(db, orderId, [dealId], karachi(13, 0)))).toBeNull();
    expect(refusal(() => assertBuy1Get1Hours(db, orderId, [dealId], karachi(16, 30)))).toBeNull();
    expect(refusal(() => assertBuy1Get1Hours(db, orderId, [dealId], karachi(18, 59)))).toBeNull();
  });

  it('never saved: refuses one before 1 PM and from 7 PM, in the cashier’s words', () => {
    expect(POSTER).toBe('Buy 1 Get 1 deals are sold from 1 PM to 7 PM.');
    expect(refusal(() => assertBuy1Get1Hours(db, orderId, [dealId], karachi(12, 59)))).toBe(POSTER);
    expect(refusal(() => assertBuy1Get1Hours(db, orderId, [dealId], karachi(19, 0)))).toBe(POSTER);
    expect(refusal(() => assertBuy1Get1Hours(db, orderId, [dealId], karachi(23, 45)))).toBe(POSTER);
    // An edit that adds a pizza AND a deal is refused for the deal.
    expect(refusal(() => assertBuy1Get1Hours(db, orderId, [pizzaId, dealId], karachi(21, 0)))).toBe(POSTER);
  });

  it('keeps the deal for an order started inside the hours (begun at 6:58 PM, deal at 7:02)', () => {
    startedAt(karachi(18, 58));
    expect(refusal(() => assertBuy1Get1Hours(db, orderId, [dealId], karachi(19, 2)))).toBeNull();
  });

  it('never touches the rest of the menu, or an edit that adds nothing', () => {
    expect(refusal(() => assertBuy1Get1Hours(db, orderId, [pizzaId], karachi(23, 45)))).toBeNull();
    expect(refusal(() => assertBuy1Get1Hours(db, orderId, [], karachi(23, 45)))).toBeNull();
  });

  it('follows the owner’s saved hours at once, past midnight too', () => {
    save({ opensMinute: 22 * 60, closesMinute: 60 });
    const words = 'Buy 1 Get 1 deals are sold from 10 PM to 1 AM.';
    expect(refusal(() => assertBuy1Get1Hours(db, orderId, [dealId], karachi(15, 0)))).toBe(words);
    expect(refusal(() => assertBuy1Get1Hours(db, orderId, [dealId], karachi(22, 0)))).toBeNull();
    expect(refusal(() => assertBuy1Get1Hours(db, orderId, [dealId], karachi(0, 30, 8)))).toBeNull();
    expect(refusal(() => assertBuy1Get1Hours(db, orderId, [dealId], karachi(1, 0, 8)))).toBe(words);
  });

  it('switched off: refused at any hour, even for an order started inside the hours; on again, sold again', () => {
    save({ on: false });
    const off = 'Buy 1 Get 1 deals are not on at the moment.';
    expect(refusal(() => assertBuy1Get1Hours(db, orderId, [dealId], karachi(15, 0)))).toBe(off);
    startedAt(karachi(14, 0));
    expect(refusal(() => assertBuy1Get1Hours(db, orderId, [dealId], karachi(15, 0)))).toBe(off);
    // The rest of the menu is never touched.
    expect(refusal(() => assertBuy1Get1Hours(db, orderId, [pizzaId], karachi(15, 0)))).toBeNull();
    save({ on: true });
    expect(refusal(() => assertBuy1Get1Hours(db, orderId, [dealId], karachi(15, 0)))).toBeNull();
  });

  it('a Save the schema refuses (the same start and end) changes nothing', () => {
    expect(() => save({ opensMinute: 600, closesMinute: 600 })).toThrow(/same time/);
    expect(refusal(() => assertBuy1Get1Hours(db, orderId, [dealId], karachi(15, 0)))).toBeNull();
  });
});
