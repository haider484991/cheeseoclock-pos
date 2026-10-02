/**
 * ORIGINAL or DUPLICATE on real orders — the owner's rule (27 Sep 2026: "the
 * original bill will be created by default flow; other bills by manual click
 * will count as duplicate") — through the REAL order repository, the real
 * print spooler, the real print log and reprint-service, on a database built
 * from every migration with foreign keys on. The printer is a stand-in that
 * records every byte, so each test reads the paper itself:
 *  - the paper the till prints by itself (payment, dispatch) is the original;
 *  - every paper printed with a print button says DUPLICATE with its reprint
 *    number, time and who — the first bill from the board and a
 *    cash-on-delivery receipt from Order History too;
 *  - a quick double press is one paper; "Try again" on a failed print sends
 *    the till's own job again, still the original;
 *  - M1: a paper that printed but could not be noted is noted before the next
 *    copy, so that copy still says DUPLICATE (and the purge keeps it);
 *  - M2: when the log can't be read, a hand-pressed paper still says
 *    DUPLICATE (no number), and a paper the till prints by itself prints
 *    unmarked;
 *  - the order panel's "Papers printed" and what the print button would do;
 *  - v0.7.34: an outside rider who pays the shop (Rider paid) while his bill
 *    still waits for the printer: the customer's copy is still the bill to
 *    collect, the SHOP COPY says what he paid, and no second paper prints;
 *    e2e fix A: Send out with "Paid now" on an idle printer — the drawer,
 *    then one bill whose SHOP COPY says RIDER PAID THE SHOP Rs 4,515.00 —
 *    and "Pays after delivery", whose bill says RIDER GIVES THE SHOP.
 *
 * node's own `node:sqlite` stands in for better-sqlite3 (built for Electron
 * here); skipped where it is missing. Every name and amount is made up.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { escPosToText } from '@cheeseoclock/printer-core';
import type { AuthenticatedUser, PrintResult, PrinterConnectionConfig, UUID } from '@cheeseoclock/shared-types';
import type { AppDatabase } from '../db/connection.js';
import { CASHIER, DEV, DatabaseSync, MANAGER, OWNER, openCostingShop, openMigrated } from '../db/costing-shop.fixture.js';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

const h = vi.hoisted(() => ({
  sends: [] as Uint8Array[],
  script: [] as Array<() => PrintResult | Promise<PrintResult>>,
  user: 'u_cash' as string | null,
  /** M1: recordDocumentPrint throws this many more times. */
  failRecord: 0,
  /** M2: listSeriesPrints throws while set. */
  failSeries: false,
  /** What the till windows were told (printer:failed notes). */
  events: [] as Array<{ channel: string; payload: Record<string, unknown> }>,
}));

vi.mock('electron-log/main', () => ({ default: { info: () => {}, warn: () => {}, error: () => {} } }));
vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [
      { webContents: { send: (channel: string, payload: Record<string, unknown>) => h.events.push({ channel, payload }) } },
    ],
  },
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
vi.mock('../db/repositories/document-print-repo.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../db/repositories/document-print-repo.js')>();
  return {
    ...real,
    recordDocumentPrint: (...args: Parameters<typeof real.recordDocumentPrint>) => {
      if (h.failRecord > 0) {
        h.failRecord -= 1;
        throw new Error('database is locked (made up)');
      }
      return real.recordDocumentPrint(...args);
    },
    listSeriesPrints: (...args: Parameters<typeof real.listSeriesPrints>) => {
      if (h.failSeries) throw new Error('database is locked (made up)');
      return real.listSeriesPrints(...args);
    },
  };
});

const session = (id: string, role: AuthenticatedUser['role'], fullName: string): AuthenticatedUser => ({
  id: id as UUID,
  fullName,
  role,
  sessionId: 'sess' as UUID,
});
const OWNER_LOGIN = session(OWNER.userId, 'admin', 'Test Owner');
const MANAGER_LOGIN = session(MANAGER.userId, 'manager', 'Test Manager');

