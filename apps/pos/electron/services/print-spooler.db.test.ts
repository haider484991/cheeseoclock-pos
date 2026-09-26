/**
 * The cash drawer through the real print spooler, on a real database built
 * from every migration, with a fake printer that records what it is sent:
 *  - a cash payment pulses the drawer once, as its own job, BEFORE the
 *    kitchen ticket and the receipt (which never carry the pulse);
 *  - card, wallet and Foodpanda payments never pulse it;
 *  - a pulse that can no longer go out within a minute is dropped (also when
 *    it waited that long behind another send), never retried after it may
 *    have gone out, and the cashier is told;
 *  - once a pulse went out (by hand or for a later-retried sale), the pulses
 *    still waiting for cash taken before it are not sent: never open twice;
 *  - the drawer pin and pulse length come from the receipt printer's setting,
 *    and changing only those keeps the printer (a USB print worker);
 *  - a watched press waits for a printer that is still starting up.
 *
 * better-sqlite3 here is built for Electron's ABI, so this uses node's own
 * `node:sqlite` behind a small better-sqlite3-shaped shim (see
 * printer-config.db.test.ts) and skips itself where it is missing. Orders
 * are made-up snapshots; no real prices.
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

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

interface SentJob {
  bytes: Uint8Array;
  opts: { drawer?: boolean; notAfter?: number } | undefined;
  config: PrinterConnectionConfig;
}

const h = vi.hoisted(() => ({
  sends: [] as SentJob[],
  /** What the fake printer answers, one per send; ok when empty. */
  script: [] as Array<() => PrintResult | Promise<PrintResult>>,
  events: [] as Array<{ channel: string; payload: Record<string, unknown> }>,
  snapshots: new Map<string, OrderSnapshot>(),
  /** Printer adapters made, and shut down (a USB one owns a print worker). */
  made: 0,
  disconnected: 0,
  /** Stands in for a printer that is slow to get ready (a USB print worker starting). */
  onConnect: null as null | (() => Promise<void>),
}));

