/**
 * ORIGINAL or DUPLICATE, through the real print spooler and the real print
 * log (document_prints), on a database built from every migration, with a
 * fake printer that records what it is sent:
 *  - the owner's rule (27 Sep 2026): the paper the till prints by itself is
 *    the original; every paper printed with a print button says DUPLICATE /
 *    Reprint #N — the first of its kind too (a bill from the board, a
 *    cash-on-delivery receipt from Order History);
 *  - the SHOP COPY is its own series; a refund slip is its own document;
 *  - a retry after a definite failure is still the original; after a failure
 *    that may have printed (or a crash mid-send) it says "Printer retry";
 *  - a press while the paper is still waiting joins it: one paper;
 *  - a bill printed with a print button is a DUPLICATE bill, and the receipt
 *    the till prints at payment is the ORIGINAL receipt;
 *  - a cancelled order never prints as a receipt; a cancelled order's waiting
 *    kitchen ticket never prints, and CANCELLED goes only when one did;
 *  - FBR: noop prints nothing, a duplicate keeps the same number, a reprint
 *    never sends anything to FBR again.
 *
 * node's own `node:sqlite` stands in for better-sqlite3 (built for Electron
 * here); skipped where it is missing. Orders are made-up snapshots.
 */
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { escPosToText } from '@cheeseoclock/printer-core';
import type {
  Cents,
  OrderNumber,
  OrderSnapshot,
  PrintResult,
  PrinterConnectionConfig,
  UUID,
} from '@cheeseoclock/shared-types';
import type { AppDatabase } from '../db/connection.js';
import { recordDrawerOpen } from '../db/repositories/drawer-open-repo.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

const h = vi.hoisted(() => ({
  sends: [] as Uint8Array[],
  /** What the fake printer answers, one per send; ok when empty. */
  script: [] as Array<() => PrintResult | Promise<PrintResult>>,
  snapshots: new Map<string, OrderSnapshot>(),
  /** Who is signed in. */
  user: 'u_cash' as string | null,
}));

vi.mock('electron-log/main', () => ({ default: { info: () => {}, warn: () => {}, error: () => {} } }));
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  app: { getPath: () => '' },
}));
vi.mock('../adapters/printer/factory.js', () => ({
  makePrinterAdapter: (config: PrinterConnectionConfig) => ({
    id: 'fake',
    config,
    connect: async () => {},
    disconnect: async () => {},
    isConnected: () => true,
    send: async (bytes: Uint8Array) => {
      h.sends.push(bytes);
      const next = h.script.shift();
      return next ? next() : { ok: true, durationMs: 1 };
    },
    testPrint: async () => ({ ok: true, durationMs: 1 }),
  }),
}));
vi.mock('../db/repositories/order-repo.js', () => ({
  getOrderSnapshot: (_db: unknown, id: string) => h.snapshots.get(id) ?? null,
}));

// ------------------------------------------------------------------ the db --

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
const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');
const T0 = '2026-01-01T00:00:00.000Z';

function openMigrated(): AppDatabase {
  if (!DatabaseSync) throw new Error('node:sqlite unavailable');
  const raw = new DatabaseSync(':memory:');
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(join(MIGRATIONS, f), 'utf8'));
  }
  raw.exec('PRAGMA foreign_keys = OFF'); // the orders are made-up snapshots
  // The log "started" before every fixture below (one test moves it).
  raw.prepare(`UPDATE settings SET value_json = ? WHERE key = 'printing.printLogSince'`).run(JSON.stringify(T0));
  const user = raw.prepare(
    `INSERT INTO users (id, full_name, pin_hash, role, created_at, updated_at, device_id) VALUES (?, ?, 'x', ?, ?, ?, 'dev-1')`,
  );
  user.run('u_cash', 'Ali Akbar', 'cashier', T0, T0);
  user.run('u_mgr', 'Sana Khan', 'manager', T0, T0);
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

// -------------------------------------------------------------- fixtures --

const id = (s: string) => s as UUID;
const cents = (n: number) => n as Cents;
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

interface OrderOpts {
  mode?: OrderSnapshot['order']['mode'];
  status?: OrderSnapshot['order']['status'];
  paid?: boolean;
  method?: string;
  createdAt?: string;
  paidAt?: string;
  /** The till that took the money (default this one, 'dev-1'). */
  paidOn?: string;
}

/**
 * Rs 1,160 (1,000 + 16% tax); paid in cash unless `paid: false`. The
 * snapshot is made up; the payment is also written to `payments`, with the
 * till that took it (the FBR row lives on that till).
 */
function order(orderId: string, o: OrderOpts = {}): string {
  const paid = o.paid !== false;
  const paidAt = o.paidAt ?? minutesAgo(2);
  if (paid) {
    db.prepare(
      `INSERT OR REPLACE INTO payments (id, order_id, method, amount_cents, tendered_cents, reference_no,
                                        received_by_user_id, paid_at, created_at, updated_at, device_id)
       VALUES (?, ?, ?, 116000, NULL, NULL, 'u_cash', ?, ?, ?, ?)`,
    ).run(`${orderId}-p0`, orderId, o.method ?? 'cash', paidAt, paidAt, paidAt, o.paidOn ?? 'dev-1');
  }
  h.snapshots.set(orderId, {
    order: {
      id: id(orderId),
      orderNumber: `20260926-${orderId.slice(-4).padStart(4, '0')}` as OrderNumber,
      mode: o.mode ?? 'takeaway',
      status: o.status ?? (paid ? 'paid' : 'sent_to_kitchen'),
      tableId: null,
      customerId: null,
      cashierId: id('u_cash'),
      shiftId: null,
      source: 'pos',
      notes: null,
      subtotalCents: cents(100_000),
      discountCents: cents(0),
      taxCents: cents(16_000),
      totalCents: cents(116_000),
      createdAt: o.createdAt ?? minutesAgo(5),
      paidAt: paid ? paidAt : null,
      voidedAt: null,
      voidedBy: null,
      voidReason: null,
      assignedRiderId: null,
      dispatchedAt: null,
      deliveredAt: null,
    },
    items: [
      {
        id: id(`${orderId}-i1`),
        orderId: id(orderId),
        menuItemId: id('m1'),
        comboId: null,
        parentOrderItemId: null,
        quantity: 1,
        unitPriceCents: cents(100_000),
        lineTotalCents: cents(100_000),
        taxCategoryId: id('t1'),
        notes: null,
        kitchenStatus: 'pending',
        menuItemName: 'Test Pizza',
        categoryName: 'Pizza',
        prepStation: 'kitchen',
        taxRateBps: 1600,
        modifiers: [],
      },
    ],
    discounts: [],
    payments: paid
      ? [
          {
            id: id(`${orderId}-p0`),
            orderId: id(orderId),
            method: (o.method ?? 'cash') as 'cash',
            amountCents: cents(116_000),
            tenderedCents: null,
            referenceNo: null,
            receivedByUserId: id('u_cash'),
            paidAt,
          },
        ]
      : [],
    cashierName: 'Ali Akbar',
    tableLabel: null,
    customerName: null,
    customerPhone: null,
    deliveryAddress: o.mode === 'delivery' ? 'Test Street 1' : null,
    rider: null,
  } as unknown as OrderSnapshot);
  return orderId;
}

