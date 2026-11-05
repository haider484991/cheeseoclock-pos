import log from 'electron-log/main';
import type { OrderStatus, PracticeClearBlock, PracticeClearPreview } from '@cheeseoclock/shared-types';
import type { AppDatabase } from '../connection.js';
import { nowIso, type Actor } from './base.js';
import { enqueueSync } from './sync-repo.js';
import { writeAudit } from './audit-repo.js';
import { checkTestDelete, deleteTestOrder, discardDraft } from './order-repo.js';
import { deleteCustomer } from './customer-repo.js';

/**
 * "Clear practice orders" (Settings → About; owner, 5 Nov 2026: "we want only
 * the logs to clear nothing else menu and items should be there", with "give
 * option to delete customer and drawer logs", and only during the trial).
 *
 * Before a till goes live, the owner clears what was rung up while learning:
 *  - every order: a finished or unfinished one the way "Delete test order"
 *    deletes it (order-repo deleteTestOrder: its payments, its foodpanda
 *    terms and its rider payouts soft-deleted, its stock put back, its
 *    waiting FBR rows skipped) but as delete_kind 'practice', so it never
 *    fills the owner's list of deleted test orders; a cart still being rung
 *    up, with no payment, is dropped like any abandoned cart (discardDraft);
 *  - the closed shifts, and the cash in / cash out of the till;
 *  - with the owner's tick only: the saved customers (deleteCustomer: name
 *    and phone blanked, addresses too) and the cash drawer log;
 *  - the order numbers start again at #0001 (order_number_counter is
 *    pure-local: no other till and no report reads it).
 *
 * Never touched: the menu, items, choices, tax, staff, printers, riders,
 * settings, stock levels set by hand, and the hash-chained audit trail,
 * which keeps every row as it was plus one 'clear_practice_orders' summary.
 * Every row goes through the usual soft delete + sync_queue + audit, in one
 * transaction: all of it or none of it.
 *
 * Only on a till on its own, with no licence key, FBR not live and no shift
 * open (PracticeClearEnv says the first three; the caller reads them).
 */

/** What the main process knows about the till, outside the database rows. */
export interface PracticeClearEnv {
  /** A licence key was ever entered (licenceId set): the till is a paying shop's. */
  licensed: boolean;
  /** FBR invoicing in production mode. */
  fbrLive: boolean;
  /** The second-till link is on (sync mode not 'off'). */
  secondTill: boolean;
}

export const PRACTICE_CLEAR_REASON = 'Practice order, cleared before the till went live';

export const PRACTICE_CLEAR_REFUSED = {
  licensed:
    'This till has a licence key, so its sales history stays. Practice orders can only be cleared during the free trial, before a licence key is entered.',
  fbrLive: 'FBR invoicing is live on this till, so its sales stay. Turn FBR off first, or ask us.',
  shiftOpen: 'A shift is open. Close the shift first, then clear the practice orders.',
  secondTill: 'A second till is connected to this one. Practice orders can only be cleared on a till on its own: ask us.',
  unfinishedPaid: 'An unfinished order has a payment on it, or came from the website. Finish it first, then clear.',
  nothing: 'There is nothing to clear.',
} as const;

interface LiveOrder {
  id: string;
  status: OrderStatus;
  source: string;
  payments: number;
}

function liveOrders(db: AppDatabase): LiveOrder[] {
  return (
    db
      .prepare(
        `SELECT o.id, o.status, o.source,
                (SELECT COUNT(*) FROM payments p WHERE p.order_id = o.id AND p.deleted_at IS NULL) AS payments
           FROM orders o
          WHERE o.deleted_at IS NULL
          ORDER BY o.created_at, o.id`,
      )
      .all() as Array<{ id: string; status: OrderStatus; source: string; payments: number }>
  ).map((r) => ({ id: r.id, status: r.status, source: r.source, payments: Number(r.payments) }));
}

function count(db: AppDatabase, sql: string, ...params: unknown[]): number {
  const row = db.prepare(sql).get(...params) as { n: number } | undefined;
  return Number(row?.n ?? 0);
}

/**
 * What is on the till now and why it can't be cleared yet (practice:preview).
 * Pure read. Each order is checked the way "Delete test order" checks it, so
 * an order that one couldn't delete (taken on the other till, sent to FBR in
 * production) stops the whole clear, with its reason.
 */
export function practiceClearPreview(db: AppDatabase, deviceId: string, env: PracticeClearEnv): PracticeClearPreview {
  const blocks: PracticeClearBlock[] = [];
  if (env.licensed) blocks.push({ code: 'licensed', message: PRACTICE_CLEAR_REFUSED.licensed });
  if (env.fbrLive) blocks.push({ code: 'fbr_live', message: PRACTICE_CLEAR_REFUSED.fbrLive });
  if (env.secondTill || count(db, `SELECT COUNT(*) AS n FROM shifts WHERE device_id <> ? AND deleted_at IS NULL`, deviceId) > 0) {
    blocks.push({ code: 'second_till', message: PRACTICE_CLEAR_REFUSED.secondTill });
  }
  if (count(db, `SELECT COUNT(*) AS n FROM shifts WHERE closed_at IS NULL AND deleted_at IS NULL`) > 0) {
    blocks.push({ code: 'shift_open', message: PRACTICE_CLEAR_REFUSED.shiftOpen });
  }

  const orders = liveOrders(db);
  const refusals = new Map<string, number>();
  for (const o of orders) {
    if (o.status === 'open') {
      if (o.source !== 'pos' || o.payments > 0) refusals.set(PRACTICE_CLEAR_REFUSED.unfinishedPaid, (refusals.get(PRACTICE_CLEAR_REFUSED.unfinishedPaid) ?? 0) + 1);
      continue;
    }
    const check = checkTestDelete(db, o.id, deviceId);
    if (!check.ok) refusals.set(check.refusal, (refusals.get(check.refusal) ?? 0) + 1);
  }
  for (const [refusal, n] of refusals) {
    blocks.push({ code: 'order_refused', message: `${n === 1 ? '1 order' : `${n} orders`} can't be cleared: ${refusal}` });
  }

  return {
    orders: orders.length,
    shifts: count(db, `SELECT COUNT(*) AS n FROM shifts WHERE deleted_at IS NULL`),
    cashMovements: count(db, `SELECT COUNT(*) AS n FROM cash_movements WHERE deleted_at IS NULL`),
    drawerLog: count(db, `SELECT COUNT(*) AS n FROM drawer_opens WHERE deleted_at IS NULL`),
    customers: count(db, `SELECT COUNT(*) AS n FROM customers WHERE deleted_at IS NULL`),
    blocks,
  };
}

