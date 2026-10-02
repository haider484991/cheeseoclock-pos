/**
 * The shift report prints when the shift closes (final plan step 19f-2; the
 * owner, 2 Oct 2026: the FULL paper at every close, for every closer;
 * toggles change only what prints), through the real 'shifts:close' handler,
 * shift repository, shift report service and print spooler, on a real
 * database built from every migration, with a fake receipt printer that
 * records what it is sent and answers as each test scripts it:
 *
 *   (1) A manager signed in closes: the reply comes back with 'printing' and
 *       the shift's takings as the close saved them (a cash sale taken after
 *       the close box opened is in them, as on the paper); exactly one paper
 *       follows, the saved report at the printer's width — SHIFT REPORT, the
 *       stored expected cash, ITEMS SOLD and ORDERS — with no drawer pulse,
 *       and one chained 'shift_report_printed' row.
 *   (2) A paper that does not print never holds up the close: a printer that
 *       fails, fails after the bytes may have gone out, never answers, or
 *       throws — the close resolves 'printing' and the shift is closed; the
 *       till windows get one 'printer:failed' naming the shift.
 *   (3) No paper: printing at close switched off ('off'); the "No printer"
 *       setup ('no_printer': the report goes to its file only, nothing on
 *       record, no failure note); no report saved ('not_made'); the print
 *       settings unreadable ('not_made', never 'Close shift failed').
 *   (4) The count stays blind: the close check and the count's drawer pulse
 *       print no report, a refused close prints nothing, a manager's PIN
 *       close gets no expected cash and no summary but the FULL paper; the
 *       owner's section switches leave sections off the paper for every
 *       closer while the saved report keeps them all.
 *
 * Only `defineHandler` is replaced (it captures the handler instead of
 * registering it with Electron); the session and the manager check are
 * stand-ins (auth-service owns PINs and passwords), and so are the website
 * orders' pause and the printer itself. makeShiftReport and getPrintPolicy
 * are the real ones, made to throw where a test says so. node:sqlite
 * behind better-sqlite3's shape; skipped where it is missing. Every name,
 * number and amount is made up (the repository is public).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { escPosToText, paperMoney } from '@cheeseoclock/printer-core';
import { parseShiftReportJson } from '@cheeseoclock/shared-schemas';
import type {
  AuthenticatedUser,
  ClosedShift,
  PrintResult,
  PrinterConnectionConfig,
  ShiftSummary,
  UUID,
} from '@cheeseoclock/shared-types';
import type { AppDatabase } from '../../db/connection.js';
import { DatabaseSync } from '../../db/costing-shop.fixture.js';
import { openTill } from '../../db/two-tills.fixture.js';
import { verifyAuditChain, type AuditChainRow } from '../../db/audit-chain.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 60_000 });

type Handler = (ctx: unknown, payload: unknown) => Promise<unknown>;

interface Sent {
  bytes: Uint8Array;
  opts: { drawer?: boolean } | undefined;
  config: PrinterConnectionConfig;
}

const h = vi.hoisted(() => ({
  handlers: new Map<string, (ctx: unknown, payload: unknown) => Promise<unknown>>(),
  session: null as AuthenticatedUser | null,
  sends: [] as Sent[],
  /** What the fake printer answers, one per send; ok when empty. */
  script: [] as Array<() => PrintResult | Promise<PrintResult>>,
  /** What the till windows were told. */
  events: [] as Array<{ channel: string; payload: Record<string, unknown> }>,
  makerThrows: false,
  policyThrows: false,
  errors: [] as Array<[string, unknown]>,
}));