function snap(orderId: string): OrderSnapshot {
  return h.snapshots.get(orderId)!;
}

/** A refund of `amount` in cash (approved by the manager), written now. */
function addRefund(orderId: string, amount: number, reason = 'cold pizza'): string {
  const s = snap(orderId);
  const at = new Date().toISOString();
  s.payments.push({
    id: id(`${orderId}-rf${s.payments.length}`),
    orderId: id(orderId),
    method: 'cash',
    amountCents: cents(-amount),
    tenderedCents: null,
    referenceNo: `partial-refund: ${reason}`,
    receivedByUserId: id('u_mgr'),
    paidAt: at,
  } as OrderSnapshot['payments'][number]);
  return at;
}

const texts = () => h.sends.map((b) => escPosToText(b));
const last = () => escPosToText(h.sends.at(-1)!);
const count = (text: string, needle: string) => text.split(needle).length - 1;
const fail = (extra: Partial<NonNullable<PrintResult['error']>> = {}) => (): PrintResult => ({
  ok: false,
  durationMs: 1,
  error: { code: 'printer_offline', message: 'fake offline', recoverable: true, ...extra },
});

interface LogRow {
  document: string;
  doc_key: string;
  copy: string;
  print_no: number;
  outcome: string;
  reason: string;
  requested_by_user_id: string | null;
  approved_by_user_id: string | null;
  fbr_irn: string | null;
}
function logRows(orderId: string): LogRow[] {
  return db
    .prepare(
      `SELECT document, doc_key, copy, print_no, outcome, reason, requested_by_user_id,
              approved_by_user_id, fbr_irn
         FROM document_prints WHERE order_id = ? ORDER BY created_at, rowid`,
    )
    .all(orderId) as unknown as LogRow[];
}
function jobs(orderId: string, kind: string) {
  return db
    .prepare(`SELECT id, status, attempts, last_error AS note FROM print_queue WHERE order_id = ? AND job_kind = ? ORDER BY rowid`)
    .all(orderId, kind) as Array<{ id: string; status: string; attempts: number; note: string | null }>;
}
/** Make every waiting job of the order due now. */
function dueNow(orderId: string): void {
  db.prepare(`UPDATE print_queue SET next_attempt_at = ? WHERE order_id = ? AND status = 'pending'`).run(
    new Date(Date.now() - 1).toISOString(),
    orderId,
  );
}

let db: AppDatabase;
const spooler = async () => (await import('./print-spooler.js')).printSpooler;
/**
 * The drawer_opens row the repository writes WITH the cash (migration 0042):
 * the drawer pulse is for it — no row, no pulse.
 */
