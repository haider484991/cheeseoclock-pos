/**
 * A till with its menu-file service wired to the stand-in website
 * (menu-deploy-website.fixture.ts), for the tests: a real database from
 * every migration, the made-up users, and every dependency recorded — the
 * backup copies, the menu publishes, the notes to the screens.
 *
 * Not a test file: imported by *.db.test.ts, which mock electron and
 * electron-log first. EVERY NAME AND MENU IS MADE UP.
 */
import type { MenuDeployChangedEvent } from '@cheeseoclock/shared-types';
import type { AppDatabase } from '../db/connection.js';
import { openTill, linkOn } from '../db/two-tills.fixture.js';
import { createTaxCategory, listTaxCategories } from '../db/repositories/tax-category-repo.js';
import type { Clock, FakeMenuWebsite } from './menu-deploy-website.fixture.js';
import { MenuPackageService } from './menu-package-service.js';

export interface ServiceTill {
  db: AppDatabase;
  deviceId: string;
  service: MenuPackageService;
  /** What happened, in order: 'backup', 'publish' (and the import itself shows in the database). */
  steps: string[];
  emits: MenuDeployChangedEvent[];
  /** Make the next backup fail. */
  failBackup: { next: boolean };
  /** Called as the backup copy is made (to look at the till at that moment, or to hold the copy up). */
  onBackup: { fn: (() => void | Promise<void>) | null };
  linked: { on: boolean };
}

export function serviceTill(
  deviceId: string,
  website: FakeMenuWebsite,
  clock: Clock,
  opts: { db?: AppDatabase; link?: 'on' | 'off'; ordersOn?: boolean; deviceName?: string } = {},
): ServiceTill {
  const db = opts.db ?? openTill(deviceId);
  // The shop's tax, as a till in use has it (madeUpMenu's 16%): a file that ADDS a tax category waits for the owner.
  if (!listTaxCategories(db).some((t) => t.rateBps === 1_600)) {
    createTaxCategory(db, { name: 'Test Tax', rateBps: 1_600 }, { userId: 'u_admin', deviceId });
  }
  if ((opts.link ?? 'on') === 'on') linkOn(db, clock.t);
  const steps: string[] = [];
  const emits: MenuDeployChangedEvent[] = [];
  const failBackup = { next: false };
  const onBackup: { fn: (() => void | Promise<void>) | null } = { fn: null };
  const linked = { on: true };
  const service = new MenuPackageService({
    db,
    deviceId,
    deviceName: opts.deviceName ?? `Test ${deviceId}`,
    appVersion: '0.7.32-test',
    callWebsite: website.fetchFor(deviceId),
    linked: () => linked.on,
    ordersOn: () => opts.ordersOn ?? true,
    publishMenu: async () => {
      steps.push('publish');
    },
    backup: async () => {
      if (failBackup.next) {
        failBackup.next = false;
        throw new Error('Test: the disk is full');
      }
      await onBackup.fn?.();
      steps.push('backup');
    },
    now: () => clock.t,
    emit: (e) => emits.push(e),
    random: () => 0.5,
  });
  return { db, deviceId, service, steps, emits, failBackup, onBackup, linked };
}

/** Counts of the menu rows a till holds (not deleted). */
export function menuRows(db: AppDatabase): { categories: number; items: number; choiceGroups: number; options: number; ingredients: number } {
  const n = (sql: string) => Number((db.prepare(sql).get() as { n: number }).n);
  return {
    categories: n(`SELECT COUNT(*) AS n FROM categories WHERE deleted_at IS NULL`),
    items: n(`SELECT COUNT(*) AS n FROM menu_items WHERE deleted_at IS NULL`),
    choiceGroups: n(`SELECT COUNT(*) AS n FROM modifier_groups WHERE deleted_at IS NULL`),
    options: n(`SELECT COUNT(*) AS n FROM modifiers WHERE deleted_at IS NULL`),
    ingredients: n(`SELECT COUNT(*) AS n FROM ingredients WHERE deleted_at IS NULL`),
  };
}

/** An order rung up on this till `msAgo` ago (only its time and till matter here). */
export function orderRungUp(db: AppDatabase, deviceId: string, atMs: number): void {
  const at = new Date(atMs).toISOString();
  db.prepare(
    `INSERT INTO orders (id, order_number, mode, status, subtotal_cents, discount_cents, tax_cents, total_cents,
                         cashier_id, created_at, updated_at, device_id, version)
     VALUES (?, ?, 'takeaway', 'open', 0, 0, 0, 0, 'u_cash', ?, ?, ?, 1)`,
  ).run(`o-${atMs}`, `T-${atMs}`, at, at, deviceId);
}