vi.mock('electron-log/main', () => ({ default: { info: () => {}, warn: () => {}, error: () => {} } }));
vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [
      {
        webContents: {
          send: (channel: string, payload: Record<string, unknown>) => h.events.push({ channel, payload }),
        },
      },
    ],
  },
  app: { getPath: () => '' },
}));
vi.mock('../adapters/printer/factory.js', () => ({
  makePrinterAdapter: (config: PrinterConnectionConfig) => ({
    id: `fake-${(h.made += 1)}`,
    config,
    connect: async () => {
      if (h.onConnect) await h.onConnect();
    },
    disconnect: async () => {
      h.disconnected += 1;
    },
    isConnected: () => true,
    send: async (bytes: Uint8Array, opts?: SentJob['opts']) => {
      h.sends.push({ bytes, opts, config });
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

function openMigrated(): AppDatabase {
  if (!DatabaseSync) throw new Error('node:sqlite unavailable');
  const raw = new DatabaseSync(':memory:');
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
    raw.exec(readFileSync(join(MIGRATIONS, f), 'utf8'));
  }
  raw.exec('PRAGMA foreign_keys = OFF'); // FBR rows below point at made-up orders
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

function order(
  orderId: string,
  mode: OrderSnapshot['order']['mode'],
  payments: Array<{ method: string; amount: number }> = [{ method: 'cash', amount: 116_000 }],
): string {
  h.snapshots.set(orderId, {
    order: {
      id: id(orderId),
      orderNumber: `20260926-${orderId.slice(-4).padStart(4, '0')}` as OrderNumber,
      mode,
      status: 'paid',
      tableId: null,
      customerId: null,
      cashierId: id('u1'),
      shiftId: null,
      source: 'pos',
      notes: null,
      subtotalCents: cents(100_000),
      discountCents: cents(0),
      taxCents: cents(16_000),
      totalCents: cents(116_000),
      createdAt: '2026-09-26T10:00:00.000Z',
      paidAt: '2026-09-26T10:01:00.000Z',
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
        modifiers: [],
      },
    ],
    discounts: [],
    payments: payments.map((p, i) => ({
      id: id(`${orderId}-p${i}`),
      orderId: id(orderId),
      method: p.method,
      amountCents: cents(p.amount),
      tenderedCents: null,
      referenceNo: null,
      receivedByUserId: id('u1'),
      paidAt: '2026-09-26T10:01:00.000Z',
    })),
    cashierName: 'Test Cashier',
    tableLabel: null,
    customerName: null,
    customerPhone: null,
    deliveryAddress: mode === 'delivery' ? 'Test Street 1' : null,
    rider: null,
  } as unknown as OrderSnapshot);
  return orderId;
}

const KICK = [0x1b, 0x70];
/** How many drawer pulses (ESC p) a byte buffer carries. */
function kicks(bytes: Uint8Array): number {
  let n = 0;
  for (let i = 0; i + 1 < bytes.length; i++) if (bytes[i] === KICK[0] && bytes[i + 1] === KICK[1]) n++;
  return n;
}
/** What each send was, in order: drawer / kitchen / receipt. */
function sentKinds(): string[] {
  return h.sends.map((s) => {
    const text = escPosToText(s.bytes);
    if (text.includes('KITCHEN')) return 'kitchen';
    if (text.trim().startsWith('[drawer') && !text.includes('TOTAL')) return 'drawer';
    return 'receipt';
  });
}
const totalKicks = () => h.sends.reduce((n, s) => n + kicks(s.bytes), 0);
const drawerEvents = () =>
  h.events.filter((e) => e.channel === 'printer:failed' && e.payload['jobKind'] === 'drawer');
const failCode = (code: string, extra: Partial<NonNullable<PrintResult['error']>> = {}) => (): PrintResult => ({
  ok: false,
  durationMs: 1,
  error: { code, message: `fake ${code}`, recoverable: true, ...extra },
});

function queueRows(db: AppDatabase, orderId: string, kind?: string) {
  return db
    .prepare(
      `SELECT id, job_kind AS kind, status, attempts FROM print_queue
        WHERE order_id = ? ${kind ? 'AND job_kind = ?' : ''} ORDER BY rowid`,
    )
    .all(...(kind ? [orderId, kind] : [orderId])) as Array<{ id: string; kind: string; status: string; attempts: number }>;
}

// ----------------------------------------------------------------- tests --

let db: AppDatabase;
const spooler = async () => (await import('./print-spooler.js')).printSpooler;

beforeEach(async () => {
  if (!DatabaseSync) return;
  h.sends.length = 0;
  h.script.length = 0;
  h.events.length = 0;
  h.snapshots.clear();
  h.onConnect = null;
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }); // no background ticks
  db = openMigrated();
  const s = await spooler();
  s.init(db);
  await s.whenIdle();
  h.sends.length = 0; // the boot warm-up sends nothing, but start clean
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Make a queued job due now, as if it had been queued `agoMs` earlier. */
function backdate(db: AppDatabase, jobId: string, agoMs: number): void {
  db.prepare(`UPDATE print_queue SET created_at = ?, next_attempt_at = ? WHERE id = ?`).run(
    new Date(Date.now() - agoMs).toISOString(),
    new Date(Date.now() - 1).toISOString(),
    jobId,
  );
}
const drawerSends = () => sentKinds().filter((k) => k === 'drawer').length;
/** Let Date.now() run `ms` ahead of the real clock (new Date() is left alone). */
function clockAhead(ms: () => number): void {
  const realNow = Date.now.bind(Date);
  vi.spyOn(Date, 'now').mockImplementation(() => realNow() + ms());
}

describe.skipIf(!DatabaseSync)('cash drawer: when it opens', () => {
  it('a cash sale opens the drawer first, before the kitchen ticket and the receipt, exactly once', async () => {
    const s = await spooler();
    s.onOrderEvent(order('o0001', 'takeaway'), 'paid', { cash: true });
    await s.whenIdle();
    expect(sentKinds()).toEqual(['drawer', 'kitchen', 'receipt']);
    expect(h.sends[0]!.opts).toMatchObject({ drawer: true });
    expect(h.sends[0]!.opts!.notAfter).toBeGreaterThan(Date.now());
    expect(escPosToText(h.sends[0]!.bytes)).toBe('[drawer pin 2, 50 ms]');
    expect(kicks(h.sends[2]!.bytes)).toBe(0);
    expect(h.sends[1]!.opts).toBeUndefined();
    expect(totalKicks()).toBe(1);
    expect(queueRows(db, 'o0001', 'drawer')).toHaveLength(1);
  });

  it('card, wallet and Foodpanda payments never open it', async () => {
    const s = await spooler();
    for (const [oid, method, mode] of [
      ['o0002', 'card', 'takeaway'],
      ['o0003', 'easypaisa', 'dine_in'],
      ['o0004', 'foodpanda', 'foodpanda'],
    ] as const) {
      s.onOrderEvent(order(oid, mode, [{ method, amount: 116_000 }]), 'paid', { cash: false });
    }
    await s.whenIdle();
    expect(totalKicks()).toBe(0);
    expect(sentKinds()).not.toContain('drawer');
    expect((db.prepare(`SELECT COUNT(*) AS n FROM print_queue WHERE job_kind = 'drawer'`).get() as { n: number }).n).toBe(0);
  });

  it('a split cash + card payment opens it once', async () => {
    const s = await spooler();
    const oid = order('o0005', 'takeaway', [
      { method: 'cash', amount: 60_000 },
      { method: 'card', amount: 56_000 },
    ]);
    s.onOrderEvent(oid, 'paid', { cash: true });
    await s.whenIdle();
    expect(totalKicks()).toBe(1);
    expect(queueRows(db, oid, 'drawer')).toHaveLength(1);
  });

  it('a shop copy on the same strip never carries a second pulse', async () => {
    const s = await spooler();
    const { getPrintPolicy, setPrintPolicy } = await import('./printer-config.js');
    setPrintPolicy(db, { ...getPrintPolicy(db), shopCopy: 'always' });
    s.onOrderEvent(order('o0006', 'takeaway'), 'paid', { cash: true });
    await s.whenIdle();
    const receipt = h.sends[sentKinds().indexOf('receipt')]!;
    expect(escPosToText(receipt.bytes)).toContain('SHOP COPY');
    expect(kicks(receipt.bytes)).toBe(0);
    expect(totalKicks()).toBe(1);
  });

  it('a cash refund opens it before the refund slip; a card refund does not', async () => {
    const s = await spooler();
    s.onOrderEvent(order('o0007', 'takeaway'), 'refunded', { cash: true });
    await s.whenIdle();
    expect(sentKinds()).toEqual(['drawer', 'receipt']);
    expect(totalKicks()).toBe(1);
    h.sends.length = 0;
    s.onOrderEvent(order('o0008', 'takeaway', [{ method: 'card', amount: 116_000 }]), 'refunded', { cash: false });
    await s.whenIdle();
    expect(sentKinds()).toEqual(['receipt']);
    expect(totalKicks()).toBe(0);
  });

  it('deliveries: one pulse per cash event, never on the bill that leaves with the rider', async () => {
    const s = await spooler();
    // Paid up front in cash; the bill prints at dispatch.
    const d1 = order('o0011', 'delivery');
    s.onOrderEvent(d1, 'paid', { cash: true });
    await s.whenIdle();
    expect(sentKinds()).toEqual(['drawer', 'kitchen']);
    s.onOrderEvent(d1, 'dispatched');
    await s.whenIdle();
    expect(sentKinds()).toEqual(['drawer', 'kitchen', 'receipt']);
    expect(queueRows(db, d1, 'drawer')).toHaveLength(1);

    // Cash on delivery: the rider brings the money back after the bill left.
    h.sends.length = 0;
    const d2 = order('o0012', 'delivery');
    s.onOrderEvent(d2, 'sent_to_kitchen');
    s.onOrderEvent(d2, 'dispatched');
    await s.whenIdle();
    expect(sentKinds()).toEqual(['kitchen', 'receipt']);
    s.onOrderEvent(d2, 'payment_captured', { cash: true });
    await s.whenIdle();
    expect(sentKinds()).toEqual(['kitchen', 'receipt', 'drawer']);
    expect(queueRows(db, d2, 'drawer')).toHaveLength(1);

    // No bill went out yet: the pulse, then the receipt.
    h.sends.length = 0;
    const d3 = order('o0013', 'delivery');
    s.onOrderEvent(d3, 'payment_captured', { cash: true });
    await s.whenIdle();
    expect(sentKinds()).toEqual(['drawer', 'receipt']);
    expect(totalKicks()).toBe(1);
  });

  it('uses the pin and pulse length saved for the receipt printer', async () => {
    const s = await spooler();
    const { setReceiptPrinterConfig } = await import('./printer-config.js');
    setReceiptPrinterConfig(db, {
      transport: 'network',
      network: { host: '192.0.2.9', port: 9100 },
      width: 48,
      drawer: { pin: 5, pulseMs: 100 },
    });
    s.resetAdapter();
    s.onOrderEvent(order('o0014', 'takeaway'), 'paid', { cash: true });
    await s.whenIdle();
    const first = h.sends[0]!;
    expect(first.config.drawer).toEqual({ pin: 5, pulseMs: 100 });
    expect([...first.bytes].join(',')).toContain([0x1b, 0x70, 0x01, 0x32, 0xfa].join(','));
    expect(escPosToText(first.bytes)).toBe('[drawer pin 5, 100 ms]');
  });

  it("a new sale's drawer goes ahead of an earlier order's paper", async () => {
    const s = await spooler();
    const { enqueuePrintJob } = await import('../db/repositories/print-queue-repo.js');
    order('o0021', 'takeaway');
    order('o0022', 'takeaway');
    // Queued straight into the table, so nothing drains in between.
    enqueuePrintJob(db, { kind: 'kitchen', orderId: 'o0021', reprint: false });
    enqueuePrintJob(db, { kind: 'receipt', orderId: 'o0021', openDrawer: false, copies: ['customer'], reason: 'payment' });
    enqueuePrintJob(db, { kind: 'drawer', orderId: 'o0022' });
    await s.whenIdle();
    expect(sentKinds()).toEqual(['drawer', 'kitchen', 'receipt']);
  });

  it('a receipt waiting for its FBR number steps aside for the next sale’s drawer', async () => {
    const s = await spooler();
    const oa = order('o0023', 'takeaway');
    db.prepare(
      `INSERT INTO fbr_submission_queue (id, order_id, payload_json, status, enqueued_at, mode_at_enqueue, created_at, updated_at)
       VALUES ('f1', ?, '{}', 'pending', ?, 'sandbox', ?, ?)`,
    ).run(oa, new Date().toISOString(), new Date().toISOString(), new Date().toISOString());
    const { enqueuePrintJob } = await import('../db/repositories/print-queue-repo.js');
    enqueuePrintJob(db, { kind: 'receipt', orderId: oa, openDrawer: false, copies: ['customer'], reason: 'payment' });
    await s.whenIdle();
    expect(h.sends).toHaveLength(0); // waiting for FBR, not holding the queue
    s.onOrderEvent(order('o0024', 'takeaway'), 'paid', { cash: true });
    await s.whenIdle();
    expect(sentKinds().slice(0, 1)).toEqual(['drawer']);
    const receipt = queueRows(db, oa, 'receipt')[0]!;
    expect(receipt.status).toBe('pending');
    expect(receipt.attempts).toBe(0); // stepping aside is not a failed attempt
  });
});

describe.skipIf(!DatabaseSync)('cash drawer: when the printer fails', () => {
  it('offline: retried quietly, then dropped past a minute with "use the key"', async () => {
    const s = await spooler();
    h.script.push(failCode('printer_offline'));
    const oid = order('o0031', 'takeaway');
    s.onOrderEvent(oid, 'paid', { cash: true });
    await s.whenIdle();
    const [job] = queueRows(db, oid, 'drawer');
    expect(job).toMatchObject({ status: 'pending', attempts: 1 });
    expect(drawerEvents()).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ retrying: true, jobKind: 'drawer' }) }),
    ]);

    // The printer stays away for over a minute: the pulse is never sent late.
    const sendsBefore = h.sends.length;
    const past = new Date(Date.now() - 61_000).toISOString();
    db.prepare(`UPDATE print_queue SET created_at = ?, next_attempt_at = ? WHERE id = ?`).run(
      past,
      new Date(Date.now() - 1).toISOString(),
      job!.id,
    );
    await s.whenIdle();
    expect(h.sends.length).toBe(sendsBefore);
    expect(queueRows(db, oid, 'drawer')[0]!.status).toBe('failed');
    const last = drawerEvents().at(-1)!.payload;
    expect(last['retrying']).toBe(false);
    expect((last['error'] as { code: string }).code).toBe('drawer_not_opened');
    expect((last['error'] as { message: string }).message).toMatch(/within a minute/);
  });

  it('may have gone out: sent once, never again, and the cashier is asked to check', async () => {
    const s = await spooler();
    h.script.push(failCode('printer_maybe_sent', { recoverable: false, maybeSent: true }));
    const oid = order('o0032', 'takeaway');
    s.onOrderEvent(oid, 'paid', { cash: true });
    await s.whenIdle();
    expect(drawerSends()).toBe(1);
    expect(queueRows(db, oid, 'drawer')[0]!.status).toBe('failed');
    const ev = drawerEvents().at(-1)!.payload;
    expect((ev['error'] as { code: string }).code).toBe('drawer_unsure');
    // Nothing brings it back.
    db.prepare(`UPDATE print_queue SET next_attempt_at = ? WHERE order_id = ?`).run(new Date(0).toISOString(), oid);
    await s.whenIdle();
    expect(drawerSends()).toBe(1);
    // A timeout that may have delivered it is treated the same way.
    h.sends.length = 0;
    h.script.push(failCode('timeout', { recoverable: true, maybeSent: true }));
    s.onOrderEvent(order('o0033', 'takeaway'), 'paid', { cash: true });
    await s.whenIdle();
    expect(drawerSends()).toBe(1);
    expect(queueRows(db, 'o0033', 'drawer')[0]!.status).toBe('failed');
  });

  it('gives up at once when the next try would come too late', async () => {
    const s = await spooler();
    h.script.push(failCode('printer_offline'));
    const oid = order('o0034', 'takeaway');
    s.onOrderEvent(oid, 'paid', { cash: true });
    await s.whenIdle();
    const [job] = queueRows(db, oid, 'drawer');
    // 50 s after the sale the second try fails too; the third would be 30 s later.
    db.prepare(`UPDATE print_queue SET created_at = ?, next_attempt_at = ? WHERE id = ?`).run(
      new Date(Date.now() - 50_000).toISOString(),
      new Date(Date.now() - 1).toISOString(),
      job!.id,
    );
    h.script.push(failCode('printer_offline'));
    await s.whenIdle();
    expect(queueRows(db, oid, 'drawer')[0]).toMatchObject({ status: 'failed', attempts: 2 });
    expect((drawerEvents().at(-1)!.payload['error'] as { code: string }).code).toBe('drawer_not_opened');
    // …and the receipt and ticket still printed.
    expect(sentKinds().filter((k) => k !== 'drawer')).toEqual(['kitchen', 'receipt']);
  });

  it('a pulse kept waiting behind a slow send until past its minute is never sent', async () => {
    const s = await spooler();
    // A send that holds the printer (here a hand-pressed pulse whose printer
    // hangs, then fails without anything going out).
    let release!: () => void;
    h.script.push(
      () =>
        new Promise<PrintResult>((resolve) => {
          release = () => resolve(failCode('printer_offline')());
        }),
    );
    const held = s.kickDrawerNow();
    await vi.waitFor(() => expect(h.sends).toHaveLength(1));
    // A cash sale now: its pulse is claimed and waits for the printer.
    const oid = order('o0037', 'takeaway');
    s.onOrderEvent(oid, 'paid', { cash: true });
    expect(queueRows(db, oid, 'drawer')[0]!.status).toBe('in_flight');
    // …for over a minute.
    clockAhead(() => 61_000);
    release();
    expect((await held).ok).toBe(false);
    await s.whenIdle();
    expect(drawerSends()).toBe(1); // only the held one: the sale's pulse never went out
    expect(queueRows(db, oid, 'drawer')[0]).toMatchObject({ status: 'failed' });
    const last = drawerEvents().at(-1)!.payload;
    expect((last['error'] as { code: string }).code).toBe('drawer_not_opened');
    expect((last['error'] as { message: string }).message).toMatch(/too long/);
    // The paper still printed.
    expect(sentKinds().slice(1)).toEqual(['kitchen', 'receipt']);
  });

  it('a receipt queued by an older till with the pulse inside prints without it, and says so', async () => {
    const s = await spooler();
    const { enqueuePrintJob } = await import('../db/repositories/print-queue-repo.js');
    const oid = order('o0035', 'takeaway');
    enqueuePrintJob(db, { kind: 'receipt', orderId: oid, openDrawer: true, copies: ['customer'], reason: 'reprint' });
    await s.whenIdle();
    expect(sentKinds()).toEqual(['receipt']);
    expect(totalKicks()).toBe(0);
    expect(drawerEvents()).toHaveLength(1);
    expect((drawerEvents()[0]!.payload['error'] as { code: string }).code).toBe('drawer_not_opened');
  });

  it('after a crash, a drawer pulse cut off mid-send is failed, other jobs go again', async () => {
    const { enqueuePrintJob, recoverStuckInFlight } = await import('../db/repositories/print-queue-repo.js');
    const d = enqueuePrintJob(db, { kind: 'drawer', orderId: 'o0036' });
    const r = enqueuePrintJob(db, { kind: 'receipt', orderId: 'o0036', openDrawer: false, copies: ['customer'], reason: 'payment' });
    db.prepare(`UPDATE print_queue SET status = 'in_flight'`).run();
    expect(recoverStuckInFlight(db)).toBe(2);
    const status = (jobId: string) =>
      (db.prepare(`SELECT status FROM print_queue WHERE id = ?`).get(jobId) as { status: string }).status;
    expect(status(d.id)).toBe('failed');
    expect(status(r.id)).toBe('pending');
  });
});