vi.mock('../registry.js', () => {
  class IpcGuardError extends Error {
    readonly apiError: { code: string; message: string };
    constructor(apiError: { code: string; message: string }) {
      super(apiError.message);
      this.apiError = apiError;
      this.name = 'IpcGuardError';
    }
  }
  return {
    IpcGuardError,
    defineHandler: (channel: string, _ctx: unknown, fn: Handler) => {
      h.handlers.set(channel, async (ctx, payload) => fn(ctx, payload));
    },
  };
});
vi.mock('electron-log/main', () => ({
  default: {
    info: () => {},
    warn: () => {},
    error: (message: string, data: unknown) => {
      h.errors.push([message, data]);
    },
    debug: () => {},
  },
}));
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
  app: { getPath: () => '', getVersion: () => '0.0.0-test' },
}));
vi.mock('../../adapters/printer/factory.js', () => ({
  makePrinterAdapter: (config: PrinterConnectionConfig) => ({
    id: 'fake',
    config,
    connect: async () => {},
    disconnect: async () => {},
    isConnected: () => true,
    send: async (bytes: Uint8Array, opts?: { drawer?: boolean }) => {
      h.sends.push({ bytes, opts, config });
      const next = h.script.shift();
      return next ? next() : { ok: true, durationMs: 1 };
    },
    testPrint: async () => ({ ok: true, durationMs: 1 }),
  }),
}));
// Who is signed in, and the manager check: auth-service's job, stood in for here.
vi.mock('../../services/auth-service.js', () => ({
  getCurrentSession: () => h.session,
  verifyManagerPin: async (_db: unknown, pin: string) => {
    if (pin === 'Manager-pass-7') return { approverUserId: 'u_mgr', approverName: 'Test Manager' };
    throw new Error("That is not a manager's PIN or password");
  },
}));
// Website orders follow the shift (tested in web-orders-shift-pause.db.test.ts).
vi.mock('../../services/web-orders-shift-pause.js', () => ({
  followShiftForWebOrders: () => {},
  closeWouldPauseWebOrders: () => false,
}));
// The real report maker, made to throw where a test says so.
vi.mock('../../services/shift-report-service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/shift-report-service.js')>();
  return {
    ...actual,
    makeShiftReport: (db: AppDatabase, deviceId: string) => {
      const make = actual.makeShiftReport(db, deviceId);
      return (ctx: Parameters<typeof make>[0]) => {
        if (h.makerThrows) throw new Error('Test: the report broke');
        return make(ctx);
      };
    },
  };
});
// The real print settings, made unreadable where a test says so.
vi.mock('../../services/printer-config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../services/printer-config.js')>();
  return {
    ...actual,
    getPrintPolicy: (db: AppDatabase) => {
      if (h.policyThrows) throw new Error('Test: the print settings broke');
      return actual.getPrintPolicy(db);
    },
  };
});

const TILL = 'till-a';
const FLOAT = 500_000;
const PIN = 'Manager-pass-7';
const PRINTER: PrinterConnectionConfig = { transport: 'network', network: { host: '192.0.2.5', port: 9100 }, width: 48 };
const session = (id: string, fullName: string, role: AuthenticatedUser['role']): AuthenticatedUser => ({
  id: id as UUID,
  fullName,
  role,
  sessionId: `sess_${id}` as UUID,
});
const CASHIER = session('u_cash', 'Test Cashier', 'cashier');
const MANAGER = session('u_mgr', 'Test Manager', 'manager');
const OWNER = session('u_admin', 'Test Owner', 'admin');
const STAFF = { userId: 'u_cash', deviceId: TILL };
const BOSS = { userId: 'u_mgr', deviceId: TILL };

type Row = Record<string, unknown>;
let db: AppDatabase;
let burger: string;

async function call<T>(channel: string, payload: unknown): Promise<T> {
  const fn = h.handlers.get(channel);
  if (!fn) throw new Error(`No handler for ${channel}`);
  const r = (await fn({ db, deviceId: TILL }, payload)) as { ok: boolean; data: T };
  if (!r.ok) throw new Error(`${channel} said no: ${JSON.stringify(r)}`);
  return r.data;
}
const refusal = (channel: string, payload: unknown) =>
  h.handlers.get(channel)!({ db, deviceId: TILL }, payload).then(
    () => {
      throw new Error(`${channel} was not refused`);
    },
    (e: { apiError?: { code: string; message: string } }) => e.apiError,
  );

/** A shift opened by the cashier on the float (the repository: no drawer pulse to the fake printer). */
async function openShift(): Promise<string> {
  const { openShift: open } = await import('../../db/repositories/shift-repo.js');
  return open(db, { openingCashCents: FLOAT }, STAFF).id;
}

/** A counter takeaway with one burger, paid by `method` at the counter. */
async function paid(method: 'cash' | 'card'): Promise<{ id: string; total: number }> {
  const r = await import('../../db/repositories/order-repo.js');
  const o = r.createOrder(db, { mode: 'takeaway' }, STAFF);
  r.addOrderItem(db, { orderId: o.id, menuItemId: burger, quantity: 1, modifierIds: [] }, STAFF);
  const total = r.findOrder(db, o.id)!.totalCents;
  r.tenderOrder(db, { orderId: o.id, payments: [{ method, amountCents: total, tenderedCents: method === 'cash' ? total : null }] }, STAFF);
  return { id: o.id, total };
}

