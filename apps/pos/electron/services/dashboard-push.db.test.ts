/**
 * The till's side of the phone dashboard (dashboard-push.ts) against a
 * made-up website that answers as the real one does (its push and state
 * routes, checked with the shared schemas):
 *   - a first look asks where the website is up to, then sends the history
 *     in batches of DASH_PUSH_MAX_ORDERS, oldest change first, until caught up;
 *   - a look with nothing new sends nothing at all (the database may sleep);
 *   - one new sale sends that order alone (and the day's figures);
 *   - a website without the dashboard (404) is left alone, and said so;
 *   - a failed push is tried again later, the error shown, then cleared;
 *   - the owner's switch off: nothing goes;
 *   - the sign-in list: a new person's setup code goes as its SHA-256 only,
 *     comes back once, formatted; the website's refusal in the owner's words.
 *
 * node's `node:sqlite` stands in for better-sqlite3 (skipped where missing).
 * Every name and amount is made up.
 */
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DASH_PUSH_MAX_ORDERS, DASH_SETUP_CODE_LENGTH, normalizeSetupCode, type DashPushBody, type DashPushCursors } from '@cheeseoclock/shared-types';
import { dashLoginsBodySchema, dashPushBodySchema } from '@cheeseoclock/shared-schemas/dashboard';
import type { AppDatabase } from '../db/connection.js';
import { DatabaseSync } from '../db/costing-shop.fixture.js';
import { TEST_USERS, openTill } from '../db/two-tills.fixture.js';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });

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
vi.mock('./print-spooler.js', () => ({ printSpooler: new Proxy({}, { get: () => () => undefined }), drawerFailureText: () => '' }));
vi.mock('./fbr-worker.js', () => ({ fbrWorker: { kick: () => {}, resetAdapter: () => {} } }));
vi.mock('./order-alerts-hub.js', () => ({ orderAlerts: { orderReceived: () => {}, importFailed: () => {} } }));

const live = describe.skipIf(!DatabaseSync);
const TILL = 'till-push';
const CASHIER = { userId: TEST_USERS.cashier.userId, deviceId: TILL };
const MANAGER = { userId: TEST_USERS.manager.userId, deviceId: TILL };

/** A made-up website: keeps what a till sends, answers as the routes do. */
class FakeSite {
  cursors: DashPushCursors | null = null;
  days = new Set<string>();
  pushes: DashPushBody[] = [];
  gets = 0;
  status = 200;
  missing = false;
  logins: Array<Record<string, unknown>> = [];
  loginBodies: unknown[] = [];

  async call(path: string, init?: RequestInit): Promise<Response> {
    if (this.missing) return new Response('{}', { status: 404 });
    if (this.status !== 200) return Response.json({ ok: false, error: 'internal' }, { status: this.status });
    if (path.startsWith('/api/bridge/dashboard/push')) {
      if ((init?.method ?? 'GET') === 'GET') {
        this.gets += 1;
        return Response.json({ ok: true, data: { cursors: this.cursors, daysKnown: [...this.days] } });
      }
      const body = dashPushBodySchema.parse(JSON.parse(String(init?.body)));
      this.pushes.push(body);
      this.cursors = body.cursors;
      for (const d of body.days ?? []) this.days.add(d.day);
      return Response.json({ ok: true, data: { cursors: body.cursors, stored: { orders: body.orders?.length ?? 0, shifts: 0, cashMoves: 0, drawerOpens: 0, stockMoves: 0, days: 0 }, serverTime: new Date().toISOString() } });
    }
    if (path === '/api/bridge/dashboard/logins') {
      if (init?.method === 'POST') {
        const body = dashLoginsBodySchema.parse(JSON.parse(String(init.body)));
        this.loginBodies.push(body);
        if (body.change.action === 'add') {
          if (this.logins.some((l) => l['username'] === (body.change as { username: string }).username)) {
            return Response.json({ ok: false, error: 'username_taken' }, { status: 409 });
          }
          const c = body.change;
          this.logins.push({ id: '0199c0de-0000-7000-8000-000000000001', username: c.username, displayName: c.displayName, role: c.role, seesReports: c.seesReports, hasPassword: false, setupPending: true, setupExpiresAt: null, lastSignInAt: null, signedInPhones: 0, createdAt: new Date().toISOString() });
        }
      }
      return Response.json({ ok: true, data: { logins: this.logins } });
    }
    return new Response('{}', { status: 404 });
  }
}