const repos = async () => ({
  ...(await import('../db/repositories/order-repo.js')),
  ...(await import('../db/repositories/shift-repo.js')),
  ...(await import('../db/repositories/customer-repo.js')),
  ...(await import('../db/repositories/rider-repo.js')),
  ...(await import('../db/repositories/print-queue-repo.js')),
});

let db: AppDatabase;
let shop: Awaited<ReturnType<typeof openCostingShop>>;
let r: Awaited<ReturnType<typeof repos>>;
const spooler = async () => (await import('./print-spooler.js')).printSpooler;
const last = () => escPosToText(h.sends.at(-1)!);
const logRows = (orderId: string) =>
  db
    .prepare(`SELECT document, copy, print_no AS printNo, reason, outcome FROM document_prints WHERE order_id = ? ORDER BY created_at, rowid`)
    .all(orderId) as Array<{ document: string; copy: string; printNo: number; reason: string; outcome: string }>;
const customerRows = (orderId: string) => logRows(orderId).filter((x) => x.copy === 'customer');
const actions = (orderId: string) =>
  (
    db
      .prepare(
        `SELECT a.action FROM audit_log a JOIN document_prints d ON d.id = a.entity_id
          WHERE a.entity_type = 'document_prints' AND d.order_id = ? AND d.copy = 'customer' ORDER BY a.rowid`,
      )
      .all(orderId) as Array<{ action: string }>
  ).map((x) => x.action);

async function policy(p: Partial<{ kitchenTicket: boolean; shopCopy: 'never' | 'delivery' | 'always'; deliveryBillOnDispatch: boolean }>) {
  const { getPrintPolicy, setPrintPolicy } = await import('./printer-config.js');
  setPrintPolicy(db, { ...getPrintPolicy(db), ...p });
}
/** orders:tender (cash, in full), then the paper per Settings → Printer, as the handler does. */
async function tenderCash(orderId: string) {
  const total = r.findOrder(db, orderId)!.totalCents;
  const done = r.tenderOrder(db, { orderId, payments: [{ method: 'cash', amountCents: total, tenderedCents: total }] }, CASHIER);
  (await spooler()).onOrderEvent(orderId, 'paid', { drawerOpenId: done.drawerOpenId });
}
/** A print button (Order History, the board, the order panel) for this login. */
async function press(orderId: string, login: AuthenticatedUser = OWNER_LOGIN) {
  const { reprintWithApproval } = await import('./reprint-service.js');
  return reprintWithApproval(db, login, { orderId });
}