/** The receipt printer this till uses from now on. */
async function usePrinter(config: PrinterConnectionConfig): Promise<void> {
  const { setReceiptPrinterConfig } = await import('../../services/printer-config.js');
  const { printSpooler } = await import('../../services/print-spooler.js');
  setReceiptPrinterConfig(db, config);
  printSpooler.resetAdapter();
  await printSpooler.whenIdle();
}

/** The owner's shift report switches on this till, kept with the rest of the print rules. */
async function setRules(rules: { shiftReportOnClose?: boolean; shiftReportSections?: Record<string, boolean> }): Promise<void> {
  const { getPrintPolicy, setPrintPolicy } = await import('../../services/printer-config.js');
  setPrintPolicy(db, { ...getPrintPolicy(db), ...rules }, 'u_admin');
}

/** Close the shift with `who` signed in: counted to the rupee on the stored expected cash, unless `counted` says. */
async function close(shiftId: string, who: AuthenticatedUser, more: Record<string, unknown> = {}): Promise<ClosedShift> {
  const { getShiftSummary } = await import('../../db/repositories/shift-repo.js');
  h.session = who;
  return call<ClosedShift>('shifts:close', {
    shiftId,
    countedCashCents: getShiftSummary(db, shiftId).expectedCashCents,
    ...more,
  });
}

/** The shift report papers the fake printer was sent (its other sends are drawer pulses), as text. */
const papers = () => h.sends.filter((s) => escPosToText(s.bytes).includes('SHIFT REPORT'));
const texts = () => papers().map((s) => escPosToText(s.bytes));

/** Exactly `n` shift report papers, once the spooler has had time to send what it was asked to. */
async function settledPapers(n: number): Promise<string[]> {
  if (n > 0) await vi.waitFor(() => expect(papers().length).toBeGreaterThanOrEqual(n));
  // Anything more would already be on its way: give it a moment to show up.
  await new Promise((r) => setTimeout(r, 30));
  expect(papers()).toHaveLength(n);
  return texts();
}

/** This till's print log for the shift: its 'shift_report_printed' rows, read. */
const printAudits = (shiftId: string) =>
  (
    db
      .prepare(`SELECT actor_user_id, after_json FROM audit_log WHERE entity_id = ? AND action = 'shift_report_printed' ORDER BY rowid`)
      .all(shiftId) as Row[]
  ).map((r): Row => ({ actor: r['actor_user_id'], ...(JSON.parse(String(r['after_json'])) as Row) }));

function auditRows(): AuditChainRow[] {
  return db
    .prepare(
      `SELECT rowid, id, entity_type AS entityType, entity_id AS entityId, action,
              actor_user_id AS actorUserId, before_json AS beforeJson, after_json AS afterJson,
              ip, created_at AS createdAt, prev_hash AS prevHash, row_hash AS rowHash
         FROM audit_log ORDER BY rowid`,
    )
    .all() as unknown as AuditChainRow[];
}

const storedShift = (shiftId: string) =>
  db.prepare(`SELECT closed_at, expected_cash_cents, close_report_json FROM shifts WHERE id = ?`).get(shiftId) as Row;

/** A row as the paper prints it: the label, and the amount right-aligned at the width. */
const paperRow = (label: string, amount: string, width = 48) => label + ' '.repeat(width - label.length - amount.length) + amount;

const failedEvents = () => h.events.filter((e) => e.channel === 'printer:failed');

const ALL_SECTIONS = ['sales', 'moneyTaken', 'channels', 'cancelsRefunds', 'drawer', 'counted', 'unpaid', 'items', 'orders'];
const HEADINGS = ['SALES', 'MONEY TAKEN', 'BY CHANNEL', 'CANCELLED AND REFUNDED', 'CASH DRAWER', 'CASH COUNTED', 'UNPAID - CARRIED OVER', 'ITEMS SOLD', 'ORDERS'];
/** The section headings on a paper's text, in print order. */
const headings = (text: string) =>
  HEADINGS.filter((head) => text.split('\n').some((line) => line === head || line.startsWith(`${head} `) || line.startsWith(`${head}:`)));

