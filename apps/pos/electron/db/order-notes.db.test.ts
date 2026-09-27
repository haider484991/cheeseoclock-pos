/**
 * The order's own notes on paper (audit 2026-09-27), from the database the
 * till prints from: the counter's "Order notes" box (orders.delivery_notes)
 * was saved but read by nothing — and not even saved for a takeaway with no
 * customer typed in — so neither the kitchen nor the rider ever saw it.
 *
 * On a real database built from the migrations, through the real
 * repositories and the real renderers the print spooler uses:
 *   - the note on an order with no customer is saved (row, sync entry and
 *     hash-chained audit row), only while the order is still being taken;
 *   - the order snapshot the spooler prints from carries it, and the kitchen
 *     ticket and the bill print it;
 *   - a website order's note (stored by the web bridge as "[web] …") prints
 *     the same way, without the tag.
 *
 * node:sqlite behind better-sqlite3's shape (better-sqlite3 here is built for
 * Electron); skips where it is missing. Names and notes are made up.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { decodeEscPos, renderKitchenTicket, renderReceipt } from '@cheeseoclock/printer-core';
import { DatabaseSync, openMigrated } from './costing-shop.fixture.js';
import { verifyAuditChain, type AuditChainRow } from './audit-chain.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });
vi.mock('electron-log/main', () => ({ default: { info: () => {}, warn: () => {}, error: () => {} } }));
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }));

const live = describe.skipIf(!DatabaseSync);

const DEV = 'till-1';
const T0 = '2026-01-01T00:00:00.000Z';
const ALI = { userId: 'u_ali', deviceId: DEV };
const NOW = new Date(2026, 8, 27, 19, 35);
const BRANDING = { storeName: 'Test Shop' };

type Db = ReturnType<typeof openMigrated>;

function freshDb(): Db {
  const db = openMigrated();
  db.prepare(`INSERT INTO users (id, full_name, pin_hash, role, created_at, updated_at, device_id) VALUES ('u_ali', 'Ali', 'x', 'cashier', ?, ?, ?)`).run(T0, T0, DEV);
  return db;
}

const rows = (bytes: Uint8Array) => decodeEscPos(bytes).map((r) => r.text);

let orders: typeof import('./repositories/order-repo.js');
let customers: typeof import('./repositories/customer-repo.js');

beforeAll(async () => {
  if (!DatabaseSync) return;
  orders = await import('./repositories/order-repo.js');
  customers = await import('./repositories/customer-repo.js');
});

live('the order’s notes, from the database to the paper', () => {
  it('a takeaway with only a note: the note is saved on the order (row, sync, audit), trimmed', () => {
    const db = freshDb();
    const order = orders.createOrder(db, { mode: 'takeaway' }, ALI);
    customers.setOrderDeliveryNotes(db, order.id, '  Collect by 7pm, extra napkins  ', ALI);

    expect(db.prepare(`SELECT delivery_notes FROM orders WHERE id = ?`).get(order.id)).toEqual({
      delivery_notes: 'Collect by 7pm, extra napkins',
    });
    const sync = db
      .prepare(`SELECT payload_json FROM sync_queue WHERE entity_type = 'orders' AND entity_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`)
      .get(order.id) as { payload_json: string };
    expect(JSON.parse(sync.payload_json)).toMatchObject({ id: order.id, deliveryNotes: 'Collect by 7pm, extra napkins' });
    const audit = db
      .prepare(`SELECT actor_user_id AS actor, before_json AS before, after_json AS after FROM audit_log WHERE entity_id = ? AND action = 'set_order_note'`)
      .get(order.id) as { actor: string; before: string; after: string };
    expect(audit.actor).toBe('u_ali');
    expect(JSON.parse(audit.before)).toMatchObject({ deliveryNotes: null });
    expect(JSON.parse(audit.after)).toMatchObject({ deliveryNotes: 'Collect by 7pm, extra napkins' });
    const chain = db
      .prepare(
        `SELECT rowid, id, entity_type AS entityType, entity_id AS entityId, action, actor_user_id AS actorUserId,
                before_json AS beforeJson, after_json AS afterJson, ip, created_at AS createdAt,
                prev_hash AS prevHash, row_hash AS rowHash
           FROM audit_log ORDER BY rowid`,
      )
      .all() as unknown as AuditChainRow[];
    expect(verifyAuditChain(chain).ok).toBe(true);

    // Blank takes it off again; the same words twice write nothing new.
    customers.setOrderDeliveryNotes(db, order.id, '   ', ALI);
    expect(orders.getOrderSnapshot(db, order.id)?.deliveryNotes).toBeNull();
  });

  it('only while the order is still being taken', () => {
    const db = freshDb();
    const order = orders.createOrder(db, { mode: 'takeaway' }, ALI);
    db.prepare(`UPDATE orders SET status = 'sent_to_kitchen' WHERE id = ?`).run(order.id);
    expect(() => customers.setOrderDeliveryNotes(db, order.id, 'Too late', ALI)).toThrow(/already been sent/);
    expect(orders.getOrderSnapshot(db, order.id)?.deliveryNotes).toBeNull();
  });

  it('the snapshot the spooler prints from carries the note, and the kitchen ticket and the bill print it', () => {
    const db = freshDb();
    const order = orders.createOrder(db, { mode: 'takeaway' }, ALI);
    customers.setOrderDeliveryNotes(db, order.id, 'Collect by 7pm', ALI);
    const snap = orders.getOrderSnapshot(db, order.id)!;
    expect(snap.deliveryNotes).toBe('Collect by 7pm');

    const kitchen = rows(renderKitchenTicket(snap, { now: NOW }));
    expect(kitchen).toContain('!! ORDER NOTE: Collect by 7pm');
    const bill = rows(renderReceipt(snap, { branding: BRANDING }));
    expect(bill).toContain('BILL - NOTHING TO PAY');
    expect(bill).toContain('Order note: Collect by 7pm');
  });

  it('a website order’s note, as the web bridge stores it, prints the same way — without the [web] tag', () => {
    const db = freshDb();
    const web = orders.createOrder(db, { mode: 'delivery', source: 'web', notes: '[web] Near the park, bell twice' }, ALI);
    const snap = orders.getOrderSnapshot(db, web.id)!;
    const kitchen = rows(renderKitchenTicket(snap, { now: NOW }));
    expect(kitchen).toContain('!! ORDER NOTE: Near the park, bell twice');
    expect(kitchen).toContain('WEBSITE ORDER');
    const bill = rows(renderReceipt(snap, { branding: BRANDING }));
    expect(bill).toContain('Order note: Near the park, bell twice');
    expect([...kitchen, ...bill].join(' ')).not.toContain('[web]');

    // The bridge's tag alone ("[web order]": the customer wrote nothing) is no note.
    const bare = orders.createOrder(db, { mode: 'delivery', source: 'web', notes: '[web order]' }, ALI);
    const bareSnap = orders.getOrderSnapshot(db, bare.id)!;
    expect(rows(renderKitchenTicket(bareSnap, { now: NOW })).some((x) => x.includes('ORDER NOTE'))).toBe(false);
    expect(rows(renderReceipt(bareSnap, { branding: BRANDING })).some((x) => x.includes('Order note'))).toBe(false);
  });
});
