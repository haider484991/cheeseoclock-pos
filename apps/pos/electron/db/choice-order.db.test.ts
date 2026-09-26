/**
 * A line's choices are stored and read back in the order the choices popup
 * asks them (owner 2026-09-27): required ones, dips on the side, extras,
 * drinks, leave-outs, anything else (shared-types orderChoiceGroups) — so
 * the cart line, the kitchen ticket and the receipt list them that way.
 * Before, order_item_modifiers were written in modifier-id (creation) order
 * and read back with no ORDER BY: with the shop's groups imported leave-outs
 * first, "No onion" led every pizza line and an extra came before the dip.
 *
 * The menu here is made the way the shop's import made it: groups (and so
 * their options' ids) in the order leave-out, drink, extras, dips, required.
 * Real repositories on a database built from every migration; node's own
 * `node:sqlite` stands in for better-sqlite3 (built for Electron here), and
 * the test skips itself where that is missing. Every name is made up.
 */
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeEscPos, renderKitchenTicket, renderReceipt } from '@cheeseoclock/printer-core';
import type { AppDatabase } from './connection.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });
vi.mock('electron-log/main', () => ({ default: { info: () => {}, warn: () => {}, error: () => {} } }));
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));

interface Stmt {
  run(...p: unknown[]): unknown;
  all(...p: unknown[]): Array<Record<string, unknown>>;
  get(...p: unknown[]): Record<string, unknown> | undefined;
}
interface RawDb {
  exec(sql: string): void;
  prepare(sql: string): Stmt;
}
type RawDbCtor = new (path: string) => RawDb;
let DatabaseSync: RawDbCtor | null = null;
try {
  DatabaseSync = (createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: RawDbCtor }).DatabaseSync;
} catch {
  DatabaseSync = null;
}
const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

function openMigrated(): AppDatabase {
  if (!DatabaseSync) throw new Error('node:sqlite unavailable');
  const raw = new DatabaseSync(':memory:');
  for (const f of readdirSync(MIGRATIONS).filter((x) => x.endsWith('.sql')).sort()) {
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
  } as unknown as AppDatabase;
}

const DEV = 'dev-till-1';
const T0 = '2026-01-01T00:00:00.000Z';
const CASHIER = { userId: 'u_cash', deviceId: DEV };
const MANAGER = { userId: 'u_mgr', deviceId: DEV };

const repos = async () => ({
  ...(await import('./repositories/order-repo.js')),
  ...(await import('./repositories/modifier-repo.js')),
  ...(await import('./repositories/menu-item-repo.js')),
  ...(await import('./repositories/category-repo.js')),
  ...(await import('./repositories/tax-category-repo.js')),
  ...(await import('./repositories/shift-repo.js')),
});

type Choice =
  | 'noOnion'
  | 'noOlives'
  | 'cola'
  | 'extraCheese'
  | 'extraOlives'
  | 'sideRanch'
  | 'thin'
  | 'thick'
  | 'stray';

let db: AppDatabase;
let r: Awaited<ReturnType<typeof repos>>;
let pizza = '';
const choice = {} as Record<Choice, string>;