beforeEach(async () => {
  if (!DatabaseSync) return;
  h.handlers.clear();
  h.session = null;
  h.sends.length = 0;
  h.script.length = 0;
  h.events.length = 0;
  h.errors.length = 0;
  h.makerThrows = false;
  h.policyThrows = false;
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] }); // no background ticks
  db = openTill(TILL, { displayName: 'TEST-TILL-1 (win32)' });
  const { createTaxCategory } = await import('../../db/repositories/tax-category-repo.js');
  const { createCategory } = await import('../../db/repositories/category-repo.js');
  const { createMenuItem } = await import('../../db/repositories/menu-item-repo.js');
  const tax = createTaxCategory(db, { name: 'Test GST', rateBps: 1_500 }, BOSS);
  const food = createCategory(db, { name: 'Test Burgers', displayOrder: 1, colorHex: '#aa5500' }, BOSS);
  burger = createMenuItem(db, { categoryId: food.id, name: 'Test Zinger Burger', basePriceCents: 100_000, taxCategoryId: tax.id }, BOSS).id;
  const { setReceiptPrinterConfig } = await import('../../services/printer-config.js');
  setReceiptPrinterConfig(db, PRINTER);
  const { printSpooler } = await import('../../services/print-spooler.js');
  printSpooler.init(db);
  printSpooler.resetAdapter();
  await printSpooler.whenIdle();
  const { registerShiftsHandlers } = await import('./shifts-handlers.js');
  registerShiftsHandlers({ db, deviceId: TILL } as never);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const live = describe.skipIf(!DatabaseSync);

live('(1) the paper at the close', () => {
  it('a manager closes: the reply says printing and carries the close’s own takings; then one paper, the saved report, no drawer pulse, one print row', async () => {
    const shiftId = await openShift();
    const first = await paid('cash');
    await paid('card');
    // The close box opens: its takings, read before the count.
    h.session = MANAGER;
    const box = await call<ShiftSummary>('shifts:summary', { shiftId });
    // A cash sale while the drawer is being counted.
    const late = await paid('cash');
    expect(box.cashSalesCents).toBe(first.total);

    const closed = await close(shiftId, MANAGER);

    expect(closed.reportPrint).toBe('printing');
    expect(closed.closedAt).not.toBeNull();
    const stored = storedShift(shiftId);
    expect(closed.expectedCashCents).toBe(stored['expected_cash_cents']);
    // The takings as the close saved them, not the box's.
    expect(closed.summary).toBeDefined();
    expect(closed.summary!.cashSalesCents).toBe(first.total + late.total);
    expect(closed.summary!.paidOrderCount).toBe(3);
    expect(closed.summary!.expectedCashCents).toBe(stored['expected_cash_cents']);

    const [text] = await settledPapers(1);
    const lines = text!.split('\n');
    expect(lines).toContain('SHIFT REPORT');
    expect(lines).toContain('Till: TEST-TILL-1');
    // The stored expected cash, and the reply's Cash sales, as the paper prints them.
    expect(lines).toContain(paperRow('EXPECTED CASH', paperMoney(Number(stored['expected_cash_cents']))));
    expect(lines).toContain(paperRow('Cash sales', paperMoney(closed.summary!.cashSalesCents)));
    expect(lines.find((l) => l.startsWith('Closed '))).toMatch(/ Test Manager$/);
    // The full paper: every section, ORDERS last.
    expect(headings(text!)).toEqual(HEADINGS);
    expect(lines.some((l) => l.startsWith('ORDERS (3) '))).toBe(true);
    expect(lines.some((l) => l.startsWith('ITEMS SOLD (3) '))).toBe(true);
    expect(text).not.toContain('Some sections are off.');
    expect(lines.find((l) => l.startsWith('Printed '))).toMatch(/ by Test Manager$/);
    // No drawer pulse with it: not in its bytes, not asked for, and nothing else sent.
    expect(text).not.toContain('[drawer pin');
    expect(h.sends).toHaveLength(1);
    expect(h.sends[0]!.opts?.drawer).not.toBe(true);
    expect(failedEvents()).toEqual([]);

    // One try on record, chained.
    await vi.waitFor(() => expect(printAudits(shiftId)).toHaveLength(1));
    expect(printAudits(shiftId)[0]).toEqual({
      actor: 'u_mgr',
      shiftId,
      copy: 'original',
      reprintNo: 0,
      sections: ALL_SECTIONS,
      items: 'items',
      width: 48,
      outcome: 'ok',
      errorCode: null,
      byUserId: 'u_mgr',
      approvedByUserId: null,
    });
    expect(verifyAuditChain(auditRows())).toMatchObject({ ok: true, brokenAt: null });
    expect(h.errors).toEqual([]);
  });

  it('the paper is the saved report at the printer’s width (58 mm): every row fits 32 columns, and the print row says 32', async () => {
    await usePrinter({ ...PRINTER, width: 32 });
    const shiftId = await openShift();
    await paid('cash');
    await close(shiftId, MANAGER);

    const [text] = await settledPapers(1);
    expect(text!.split('\n').filter((l) => l.length > 32)).toEqual([]);
    expect(text).toContain('ORDERS (1)');
    await vi.waitFor(() => expect(printAudits(shiftId)).toHaveLength(1));
    expect(printAudits(shiftId)[0]).toMatchObject({ width: 32, outcome: 'ok' });
  });
});