async function shop(): Promise<{ db: AppDatabase; burger: string }> {
  const { createTaxCategory } = await import('../db/repositories/tax-category-repo.js');
  const { createCategory } = await import('../db/repositories/category-repo.js');
  const { createMenuItem } = await import('../db/repositories/menu-item-repo.js');
  const { openShift } = await import('../db/repositories/shift-repo.js');
  const db = openTill(TILL);
  const tax = createTaxCategory(db, { name: 'Test GST', rateBps: 1_500 }, MANAGER);
  const food = createCategory(db, { name: 'Test Pies', displayOrder: 1, colorHex: '#aa5500' }, MANAGER);
  const burger = createMenuItem(db, { categoryId: food.id, name: 'Test Pie', basePriceCents: 100_000, taxCategoryId: tax.id }, MANAGER).id;
  openShift(db, { openingCashCents: 500_000 }, CASHIER);
  return { db, burger };
}

async function sell(db: AppDatabase, burger: string): Promise<string> {
  const r = await import('../db/repositories/order-repo.js');
  const o = r.createOrder(db, { mode: 'takeaway' }, CASHIER);
  r.addOrderItem(db, { orderId: o.id, menuItemId: burger, quantity: 1, modifierIds: [] }, CASHIER);
  const total = r.findOrder(db, o.id)!.totalCents;
  r.tenderOrder(db, { orderId: o.id, payments: [{ method: 'cash', amountCents: total, tenderedCents: total }] }, CASHIER);
  return o.id;
}

async function service(db: AppDatabase, site: FakeSite, now = { t: Date.now() }) {
  const { DashboardPushService } = await import('./dashboard-push.js');
  return new DashboardPushService({
    db,
    deviceId: TILL,
    deviceName: 'Test Till',
    appVersion: '0.7.40',
    callWebsite: (p, i) => site.call(p, i),
    linked: () => true,
    siteUrl: () => 'https://shop.test',
    web: () => ({ linked: true, ordersOn: true, accepting: true, pausedByShift: false }),
    notPrinted: () => 0,
    shopWide: () => false,
    now: () => now.t,
  });
}

beforeEach(() => vi.useRealTimers());