beforeEach(async () => {
  if (!DatabaseSync) return;
  db = openMigrated();
  const user = db.prepare(
    `INSERT INTO users (id, full_name, pin_hash, role, created_at, updated_at, device_id) VALUES (?, ?, 'x', ?, ?, ?, ?)`,
  );
  user.run('u_cash', 'Test Cashier', 'cashier', T0, T0, DEV);
  user.run('u_mgr', 'Test Manager', 'manager', T0, T0, DEV);
  r = await repos();
  const tax = r.createTaxCategory(db, { name: 'Test tax', rateBps: 0 }, MANAGER);
  const cat = r.createCategory(db, { name: 'Test pizzas', displayOrder: 1, colorHex: '#aa5500' }, MANAGER);
  pizza = r.createMenuItem(db, { categoryId: cat.id, name: 'Test Pizza', basePriceCents: 100_000, taxCategoryId: tax.id }, MANAGER).id;

  // Made in the order the shop's menu import made them: leave-outs first.
  const group = (name: string, required = false) =>
    r.createModifierGroup(
      db,
      { name, selectionType: required ? 'single' : 'multi', minSelect: required ? 1 : 0, maxSelect: required ? 1 : 5, isRequired: required },
      MANAGER,
    ).id;
  const leaveOut = group('Leave out · Test Pizza');
  const drink = group('Add a drink');
  const extras = group('Extra toppings');
  const dips = group('Dips on the side');
  const crust = group('Choose your crust', true);
  const stray = group('Test other group');
  const add = (c: Choice, groupId: string, name: string, sortOrder: number, price = 0) => {
    choice[c] = r.createModifier(db, { modifierGroupId: groupId, name, priceDeltaCents: price, sortOrder }, MANAGER).id;
  };
  add('noOnion', leaveOut, 'No onion', 0);
  add('noOlives', leaveOut, 'No olives', 1);
  add('cola', drink, 'Test Cola 345 ml', 0, 12_000);
  add('extraCheese', extras, 'Extra cheese', 0, 15_000);
  add('extraOlives', extras, 'Extra olives', 1, 10_000);
  add('sideRanch', dips, 'Side of Ranch', 0, 8_000);
  add('thin', crust, 'Thin crust', 0);
  add('thick', crust, 'Thick crust', 1);
  add('stray', stray, 'Stray choice', 0);
  // Attached in that order too; the stray group is not on the pizza.
  r.setItemModifierGroups(
    db,
    pizza,
    [leaveOut, drink, extras, dips, crust].map((modifierGroupId, sortOrder) => ({ modifierGroupId, sortOrder })),
    MANAGER,
  );
  r.openShift(db, { openingCashCents: 0 }, MANAGER);
});

/** A draft with one pizza, its choices sent in `picks` order. */
function ring(picks: Choice[]): { orderId: string; lineId: string } {
  const o = r.createOrder(db, { mode: 'takeaway' }, CASHIER);
  const line = r.addOrderItem(db, { orderId: o.id, menuItemId: pizza, quantity: 1, modifierIds: picks.map((p) => choice[p]), notes: null }, CASHIER);
  return { orderId: o.id, lineId: line.id };
}
const names = (orderId: string) => r.getOrderSnapshot(db, orderId)!.items[0]!.modifiers.map((m) => m.modifierName);
const rows = (bytes: Uint8Array) => decodeEscPos(bytes).map((x) => x.text);
const all = (sql: string, ...p: unknown[]) => db.prepare(sql).all(...p) as Array<Record<string, unknown>>;
const one = (sql: string, ...p: unknown[]) => db.prepare(sql).get(...p) as Record<string, unknown> | undefined;