export interface PracticeClearInput {
  customers: boolean;
  drawerLog: boolean;
  /** The owner whose PIN or password confirmed it. */
  ownerUserId: string;
}

export interface PracticeClearDone {
  orders: number;
  shifts: number;
  cashMovements: number;
  drawerLog: number;
  customers: number;
  /** Orders cleared that came from the website (the bridge tells the site). */
  webOrderIds: string[];
  /** Every order cleared (the print queue drops what was still waiting for them). */
  orderIds: string[];
}

/** Soft-delete every live row of a replicable table: synced and audited one by one. */
function softDeleteAll(db: AppDatabase, table: 'shifts' | 'cash_movements' | 'drawer_opens', now: string, actorUserId: string): number {
  const rows = db.prepare(`SELECT * FROM ${table} WHERE deleted_at IS NULL ORDER BY created_at, id`).all() as Array<
    Record<string, unknown> & { id: string }
  >;
  const update = db.prepare(`UPDATE ${table} SET deleted_at = ?, updated_at = ?, version = version + 1 WHERE id = ? AND deleted_at IS NULL`);
  let n = 0;
  for (const row of rows) {
    if (Number(update.run(now, now, row.id).changes) === 0) continue;
    enqueueSync(db, { entityType: table, entityId: row.id, op: 'delete', payload: { id: row.id, deletedAt: now } });
    writeAudit(db, { entityType: table, entityId: row.id, action: 'clear_practice_orders', actorUserId, before: row, after: { deletedAt: now } });
    n += 1;
  }
  return n;
}

/**
 * Clear the practice orders (practice:clear, after the owner's secret was
 * checked and the safety copy made). One transaction; a refusal throws its
 * words and writes nothing.
 */
export function clearPracticeOrders(
  db: AppDatabase,
  input: PracticeClearInput,
  actor: Actor & { userId: string },
  env: PracticeClearEnv,
): PracticeClearDone {
  return db.transaction((): PracticeClearDone => {
    const preview = practiceClearPreview(db, actor.deviceId, env);
    const block = preview.blocks[0];
    if (block) throw new Error(block.message);
    const nothing =
      preview.orders === 0 &&
      preview.shifts === 0 &&
      preview.cashMovements === 0 &&
      (!input.drawerLog || preview.drawerLog === 0) &&
      (!input.customers || preview.customers === 0);
    if (nothing) throw new Error(PRACTICE_CLEAR_REFUSED.nothing);

    const now = nowIso();
    const orderIds: string[] = [];
    const webOrderIds: string[] = [];
    for (const o of liveOrders(db)) {
      if (o.status === 'open') {
        discardDraft(db, o.id, actor);
      } else {
        const done = deleteTestOrder(
          db,
          {
            orderId: o.id,
            reason: PRACTICE_CLEAR_REASON,
            // Practice food was never really made: whatever it still holds goes back.
            restock: true,
            expectStatus: o.status,
            ownerUserId: input.ownerUserId,
            kind: 'practice',
          },
          actor,
        );
        if (done.web) webOrderIds.push(o.id);
      }
      orderIds.push(o.id);
    }

    // Rider payouts went with their orders; what is left is cash in / out.
    const cashMovements = softDeleteAll(db, 'cash_movements', now, actor.userId);
    const shifts = softDeleteAll(db, 'shifts', now, actor.userId);
    const drawerLog = input.drawerLog ? softDeleteAll(db, 'drawer_opens', now, actor.userId) : 0;

    let customers = 0;
    if (input.customers) {
      const ids = db.prepare(`SELECT id FROM customers WHERE deleted_at IS NULL ORDER BY created_at, id`).all() as Array<{ id: string }>;
      for (const { id } of ids) {
        deleteCustomer(db, id, actor);
        customers += 1;
      }
    }

    // Order numbers start again at #0001 (pure-local: the counter is this till's own).
    db.prepare(`DELETE FROM order_number_counter`).run();

    writeAudit(db, {
      entityType: 'till',
      entityId: actor.deviceId,
      action: 'clear_practice_orders',
      actorUserId: actor.userId,
      before: {
        orders: preview.orders,
        shifts: preview.shifts,
        cashMovements: preview.cashMovements,
        drawerLog: preview.drawerLog,
        customers: preview.customers,
      },
      after: {
        clearedAt: now,
        ownerUserId: input.ownerUserId,
        options: { customers: input.customers, drawerLog: input.drawerLog },
        orders: orderIds.length,
        shifts,
        cashMovements,
        drawerLog,
        customers,
      },
    });
    log.info('Practice orders cleared', { orders: orderIds.length, shifts, cashMovements, drawerLog, customers });
    return { orders: orderIds.length, shifts, cashMovements, drawerLog, customers, webOrderIds, orderIds };
  })();
}