live('sending the figures', () => {
  it('the history in batches, oldest first, until caught up; then nothing while nothing changes; then one new sale alone', async () => {
    const { db, burger } = await shop();
    const ids: string[] = [];
    for (let i = 0; i < DASH_PUSH_MAX_ORDERS + 5; i++) ids.push(await sell(db, burger));
    const site = new FakeSite();
    const s = await service(db, site);

    await s.tick();
    expect(site.gets).toBe(1);
    expect(site.pushes).toHaveLength(1);
    expect(site.pushes[0]!.orders).toHaveLength(DASH_PUSH_MAX_ORDERS);
    expect(site.pushes[0]!.orders!.map((o) => o.id)).toEqual(ids.slice(0, DASH_PUSH_MAX_ORDERS));
    expect(site.pushes[0]!.caughtUp).toBe(false);
    expect(site.pushes[0]!.stock).toBeDefined();
    expect(site.pushes[0]!.menu?.items.map((i) => i.name)).toEqual(['Test Pie']);
    expect(site.pushes[0]!.days?.map((d) => d.day)).toEqual([new Date().toISOString().slice(0, 10)]);
    expect(s.status().phase).toBe('sending_history');

    await s.tick();
    expect(site.pushes).toHaveLength(2);
    expect(site.pushes[1]!.orders!.map((o) => o.id)).toEqual(ids.slice(DASH_PUSH_MAX_ORDERS));
    expect(site.pushes[1]!.caughtUp).toBe(true);
    expect(site.pushes[1]!.stock).toBeUndefined(); // unchanged since the first push
    expect(s.status()).toMatchObject({ phase: 'up_to_date', ordersSent: DASH_PUSH_MAX_ORDERS + 5, dashboardUrl: 'https://shop.test/dashboard' });

    await s.tick();
    expect(site.pushes).toHaveLength(2); // nothing new: no request at all

    const fresh = await sell(db, burger);
    await s.tick();
    expect(site.pushes).toHaveLength(3);
    expect(site.pushes[2]!.orders!.map((o) => o.id)).toEqual([fresh]);
    // Today's figures went a moment ago: they wait their turn.
    expect(site.pushes[2]!.days).toBeUndefined();
  });

  it('a new start asks the website where it is up to, and sends only what it lacks', async () => {
    const { db, burger } = await shop();
    await sell(db, burger);
    const site = new FakeSite();
    await (await service(db, site)).tick();
    expect(site.pushes).toHaveLength(1);
    // The till restarts: a new service, the same website.
    const again = await service(db, site);
    await again.tick();
    expect(site.gets).toBe(2);
    // Nothing changed since: only the overlap re-read, nothing new sent but the stock list (a new service knows no stamp).
    expect(site.pushes[1]?.orders ?? []).toHaveLength(1); // the overlap: its last order once more (an unchanged copy, kept as it is)
  });

  it('a website without the dashboard is left alone; a failure is tried again and then clears; the switch off sends nothing', async () => {
    const { db, burger } = await shop();
    await sell(db, burger);
    const old = new FakeSite();
    old.missing = true;
    const s1 = await service(db, old);
    await s1.tick();
    expect(s1.status().phase).toBe('website_old');
    expect(old.pushes).toHaveLength(0);

    const flaky = new FakeSite();
    const s2 = await service(db, flaky);
    flaky.status = 500;
    await s2.tick();
    expect(s2.status().phase).toBe('failing');
    expect(s2.status().lastError).toBeTruthy();
    flaky.status = 200;
    await s2.tick();
    expect(s2.status()).toMatchObject({ phase: 'up_to_date', lastError: null });

    const { writePushOn } = await import('./dashboard-push.js');
    writePushOn(db, false, TEST_USERS.owner.userId);
    const quiet = new FakeSite();
    const s3 = await service(db, quiet);
    await s3.tick();
    expect(quiet.gets + quiet.pushes.length).toBe(0);
    expect(s3.status().phase).toBe('off');
  });

  it('with a shift open and nothing new, it still says it is there every ten minutes', async () => {
    const { db, burger } = await shop();
    await sell(db, burger);
    const site = new FakeSite();
    const now = { t: Date.now() };
    const s = await service(db, site, now);
    await s.tick();
    const n = site.pushes.length;
    now.t += 60_000;
    await s.tick();
    expect(site.pushes).toHaveLength(n);
    now.t += 10 * 60_000;
    await s.tick();
    expect(site.pushes).toHaveLength(n + 1);
    expect(site.pushes[n]!.live.shift).not.toBeNull();
  });
});

live('the sign-in list', () => {
  it('a new person: only the code’s SHA-256 goes, the code comes back once, formatted; a taken username in the owner’s words', async () => {
    const { db } = await shop();
    const site = new FakeSite();
    const s = await service(db, site);
    const made = await s.withNewCode(
      (setupCodeHash) => ({ action: 'add', username: 'testmgr', displayName: 'Test Manager', role: 'manager', seesReports: false, setupCodeHash }),
      'Test Owner',
      () => 'testmgr',
    );
    expect(made.code).toMatch(/^[2-9A-Z]{4}-[2-9A-Z]{4}-[2-9A-Z]{4}$/);
    expect(normalizeSetupCode(made.code)).toHaveLength(DASH_SETUP_CODE_LENGTH);
    const sent = JSON.stringify(site.loginBodies[0]);
    expect(sent).not.toContain(normalizeSetupCode(made.code));
    expect((site.loginBodies[0] as { change: { setupCodeHash: string } }).change.setupCodeHash).toBe(
      createHash('sha256').update(normalizeSetupCode(made.code)).digest('hex'),
    );
    expect(made.logins.map((l) => l.username)).toEqual(['testmgr']);

    await expect(
      s.withNewCode((h) => ({ action: 'add', username: 'testmgr', displayName: 'X', role: 'manager', seesReports: false, setupCodeHash: h }), null, () => 'testmgr'),
    ).rejects.toThrow('That username is taken. Pick another.');
  });
});