live('(2) a paper that does not print never holds up the close', () => {
  it('the printer fails: the close resolves printing, the shift is closed, the till is told once (naming the shift), the try is on record as failed', async () => {
    const shiftId = await openShift();
    await paid('cash');
    h.script.push(() => ({
      ok: false,
      durationMs: 1,
      error: { code: 'network_error', message: 'connect EHOSTUNREACH 192.0.2.5:9100', recoverable: true },
    }));

    const closed = await close(shiftId, MANAGER);

    expect(closed.reportPrint).toBe('printing');
    expect(storedShift(shiftId)['closed_at']).toBe(closed.closedAt);
    await vi.waitFor(() => expect(failedEvents()).toHaveLength(1));
    const event = failedEvents()[0]!.payload;
    expect(event).toEqual({
      jobKind: 'shift_report',
      shiftId,
      what: 'Shift report',
      error: { code: 'network_error', message: 'connect EHOSTUNREACH 192.0.2.5:9100' },
      retrying: false,
    });
    // Not a print_queue job: the queue's own retry never sees it.
    expect(event).not.toHaveProperty('jobId');
    expect(event).not.toHaveProperty('orderId');
    await settledPapers(1);
    expect(failedEvents()).toHaveLength(1);
    expect(printAudits(shiftId)).toEqual([expect.objectContaining({ copy: 'original', outcome: 'failed', errorCode: 'network_error' })]);
    expect(verifyAuditChain(auditRows()).ok).toBe(true);
  });

  it('the printer fails after the bytes may have gone out: on record as maybe, and the till is told', async () => {
    const shiftId = await openShift();
    h.script.push(() => ({
      ok: false,
      durationMs: 5_000,
      error: { code: 'timeout', message: 'The printer did not answer', recoverable: true, maybeSent: true },
    }));

    expect((await close(shiftId, MANAGER)).reportPrint).toBe('printing');

    await vi.waitFor(() => expect(failedEvents()).toHaveLength(1));
    expect(failedEvents()[0]!.payload).toMatchObject({ jobKind: 'shift_report', shiftId, error: { code: 'timeout' } });
    expect(printAudits(shiftId)).toEqual([expect.objectContaining({ outcome: 'maybe', errorCode: 'timeout' })]);
  });

  it('the printer never answers: the close resolves first, closed and saved; the paper’s outcome comes later', async () => {
    const shiftId = await openShift();
    await paid('cash');
    let answer: (r: PrintResult) => void = () => {};
    h.script.push(() => new Promise<PrintResult>((resolve) => (answer = resolve)));

    const closed = await close(shiftId, MANAGER);

    // The reply came back while the printer still had not answered.
    expect(closed.reportPrint).toBe('printing');
    expect(closed.summary).toBeDefined();
    expect(storedShift(shiftId)).toMatchObject({ closed_at: closed.closedAt });
    expect(String(storedShift(shiftId)['close_report_json'])).toContain('"v":1');
    await vi.waitFor(() => expect(papers()).toHaveLength(1));
    expect(printAudits(shiftId)).toEqual([]);
    expect(failedEvents()).toEqual([]);

    // It answers at last (so the spooler is free for the next test).
    answer({ ok: true, durationMs: 9_000 });
    await vi.waitFor(() => expect(printAudits(shiftId)).toHaveLength(1));
    expect(printAudits(shiftId)[0]).toMatchObject({ outcome: 'ok' });
    expect(failedEvents()).toEqual([]);
  });

  it('the adapter throws: the close resolves printing, and the till is told', async () => {
    const shiftId = await openShift();
    h.script.push(() => {
      throw new Error('Test: the print worker died');
    });

    const closed = await close(shiftId, MANAGER);

    expect(closed.reportPrint).toBe('printing');
    expect(storedShift(shiftId)['closed_at']).toBe(closed.closedAt);
    await vi.waitFor(() => expect(failedEvents()).toHaveLength(1));
    expect(failedEvents()[0]!.payload).toMatchObject({
      jobKind: 'shift_report',
      shiftId,
      error: { code: 'spooler_exception', message: 'Test: the print worker died' },
    });
    expect(printAudits(shiftId)).toEqual([expect.objectContaining({ outcome: 'failed', errorCode: 'spooler_exception' })]);
  });
});