describe.skipIf(!DatabaseSync)('choices in the order they were asked', () => {
  it('the cart line reads required, dips, extras, drinks, leave-outs — however they were sent and whatever their ids', async () => {
    const { orderId } = ring(['extraOlives', 'noOnion', 'thick', 'cola', 'sideRanch', 'extraCheese']);
    expect(names(orderId)).toEqual([
      'Thick crust',
      'Side of Ranch',
      'Extra cheese',
      'Extra olives',
      'Test Cola 345 ml',
      'No onion',
    ]);
    // Stored with their place, 0 first.
    const stored = all(
      `SELECT modifier_name AS n, sort_order AS s FROM order_item_modifiers WHERE deleted_at IS NULL ORDER BY sort_order`,
    ).map((x) => [x['n'], Number(x['s'])]);
    expect(stored).toEqual([
      ['Thick crust', 0],
      ['Side of Ranch', 1],
      ['Extra cheese', 2],
      ['Extra olives', 3],
      ['Test Cola 345 ml', 4],
      ['No onion', 5],
    ]);
    // The price is the same whatever the order.
    expect(r.getOrderSnapshot(db, orderId)!.items[0]!.lineTotalCents).toBe(100_000 + 12_000 + 15_000 + 10_000 + 8_000);
  });

  it('the kitchen ticket shouts the leave-out first, then lists the rest as asked; the receipt lists them as asked', async () => {
    const { orderId } = ring(['cola', 'noOnion', 'extraCheese', 'thin', 'sideRanch']);
    const snap = r.getOrderSnapshot(db, orderId)!;
    const ticket = rows(renderKitchenTicket(snap, { now: new Date(2026, 8, 27, 19, 35) }));
    const first = ticket.indexOf('    NO ONION');
    expect(first).toBeGreaterThan(0);
    expect(ticket.slice(first, first + 5)).toEqual([
      '    NO ONION',
      '    + Thin crust',
      '    + Side of Ranch',
      '    + Extra cheese',
      '    + Test Cola 345 ml',
    ]);
    const receipt = rows(renderReceipt(snap, { branding: { storeName: 'Test Shop' } }));
    const choices = receipt.filter((x) => x.startsWith('    ')).map((x) => x.trim().replace(/\s+\+ [\d,.]+$/, ''));
    expect(choices).toEqual(['Thin crust', 'Side of Ranch', 'Extra cheese', 'Test Cola 345 ml', 'No onion']);
  });

  it('Customize keeps the asked order too', async () => {
    const { orderId, lineId } = ring(['thin']);
    r.updateOrderItemOptions(
      db,
      { orderId, orderItemId: lineId, modifierIds: [choice.noOlives, choice.extraOlives, choice.noOnion, choice.thick, choice.extraCheese], notes: 'no chilli' },
      CASHIER,
    );
    expect(names(orderId)).toEqual(['Thick crust', 'Extra cheese', 'Extra olives', 'No onion', 'No olives']);
    const audit = one(
      `SELECT after_json AS a FROM audit_log WHERE entity_type = 'order_items' AND action = 'update_options' ORDER BY rowid DESC LIMIT 1`,
    );
    const after = JSON.parse(String(audit?.['a'])) as { modifiers: Array<{ modifierName: string }> };
    expect(after.modifiers.map((m) => m.modifierName)).toEqual(['Thick crust', 'Extra cheese', 'Extra olives', 'No onion', 'No olives']);
  });

  it('a choice from a group the item no longer has goes last, in the order it was sent', async () => {
    const { orderId } = ring(['stray', 'noOnion', 'thin']);
    expect(names(orderId)).toEqual(['Thin crust', 'No onion', 'Stray choice']);
  });

  it('the other till gets the place with the row (the row image carries sortOrder)', async () => {
    ring(['noOnion', 'thin']);
    const images = all(`SELECT payload_json AS p FROM sync_queue WHERE entity_type = 'order_item_modifiers' ORDER BY rowid`).map(
      (x) => JSON.parse(String(x['p'])) as { modifierName: string; sortOrder: number },
    );
    expect(images.map((i) => [i.modifierName, i.sortOrder])).toEqual([
      ['Thin crust', 0],
      ['No onion', 1],
    ]);
  });

  it('lines written before the change (all at 0) read back in the order they were written', async () => {
    const { orderId, lineId } = ring(['noOnion', 'thin', 'extraCheese']);
    // What an older till left: the rows in modifier-id order, no place.
    const ids = all(`SELECT id, modifier_id FROM order_item_modifiers WHERE order_item_id = ? AND deleted_at IS NULL`, lineId);
    const written = ['noOnion', 'extraCheese', 'thin'] as const;
    for (const [i, c] of written.entries()) {
      const row = ids.find((x) => x['modifier_id'] === choice[c])!;
      db.prepare(`UPDATE order_item_modifiers SET sort_order = 0, created_at = ? WHERE id = ?`).run(
        new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
        row['id'],
      );
    }
    expect(names(orderId)).toEqual(['No onion', 'Extra cheese', 'Thin crust']);
  });
});