function cash(kind: 'sale' | 'refund' = 'sale'): { drawerOpenId: string } {
  const amountCents = kind === 'refund' ? -116_000 : 116_000;
  return { drawerOpenId: recordDrawerOpen(db, { kind, amountCents }, { userId: 'u_cash', deviceId: 'dev-1' }).id };
}
async function policy(p: Partial<{ kitchenTicket: boolean; shopCopy: 'never' | 'delivery' | 'always'; deliveryBillOnDispatch: boolean }>) {
  const { getPrintPolicy, setPrintPolicy } = await import('./printer-config.js');
  setPrintPolicy(db, { ...getPrintPolicy(db), ...p });
}
async function fbrMode(mode: 'noop' | 'sandbox' | 'production') {
  const { setSetting } = await import('../db/repositories/settings-repo.js');
  setSetting(db, 'fbr.config', { mode, sellerNTNCNIC: '', sellerBusinessName: 'Test', sellerProvince: 'Sindh', sellerAddress: '', paused: false });
}
function fbrRow(orderId: string, status: string, irn: string | null, mode = 'production', kind = 'sale', refId = '') {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO fbr_submission_queue (id, order_id, kind, ref_id, payload_json, status, irn, qr_payload, enqueued_at, mode_at_enqueue, created_at, updated_at)
     VALUES (?, ?, ?, ?, '{}', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(`f-${orderId}-${kind}-${refId}`, orderId, kind, refId, status, irn, irn ? `https://verify.example/${irn}` : null, now, mode, now, now);
}
const fbrRows = () => Number((db.prepare(`SELECT COUNT(*) AS n FROM fbr_submission_queue`).get() as { n: number }).n);

beforeEach(async () => {
  if (!DatabaseSync) return;
  h.sends.length = 0;
  h.script.length = 0;
  h.snapshots.clear();
  h.user = 'u_cash';
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }); // no background ticks
  db = openMigrated();
  const s = await spooler();
  s.init(db, { deviceId: 'dev-1', currentUserId: () => h.user });
  await s.whenIdle();
  h.sends.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ----------------------------------------------------------------- tests --

describe.skipIf(!DatabaseSync)('receipts: original, then DUPLICATE', () => {
  it('the payment receipt is the original; each reprint says DUPLICATE / Reprint #N; the shop copy is never a duplicate', async () => {
    const s = await spooler();
    await policy({ shopCopy: 'always' });
    const oid = order('o0101');
    s.onOrderEvent(oid, 'paid', cash());
    await s.whenIdle();
    const receipt = texts().find((t) => t.includes('RECEIPT'))!;
    expect(receipt).not.toContain('DUPLICATE');
    expect(count(receipt, 'SHOP COPY')).toBe(1);
    expect(count(receipt, 'PAID - CASH')).toBe(2);
    expect(logRows(oid).filter((r) => r.document === 'receipt')).toMatchObject([
      { copy: 'customer', print_no: 0, outcome: 'printed', reason: 'payment', requested_by_user_id: 'u_cash' },
      { copy: 'shop', print_no: 0, outcome: 'printed', reason: 'payment' },
    ]);

    expect(s.reprintReceipt(oid, { requestedByUserId: 'u_cash' })).toEqual({
      status: 'queued',
      document: 'receipt',
      duplicate: true,
      printNo: 1,
      reprintNo: 1,
    });
    await s.whenIdle();
    const first = last();
    expect(first.split('\n')[1]).toBe('DUPLICATE');
    expect(first).toContain('Reprint #1');
    expect(first).toContain('by Ali Akbar');
    expect(first).toContain('PAID - CASH (DUPLICATE)');
    expect(first).toContain('** DUPLICATE - Reprint #1 **');
    expect(first).not.toContain('SHOP COPY');

    s.reprintReceipt(oid, { requestedByUserId: 'u_mgr' });
    await s.whenIdle();
    expect(last()).toContain('Reprint #2');
    expect(last()).toContain('by Sana Khan');
    const customer = logRows(oid).filter((r) => r.copy === 'customer' && r.document === 'receipt');
    expect(customer.map((r) => [r.print_no, r.reason])).toEqual([
      [0, 'payment'],
      [1, 'reprint'],
      [2, 'reprint'],
    ]);
    // Each paper is in the audit trail too.
    const actions = db
      .prepare(`SELECT action FROM audit_log WHERE entity_type = 'document_prints' ORDER BY rowid`)
      .all()
      .map((r) => (r as { action: string }).action);
    expect(actions.filter((a) => a === 'print_duplicate')).toHaveLength(2);
  });

  it("a cash sale's drawer pulse is not a paper: the first reprint is #1 (nothing counted twice)", async () => {
    const s = await spooler();
    const oid = order('o0102');
    s.onOrderEvent(oid, 'paid', cash());
    await s.whenIdle();
    expect(texts().find((t) => t.includes('RECEIPT'))).not.toContain('DUPLICATE');
    expect(s.planReprint(oid).priorAll).toBe(1);
    expect(s.planReprint(oid).priorManual).toBe(0);
    s.reprintReceipt(oid, { requestedByUserId: 'u_cash' });
    await s.whenIdle();
    expect(last()).toContain('Reprint #1');
    expect(logRows(oid).map((r) => r.document)).toEqual(['kitchen', 'receipt', 'receipt']);
  });

  it('a retry after a definite failure is still the original, with one log row', async () => {
    const s = await spooler();
    await policy({ kitchenTicket: false });
    h.script.push(fail());
    const oid = order('o0103');
    s.onOrderEvent(oid, 'paid', {});
    await s.whenIdle();
    expect(logRows(oid)).toEqual([]);
    dueNow(oid);
    await s.whenIdle();
    expect(h.sends).toHaveLength(2);
    expect(last()).not.toContain('DUPLICATE');
    expect(logRows(oid)).toMatchObject([{ print_no: 0, outcome: 'printed' }]);
  });

  it('a failure that may have printed: logged unsure, and the retry says DUPLICATE (printer retry)', async () => {
    const s = await spooler();
    await policy({ kitchenTicket: false });
    h.script.push(fail({ code: 'timeout', maybeSent: true }));
    const oid = order('o0104');
    s.onOrderEvent(oid, 'paid', {});
    await s.whenIdle();
    expect(logRows(oid)).toMatchObject([{ print_no: 0, outcome: 'unsure' }]);
    dueNow(oid);
    await s.whenIdle();
    const retry = last();
    expect(retry).toContain('Printer retry');
    expect(retry).toContain('The first copy may have printed');
    expect(retry).toContain('** DUPLICATE - printer retry **');
    expect(logRows(oid)).toMatchObject([
      { print_no: 0, outcome: 'unsure' },
      { print_no: 1, outcome: 'printed' },
    ]);
    // A printer retry is not a reprint by anyone: the cashier's allowance is untouched.
    expect(s.planReprint(oid).priorManual).toBe(0);
    const audit = db.prepare(`SELECT action FROM audit_log WHERE entity_type = 'document_prints' ORDER BY rowid`).all();
    expect(audit.map((r) => (r as { action: string }).action)).toEqual(['print_unsure', 'print_duplicate']);
  });

  it('the plan is on the job before the bytes go out; a crash mid-send is logged unsure at boot and the re-send says DUPLICATE', async () => {
    const s = await spooler();
    await policy({ kitchenTicket: false });
    let release!: () => void;
    h.script.push(() => new Promise<PrintResult>((r) => (release = () => r({ ok: true, durationMs: 1 }))));
    const oid = order('o0105');
    s.onOrderEvent(oid, 'paid', {});
    await vi.waitFor(() => expect(h.sends).toHaveLength(1));
    const inFlight = db
      .prepare(`SELECT status, sending_plan_json AS plan FROM print_queue WHERE order_id = ?`)
      .get(oid) as { status: string; plan: string };
    expect(inFlight.status).toBe('in_flight');
    const plan = JSON.parse(inFlight.plan) as { papers: Array<Record<string, unknown>> };
    expect(plan.papers).toMatchObject([{ document: 'receipt', copy: 'customer', printNo: 0, reason: 'payment' }]);
    release();
    await s.whenIdle();
    expect((db.prepare(`SELECT sending_plan_json AS p FROM print_queue WHERE order_id = ?`).get(oid) as { p: unknown }).p).toBeNull();

    // The same send again, but the till dies mid-way: at boot the job is still in flight with its plan.
    const o2 = order('o0106');
    const { enqueuePrintJob, setSendingPlan } = await import('../db/repositories/print-queue-repo.js');
    const job = enqueuePrintJob(db, { kind: 'receipt', orderId: o2, openDrawer: false, copies: ['customer'], reason: 'payment' });
    setSendingPlan(db, job.id, { papers: [{ ...plan.papers[0], orderNumber: snap(o2).order.orderNumber }] });
    db.prepare(`UPDATE print_queue SET status = 'in_flight' WHERE id = ?`).run(job.id);
    h.sends.length = 0;
    s.init(db, { deviceId: 'dev-1', currentUserId: () => h.user });
    await s.whenIdle();
    expect(logRows(o2)).toMatchObject([
      { print_no: 0, outcome: 'unsure' },
      { print_no: 1, outcome: 'printed' },
    ]);
    expect(last()).toContain('** DUPLICATE - printer retry **');
  });
});

describe.skipIf(!DatabaseSync)('a press while the paper is still waiting', () => {
  it('joins the waiting job: exactly one paper, and it is the original', async () => {
    const s = await spooler();
    await policy({ kitchenTicket: false });
    h.script.push(fail());
    const oid = order('o0201');
    s.onOrderEvent(oid, 'paid', {});
    await s.whenIdle();
    expect(jobs(oid, 'receipt')).toMatchObject([{ status: 'pending', attempts: 1 }]);
    const r = s.reprintReceipt(oid, { requestedByUserId: 'u_cash' });
    expect(r).toMatchObject({ status: 'merged', duplicate: false, printNo: 0 });
    await s.whenIdle();
    expect(h.sends).toHaveLength(2); // the failed try and the one that printed
    expect(last()).not.toContain('DUPLICATE');
    expect(jobs(oid, 'receipt')).toHaveLength(1);
  });

  it('two presses while the printer is busy give one paper', async () => {
    const s = await spooler();
    await policy({ kitchenTicket: false });
    const oid = order('o0202');
    s.onOrderEvent(oid, 'paid', {});
    await s.whenIdle();
    let release!: () => void;
    h.script.push(() => new Promise<PrintResult>((r) => (release = () => r({ ok: true, durationMs: 1 }))));
    expect(s.reprintReceipt(oid, { requestedByUserId: 'u_cash' }).status).toBe('queued');
    await vi.waitFor(() => expect(h.sends).toHaveLength(2));
    expect(s.reprintReceipt(oid, { requestedByUserId: 'u_cash' }).status).toBe('merged');
    expect(s.reprintReceipt(oid, { requestedByUserId: 'u_cash' }).status).toBe('merged');
    release();
    await s.whenIdle();
    expect(h.sends).toHaveLength(2);
    expect(logRows(oid).filter((r) => r.reason === 'reprint')).toHaveLength(1);
  });
});

describe.skipIf(!DatabaseSync)('bills, receipts, refunds and cancelled orders', () => {
  it("the owner's rule: a bill printed with a print button is a DUPLICATE, even the first one; the paid receipt the till prints by itself is the ORIGINAL", async () => {
    const s = await spooler();
    await policy({ kitchenTicket: false });
    const oid = order('o0301', { paid: false, status: 'sent_to_kitchen' });
    // The board's printer icon on an unpaid order: the first bill, pressed by hand.
    expect(s.reprintReceipt(oid, { requestedByUserId: 'u_cash' })).toMatchObject({
      document: 'bill',
      duplicate: true,
      printNo: 0,
      reprintNo: 1,
    });
    await s.whenIdle();
    const bill1 = last();
    expect(bill1).toContain('BILL - NOT PAID');
    expect(bill1).toContain('PAY AT THE COUNTER');
    expect(bill1.split('\n')[1]).toBe('DUPLICATE');
    expect(bill1).toMatch(/Reprint #1 \| \d\d\/\d\d\/\d{4} \d\d:\d\d \| by Ali Akbar/);
    expect(bill1).toContain('** DUPLICATE - Reprint #1 **');
    // No "Original: …" line: nothing printed before it.
    expect(bill1).not.toContain('Original:');

    // A second press: Reprint #2.
    s.reprintReceipt(oid, { requestedByUserId: 'u_mgr' });
    await s.whenIdle();
    expect(last()).toContain('** DUPLICATE - Reprint #2 **');
    expect(last()).toContain('by Sana Khan');
    // Still no original of this bill: no "Original: …" line.
    expect(last()).not.toContain('Original:');

    // Paid at the counter later (served with the payment): the receipt the till
    // prints by itself is the ORIGINAL — the bill and the receipt are different papers.
    const paidSnap = snap(order('o0301', { status: 'served' }));
    expect(paidSnap.order.paidAt).not.toBeNull();
    s.onOrderEvent(oid, 'payment_captured', {});
    await s.whenIdle();
    expect(last()).toContain('RECEIPT');
    expect(last()).toContain('PAID - CASH');
    expect(last()).not.toContain('DUPLICATE');

    s.reprintReceipt(oid, { requestedByUserId: 'u_cash' });
    await s.whenIdle();
    expect(last()).toContain('RECEIPT');
    expect(last()).toContain('** DUPLICATE - Reprint #1 **');
    expect(logRows(oid).map((r) => [r.document, r.print_no, r.reason])).toEqual([
      ['bill', 1, 'reprint'],
      ['bill', 1, 'reprint'],
      ['receipt', 0, 'payment'],
      ['receipt', 1, 'reprint'],
    ]);
    // Both bills pressed by hand are DUPLICATEs in the audit trail too.
    const actions = db
      .prepare(`SELECT action FROM audit_log WHERE entity_type = 'document_prints' ORDER BY rowid`)
      .all()
      .map((r) => (r as { action: string }).action);
    expect(actions).toEqual(['print_duplicate', 'print_duplicate', 'print_original', 'print_duplicate']);
  });

  it("the owner's rule: a cash-on-delivery receipt first printed by hand is a DUPLICATE, not 'Printed later'; the dispatch paper stays the original", async () => {
    const s = await spooler();
    await policy({ kitchenTicket: false, shopCopy: 'never' });
    // Out with the rider: the dispatch bill (automatic) is the original bill.
    const oid = order('o0312', { mode: 'delivery', paid: false, status: 'out_for_delivery' });
    s.onOrderEvent(oid, 'dispatched');
    await s.whenIdle();
    expect(last()).toContain('BILL - NOT PAID');
    expect(last()).not.toContain('DUPLICATE');
    // The rider brings the money back (paid long ago, as Order History sees it).
    order('o0312', { mode: 'delivery', status: 'delivered', paidAt: minutesAgo(90) });
    s.onOrderEvent(oid, 'payment_captured', cash());
    await s.whenIdle();
    // The customer already holds the dispatch paper: only the drawer.
    expect(logRows(oid).map((r) => r.document)).toEqual(['bill']);
    // Order History, much later: the first RECEIPT, by hand — a DUPLICATE.
    expect(s.planReprint(oid)).toMatchObject({ document: 'receipt', priorAll: 0, reprintNo: 1 });
    expect(s.reprintReceipt(oid, { requestedByUserId: 'u_mgr' })).toMatchObject({ duplicate: true, printNo: 0, reprintNo: 1 });
    await s.whenIdle();
    const receipt = last();
    expect(receipt).toContain('RECEIPT');
    expect(receipt.split('\n')[1]).toBe('DUPLICATE');
    expect(receipt).toContain('PAID - CASH (DUPLICATE)');
    expect(receipt).toContain('** DUPLICATE - Reprint #1 **');
    expect(receipt).not.toContain('Printed later');
    expect(logRows(oid).map((r) => [r.document, r.print_no, r.reason])).toEqual([
      ['bill', 0, 'dispatch'],
      ['receipt', 1, 'reprint'],
    ]);
    // The only receipt there is: it says DUPLICATE, but Order History does not
    // call it a reprint (the bill that left with the rider is another paper).
    const { reprintCounts } = await import('../db/repositories/document-print-repo.js');
    expect(reprintCounts(db, [oid])).toEqual({});
  });

  it("the owner's rule: a receipt pressed for before the rider leaves is a DUPLICATE; the one the till prints at dispatch is the ORIGINAL", async () => {
    const s = await spooler();
    await policy({ kitchenTicket: false, shopCopy: 'never', deliveryBillOnDispatch: true });
    const oid = order('o0313', { mode: 'delivery', status: 'preparing' });
    s.onOrderEvent(oid, 'paid', cash());
    await s.whenIdle();
    // Paid up front, bill on dispatch: nothing on paper yet.
    expect(logRows(oid)).toEqual([]);
    s.reprintReceipt(oid, { requestedByUserId: 'u_cash' });
    await s.whenIdle();
    expect(last()).toContain('** DUPLICATE - Reprint #1 **');
    order('o0313', { mode: 'delivery', status: 'out_for_delivery' });
    s.onOrderEvent(oid, 'dispatched');
    await s.whenIdle();
    expect(last()).toContain('RECEIPT');
    expect(last()).not.toContain('DUPLICATE');
    // A later hand press counts both: Reprint #2 — and names the till's paper as the original.
    s.reprintReceipt(oid, { requestedByUserId: 'u_cash' });
    await s.whenIdle();
    expect(last()).toContain('** DUPLICATE - Reprint #2 **');
    expect(last()).toMatch(/Original: \d\d\/\d\d\/\d{4} \d\d:\d\d/);
    expect(logRows(oid).map((r) => [r.print_no, r.reason])).toEqual([
      [1, 'reprint'],
      [0, 'dispatch'],
      [2, 'reprint'],
    ]);
  });

  it("the owner's rule: a quick double press while the paper is still waiting prints ONE paper", async () => {
    const s = await spooler();
    await policy({ kitchenTicket: false });
    const oid = order('o0314', { paid: false, status: 'preparing' });
    let release!: () => void;
    h.script.push(() => new Promise<PrintResult>((r) => (release = () => r({ ok: true, durationMs: 1 }))));
    s.reprintReceipt(oid, { requestedByUserId: 'u_cash' });
    await vi.waitFor(() => expect(h.sends).toHaveLength(1));
    expect(s.reprintReceipt(oid, { requestedByUserId: 'u_cash' })).toMatchObject({ status: 'merged' });
    release();
    await s.whenIdle();
    expect(h.sends).toHaveLength(1);
    expect(logRows(oid)).toHaveLength(1);
  });

  it('the cash-on-delivery bill at dispatch says NOT PAID and nothing about FBR, and does not wait for FBR', async () => {
    const s = await spooler();
    await fbrMode('production');
    const oid = order('o0302', { mode: 'delivery', paid: false, status: 'out_for_delivery' });
    s.onOrderEvent(oid, 'dispatched');
    await s.whenIdle();
    const bill = texts().filter((t) => t.includes('BILL - NOT PAID'));
    expect(bill).toHaveLength(1);
    expect(bill[0]).toContain('CASH ON DELIVERY');
    expect(bill[0]).toContain('SHOP COPY'); // the default: a shop copy with every delivery bill
    expect(bill[0]).not.toContain('FBR');
  });

  it('a refund prints a REFUND slip — with a signed SHOP COPY when cash went back', async () => {
    const s = await spooler();
    const oid = order('o0303');
    const at = addRefund(oid, 30_000);
    s.onOrderEvent(oid, 'refunded', cash('refund'));
    await s.whenIdle();
    const slip = texts().find((t) => t.includes('REFUND'))!;
    expect(count(slip, 'REFUND SLIP - NOT A RECEIPT FOR PAYMENT')).toBe(2);
    expect(count(slip, 'Rs 300.00 RETURNED')).toBe(2);
    expect(slip).toContain('Customer received Rs 300.00');
    expect(slip).toContain('Approved by: Sana Khan');
    expect(slip).toContain('Refunded by: Ali Akbar');
    expect(slip).toContain('Reason: cold pizza');
    expect(slip).not.toContain('PAID - CASH');
    expect(logRows(oid)).toMatchObject([
      { document: 'refund', doc_key: `refund:${at}`, copy: 'customer', print_no: 0 },
      { document: 'refund', doc_key: `refund:${at}`, copy: 'shop', print_no: 0 },
    ]);
    // A card refund hands no cash back: the customer's slip only.
    h.sends.length = 0;
    const o2 = order('o0310', { method: 'card' });
    addRefund(o2, 10_000);
    s.onOrderEvent(o2, 'refunded', {});
    await s.whenIdle();
    expect(count(last(), 'REFUND SLIP - NOT A RECEIPT FOR PAYMENT')).toBe(1);
    expect(count(last(), 'SHOP COPY')).toBe(0);
    // Shop copies switched off: a cash refund gets the customer's slip only.
    await policy({ shopCopy: 'never' });
    const o3 = order('o0311');
    addRefund(o3, 10_000);
    s.onOrderEvent(o3, 'refunded', cash('refund'));
    await s.whenIdle();
    expect(count(last(), 'SHOP COPY')).toBe(0);
  });

  it('a cancelled order reprinted prints CANCELLED ORDER, never a receipt or a bill', async () => {
    const s = await spooler();
    const oid = order('o0304', { paid: false, status: 'void' });
    snap(oid).order.voidReason = 'Customer left';
    snap(oid).order.voidedBy = id('u_mgr');
    snap(oid).order.voidedAt = new Date().toISOString();
    expect(s.reprintReceipt(oid, { requestedByUserId: 'u_cash' })).toMatchObject({ document: 'void' });
    await s.whenIdle();
    expect(last()).toContain('CANCELLED ORDER');
    expect(last()).toContain('Approved by: Sana Khan');
    expect(last()).not.toContain('RECEIPT');
    expect(last()).not.toContain('BILL - NOT PAID');
    expect(last()).not.toContain('TOTAL');
    // Printed with a print button: a DUPLICATE, like every paper pressed for by hand.
    expect(last()).toContain('** DUPLICATE - Reprint #1 **');
    expect(logRows(oid)).toMatchObject([{ document: 'void', print_no: 1, reason: 'reprint' }]);
  });

  it('a bill queued for a rider that is cancelled before it prints never comes out', async () => {
    const s = await spooler();
    h.script.push(fail());
    const oid = order('o0305', { mode: 'delivery', paid: false, status: 'out_for_delivery' });
    s.onOrderEvent(oid, 'dispatched');
    await s.whenIdle();
    snap(oid).order.status = 'void';
    dueNow(oid);
    await s.whenIdle();
    expect(h.sends).toHaveLength(1);
    expect(jobs(oid, 'receipt')).toMatchObject([{ status: 'done', note: 'Not printed: order cancelled' }]);
  });
});

describe.skipIf(!DatabaseSync)('kitchen tickets', () => {
  it('the automatic ticket failed for good: the chef-hat ticket is the kitchen’s first, unstamped', async () => {
    const s = await spooler();
    h.script.push(fail({ recoverable: false }));
    const oid = order('o0401', { paid: false, status: 'sent_to_kitchen' });
    s.onOrderEvent(oid, 'sent_to_kitchen');
    await s.whenIdle();
    expect(jobs(oid, 'kitchen')).toMatchObject([{ status: 'failed' }]);
    expect(s.reprintKitchenTicket(oid, { requestedByUserId: 'u_cash' })).toMatchObject({ status: 'queued', duplicate: false });
    await s.whenIdle();
    expect(last()).toContain('KITCHEN');
    expect(last()).not.toContain('REPRINT');
    expect(last()).not.toContain('RE-SENT');
  });

  it('after a printed ticket the chef-hat ticket says REPRINT / SAME ORDER; never for a cancelled or finished order', async () => {
    const s = await spooler();
    const oid = order('o0402', { paid: false, status: 'sent_to_kitchen' });
    s.onOrderEvent(oid, 'sent_to_kitchen');
    await s.whenIdle();
    expect(last()).not.toContain('REPRINT');
    s.reprintKitchenTicket(oid, { requestedByUserId: 'u_cash' });
    await s.whenIdle();
    expect(last()).toContain('* REPRINT *');
    expect(last()).toContain('SAME ORDER - DO NOT COOK TWICE');
    expect(last()).toContain('by Ali Akbar');
    expect(logRows(oid)).toMatchObject([
      { document: 'kitchen', print_no: 0, reason: 'auto' },
      { document: 'kitchen', print_no: 1, reason: 'reprint' },
    ]);
    snap(oid).order.status = 'out_for_delivery';
    expect(() => s.reprintKitchenTicket(oid)).toThrow(/done with this order/);
    snap(oid).order.status = 'void';
    expect(() => s.reprintKitchenTicket(oid)).toThrow(/cancelled/);
    snap(oid).order.status = 'open';
    expect(() => s.reprintKitchenTicket(oid)).toThrow(/not gone to the kitchen/);
  });

  it('only fumbled tries so far: the chef-hat ticket says RE-SENT / check before cooking, not "do not cook"', async () => {
    const s = await spooler();
    for (let i = 0; i < 5; i += 1) h.script.push(fail({ code: 'timeout', maybeSent: true }));
    const oid = order('o0403', { paid: false, status: 'preparing' });
    s.onOrderEvent(oid, 'sent_to_kitchen');
    for (let i = 0; i < 5; i += 1) {
      await s.whenIdle();
      dueNow(oid);
    }
    await s.whenIdle();
    expect(jobs(oid, 'kitchen')[0]!.status).toBe('failed');
    // The button says what the paper says (its toast is read out to the kitchen): RE-SENT, not REPRINT.
    expect(s.reprintKitchenTicket(oid, { requestedByUserId: 'u_cash' })).toEqual({
      status: 'queued',
      document: 'kitchen',
      duplicate: false,
      resent: true,
      printNo: 5,
    });
    await s.whenIdle();
    expect(last()).toContain('* RE-SENT *');
    expect(last()).toContain('CHECK FOR TICKET #0403');
    expect(last()).not.toContain('COOK TWICE');
    // That one printed: the next press is a REPRINT, and says so.
    expect(s.reprintKitchenTicket(oid, { requestedByUserId: 'u_cash' })).toMatchObject({ duplicate: true, printNo: 6 });
    expect(s.reprintKitchenTicket(oid)).not.toHaveProperty('resent');
    await s.whenIdle();
    expect(last()).toContain('* REPRINT *');
  });

  it('cancelled while the ticket waits to retry: that ticket never prints, and no CANCELLED slip for a ticket the kitchen never got', async () => {
    const s = await spooler();
    h.script.push(fail());
    const oid = order('o0404', { paid: false, status: 'sent_to_kitchen' });
    s.onOrderEvent(oid, 'sent_to_kitchen');
    await s.whenIdle();
    snap(oid).order.status = 'void';
    s.onOrderEvent(oid, 'cancelled');
    dueNow(oid);
    await s.whenIdle();
    expect(h.sends).toHaveLength(1); // only the failed first try
    expect(jobs(oid, 'kitchen')).toMatchObject([{ status: 'done', note: 'Not printed: order cancelled' }]);
  });

  it('cancelled after a try that may have printed: one paper — the CANCELLED slip', async () => {
    const s = await spooler();
    h.script.push(fail({ code: 'timeout', maybeSent: true }));
    const oid = order('o0405', { paid: false, status: 'sent_to_kitchen' });
    s.onOrderEvent(oid, 'sent_to_kitchen');
    await s.whenIdle();
    Object.assign(snap(oid).order, {
      status: 'void',
      voidReason: 'Customer left',
      voidedBy: 'u_mgr',
      voidedAt: new Date().toISOString(),
    });
    s.onOrderEvent(oid, 'cancelled');
    dueNow(oid);
    await s.whenIdle();
    expect(h.sends).toHaveLength(2);
    expect(last()).toContain('* CANCELLED *');
    expect(last()).toContain('by Sana Khan');
    expect(last()).toContain('Reason: Customer left');
    expect(logRows(oid).map((r) => [r.document, r.outcome])).toEqual([
      ['kitchen', 'unsure'],
      ['kitchen_cancel', 'printed'],
    ]);
  });

  it('a full cash refund while preparing: the refund slip (with its shop copy) AND the kitchen CANCELLED slip', async () => {
    const s = await spooler();
    const oid = order('o0406', { status: 'preparing' });
    s.onOrderEvent(oid, 'paid', cash());
    await s.whenIdle();
    h.sends.length = 0;
    addRefund(oid, 116_000, 'kitchen out of cheese');
    snap(oid).order.status = 'refunded';
    // What orders:refund does: 'refunded', then 'cancelled'.
    s.onOrderEvent(oid, 'refunded', cash('refund'));
    s.onOrderEvent(oid, 'cancelled');
    await s.whenIdle();
    const all = texts().join('\n=====\n');
    expect(count(all, 'REFUND SLIP - NOT A RECEIPT FOR PAYMENT')).toBe(2);
    expect(all).toContain('Customer received Rs 1,160.00');
    expect(all).toContain('* CANCELLED *');
  });

  it('a draft from before the log started, sent after it, prints an unstamped ticket', async () => {
    const s = await spooler();
    db.prepare(`UPDATE settings SET value_json = ? WHERE key = 'printing.printLogSince'`).run(JSON.stringify(new Date().toISOString()));
    const oid = order('o0407', { paid: false, status: 'sent_to_kitchen', createdAt: '2025-12-31T10:00:00.000Z' });
    s.onOrderEvent(oid, 'sent_to_kitchen');
    await s.whenIdle();
    expect(last()).toContain('KITCHEN');
    expect(last()).not.toContain('REPRINT');
  });
});

describe.skipIf(!DatabaseSync)('papers printed before the log', () => {
  it('a receipt the old version printed makes the first reprint a DUPLICATE (#1)', async () => {
    const s = await spooler();
    const oid = order('o0501');
    db.prepare(
      `INSERT INTO print_queue (id, job_kind, order_id, payload_json, status, attempts, next_attempt_at, created_at, updated_at, completed_at, sending_plan_json)
       VALUES ('legacy1', 'receipt', ?, ?, 'done', 0, ?, ?, ?, ?, '"legacy"')`,
    ).run(oid, JSON.stringify({ kind: 'receipt', orderId: oid, openDrawer: false, copies: ['customer'], reason: 'payment' }), T0, T0, T0, T0);
    expect(s.planReprint(oid).priorAll).toBe(1);
    s.reprintReceipt(oid, { requestedByUserId: 'u_mgr' });
    await s.whenIdle();
    expect(last()).toContain('Reprint #1');
    expect(last()).not.toContain('Original:'); // when the old one printed is not known
  });

  it('a receipt for an order paid before the log started, with no job left from then, counts as printed once', async () => {
    const s = await spooler();
    db.prepare(`UPDATE settings SET value_json = ? WHERE key = 'printing.printLogSince'`).run(JSON.stringify(new Date().toISOString()));
    const oid = order('o0502', { paidAt: '2025-11-01T10:00:00.000Z', createdAt: '2025-11-01T09:50:00.000Z' });
    s.reprintReceipt(oid, { requestedByUserId: 'u_mgr' });
    await s.whenIdle();
    expect(last()).toContain('DUPLICATE');
    // …and the old version's done jobs are kept by housekeeping.
    const { purgeOldDoneJobs } = await import('../db/repositories/print-queue-repo.js');
    db.prepare(
      `INSERT INTO print_queue (id, job_kind, order_id, payload_json, status, attempts, next_attempt_at, created_at, updated_at, completed_at, sending_plan_json)
       VALUES ('legacy2', 'kitchen', ?, '{}', 'done', 0, ?, ?, ?, ?, '"legacy"')`,
    ).run(oid, T0, T0, T0, T0);
    purgeOldDoneJobs(db, new Date().toISOString());
    expect(db.prepare(`SELECT id FROM print_queue WHERE id = 'legacy2'`).get()).toBeDefined();
  });
});

describe.skipIf(!DatabaseSync)('FBR on paper', () => {
  it('noop (the default): no FBR text at all, not even "pending"', async () => {
    const s = await spooler();
    const oid = order('o0601');
    fbrRow(oid, 'sent', 'NOOP-123', 'noop');
    s.onOrderEvent(oid, 'paid', {});
    await s.whenIdle();
    const receipt = texts().find((t) => t.includes('RECEIPT'))!;
    expect(receipt).not.toContain('FBR');
    expect(receipt).not.toContain('NOOP-123');
  });

  it('live: the duplicate carries the same FBR number and QR, and a reprint sends nothing to FBR', async () => {
    const s = await spooler();
    await fbrMode('production');
    const oid = order('o0602');
    fbrRow(oid, 'sent', '123456-260926193500-0001');
    s.onOrderEvent(oid, 'paid', {});
    await s.whenIdle();
    const original = texts().find((t) => t.includes('RECEIPT'))!;
    expect(original).toContain('FBR Invoice No: 123456-260926193500-0001');
    const before = fbrRows();
    s.reprintReceipt(oid, { requestedByUserId: 'u_cash' });
    await s.whenIdle();
    expect(last()).toContain('FBR Invoice No: 123456-260926193500-0001');
    expect(last()).toContain('[QR]');
    expect(fbrRows()).toBe(before);
    expect(logRows(oid).filter((r) => r.document === 'receipt').map((r) => r.fbr_irn)).toEqual([
      '123456-260926193500-0001',
      '123456-260926193500-0001',
    ]);
  });

  it('live, the sale not queued yet: the receipt waits for its number instead of printing without it', async () => {
    const s = await spooler();
    await fbrMode('production');
    await policy({ kitchenTicket: false });
    const oid = order('o0603');
    s.onOrderEvent(oid, 'paid', {});
    await s.whenIdle();
    expect(h.sends).toHaveLength(0);
    fbrRow(oid, 'sent', 'LIVE-1');
    dueNow(oid);
    await s.whenIdle();
    expect(last()).toContain('FBR Invoice No: LIVE-1');
  });

  it("a sale the OTHER till sent to FBR: the duplicate here carries that till's number and QR (from the synced print log), at once, and nothing goes to FBR", async () => {
    const s = await spooler();
    await fbrMode('production');
    await policy({ kitchenTicket: false });
    const oid = order('o0605', { paidOn: 'dev-2', paidAt: minutesAgo(20) });
    // Till dev-2's receipt, as it arrives here by sync: its row in the log, no FBR row on this till.
    const { recordDocumentPrint } = await import('../db/repositories/document-print-repo.js');
    recordDocumentPrint(
      db,
      {
        orderId: oid,
        orderNumber: snap(oid).order.orderNumber,
        document: 'receipt',
        docKey: 'receipt',
        copy: 'customer',
        printNo: 0,
        outcome: 'printed',
        reason: 'payment',
        requestedByUserId: 'u_cash',
        approvedByUserId: null,
        printJobId: 'job-on-dev-2',
        fbrIrn: 'OTHER-TILL-1',
        fbrQrPayload: 'https://verify.example/OTHER-TILL-1',
        fbrMode: 'production',
      },
      'dev-2',
    );
    s.reprintReceipt(oid, { requestedByUserId: 'u_mgr' });
    await s.whenIdle();
    expect(h.sends).toHaveLength(1);
    const dup = last();
    expect(dup).toContain('DUPLICATE');
    expect(dup).toContain('Reprint #1');
    expect(dup).toContain('FBR Invoice No: OTHER-TILL-1');
    expect(dup).toContain('[QR]');
    expect(dup).not.toContain('not issued');
    expect(fbrRows()).toBe(0);
    // This paper's row keeps the number and QR too.
    expect(
      db.prepare(`SELECT fbr_irn AS irn, fbr_qr_payload AS qr FROM document_prints WHERE order_id = ? AND device_id = 'dev-1'`).get(oid),
    ).toEqual({ irn: 'OTHER-TILL-1', qr: 'https://verify.example/OTHER-TILL-1' });
  });

  it('a prepaid delivery paid on the other till, dispatched here: prints at once and claims nothing about FBR', async () => {
    const s = await spooler();
    await fbrMode('production');
    await policy({ kitchenTicket: false, deliveryBillOnDispatch: true });
    const oid = order('o0606', { mode: 'delivery', status: 'out_for_delivery', paidOn: 'dev-2' });
    s.onOrderEvent(oid, 'dispatched');
    await s.whenIdle();
    // No 4 s wait for an FBR row this till will never have.
    const receipt = texts().find((t) => t.includes('RECEIPT'));
    expect(receipt).toBeDefined();
    expect(receipt).toContain('PREPAID - RIDER COLLECTS NOTHING');
    // Neither "not yet issued" nor "not issued": this till cannot know.
    expect(receipt).not.toContain('FBR');
    // The same sale taken on THIS till still waits for its number, and says so if it never comes.
    h.sends.length = 0;
    const here = order('o0607', { mode: 'delivery', status: 'out_for_delivery' });
    s.onOrderEvent(here, 'dispatched');
    await s.whenIdle();
    expect(texts().filter((t) => t.includes('RECEIPT'))).toHaveLength(0);
  });

  it('the first paper with the FBR number after one without it is an FBR copy, and does not use up the cashier’s free reprint', async () => {
    const s = await spooler();
    await fbrMode('production');
    await policy({ kitchenTicket: false });
    const oid = order('o0604');
    fbrRow(oid, 'failed', null);
    s.onOrderEvent(oid, 'paid', {});
    await s.whenIdle();
    expect(last()).toContain('FBR invoice no.: not issued');
    db.prepare(`UPDATE fbr_submission_queue SET status = 'sent', irn = 'LATE-1' WHERE order_id = ?`).run(oid);
    expect(s.planReprint(oid).fbrCopy).toBe(true);
    s.reprintReceipt(oid, { requestedByUserId: 'u_cash' });
    await s.whenIdle();
    expect(last()).toContain('FBR copy - the first with the FBR number');
    expect(last()).toContain('FBR Invoice No: LATE-1');
    const plan = s.planReprint(oid);
    expect(plan.fbrCopy).toBe(false);
    expect(plan.priorManual).toBe(0);
  });
});

describe.skipIf(!DatabaseSync)('who and when', () => {
  it("a first paper printed by hand long after the sale is a DUPLICATE (the owner's rule), never \"Printed later\"", async () => {
    const s = await spooler();
    const oid = order('o0701', { status: 'delivered', paidAt: minutesAgo(90) });
    // Its receipt never printed on this till (a bill went with the rider).
    s.reprintReceipt(oid, { requestedByUserId: 'u_mgr', approvedByUserId: 'u_mgr' });
    await s.whenIdle();
    expect(last()).not.toContain('Printed later');
    expect(last().split('\n')[1]).toBe('DUPLICATE');
    expect(last()).toContain('Reprint #1');
    expect(last()).toContain('by Sana Khan');
  });

  it('cash on delivery taken when the rider comes back: the receipt says PAID ON DELIVERY, never PREPAID', async () => {
    const s = await spooler();
    await policy({ kitchenTicket: false, deliveryBillOnDispatch: false });
    const now = new Date().toISOString();
    const oid = order('o0703', { mode: 'delivery', status: 'paid', paidAt: now });
    Object.assign(snap(oid).order, { dispatchedAt: minutesAgo(30), deliveredAt: now });
    s.onOrderEvent(oid, 'payment_captured', cash());
    await s.whenIdle();
    const receipt = texts().find((t) => t.includes('RECEIPT'))!;
    expect(receipt).toContain('PAID - CASH');
    expect(receipt).toContain('PAID ON DELIVERY');
    expect(receipt).not.toContain('PREPAID');
  });

  it('a hand-pressed copy never takes the place of the paper the till prints itself; a second automatic paper says Copy #N, with no name', async () => {
    const s = await spooler();
    await policy({ kitchenTicket: false });
    const oid = order('o0702', { mode: 'delivery' });
    // The cashier printed it at the counter, then the rider was assigned.
    s.reprintReceipt(oid, { requestedByUserId: 'u_cash' });
    await s.whenIdle();
    expect(last()).toContain('** DUPLICATE - Reprint #1 **');
    s.onOrderEvent(oid, 'dispatched');
    await s.whenIdle();
    const dispatch = last();
    // The till's own paper: the ORIGINAL.
    expect(dispatch).not.toContain('DUPLICATE');
    expect(dispatch).toContain('PREPAID - RIDER COLLECTS NOTHING');
    // A second paper the till prints by itself (an older till's job for the same paper).
    const { enqueuePrintJob } = await import('../db/repositories/print-queue-repo.js');
    enqueuePrintJob(db, { kind: 'receipt', orderId: oid, openDrawer: false, copies: ['customer'], reason: 'dispatch' });
    await s.whenIdle();
    expect(last()).toContain('Copy #3');
    expect(last()).not.toContain('by Ali Akbar');
    expect(logRows(oid).filter((r) => r.copy === 'customer').map((r) => [r.print_no, r.reason])).toEqual([
      [1, 'reprint'],
      [0, 'dispatch'],
      [2, 'dispatch'],
    ]);
  });
});

describe.skipIf(!DatabaseSync)('the shop on paper (owner 2026-09-27)', () => {
  it("a till that never set a website prints the shop's own at the bottom, under the address and phone; the name on top with no logo", async () => {
    const s = await spooler();
    await policy({ kitchenTicket: false });
    const cfg = await import('./printer-config.js');
    cfg.setReceiptBranding(db, {
      storeName: 'Test Shop',
      storeTagline: 'Test tagline',
      branchLine: 'Test Street 1',
      phoneLine: '0300 0000000',
      footerLine: 'Test thanks',
    });
    const oid = order('o0801');
    s.onOrderEvent(oid, 'paid', {});
    await s.whenIdle();
    const lines = texts().find((t) => t.includes('RECEIPT'))!.split('\n');
    // No logo set: the name, then the tagline, then the title.
    expect(lines.slice(0, 4)).toEqual(['Test Shop', 'Test tagline', '', 'RECEIPT']);
    const address = lines.indexOf('Test Street 1');
    expect(address).toBeGreaterThan(lines.indexOf('PAID - CASH'));
    expect(lines.slice(address, address + 4)).toEqual(['Test Street 1', '0300 0000000', 'cheeseoclock.net', 'Test thanks']);

    // Cleared in Settings: no website line at all.
    cfg.setReceiptBranding(db, { ...cfg.getReceiptBranding(db), websiteLine: '' });
    s.reprintReceipt(oid, { requestedByUserId: 'u_mgr' });
    await s.whenIdle();
    const again = last().split('\n');
    expect(again).not.toContain('cheeseoclock.net');
    const a = again.indexOf('Test Street 1');
    expect(again.slice(a, a + 3)).toEqual(['Test Street 1', '0300 0000000', 'Test thanks']);
  });
});