live('(3) no paper', () => {
  it('printing at close switched off: off, nothing sent, nothing on record; the report is still saved', async () => {
    await setRules({ shiftReportOnClose: false });
    const shiftId = await openShift();
    await paid('cash');

    const closed = await close(shiftId, MANAGER);

    expect(closed.reportPrint).toBe('off');
    expect(closed.summary).toBeDefined();
    await settledPapers(0);
    expect(h.sends).toEqual([]);
    expect(printAudits(shiftId)).toEqual([]);
    expect(failedEvents()).toEqual([]);
    expect(parseShiftReportJson(String(storedShift(shiftId)['close_report_json']))).toHaveProperty('report');
  });

  it('the "No printer" setup: no_printer; the report goes to its file only — no failure note and nothing on record, even when the file cannot be written', async () => {
    const { DEFAULT_RECEIPT_CONFIG } = await import('../../services/printer-config.js');
    await usePrinter(DEFAULT_RECEIPT_CONFIG);
    const shiftId = await openShift();
    await paid('cash');

    expect((await close(shiftId, MANAGER)).reportPrint).toBe('no_printer');

    const [text] = await settledPapers(1);
    // To the "No printer" setup's file (the mock printer), like every paper there.
    expect(papers()[0]!.config.network?.host).toBe('mock');
    expect(text).toContain('ORDERS (1)');
    expect(printAudits(shiftId)).toEqual([]);
    expect(failedEvents()).toEqual([]);

    // The next close's file cannot be written: still no failure note, nothing on record.
    const next = await openShift();
    h.script.push(() => ({ ok: false, durationMs: 1, error: { code: 'mock_write_failed', message: 'EACCES', recoverable: false } }));
    expect((await close(next, MANAGER)).reportPrint).toBe('no_printer');
    await settledPapers(2);
    expect(printAudits(next)).toEqual([]);
    expect(failedEvents()).toEqual([]);
  });

  it('no report saved (the maker threw): not_made; the shift is closed, nothing is sent', async () => {
    h.makerThrows = true;
    const shiftId = await openShift();
    await paid('cash');

    const closed = await close(shiftId, MANAGER);

    expect(closed.reportPrint).toBe('not_made');
    expect(storedShift(shiftId)).toMatchObject({ closed_at: closed.closedAt, close_report_json: null });
    expect(closed.summary).toBeDefined();
    await settledPapers(0);
    expect(h.sends).toEqual([]);
    expect(printAudits(shiftId)).toEqual([]);
    expect(failedEvents()).toEqual([]);
    expect(h.errors).toEqual([['Shift report not made', { shiftId, error: 'Test: the report broke' }]]);
  });

  it('the print settings cannot be read: the close is ok with not_made, never "Close shift failed"; the report is saved', async () => {
    const shiftId = await openShift();
    await paid('cash');
    h.policyThrows = true;

    const closed = await close(shiftId, MANAGER);

    expect(closed.reportPrint).toBe('not_made');
    expect(storedShift(shiftId)['closed_at']).toBe(closed.closedAt);
    expect(parseShiftReportJson(String(storedShift(shiftId)['close_report_json']))).toHaveProperty('report');
    await settledPapers(0);
    expect(printAudits(shiftId)).toEqual([]);
    expect(h.errors).toEqual([['Shift report not printed at the close', { shiftId, error: 'Test: the print settings broke' }]]);
  });
});

