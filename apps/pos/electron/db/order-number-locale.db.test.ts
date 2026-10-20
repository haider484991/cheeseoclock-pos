/**
 * Order numbers count within the SHOP's trading day (shop-clock.ts), through
 * the real createOrder on a real migrated SQLite (the harness is
 * shift-rider-payout.db.test.ts's).
 *
 * A number is the trading day and a count ("20261020-0007"). It used to take
 * the UTC date, which is a Pakistani trading day only because 05:00 in
 * Karachi is 00:00 UTC — so a New York till started again at #0001 at 8 pm,
 * mid-rush. Pakistan's numbers are pinned here exactly as before.
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

/** A till with a shift open, and a way to start an order at an instant. */
async function shop() {
  const db = openTill(TILL);
  const { openShift } = await import('./repositories/shift-repo.js');
  const { createOrder } = await import('./repositories/order-repo.js');
  vi.setSystemTime(new Date('2026-10-02T06:00:00.000Z'));
  openShift(db, { openingCashCents: 500_000 }, MANAGER);
  return (iso: string): string => {
    vi.setSystemTime(new Date(iso));
    return createOrder(db, { mode: 'takeaway' }, CASHIER).orderNumber;
  };
}

live('order numbers follow the shop’s trading day', () => {
  it('Pakistan: numbered exactly as before, through the night', async () => {
    const orderAt = await shop();
    expect(orderAt('2026-10-02T15:00:00.000Z')).toBe('20261002-0001'); // 20:00 in Karachi
    expect(orderAt('2026-10-02T20:30:00.000Z')).toBe('20261002-0002'); // 01:30: still the 2nd's trading day
    expect(orderAt('2026-10-03T00:00:00.000Z')).toBe('20261003-0001'); // 05:00: a new trading day
  });

  it('New York: the evening rush keeps its day, and 05:00 starts the next', async () => {
    const shared = await import('@cheeseoclock/shared-types');
    shared.setShopLocale(shared.US_SHOP_LOCALE);
    const orderAt = await shop();
    expect(orderAt('2026-10-20T23:30:00.000Z')).toBe('20261020-0001'); // 19:30 EDT
    // 20:30 EDT: the UTC date is already the 21st, which used to restart the count at #0001.
    expect(orderAt('2026-10-21T00:30:00.000Z')).toBe('20261020-0002');
    expect(orderAt('2026-10-21T06:30:00.000Z')).toBe('20261020-0003'); // 02:30: still the 20th's night
    expect(orderAt('2026-10-21T09:30:00.000Z')).toBe('20261021-0001'); // 05:30: the 21st begins
  });
});