beforeEach(async () => {
  if (!DatabaseSync) return;
  h.sends.length = 0;
  h.script.length = 0;
  h.user = CASHIER.userId;
  h.failRecord = 0;
  h.failSeries = false;
  h.events.length = 0;
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  db = openMigrated();
  shop = await openCostingShop(db);
  r = await repos();
  r.openShift(db, { openingCashCents: 0 }, MANAGER);
  const { setReceiptPrinterConfig } = await import('./printer-config.js');
  setReceiptPrinterConfig(db, { transport: 'network', network: { host: '192.0.2.7', port: 9100 }, width: 48 });
  const s = await spooler();
  s.init(db, { deviceId: DEV, currentUserId: () => h.user });
  s.resetAdapter();
  await s.whenIdle();
  await policy({ kitchenTicket: false, shopCopy: 'never' });
  h.sends.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe.skipIf(!DatabaseSync)("the owner's rule on real orders", () => {
  it('a cash sale: the payment receipt is the ORIGINAL; Order History prints a DUPLICATE, Reprint #1', async () => {
    const s = await spooler();
    const o = shop.ring([['fajitaM', 1]]);
    await tenderCash(o);
    await s.whenIdle();
    const receipt = h.sends.map((b) => escPosToText(b)).find((x) => x.includes('RECEIPT'))!;
    expect(receipt).not.toContain('DUPLICATE');
    expect(receipt).toContain('PAID - CASH');

    expect(await press(o)).toMatchObject({ status: 'queued', document: 'receipt', duplicate: true, printNo: 1, reprintNo: 1 });
    await s.whenIdle();
    const copy = last();
    expect(copy.split('\n')[1]).toBe('DUPLICATE');
    expect(copy).toMatch(/Reprint #1 \| \d\d\/\d\d\/\d{4} \d\d:\d\d \| by Test Owner/);
    expect(copy).toContain('PAID - CASH (DUPLICATE)');
    expect(copy).toContain('** DUPLICATE - Reprint #1 **');
    expect(customerRows(o)).toEqual([
      { document: 'receipt', copy: 'customer', printNo: 0, reason: 'payment', outcome: 'printed' },
      { document: 'receipt', copy: 'customer', printNo: 1, reason: 'reprint', outcome: 'printed' },
    ]);
    expect(actions(o)).toEqual(['print_original', 'print_duplicate']);
  });

  it('the board, unpaid: the first bill by hand is a DUPLICATE; a quick double press is one paper; the paid receipt the till prints is the ORIGINAL', async () => {
    const s = await spooler();
    const o = shop.ring([['fajitaM', 1]]);
    r.sendOrderToKitchen(db, o, CASHIER);
    // Send prints no customer paper by itself (Settings → Printing rules says
    // so): the table's only bill comes from a print button.
    s.onOrderEvent(o, 'sent_to_kitchen');
    await s.whenIdle();
    expect(h.sends).toHaveLength(0);
    expect(customerRows(o)).toEqual([]);
    expect(await press(o, MANAGER_LOGIN)).toMatchObject({ document: 'bill', duplicate: true, printNo: 0, reprintNo: 1 });
    await s.whenIdle();
    expect(last()).toContain('BILL - NOT PAID');
    expect(last()).toContain('** DUPLICATE - Reprint #1 **');
    expect(last()).toContain('by Test Manager');

    // Two presses before the printer answers: one paper.
    let release!: () => void;
    h.script.push(() => new Promise<PrintResult>((resolve) => (release = () => resolve({ ok: true, durationMs: 1 }))));
    expect(await press(o)).toMatchObject({ status: 'queued', reprintNo: 2 });
    await vi.waitFor(() => expect(h.sends).toHaveLength(2));
    expect(await press(o)).toMatchObject({ status: 'merged' });
    release();
    await s.whenIdle();
    expect(h.sends).toHaveLength(2);
    expect(last()).toContain('** DUPLICATE - Reprint #2 **');
    // Reports → Staff / Order History: the table's first bill is routine, not
    // a reprint, though it says DUPLICATE; the second press is one.
    const { reprintCounts } = await import('../db/repositories/document-print-repo.js');
    expect(reprintCounts(db, [o])).toEqual({ [o]: 1 });

    // Collected at the table: the receipt the till prints by itself is the original.
    r.markOrderPreparing(db, o, CASHIER);
    r.markOrderReady(db, o, CASHIER);
    const total = r.findOrder(db, o)!.totalCents;
    const served = r.markOrderServed(db, { orderId: o, payment: { method: 'cash', amountCents: total, tenderedCents: total } }, CASHIER);
    s.onOrderEvent(o, 'payment_captured', { drawerOpenId: served.drawerOpenId });
    await s.whenIdle();
    expect(last()).toContain('RECEIPT');
    expect(last()).not.toContain('DUPLICATE');
    expect(customerRows(o).map((x) => [x.document, x.printNo, x.reason])).toEqual([
      ['bill', 1, 'reprint'],
      ['bill', 1, 'reprint'],
      ['receipt', 0, 'payment'],
    ]);
  });

  it('cash on delivery: the dispatch bill is the original; the first receipt from Order History is a DUPLICATE, not "Printed later"', async () => {
    const s = await spooler();
    await policy({ deliveryBillOnDispatch: true });
    const customer = r.createCustomer(db, { name: 'Test Customer', phone: '03001234567' }, CASHIER);
    const address = r.createAddress(db, { customerId: customer.id, addressLine: 'House 1, Test Street', area: 'Test Area' }, CASHIER);
    const rider = r.createRider(db, { name: 'Test Rider', phone: '03009876543' }, MANAGER);
    const o = r.createOrder(db, { mode: 'delivery' }, CASHIER).id;
    r.snapshotCustomerOntoOrder(db, { orderId: o, customerId: customer.id, addressId: address.id }, CASHIER);
    r.addOrderItem(db, { orderId: o, menuItemId: shop.item.fajitaM, quantity: 1, modifierIds: [], notes: null }, CASHIER);
    r.sendOrderToKitchen(db, o, CASHIER);
    r.markOrderReady(db, o, CASHIER);
    r.assignRiderToOrder(db, o, rider.id, CASHIER);
    s.onOrderEvent(o, 'dispatched');
    await s.whenIdle();
    expect(last()).toContain('CASH ON DELIVERY');
    expect(last()).not.toContain('DUPLICATE');
    const total = r.findOrder(db, o)!.totalCents;
    const back = r.markOrderDelivered(db, { orderId: o, payment: { method: 'cash', amountCents: total, tenderedCents: total } }, CASHIER);
    s.onOrderEvent(o, 'payment_captured', { drawerOpenId: back.drawerOpenId });
    await s.whenIdle();
    // The customer holds the dispatch paper: only the drawer this time.
    expect(customerRows(o).map((x) => x.document)).toEqual(['bill']);

    const papers = s.orderPapers(o);
    expect(papers.next).toEqual({ document: 'receipt', printedBefore: 0, reprintNo: 1, waiting: false, failedJobId: null });
    await press(o);
    await s.whenIdle();
    expect(last()).toContain('RECEIPT');
    expect(last()).toContain('** DUPLICATE - Reprint #1 **');
    expect(last()).not.toContain('Printed later');
    // "Papers printed", oldest first.
    expect(s.orderPapers(o).papers.map((p) => [p.document, p.label, p.duplicate, p.reason])).toEqual([
      ['bill', 'Original', false, 'dispatch'],
      ['receipt', 'Reprint #1', true, 'reprint'],
    ]);
  });

  it('"Try again" on a failed print sends the till\'s own job again — still the ORIGINAL; a print button would print a DUPLICATE', async () => {
    const s = await spooler();
    // The drawer pulse goes first and opens; the receipt fails for good.
    h.script.push(
      () => ({ ok: true, durationMs: 1 }),
      () => ({ ok: false, durationMs: 1, error: { code: 'bad_printer_name', message: 'No such printer', recoverable: false } }),
    );
    const o = shop.ring([['fajitaM', 1]]);
    await tenderCash(o);
    await s.whenIdle();
    const failed = r.findOpenJob(db, o, 'receipt');
    expect(failed).toBeNull();
    const job = db.prepare(`SELECT id, status FROM print_queue WHERE order_id = ? AND job_kind = 'receipt'`).get(o) as { id: string; status: string };
    expect(job.status).toBe('failed');
    expect(logRows(o)).toEqual([]);
    // The note names the paper and the order (two failures with the same
    // printer error are two notes), and carries the job for "Try again".
    const label = `Order #${r.findOrder(db, o)!.orderNumber.split('-').pop()}`;
    expect(h.events.filter((e) => e.channel === 'printer:failed').map((e) => e.payload)).toEqual([
      expect.objectContaining({ jobId: job.id, jobKind: 'receipt', orderId: o, what: `Receipt for ${label}`, retrying: false }),
    ]);
    // The note closed, the till restarted: the order panel still offers THAT
    // job (the original) instead of a DUPLICATE.
    expect(s.orderPapers(o).next).toMatchObject({ document: 'receipt', printedBefore: 0, failedJobId: job.id });
    expect(s.retryFailedJob(job.id)).toEqual({ orderId: o });
    await s.whenIdle();
    expect(last()).toContain('RECEIPT');
    expect(last()).not.toContain('DUPLICATE');
    expect(customerRows(o)).toEqual([{ document: 'receipt', copy: 'customer', printNo: 0, reason: 'payment', outcome: 'printed' }]);
    expect(s.orderPapers(o).next).toMatchObject({ printedBefore: 1, failedJobId: null });
    // Nothing left to try again: already printed. A drawer pulse is never re-sent.
    expect(s.retryFailedJob(job.id)).toBeNull();
    // And a print button now: a DUPLICATE.
    await press(o);
    await s.whenIdle();
    expect(last()).toContain('** DUPLICATE - Reprint #1 **');
  });
});

describe.skipIf(!DatabaseSync)('two receipts failing in the rush', () => {
  it('each note names its order and job; a print button pressed instead supersedes the failed one (DUPLICATE, nothing owed)', async () => {
    const s = await spooler();
    const off = () => ({ ok: false, durationMs: 1, error: { code: 'offline', message: 'The printer is off (made up)', recoverable: false } });
    const ok = () => ({ ok: true, durationMs: 1 });
    // Each sale: the drawer opens, the receipt fails with the same error.
    h.script.push(ok, off, ok, off);
    const a = shop.ring([['fajitaM', 1]]);
    await tenderCash(a);
    await s.whenIdle();
    const b = shop.ring([['fajitaM', 1]]);
    await tenderCash(b);
    await s.whenIdle();
    const label = (o: string) => `Receipt for Order #${r.findOrder(db, o)!.orderNumber.split('-').pop()}`;
    const notes = h.events.filter((e) => e.channel === 'printer:failed').map((e) => e.payload);
    expect(notes.map((p) => p['what'])).toEqual([label(a), label(b)]);
    expect(new Set(notes.map((p) => p['jobId'])).size).toBe(2);
    expect(notes.map((p) => (p['error'] as { message: string }).message)).toEqual(['The printer is off (made up)', 'The printer is off (made up)']);

    // #b's receipt is printed with a print button instead: a DUPLICATE, and
    // the failed job is no longer offered (the customer has a paper now).
    expect(s.orderPapers(b).next?.failedJobId).toBeTruthy();
    await press(b);
    await s.whenIdle();
    expect(last()).toContain('** DUPLICATE - Reprint #1 **');
    expect(s.orderPapers(b).next?.failedJobId).toBeNull();
    // #a's is still owed.
    expect(s.orderPapers(a).next?.failedJobId).toBeTruthy();
  });
});

describe.skipIf(!DatabaseSync)('when the print log misbehaves', () => {
  it('M1: printed but not noted — the job is done with its plan kept, noted before the next copy (so it says DUPLICATE), once, and the purge keeps it meanwhile', async () => {
    const s = await spooler();
    const o = shop.ring([['fajitaM', 1]]);
    // The log can't be written when the printer takes the receipt, nor on the
    // spooler's next look (it tries again before every job).
    h.failRecord = 2;
    await tenderCash(o);
    await s.whenIdle();
    const job = db
      .prepare(`SELECT id, status, sending_plan_json AS plan, last_error AS note FROM print_queue WHERE order_id = ? AND job_kind = 'receipt'`)
      .get(o) as { id: string; status: string; plan: string | null; note: string };
    expect(job).toMatchObject({ status: 'done', note: 'Printed; print log not written yet' });
    expect(job.plan).not.toBeNull();
    expect(logRows(o)).toEqual([]);
    // The purge of old printed jobs keeps one whose papers are not noted yet (the drawer pulse's job goes).
    expect(r.purgeOldDoneJobs(db, '2100-01-01T00:00:00.000Z')).toBe(1);
    expect(db.prepare(`SELECT id FROM print_queue WHERE order_id = ?`).all(o)).toEqual([{ id: job.id }]);

    // The next press: the kept paper is noted first, so this one is a DUPLICATE of it.
    await press(o);
    await s.whenIdle();
    expect(last()).toContain('** DUPLICATE - Reprint #1 **');
    expect(customerRows(o).map((x) => [x.printNo, x.reason])).toEqual([
      [0, 'payment'],
      [1, 'reprint'],
    ]);
    const after = db.prepare(`SELECT sending_plan_json AS plan FROM print_queue WHERE id = ?`).get(job.id) as { plan: string | null };
    expect(after.plan).toBeNull();
    // Noted once: a restart does not note it again.
    s.init(db, { deviceId: DEV, currentUserId: () => h.user });
    await s.whenIdle();
    expect(customerRows(o)).toHaveLength(2);
  });

  it('M2: the log unreadable on a hand press — DUPLICATE with no number (print_no 1); a paper the till prints itself prints unmarked', async () => {
    const s = await spooler();
    const o = shop.ring([['fajitaM', 1]]);
    await tenderCash(o);
    await s.whenIdle();
    h.sends.length = 0;
    const { enqueuePrintJob } = await import('../db/repositories/print-queue-repo.js');
    h.failSeries = true;
    // A hand press (queued straight: planning it would read the log too).
    enqueuePrintJob(db, { kind: 'receipt', orderId: o, openDrawer: false, copies: ['customer'], reason: 'reprint', requestedByUserId: OWNER.userId });
    await s.whenIdle();
    const hand = last();
    expect(hand.split('\n')[1]).toBe('DUPLICATE');
    expect(hand).toMatch(/Reprint \| \d\d\/\d\d\/\d{4} \d\d:\d\d \| by Test Owner/);
    expect(hand).toContain('** DUPLICATE **');
    expect(hand).not.toMatch(/Reprint #/);
    // A paper the till prints by itself: never marked DUPLICATE by an error.
    const o2 = shop.ring([['fajitaM', 1]]);
    await tenderCash(o2);
    await s.whenIdle();
    expect(last()).toContain('RECEIPT');
    expect(last()).not.toContain('DUPLICATE');
    h.failSeries = false;
    expect(customerRows(o).map((x) => [x.printNo, x.reason])).toEqual([
      [0, 'payment'],
      [1, 'reprint'],
    ]);
    expect(customerRows(o2).map((x) => [x.printNo, x.reason])).toEqual([[0, 'payment']]);
  });
});

describe.skipIf(!DatabaseSync)('an outside rider pays the shop before his bill comes out of the printer (v0.7.34, owner 2026-10-02)', () => {
  /**
   * The owner's example: 15% tax, Big Two Rs 3,400 + Fries Rs 500 and the
   * area's Rs 200 charge (taxed too): FOOD TOTAL Rs 4,515, CUSTOMER PAYS Rs
   * 4,715, the rider keeps Rs 200. Rung up, sent and ready, as the counter does.
   */
  async function readyOutsideDelivery(): Promise<string> {
    const { createTaxCategory } = await import('../db/repositories/tax-category-repo.js');
    const { createCategory } = await import('../db/repositories/category-repo.js');
    const { createMenuItem } = await import('../db/repositories/menu-item-repo.js');
    const tax = createTaxCategory(db, { name: 'Test GST', rateBps: 1_500 }, MANAGER);
    const food = createCategory(db, { name: 'Test Burgers', displayOrder: 9, colorHex: '#aa5500' }, MANAGER);
    const item = (categoryId: string, name: string, basePriceCents: number) =>
      createMenuItem(db, { categoryId, name, basePriceCents, taxCategoryId: tax.id }, MANAGER).id;
    const lines = [
      item(food.id, 'Test Big Two', 340_000),
      item(food.id, 'Test Fries', 50_000),
      item(shop.cat.fees, 'Delivery Charge (Rs 200)', 20_000),
    ];
    const customer = r.createCustomer(db, { name: 'Test Customer', phone: '03001234567' }, CASHIER);
    const address = r.createAddress(db, { customerId: customer.id, addressLine: 'House 1, Test Street', area: 'Test Area' }, CASHIER);
    const o = r.createOrder(db, { mode: 'delivery' }, CASHIER).id;
    r.snapshotCustomerOntoOrder(db, { orderId: o, customerId: customer.id, addressId: address.id }, CASHIER);
    for (const menuItemId of lines) r.addOrderItem(db, { orderId: o, menuItemId, quantity: 1, modifierIds: [], notes: null }, CASHIER);
    r.sendOrderToKitchen(db, o, CASHIER);
    r.markOrderReady(db, o, CASHIER);
    return o;
  }
  /** One paper per cut. */
  const papersOf = (bytes: Uint8Array) => {
    const out: string[][] = [[]];
    for (const row of escPosToText(bytes).split('\n')) {
      if (row === '[cut]') out.push([]);
      else out.at(-1)!.push(row);
    }
    return out.filter((p) => p.some((row) => row.trim() !== ''));
  };

  it("Send out, then Rider paid while the printer is still busy: the customer keeps the BILL (TO COLLECT Rs 4,715.00, Pay the rider); the SHOP COPY says RIDER PAID THE SHOP Rs 4,515.00; no second bill", async () => {
    const s = await spooler();
    await policy({ deliveryBillOnDispatch: true, shopCopy: 'delivery' });
    const o = await readyOutsideDelivery();

    // The printer is busy with the counter's last sale (its drawer pulse is
    // still going out) when the rider is sent out. (An idle printer takes the
    // bill the moment it is queued, and reads the order then: the race is a
    // bill still waiting in the queue when the money comes in.)
    let release!: () => void;
    h.script.push(() => new Promise<PrintResult>((resolve) => (release = () => resolve({ ok: true, durationMs: 1 }))));
    await tenderCash(shop.ring([['fajitaM', 1]]));
    await vi.waitFor(() => expect(h.sends).toHaveLength(1));

    // Send out: his bill waits behind it.
    const sent = r.sendOutOrder(db, o, CASHIER);
    expect(sent).toMatchObject({ totalCents: 471_500, riderKeepsCents: 20_000 });
    s.onOrderEvent(o, 'dispatched');
    // Paid now: he hands in the food total before the bill has printed.
    const paid = r.takeRiderPayment(db, { orderId: o, method: 'cash', riderKeepsCents: 20_000 }, CASHIER);
    expect(paid).toMatchObject({ status: 'out_for_delivery', paidAt: expect.any(String) });
    s.onOrderEvent(o, 'payment_captured', { drawerOpenId: paid.drawerOpenId });
    expect(h.sends).toHaveLength(1);
    release();
    await s.whenIdle();

    // Exactly one paper for this order: the bill that left with the food, its two copies.
    const receipts = (
      db.prepare(`SELECT payload_json AS p FROM print_queue WHERE order_id = ? AND job_kind = 'receipt' ORDER BY rowid`).all(o) as Array<{ p: string }>
    ).map((x) => (JSON.parse(x.p) as { reason: string }).reason);
    expect(receipts).toEqual(['dispatch']);
    const bills = h.sends.map((b) => papersOf(b)).filter((ps) => ps.some((p) => p.some((row) => row.includes('Test Big Two'))));
    expect(bills).toHaveLength(1);
    const [customer, shopCopy] = bills[0]!;
    expect(bills[0]).toHaveLength(2);

    // The customer's copy: still a bill for the full amount, nothing about PAID or the rider's money.
    expect(customer).toContain('BILL - NOT PAID');
    expect(customer!.some((row) => /^TO COLLECT\s+Rs 4,715\.00$/.test(row))).toBe(true);
    expect(customer).toContain('Pay the rider Rs 4,715.00');
    expect(customer!.join('\n')).not.toMatch(/PAID - |RIDER PAID|RIDER GIVES|SHOP COPY|DUPLICATE/);

    // The shop's copy: what he paid the shop, after it printed — and the customer still pays him at the door.
    expect(shopCopy).toContain('SHOP COPY');
    expect(shopCopy!.some((row) => /^RIDER PAID THE SHOP\s+Rs 4,515\.00$/.test(row))).toBe(true);
    expect(shopCopy!.join('\n')).not.toMatch(/RIDER GIVES THE SHOP/);
    expect(shopCopy!.some((row) => /^TO COLLECT\s+Rs 4,715\.00$/.test(row))).toBe(true);

    // The print log: the bill, as the original, with its shop copy; no receipt.
    expect(logRows(o)).toEqual([
      { document: 'bill', copy: 'customer', printNo: 0, reason: 'dispatch', outcome: 'printed' },
      { document: 'bill', copy: 'shop', printNo: 0, reason: 'dispatch', outcome: 'printed' },
    ]);
  });

  it('Send out with "Paid now" on an idle printer (the e2e run, fix A): the drawer, then ONE bill — the customer still pays Rs 4,715.00 at the door, the SHOP COPY says RIDER PAID THE SHOP Rs 4,515.00', async () => {
    const s = await spooler();
    await policy({ deliveryBillOnDispatch: true, shopCopy: 'delivery' });
    const o = await readyOutsideDelivery();
    await s.whenIdle();
    h.sends.length = 0;

    // As orders:sendOut does with riderPayment: both in one step, then the one event.
    const paid = r.sendOutRiderPaid(db, { orderId: o, method: 'cash', riderKeepsCents: 20_000 }, CASHIER);
    expect(paid).toMatchObject({ status: 'out_for_delivery', totalCents: 471_500, riderKeepsCents: 20_000 });
    s.onOrderEvent(o, 'sent_out_paid', { drawerOpenId: paid.drawerOpenId });
    await s.whenIdle();

    // The drawer opens first, then the bill and its SHOP COPY.
    expect(h.sends).toHaveLength(2);
    expect(escPosToText(h.sends[0]!)).toMatch(/^\[drawer pin \d, \d+ ms\]/);
    const bill = papersOf(h.sends[1]!);
    expect(bill).toHaveLength(2);
    const [customer, shopCopy] = bill;
    expect(customer).toContain('BILL - NOT PAID');
    expect(customer!.some((row) => /^TO COLLECT\s+Rs 4,715\.00$/.test(row))).toBe(true);
    expect(customer).toContain('Pay the rider Rs 4,715.00');
    expect(customer!.join('\n')).not.toMatch(/PAID - |RIDER PAID|RIDER GIVES|SHOP COPY|DUPLICATE/);
    expect(shopCopy).toContain('SHOP COPY');
    expect(shopCopy!.some((row) => /^Outside rider keeps\s+200\.00$/.test(row))).toBe(true);
    expect(shopCopy!.some((row) => /^RIDER PAID THE SHOP\s+Rs 4,515\.00$/.test(row))).toBe(true);
    expect(shopCopy!.join('\n')).not.toMatch(/RIDER GIVES THE SHOP/);
    expect(logRows(o)).toEqual([
      { document: 'bill', copy: 'customer', printNo: 0, reason: 'dispatch', outcome: 'printed' },
      { document: 'bill', copy: 'shop', printNo: 0, reason: 'dispatch', outcome: 'printed' },
    ]);
  });

  it('"Pays after delivery" (and the Paid now box closed without paying): the bill prints at Send out saying RIDER GIVES THE SHOP; Rider paid later opens the drawer and prints nothing more', async () => {
    const s = await spooler();
    await policy({ deliveryBillOnDispatch: true, shopCopy: 'delivery' });
    const o = await readyOutsideDelivery();
    await s.whenIdle();
    h.sends.length = 0;

    r.sendOutOrder(db, o, CASHIER);
    s.onOrderEvent(o, 'dispatched');
    await s.whenIdle();
    expect(h.sends).toHaveLength(1);
    const [, shopCopy] = papersOf(h.sends[0]!);
    expect(shopCopy!.some((row) => /^RIDER GIVES THE SHOP\s+Rs 4,515\.00$/.test(row))).toBe(true);
    expect(shopCopy!.join('\n')).not.toMatch(/RIDER PAID THE SHOP/);

    const paid = r.takeRiderPayment(db, { orderId: o, method: 'cash', riderKeepsCents: 20_000 }, CASHIER);
    s.onOrderEvent(o, 'payment_captured', { drawerOpenId: paid.drawerOpenId });
    await s.whenIdle();
    expect(h.sends).toHaveLength(2);
    expect(escPosToText(h.sends[1]!)).toMatch(/^\[drawer pin \d, \d+ ms\]/);
    expect(logRows(o).map((x) => [x.document, x.copy, x.reason])).toEqual([
      ['bill', 'customer', 'dispatch'],
      ['bill', 'shop', 'dispatch'],
    ]);
  });
});