live('(4) the count stays blind, and the paper is the full one for every closer', () => {
  it('the close check and the count’s drawer pulse print no report; a refused close prints nothing', async () => {
    const shiftId = await openShift();
    await paid('cash');
    h.session = MANAGER;
    await call('shifts:closeCheck', { shiftId });
    await call('shifts:openDrawer', { kind: 'count' });
    // The pulse went to the printer; no report with it.
    await vi.waitFor(() => expect(h.sends).toHaveLength(1));
    expect(escPosToText(h.sends[0]!.bytes)).toContain('[drawer pin');
    await settledPapers(0);

    // Refused: a cashier with no PIN, a wrong PIN, notes that do not add up.
    h.session = CASHIER;
    expect(await refusal('shifts:close', { shiftId, countedCashCents: FLOAT })).toMatchObject({ code: 'forbidden' });
    expect(await refusal('shifts:close', { shiftId, countedCashCents: FLOAT, approverPin: '1111' })).toMatchObject({ code: 'forbidden' });
    h.session = MANAGER;
    expect(
      await refusal('shifts:close', {
        shiftId,
        countedCashCents: FLOAT,
        countedNotes: { notes: [{ faceCents: 100_000, count: 1 }], otherCents: 0 },
      }),
    ).toMatchObject({ code: 'precondition_failed' });
    await settledPapers(0);
    expect(h.sends).toHaveLength(1);
    expect(printAudits(shiftId)).toEqual([]);
    expect(storedShift(shiftId)['closed_at']).toBeNull();
  });

  it('a manager’s PIN on a cashier’s login: no expected cash and no summary in the reply, but the FULL paper prints', async () => {
    const shiftId = await openShift();
    await paid('cash');
    await paid('card');

    const closed = await close(shiftId, CASHIER, { approverPin: PIN });

    expect(closed.reportPrint).toBe('printing');
    expect(closed.expectedCashCents).toBeNull();
    expect(closed).not.toHaveProperty('summary');
    expect(closed.closedByUserId).toBe('u_mgr');

    const [text] = await settledPapers(1);
    expect(headings(text!)).toEqual(HEADINGS);
    const lines = text!.split('\n');
    expect(lines).toContain(paperRow('EXPECTED CASH', paperMoney(Number(storedShift(shiftId)['expected_cash_cents']))));
    expect(lines).toContain("  PIN on Test Cashier's login");
    expect(lines.find((l) => l.startsWith('Printed '))).toMatch(/ by Test Manager$/);
    await vi.waitFor(() => expect(printAudits(shiftId)).toHaveLength(1));
    expect(printAudits(shiftId)[0]).toMatchObject({ sections: ALL_SECTIONS, byUserId: 'u_mgr', approvedByUserId: 'u_mgr', outcome: 'ok' });
  });

  it('the owner switched ITEMS SOLD and ORDERS off: they leave the paper for every closer (owner, manager, PIN) while the saved report keeps both', async () => {
    await setRules({ shiftReportSections: { items: false, orders: false } });
    const closers: Array<[AuthenticatedUser, Record<string, unknown>]> = [
      [OWNER, {}],
      [MANAGER, {}],
      [CASHIER, { approverPin: PIN }],
    ];
    for (const [i, [who, more]] of closers.entries()) {
      const shiftId = await openShift();
      await paid('cash');
      expect((await close(shiftId, who, more)).reportPrint).toBe('printing');

      const text = (await settledPapers(i + 1))[i]!;
      expect(headings(text)).toEqual(HEADINGS.filter((head) => head !== 'ITEMS SOLD' && head !== 'ORDERS'));
      expect(text).toContain('Some sections are off.\nSee Settings > Printers.');
      // The saved report keeps every section, items and orders too.
      const saved = parseShiftReportJson(String(storedShift(shiftId)['close_report_json']));
      expect(saved && 'report' in saved ? { items: saved.report.items.length, orders: saved.report.orders.length } : null).toEqual({
        items: 1,
        orders: 1,
      });
      await vi.waitFor(() => expect(printAudits(shiftId)).toHaveLength(1));
      expect(printAudits(shiftId)[0]!['sections']).toEqual(ALL_SECTIONS.filter((s) => s !== 'items' && s !== 'orders'));
    }
  });
});