describe.skipIf(!DatabaseSync)('cash drawer: never twice for the same cash', () => {
  it('opened by hand while a sale’s pulse waits for the printer: that pulse is not sent later', async () => {
    const s = await spooler();
    h.script.push(failCode('printer_offline'));
    const oid = order('o0041', 'takeaway');
    s.onOrderEvent(oid, 'paid', { cash: true });
    await s.whenIdle();
    const [job] = queueRows(db, oid, 'drawer');
    expect(job).toMatchObject({ status: 'pending', attempts: 1 });
    expect(drawerSends()).toBe(1);
    // The printer is back; a manager presses Open drawer (or a cash in / out,
    // a shift open, Open drawer to count) a few seconds after the sale.
    backdate(db, job!.id, 3_000);
    expect((await s.kickDrawerNow()).ok).toBe(true);
    expect(drawerSends()).toBe(2);
    // The sale's retry comes due: the drawer already opened for that cash.
    backdate(db, job!.id, 3_000);
    await s.whenIdle();
    expect(drawerSends()).toBe(2);
    const row = db.prepare(`SELECT status, last_error AS note FROM print_queue WHERE id = ?`).get(job!.id) as {
      status: string;
      note: string;
    };
    expect(row.status).toBe('done');
    expect(row.note).toMatch(/opened after this sale/);
    // Nobody is told it failed.
    expect(drawerEvents().filter((e) => e.payload['retrying'] === false)).toEqual([]);
  });

  it('one pulse that goes out serves every earlier sale still waiting', async () => {
    const s = await spooler();
    const o1 = order('o0042', 'takeaway');
    const o2 = order('o0043', 'takeaway');
    h.script.push(failCode('printer_offline'));
    s.onOrderEvent(o1, 'paid', { cash: true });
    await s.whenIdle();
    h.script.push(failCode('printer_offline'));
    s.onOrderEvent(o2, 'paid', { cash: true });
    await s.whenIdle();
    expect(drawerSends()).toBe(2);
    const j1 = queueRows(db, o1, 'drawer')[0]!;
    const j2 = queueRows(db, o2, 'drawer')[0]!;
    backdate(db, j1.id, 4_000);
    backdate(db, j2.id, 3_000);
    await s.whenIdle();
    expect(drawerSends()).toBe(3); // one more, not two
    expect(queueRows(db, o1, 'drawer')[0]!.status).toBe('done');
    expect(queueRows(db, o2, 'drawer')[0]!.status).toBe('done');
  });

  it('a hand-pressed pulse that surely did not go out leaves the sale’s retry to open it', async () => {
    const s = await spooler();
    h.script.push(failCode('printer_offline'));
    const oid = order('o0044', 'takeaway');
    s.onOrderEvent(oid, 'paid', { cash: true });
    await s.whenIdle();
    const job = queueRows(db, oid, 'drawer')[0]!;
    backdate(db, job.id, 3_000);
    h.script.push(failCode('printer_offline'));
    expect((await s.kickDrawerNow()).ok).toBe(false);
    backdate(db, job.id, 3_000);
    await s.whenIdle();
    expect(drawerSends()).toBe(3); // the sale's, the hand-pressed one, the retry
    const row = db.prepare(`SELECT status, last_error AS note FROM print_queue WHERE id = ?`).get(job.id) as {
      status: string;
      note: string | null;
    };
    expect(row).toEqual({ status: 'done', note: null });
  });

  it('a hand-pressed pulse that MAY have gone out counts as opened: no second pulse', async () => {
    const s = await spooler();
    h.script.push(failCode('printer_offline'));
    const oid = order('o0045', 'takeaway');
    s.onOrderEvent(oid, 'paid', { cash: true });
    await s.whenIdle();
    const job = queueRows(db, oid, 'drawer')[0]!;
    backdate(db, job.id, 3_000);
    h.script.push(failCode('timeout', { maybeSent: true }));
    expect((await s.kickDrawerNow()).error?.maybeSent).toBe(true);
    backdate(db, job.id, 3_000);
    await s.whenIdle();
    expect(drawerSends()).toBe(2);
    expect(queueRows(db, oid, 'drawer')[0]!.status).toBe('done');
  });

  it('a sale after the drawer opened still opens it', async () => {
    const s = await spooler();
    expect((await s.kickDrawerNow()).ok).toBe(true);
    await new Promise((r) => setTimeout(r, 5));
    s.onOrderEvent(order('o0046', 'takeaway'), 'paid', { cash: true });
    await s.whenIdle();
    expect(drawerSends()).toBe(2);
  });
});

