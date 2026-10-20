/**
 * What a till abroad refuses, through the real repositories on a real
 * migrated SQLite (the harness is order-number-locale.db.test.ts's): a
 * Pakistani wallet as a tender, and Foodpanda as an order type. The screens
 * never offer either on a US till; these are the guards behind them. Pakistan
 * takes all of it, exactly as before.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedUser } from '@cheeseoclock/shared-types';
import { DatabaseSync } from './costing-shop.fixture.js';
import { openTill } from './two-tills.fixture.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

const h = vi.hoisted(() => ({ session: null as AuthenticatedUser | null }));

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
vi.mock('../ipc/registry.js', () => {
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
vi.mock('../services/auth-service.js', () => ({
  getCurrentSession: () => h.session,
  verifyManagerPin: async () => {
    throw new Error('no manager here');
  },
}));
vi.mock('../services/print-spooler.js', () => ({
  printSpooler: new Proxy({}, { get: () => () => undefined }),
  drawerFailureText: () => '',
}));
vi.mock('../services/fbr-worker.js', () => ({ fbrWorker: { kick: () => {}, resetAdapter: () => {} } }));
vi.mock('../services/order-alerts-hub.js', () => ({ orderAlerts: { orderReceived: () => {}, importFailed: () => {} } }));

const TILL = 'till-a';
const CASHIER = { userId: 'u_cash', deviceId: TILL };
const MANAGER = { userId: 'u_mgr', deviceId: TILL };
const live = describe.skipIf(!DatabaseSync);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
});
afterEach(async () => {
  vi.useRealTimers();
  (await import('@cheeseoclock/shared-types')).resetShopLocale();
});

/** A till with a shift open and one Rs 1,000 item (+16% tax): orders that can be paid. */
async function shop() {
  const db = openTill(TILL);
  vi.setSystemTime(new Date('2026-10-02T12:00:00.000Z'));
  const { openShift } = await import('./repositories/shift-repo.js');
  const { createTaxCategory } = await import('./repositories/tax-category-repo.js');
  const { createCategory } = await import('./repositories/category-repo.js');
  const { createMenuItem } = await import('./repositories/menu-item-repo.js');
  const repo = await import('./repositories/order-repo.js');
  openShift(db, { openingCashCents: 500_000 }, MANAGER);
  const tax = createTaxCategory(db, { name: 'Test tax', rateBps: 1_600 }, MANAGER);
  const cat = createCategory(db, { name: 'Test food', displayOrder: 1, colorHex: '#aa5500' }, MANAGER);
  const item = createMenuItem(db, { categoryId: cat.id, name: 'Test pizza', basePriceCents: 100_000, taxCategoryId: tax.id }, MANAGER).id;
  /** A takeaway with the item on it, ready to pay. */
  const order = () => {
    const o = repo.createOrder(db, { mode: 'takeaway' }, CASHIER);
    repo.addOrderItem(db, { orderId: o.id, menuItemId: item, quantity: 1, modifierIds: [] }, CASHIER);
    return repo.getOrderSnapshot(db, o.id)!.order;
  };
  const pay = (method: 'cash' | 'card' | 'easypaisa' | 'jazzcash' | 'bank_transfer') => {
    const o = order();
    return repo.tenderOrder(db, { orderId: o.id, payments: [{ method, amountCents: o.totalCents }] }, CASHIER);
  };
  return { db, repo, order, pay };
}

const us = async () => {
  const shared = await import('@cheeseoclock/shared-types');
  shared.setShopLocale(shared.US_SHOP_LOCALE);
};

live('a till abroad takes only what its shop takes', () => {
  it('Pakistan: every way it was paid before, and Foodpanda orders', async () => {
    const { pay, repo, db } = await shop();
    for (const method of ['cash', 'card', 'easypaisa', 'jazzcash', 'bank_transfer'] as const) {
      expect(() => pay(method), method).not.toThrow();
    }
    expect(() => repo.createOrder(db, { mode: 'foodpanda' }, CASHIER)).not.toThrow();
  });

  it('the US: cash and card, and a Pakistani wallet is refused', async () => {
    await us();
    const { pay } = await shop();
    expect(() => pay('cash')).not.toThrow();
    expect(() => pay('card')).not.toThrow();
    expect(() => pay('easypaisa')).toThrow('This shop is not paid by easypaisa');
    expect(() => pay('jazzcash')).toThrow('This shop is not paid by jazzcash');
    expect(() => pay('bank_transfer')).toThrow('This shop is not paid by bank transfer');
  });

  it('the US: no Foodpanda order, new or switched to', async () => {
    await us();
    const { repo, db, order } = await shop();
    expect(() => repo.createOrder(db, { mode: 'foodpanda' }, CASHIER)).toThrow('Foodpanda orders are not taken in this shop');
    expect(() => repo.setOrderMode(db, order().id, 'foodpanda', CASHIER)).toThrow('Foodpanda orders are not taken in this shop');
  });
});
