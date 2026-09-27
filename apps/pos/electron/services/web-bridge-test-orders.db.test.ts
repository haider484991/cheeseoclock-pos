/**
 * The website hears about a test order the owner deleted (migration 0041):
 * the bridge's status push maps a deleted order to 'cancelled', and a site
 * that already holds a final status keeps it. The website's API is a stand-in
 * that records what it was sent; the database is real (every migration,
 * foreign keys on), through node's own `node:sqlite`. Every name and amount
 * is made up.
 */
import { describe, expect, it, vi } from 'vitest';
import type { AppDatabase } from '../db/connection.js';
import { CASHIER, DatabaseSync, OWNER, openCostingShop, openMigrated } from '../db/costing-shop.fixture.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });
vi.mock('electron-log/main', () => ({ default: { info: () => {}, warn: () => {}, error: () => {} } }));
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  app: { getPath: () => '', getVersion: () => '0.0.0-test' },
  safeStorage: { isEncryptionAvailable: () => false },
  Notification: class {
    static isSupported() {
      return false;
    }
  },
}));

interface BridgeInside {
  db: AppDatabase | null;
  api: (cfg: unknown, path: string, init: { method: string; body: string }) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;
  pushStatusUpdates: (cfg: unknown) => Promise<void>;
}

describe.skipIf(!DatabaseSync)('the website and a deleted test order', () => {
  it("is told the order is cancelled; a site that already holds a final status keeps it", async () => {
    const db = openMigrated();
    const shop = await openCostingShop(db);
    const orders = await import('../db/repositories/order-repo.js');
    const { openShift } = await import('../db/repositories/shift-repo.js');
    openShift(db, { openingCashCents: 0 }, CASHIER);
    const now = new Date().toISOString();
    const ring = (webId: string, lastPushed: string) => {
      const o = shop.ring([['bakedWings', 1]]);
      orders.sendOrderToKitchen(db, o, CASHIER);
      db.prepare(
        `INSERT INTO web_order_imports (web_order_id, pos_order_id, status, last_pushed_status, imported_at, created_at, updated_at)
         VALUES (?, ?, 'imported', ?, ?, ?, ?)`,
      ).run(webId, o, lastPushed, now, now, now);
      return o;
    };
    const a = ring('web-a', 'preparing');
    const b = ring('web-b', 'preparing');
    for (const o of [a, b]) {
      expect(orders.testDeletePreview(db, o, CASHIER.deviceId).web).toBe(true);
      const done = orders.deleteTestOrder(
        db,
        { orderId: o, reason: 'Printer test', restock: null, expectStatus: 'sent_to_kitchen', ownerUserId: OWNER.userId },
        OWNER,
      );
      expect(done.web).toBe(true);
    }

    const { webOrdersBridge } = await import('./web-orders-bridge.js');
    const bridge = webOrdersBridge as unknown as BridgeInside;
    const sent: Array<[string, unknown]> = [];
    bridge.db = db;
    bridge.api = async (_cfg, path, init) => {
      sent.push([path, JSON.parse(init.body)]);
      // The site already holds a final status for web-b: it keeps it.
      const final = path.includes('web-b');
      return { ok: true, json: async () => ({ data: final ? { updated: false, finalStatus: 'delivered' } : { updated: true } }) };
    };
    await bridge.pushStatusUpdates({});
    expect(sent).toEqual([
      ['/api/bridge/orders/web-a/status', { status: 'cancelled' }],
      ['/api/bridge/orders/web-b/status', { status: 'cancelled' }],
    ]);
    const held = db.prepare(`SELECT web_order_id AS id, last_pushed_status AS s FROM web_order_imports ORDER BY web_order_id`).all();
    expect(held).toEqual([
      { id: 'web-a', s: 'cancelled' },
      { id: 'web-b', s: 'delivered' },
    ]);
    // Nothing more to push: both are final.
    sent.length = 0;
    await bridge.pushStatusUpdates({});
    expect(sent).toEqual([]);
  });
});