describe.skipIf(!DatabaseSync)('cash drawer: by hand', () => {
  it('kickDrawerNow sends only the pulse, once, with no queue row', async () => {
    const s = await spooler();
    const result = await s.kickDrawerNow();
    expect(result.ok).toBe(true);
    expect(h.sends).toHaveLength(1);
    expect(escPosToText(h.sends[0]!.bytes)).toBe('[drawer pin 2, 50 ms]');
    expect(h.sends[0]!.opts).toMatchObject({ drawer: true });
    expect((db.prepare(`SELECT COUNT(*) AS n FROM print_queue`).get() as { n: number }).n).toBe(0);
  });

  it('a failed pulse by hand is not retried', async () => {
    const s = await spooler();
    h.script.push(failCode('printer_offline'));
    const result = await s.kickDrawerNow();
    expect(result.ok).toBe(false);
    await s.whenIdle();
    expect(h.sends).toHaveLength(1);
  });

  it('changing only the drawer pin or pulse keeps the printer (and its USB print worker)', async () => {
    const s = await spooler();
    const { setReceiptPrinterConfig } = await import('./printer-config.js');
    const printer = { transport: 'network' as const, network: { host: '192.0.2.10', port: 9100 }, width: 48 as const };
    setReceiptPrinterConfig(db, printer);
    s.resetAdapter();
    expect((await s.kickDrawerNow()).ok).toBe(true);
    const made = h.made;
    const shut = h.disconnected;
    // The "Drawer won't open?" checklist: 100 ms, then pin 5 — saved and tested each time.
    for (const drawer of [
      { pin: 2, pulseMs: 100 },
      { pin: 5, pulseMs: 100 },
    ] as const) {
      setReceiptPrinterConfig(db, { ...printer, drawer });
      s.resetAdapter();
      expect((await s.kickDrawerNow({ watched: true })).ok).toBe(true);
      expect(escPosToText(h.sends.at(-1)!.bytes)).toBe(`[drawer pin ${drawer.pin}, ${drawer.pulseMs} ms]`);
    }
    expect(h.made).toBe(made);
    expect(h.disconnected).toBe(shut);
    // A sale's pulse uses the new setting too.
    s.onOrderEvent(order('o0051', 'takeaway'), 'paid', { cash: true });
    await s.whenIdle();
    expect(escPosToText(h.sends[sentKinds().lastIndexOf('drawer')]!.bytes)).toBe('[drawer pin 5, 100 ms]');
    // A different printer does get a new adapter, and the old one is shut down.
    setReceiptPrinterConfig(db, { ...printer, network: { host: '192.0.2.11', port: 9100 } });
    s.resetAdapter();
    expect((await s.kickDrawerNow()).ok).toBe(true);
    expect(h.made).toBe(made + 1);
    expect(h.disconnected).toBe(shut + 1);
  });

  it('a printer slow to start: a watched press waits for it, and the 10 s count starts once it is ready', async () => {
    const s = await spooler();
    // The print worker takes 12 s to get ready (e.g. just after a printer change on a slow PC).
    let ahead = 0;
    clockAhead(() => ahead);
    h.onConnect = async () => {
      ahead += 12_000;
    };
    const pressedAt = Date.now();
    const r = await s.kickDrawerNow({ watched: true });
    expect(r.ok).toBe(true);
    const sent = h.sends.at(-1)!;
    expect(sent.opts!.notAfter).toBeGreaterThan(pressedAt + 12_000);
    expect(sent.opts!.notAfter).toBeLessThanOrEqual(Date.now() + 10_000);
  });

  it('a watched press gives up — sending nothing — when the printer is still not ready after 30 s', async () => {
    const s = await spooler();
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    h.onConnect = () => new Promise<void>(() => {}); // never ready
    const pending = s.kickDrawerNow({ watched: true });
    await vi.advanceTimersByTimeAsync(30_001);
    const r = await pending;
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('printer_starting');
    expect(h.sends).toEqual([]);
    const { drawerFailureText } = await import('./print-spooler.js');
    expect(drawerFailureText(r.error)).toMatch(/still getting the printer ready.*Try again/);
  });

  it('an unwatched pulse (cash in / out, shift open) does not wait for a slow printer', async () => {
    const s = await spooler();
    h.onConnect = () => new Promise<void>(() => {}); // never ready
    expect((await s.kickDrawerNow()).ok).toBe(true); // straight to send; the adapter enforces the 10 s
    expect(h.sends[0]!.opts!.notAfter).toBeLessThanOrEqual(Date.now() + 10_000);
  });

  it('kickDrawerSoon tells the till when it did not open', async () => {
    const s = await spooler();
    h.script.push(failCode('network_error'));
    s.kickDrawerSoon();
    await vi.waitFor(() => expect(drawerEvents()).toHaveLength(1));
    const err = drawerEvents()[0]!.payload['error'] as { code: string; message: string };
    expect(err.code).toBe('drawer_not_opened');
    expect(err.message).toMatch(/didn't answer/);
  });

  it('plain words for why the drawer did not open', async () => {
    const { drawerFailureText } = await import('./print-spooler.js');
    expect(drawerFailureText({ code: 'x', message: 'm', recoverable: false, maybeSent: true })).toMatch(/Check the drawer/);
    expect(drawerFailureText({ code: 'drawer_too_late', message: '', recoverable: false })).toMatch(/too long/);
    expect(drawerFailureText({ code: 'printer_starting', message: '', recoverable: false })).toMatch(/Try again/);
    expect(
      drawerFailureText({ code: 'printer_offline', message: 'Windows says the printer is off (status 0x80)', recoverable: true }),
    ).toBe('The printer is not ready. Windows says the printer is off (status 0x80)');
    expect(drawerFailureText({ code: 'no_config', message: '', recoverable: false })).toMatch(/Settings → Printers/);
    expect(drawerFailureText(undefined)).toMatch(/did not take/);
  });
});
