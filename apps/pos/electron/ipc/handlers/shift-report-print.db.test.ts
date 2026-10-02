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
 * And printing it again, 'shifts:printReport' (final plan step 19f-3):
 *   (5) Who may: a manager this till's shift within 15 minutes of its close
 *       (the till's clock, either side), DUPLICATE Reprint #1 then #2, and
 *       not the other till's; the owner any closed shift, one that came over
 *       the link too, with that till's name on it, at this till's width,
 *       with the note count as counted there; a cashier's login with a
 *       manager's or the owner's PIN or password and then by their rules
 *       (none: needs manager_pin; a wrong one: wrongSecret). Refused in plain
 *       words: a shift still open, one closed with no report, a newer till's
 *       report, one that cannot be read, an unknown shift.
 *   (6) Try again prints the ORIGINAL after a failed one, a DUPLICATE once
 *       it came out or may have; a reprint that does not print says why and
 *       leaves its number to the next; two presses at once print #1 and #2;
 *       the "No printer" setup writes the file, puts nothing on record and
 *       says so.
 *   (7) Frozen: after a refund and a deleted test order, a reprint's figures
 *       are the original's to the character; only the DUPLICATE band and the
 *       footer differ, and the footer notes the deleted cash.
 *   (8) One chained 'shift_report_printed' row per try, failed ones too, and
 *       none for a refusal.
 *  (12) The switches change only what prints: ORDERS off at the close, on
 *       for a reprint, prints from the saved report; printing at close off
 *       still prints again.
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
import { CASH_NOTE_FACE_CENTS, SHIFT_REPORT_AGAIN_MS } from '@cheeseoclock/shared-types';
import type {
  AuthenticatedUser,
  ClosedShift,
  PrintResult,
  PrinterConnectionConfig,
  ShiftReportPrintResult,
  ShiftSummary,
  UUID,
} from '@cheeseoclock/shared-types';
import type { AppDatabase } from '../../db/connection.js';
import { DatabaseSync } from '../../db/costing-shop.fixture.js';
import { openTill, push } from '../../db/two-tills.fixture.js';
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
    if (pin === 'Owner-pass-9') return { approverUserId: 'u_admin', approverName: 'Test Owner' };
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
const OWNER_PIN = 'Owner-pass-9';
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

// ------------------------------------------------- printing it again (19f-3)

/** Print the shift report again with `who` signed in: Print again, unless `more` says again: false (Try again). */
async function printAgain(shiftId: string, who: AuthenticatedUser, more: Record<string, unknown> = {}): Promise<ShiftReportPrintResult> {
  h.session = who;
  return call<ShiftReportPrintResult>('shifts:printReport', { shiftId, ...more });
}

/** The refusal, with `who` signed in: its code, its words and any details. */
async function printRefused(shiftId: string, who: AuthenticatedUser, more: Record<string, unknown> = {}): Promise<unknown> {
  h.session = who;
  return refusal('shifts:printReport', { shiftId, ...more });
}

/** The till's clock reads `ms` (Date.now: what the 15 minutes are measured with). */
const clockAt = (ms: number) => vi.spyOn(Date, 'now').mockReturnValue(ms);

/** A shift with a cash and a card sale, closed by the manager; its original paper printed and on record. */
async function closedAndPrinted(): Promise<{ shiftId: string; closedMs: number; original: string }> {
  const shiftId = await openShift();
  await paid('cash');
  await paid('card');
  const closed = await close(shiftId, MANAGER);
  const [original] = await settledPapers(1);
  await vi.waitFor(() => expect(printAudits(shiftId)).toHaveLength(1));
  return { shiftId, closedMs: Date.parse(closed.closedAt!), original: original! };
}

/** The paper's figures: from SHIFT REPORT down to its 'Printed' line (the DUPLICATE band above and the footer below left out). */
function figuresOf(text: string): string[] {
  const lines = text.split('\n');
  const end = lines.findIndex((l) => l.startsWith('Printed '));
  expect(end).toBeGreaterThan(0);
  return lines.slice(lines.indexOf('SHIFT REPORT'), end);
}

/** The paper's footer: its 'Printed' line to the end, blank rows and the cut left out. */
function footerOf(text: string): string[] {
  const lines = text.split('\n');
  return lines.slice(lines.findIndex((l) => l.startsWith('Printed '))).filter((l) => l.trim() !== '' && !l.startsWith('[cut'));
}

/** The DUPLICATE band's middle line ('Reprint #1 | dd/mm/yyyy hh:mm | by NAME'), or undefined on an original. */
const bandOf = (text: string) => {
  const lines = text.split('\n');
  return lines.includes('DUPLICATE') ? lines[lines.indexOf('DUPLICATE') + 1] : undefined;
};

live('(5) printing it again: who may', () => {
  it('a manager: this till’s shift within 15 minutes of its close (the till’s clock, either side) — DUPLICATE Reprint #1, then #2; after that refused, to a PIN on a cashier’s login too; the owner still prints it', async () => {
    const { shiftId, closedMs } = await closedAndPrinted();

    expect(await printAgain(shiftId, MANAGER)).toEqual({ printed: true, copy: 'reprint', reprintNo: 1, error: null });
    clockAt(closedMs + SHIFT_REPORT_AGAIN_MS); // the last moment
    expect(await printAgain(shiftId, MANAGER)).toEqual({ printed: true, copy: 'reprint', reprintNo: 2, error: null });
    const [, first, second] = await settledPapers(3);
    expect(bandOf(first!)?.startsWith('Reprint #1 | ')).toBe(true);
    expect(bandOf(first!)?.endsWith(' | by Test Manager')).toBe(true);
    expect(footerOf(first!).at(-1)).toBe('** DUPLICATE - Reprint #1 **');
    expect(footerOf(second!).at(-1)).toBe('** DUPLICATE - Reprint #2 **');

    const older = { code: 'forbidden', message: 'Only the owner can print an older shift report - from Shift history' };
    clockAt(closedMs + SHIFT_REPORT_AGAIN_MS + 1);
    expect(await printRefused(shiftId, MANAGER)).toEqual(older);
    // The manager's PIN on a cashier's login: the manager's rules.
    expect(await printRefused(shiftId, CASHIER, { approverPin: PIN })).toEqual(older);
    // A till clock put back more than 15 minutes before the close: refused too.
    clockAt(closedMs - SHIFT_REPORT_AGAIN_MS - 1);
    expect(await printRefused(shiftId, MANAGER)).toEqual(older);
    clockAt(closedMs - SHIFT_REPORT_AGAIN_MS);
    expect(await printAgain(shiftId, MANAGER)).toMatchObject({ printed: true, reprintNo: 3 });

    // The owner, and the owner's PIN on a cashier's login: any time.
    clockAt(closedMs + 24 * 60 * 60_000);
    expect(await printAgain(shiftId, OWNER)).toEqual({ printed: true, copy: 'reprint', reprintNo: 4, error: null });
    expect(await printAgain(shiftId, CASHIER, { approverPin: OWNER_PIN })).toEqual({ printed: true, copy: 'reprint', reprintNo: 5, error: null });
    await settledPapers(6);
    expect(printAudits(shiftId).map((a) => [a['actor'], a['copy'], a['reprintNo'], a['byUserId'], a['approvedByUserId'], a['outcome']])).toEqual([
      ['u_mgr', 'original', 0, 'u_mgr', null, 'ok'],
      ['u_mgr', 'reprint', 1, 'u_mgr', null, 'ok'],
      ['u_mgr', 'reprint', 2, 'u_mgr', null, 'ok'],
      ['u_mgr', 'reprint', 3, 'u_mgr', null, 'ok'],
      ['u_admin', 'reprint', 4, 'u_admin', null, 'ok'],
      ['u_cash', 'reprint', 5, 'u_cash', 'u_admin', 'ok'],
    ]);
  });

  it('a cashier’s login: asked for a manager’s PIN or password (needs manager_pin), a wrong one refused as wrong; with the manager’s it prints, by the cashier, approved by the manager', async () => {
    const { shiftId } = await closedAndPrinted();

    expect(await printRefused(shiftId, CASHIER)).toEqual({
      code: 'forbidden',
      message: "A manager's PIN or password is needed to print the shift report",
      details: { needs: 'manager_pin' },
    });
    expect(await printRefused(shiftId, CASHIER, { approverPin: '1111' })).toEqual({
      code: 'forbidden',
      message: "That is not a manager's PIN or password",
      details: { needs: 'manager_pin', wrongSecret: true },
    });
    await settledPapers(1);
    expect(printAudits(shiftId)).toHaveLength(1);

    expect(await printAgain(shiftId, CASHIER, { approverPin: PIN })).toEqual({ printed: true, copy: 'reprint', reprintNo: 1, error: null });
    const [, text] = await settledPapers(2);
    expect(bandOf(text!)?.endsWith(' | by Test Cashier')).toBe(true);
    expect(footerOf(text!)[0]?.endsWith(' by Test Cashier')).toBe(true);
    expect(printAudits(shiftId)[1]).toEqual({
      actor: 'u_cash',
      shiftId,
      copy: 'reprint',
      reprintNo: 1,
      sections: ALL_SECTIONS,
      items: 'items',
      width: 48,
      outcome: 'ok',
      errorCode: null,
      byUserId: 'u_cash',
      approvedByUserId: 'u_mgr',
    });
  });

  it('the other till’s shift, come over the link: a manager is refused; the owner prints it with that till’s name on it, a DUPLICATE even on Try again', async () => {
    const b = openTill('till-b', { usersFrom: TILL, displayName: 'TEST-TILL-2 (win32)' });
    const repo = await import('../../db/repositories/shift-repo.js');
    const { makeShiftReport } = await import('../../services/shift-report-service.js');
    const onB = { userId: 'u_mgr', deviceId: 'till-b' };
    const shiftId = repo.openShift(b, { openingCashCents: FLOAT }, onB).id;
    repo.closeShift(b, { shiftId, countedCashCents: FLOAT, notes: null }, onB, null, { makeReport: makeShiftReport(b, 'till-b') });
    await push(b, 'till-b', db);
    expect(repo.getShiftCloseReport(db, shiftId)).toMatchObject({ deviceId: 'till-b' });

    expect(await printRefused(shiftId, MANAGER)).toEqual({
      code: 'forbidden',
      message: "Only the owner can print the other till's shift report - from Shift history",
    });
    // This till never tried that shift's original: Try again is a DUPLICATE too.
    expect(await printAgain(shiftId, OWNER, { again: false })).toEqual({ printed: true, copy: 'reprint', reprintNo: 1, error: null });
    const [text] = await settledPapers(1);
    expect(text!.split('\n')).toContain('Till: TEST-TILL-2');
    expect(text!.split('\n')).not.toContain('Till: TEST-TILL-1');
    expect(printAudits(shiftId)).toEqual([expect.objectContaining({ actor: 'u_admin', copy: 'reprint', reprintNo: 1, outcome: 'ok' })]);
  });

  it('the other till’s shift, closed there counted by note with a 58 mm printer: the owner prints it here at this till’s width (48 columns), headed with that till’s name, its note count as counted there', async () => {
    const b = openTill('till-b', { usersFrom: TILL, displayName: 'TEST-TILL-2 (win32)' });
    const { setReceiptPrinterConfig } = await import('../../services/printer-config.js');
    setReceiptPrinterConfig(b, { ...PRINTER, width: 32 });
    const repo = await import('../../db/repositories/shift-repo.js');
    const { makeShiftReport } = await import('../../services/shift-report-service.js');
    const onB = { userId: 'u_mgr', deviceId: 'till-b' };
    const shiftId = repo.openShift(b, { openingCashCents: FLOAT }, onB).id;
    // The float counted on till B: Rs 1,000 × 4, 500 × 1, 100 × 4, 50 × 1, 20 × 2 and Rs 10 in coins.
    const byFace: Record<number, number> = { 100_000: 4, 50_000: 1, 10_000: 4, 5_000: 1, 2_000: 2 };
    const countedNotes = { notes: CASH_NOTE_FACE_CENTS.map((faceCents) => ({ faceCents, count: byFace[faceCents] ?? 0 })), otherCents: 1_000 };
    repo.closeShift(b, { shiftId, countedCashCents: FLOAT, countedNotes, notes: null }, onB, null, { makeReport: makeShiftReport(b, 'till-b') });
    await push(b, 'till-b', db);
    // Both the count and the report came over the link.
    expect(repo.findShift(db, shiftId)).toMatchObject({ countedCashCents: FLOAT, countedNotes });
    expect(repo.getShiftCloseReport(db, shiftId)).toMatchObject({ deviceId: 'till-b' });

    expect(await printAgain(shiftId, OWNER)).toEqual({ printed: true, copy: 'reprint', reprintNo: 1, error: null });
    const [text] = await settledPapers(1);
    const lines = text!.split('\n');
    expect(lines).toContain('Till: TEST-TILL-2');
    expect(lines).not.toContain('Till: TEST-TILL-1');
    // At this till's width, not till B's: every row fits 48 columns, the count's rows right-aligned at 48.
    expect(lines.filter((l) => l.length > 48)).toEqual([]);
    const counted = lines.indexOf('CASH COUNTED');
    expect(counted).toBeGreaterThan(0);
    expect(lines.slice(counted, counted + 8)).toEqual([
      'CASH COUNTED',
      paperRow('Rs 1,000 x 4', '4,000.00'),
      paperRow('Rs 500 x 1', '500.00'),
      paperRow('Rs 100 x 4', '400.00'),
      paperRow('Rs 50 x 1', '50.00'),
      paperRow('Rs 20 x 2', '40.00'),
      paperRow('Coins and other', '10.00'),
      paperRow('COUNTED', '5,000.00'),
    ]);
    expect(printAudits(shiftId)).toEqual([expect.objectContaining({ actor: 'u_admin', copy: 'reprint', reprintNo: 1, width: 48, outcome: 'ok' })]);
  });

  it('refused in plain words, nothing printed or put on record: a shift still open, one closed with no report saved, a newer till’s report, one that cannot be read, an unknown shift', async () => {
    const shiftId = await openShift();
    await paid('cash');
    for (const who of [OWNER, MANAGER]) {
      expect(await printRefused(shiftId, who)).toEqual({ code: 'precondition_failed', message: 'This shift is still open - close it first' });
    }
    h.makerThrows = true;
    expect((await close(shiftId, MANAGER)).reportPrint).toBe('not_made');
    h.makerThrows = false;
    for (const who of [OWNER, MANAGER]) {
      expect(await printRefused(shiftId, who)).toEqual({ code: 'not_found', message: 'This shift was closed before the till printed shift reports' });
    }

    const next = await openShift();
    await close(next, MANAGER);
    await settledPapers(1);
    await vi.waitFor(() => expect(printAudits(next)).toHaveLength(1));
    db.prepare(`UPDATE shifts SET close_report_json = ? WHERE id = ?`).run('{"v":2,"tillName":"TEST-TILL-9"}', next);
    expect(await printRefused(next, OWNER)).toEqual({
      code: 'precondition_failed',
      message: 'This shift report was made by a newer till - update this till to print it',
    });
    db.prepare(`UPDATE shifts SET close_report_json = ? WHERE id = ?`).run('{"v":1,"tillName":"TEST-TILL-1"}', next);
    expect(await printRefused(next, OWNER)).toEqual({ code: 'precondition_failed', message: "This shift's saved report could not be read" });
    expect(await printRefused('no-such-shift', OWNER)).toEqual({ code: 'not_found', message: 'That shift was not found' });
    h.session = null;
    expect(await refusal('shifts:printReport', { shiftId: next })).toEqual({ code: 'unauthenticated', message: 'Not logged in' });

    await settledPapers(1);
    expect(printAudits(shiftId)).toEqual([]);
    expect(printAudits(next)).toHaveLength(1);
    expect(failedEvents()).toEqual([]);
  });
});

live('(6) Try again and the printer’s answer', () => {
  it('Try again after a failed original prints the ORIGINAL (no DUPLICATE, no failure note); once it is out, Try again is a DUPLICATE', async () => {
    const shiftId = await openShift();
    await paid('cash');
    h.script.push(() => ({
      ok: false,
      durationMs: 1,
      error: { code: 'network_error', message: 'connect EHOSTUNREACH 192.0.2.5:9100', recoverable: true },
    }));
    await close(shiftId, MANAGER);
    await vi.waitFor(() => expect(failedEvents()).toHaveLength(1));
    const [failed] = await settledPapers(1);

    expect(await printAgain(shiftId, MANAGER, { again: false })).toEqual({ printed: true, copy: 'original', reprintNo: 0, error: null });
    const [, original] = await settledPapers(2);
    expect(bandOf(original!)).toBeUndefined();
    expect(original).not.toContain('DUPLICATE');
    expect(figuresOf(original!)).toEqual(figuresOf(failed!));

    expect(await printAgain(shiftId, MANAGER, { again: false })).toEqual({ printed: true, copy: 'reprint', reprintNo: 1, error: null });
    const [, , dup] = await settledPapers(3);
    expect(footerOf(dup!).at(-1)).toBe('** DUPLICATE - Reprint #1 **');
    // The Try again's answer is its reply: no second failure note.
    expect(failedEvents()).toHaveLength(1);
    expect(printAudits(shiftId).map((a) => [a['copy'], a['reprintNo'], a['outcome'], a['errorCode']])).toEqual([
      ['original', 0, 'failed', 'network_error'],
      ['original', 0, 'ok', null],
      ['reprint', 1, 'ok', null],
    ]);
    expect(verifyAuditChain(auditRows())).toMatchObject({ ok: true, brokenAt: null });
  });

  it('after an original that may have come out (maybe), Try again is a DUPLICATE', async () => {
    const shiftId = await openShift();
    h.script.push(() => ({
      ok: false,
      durationMs: 5_000,
      error: { code: 'timeout', message: 'The printer did not answer', recoverable: true, maybeSent: true },
    }));
    await close(shiftId, MANAGER);
    await vi.waitFor(() => expect(printAudits(shiftId)).toEqual([expect.objectContaining({ outcome: 'maybe' })]));

    expect(await printAgain(shiftId, MANAGER, { again: false })).toEqual({ printed: true, copy: 'reprint', reprintNo: 1, error: null });
    const [, dup] = await settledPapers(2);
    expect(bandOf(dup!)?.startsWith('Reprint #1 | ')).toBe(true);
  });

  it('(8) a reprint that does not print says why and leaves its number to the next; one that may have printed uses it up; every try is one chained row, a refusal none', async () => {
    const { shiftId } = await closedAndPrinted();
    h.script.push(() => ({
      ok: false,
      durationMs: 1,
      error: { code: 'network_error', message: 'connect EHOSTUNREACH 192.0.2.5:9100', recoverable: true },
    }));
    expect(await printAgain(shiftId, MANAGER)).toEqual({
      printed: false,
      copy: 'reprint',
      reprintNo: 1,
      error: { code: 'network_error', message: 'connect EHOSTUNREACH 192.0.2.5:9100' },
    });
    h.script.push(() => ({
      ok: false,
      durationMs: 5_000,
      error: { code: 'timeout', message: 'The printer did not answer', recoverable: true, maybeSent: true },
    }));
    expect(await printAgain(shiftId, MANAGER)).toEqual({
      printed: false,
      copy: 'reprint',
      reprintNo: 1,
      error: { code: 'timeout', message: 'The printer did not answer', maybeSent: true },
    });
    h.script.push(() => {
      throw new Error('Test: the print worker died');
    });
    expect(await printAgain(shiftId, MANAGER)).toEqual({
      printed: false,
      copy: 'reprint',
      reprintNo: 2,
      error: { code: 'spooler_exception', message: 'Test: the print worker died' },
    });
    expect(await printAgain(shiftId, MANAGER)).toEqual({ printed: true, copy: 'reprint', reprintNo: 2, error: null });

    // A refusal adds nothing.
    expect(await printRefused(shiftId, CASHIER)).toMatchObject({ code: 'forbidden' });
    await settledPapers(5);
    expect(failedEvents()).toEqual([]);
    expect(printAudits(shiftId).map((a) => [a['copy'], a['reprintNo'], a['outcome'], a['errorCode']])).toEqual([
      ['original', 0, 'ok', null],
      ['reprint', 1, 'failed', 'network_error'],
      ['reprint', 1, 'maybe', 'timeout'],
      ['reprint', 2, 'failed', 'spooler_exception'],
      ['reprint', 2, 'ok', null],
    ]);
    expect(verifyAuditChain(auditRows())).toMatchObject({ ok: true, brokenAt: null });
    expect(h.errors).toEqual([]);
  });

  it('two presses at once print one after the other: Reprint #1 and #2', async () => {
    const { shiftId } = await closedAndPrinted();
    const both = await Promise.all([printAgain(shiftId, MANAGER), printAgain(shiftId, MANAGER)]);
    expect(both.map((r) => [r.printed, r.reprintNo])).toEqual([
      [true, 1],
      [true, 2],
    ]);
    const [, first, second] = await settledPapers(3);
    expect(footerOf(first!).at(-1)).toBe('** DUPLICATE - Reprint #1 **');
    expect(footerOf(second!).at(-1)).toBe('** DUPLICATE - Reprint #2 **');
  });

  it('the "No printer" setup: the paper goes to its file, nothing is put on record, and the reply says no printer', async () => {
    const { DEFAULT_RECEIPT_CONFIG } = await import('../../services/printer-config.js');
    await usePrinter(DEFAULT_RECEIPT_CONFIG);
    const shiftId = await openShift();
    expect((await close(shiftId, MANAGER)).reportPrint).toBe('no_printer');
    await settledPapers(1);

    expect(await printAgain(shiftId, MANAGER)).toEqual({
      printed: false,
      copy: 'reprint',
      reprintNo: 1,
      error: { code: 'no_printer', message: 'No receipt printer is set up on this till' },
    });
    const [, file] = await settledPapers(2);
    expect(papers()[1]!.config.network?.host).toBe('mock');
    expect(footerOf(file!).at(-1)).toBe('** DUPLICATE - Reprint #1 **');
    expect(printAudits(shiftId)).toEqual([]);
    expect(failedEvents()).toEqual([]);
  });
});

live('(7) a reprint prints the saved figures', () => {
  it('after a refund and a deleted test order: the same figures as the original to the character; only the DUPLICATE band and the footer differ, and the footer notes the deleted cash', async () => {
    const shiftId = await openShift();
    await paid('cash');
    const refunded = await paid('cash');
    const test = await paid('cash');
    await paid('card');
    await close(shiftId, MANAGER);
    const [original] = await settledPapers(1);
    const saved = storedShift(shiftId)['close_report_json'];

    // After the close, in the next shift: one order refunded, another deleted by the owner as a test.
    const r = await import('../../db/repositories/order-repo.js');
    await openShift();
    r.refundOrder(db, { orderId: refunded.id, reason: 'Test refund', approverUserId: 'u_mgr', foodMade: 'made' }, BOSS);
    r.deleteTestOrder(
      db,
      { orderId: test.id, reason: 'Printer test', restock: null, expectStatus: r.findOrder(db, test.id)!.status, ownerUserId: 'u_admin' },
      { userId: 'u_admin', deviceId: TILL },
    );
    expect(storedShift(shiftId)['close_report_json']).toBe(saved);

    expect(await printAgain(shiftId, MANAGER)).toEqual({ printed: true, copy: 'reprint', reprintNo: 1, error: null });
    const [, reprint] = await settledPapers(2);
    expect(figuresOf(reprint!)).toEqual(figuresOf(original!));
    expect(figuresOf(reprint!).some((l) => l.startsWith('ORDERS (4) '))).toBe(true);
    expect(reprint).not.toContain('(refunded)');
    expect(bandOf(original!)).toBeUndefined();
    expect(bandOf(reprint!)?.startsWith('Reprint #1 | ')).toBe(true);

    const deleted = paperMoney(test.total);
    expect(footerOf(original!).slice(1)).toEqual([
      'Sales = orders paid on this till this shift.',
      'Figures as saved when the shift closed.',
      '-- END OF SHIFT REPORT --',
    ]);
    expect(footerOf(reprint!).slice(1)).toEqual([
      'Sales = orders paid on this till this shift.',
      'Figures as saved when the shift closed.',
      'Since the close: test orders deleted, cash',
      `${deleted} (not taken off above)`,
      '-- END OF SHIFT REPORT --',
      '** DUPLICATE - Reprint #1 **',
    ]);
  });
});

live('(12) the switches change only what prints', () => {
  it('a close printed with All orders off; the owner switches it on and prints again: a DUPLICATE with the ORDERS section from the saved report; switched off again, the next reprint leaves it off', async () => {
    await setRules({ shiftReportSections: { orders: false } });
    const shiftId = await openShift();
    await paid('cash');
    await paid('card');
    await close(shiftId, MANAGER);
    const [first] = await settledPapers(1);
    expect(headings(first!)).toEqual(HEADINGS.filter((head) => head !== 'ORDERS'));
    expect(first).toContain('Some sections are off.\nSee Settings > Printers.');

    await setRules({ shiftReportSections: { orders: true } });
    expect(await printAgain(shiftId, OWNER)).toEqual({ printed: true, copy: 'reprint', reprintNo: 1, error: null });
    const [, all] = await settledPapers(2);
    expect(headings(all!)).toEqual(HEADINGS);
    expect(all!.split('\n').some((l) => l.startsWith('ORDERS (2) '))).toBe(true);
    expect(all).not.toContain('Some sections are off.');

    await setRules({ shiftReportSections: { orders: false, items: false } });
    expect(await printAgain(shiftId, OWNER)).toMatchObject({ printed: true, reprintNo: 2 });
    const [, , fewer] = await settledPapers(3);
    expect(headings(fewer!)).toEqual(HEADINGS.filter((head) => head !== 'ORDERS' && head !== 'ITEMS SOLD'));
    expect(printAudits(shiftId).map((a) => a['sections'])).toEqual([
      ALL_SECTIONS.filter((s) => s !== 'orders'),
      ALL_SECTIONS,
      ALL_SECTIONS.filter((s) => s !== 'orders' && s !== 'items'),
    ]);
  });

  it('printing at close switched off: nothing at the close, and Print again still prints (a DUPLICATE, at the printer’s width: 58 mm here)', async () => {
    await usePrinter({ ...PRINTER, width: 32 });
    await setRules({ shiftReportOnClose: false });
    const shiftId = await openShift();
    await paid('cash');
    expect((await close(shiftId, MANAGER)).reportPrint).toBe('off');
    await settledPapers(0);

    expect(await printAgain(shiftId, MANAGER, { again: false })).toEqual({ printed: true, copy: 'reprint', reprintNo: 1, error: null });
    const [text] = await settledPapers(1);
    expect(text!.split('\n').filter((l) => l.length > 32)).toEqual([]);
    expect(text!.split('\n')).toContain('DUPLICATE');
    expect(headings(text!)).toEqual(HEADINGS);
    expect(printAudits(shiftId)).toEqual([expect.objectContaining({ copy: 'reprint', reprintNo: 1, width: 32, outcome: 'ok' })]);
  });
});
