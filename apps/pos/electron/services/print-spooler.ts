import log from 'electron-log/main';
import { BrowserWindow } from 'electron';
import type { AppDatabase } from '../db/connection.js';
import {
  receiptDocumentFor,
  refundHandOver,
  isDrinkLine,
  renderDrawerKick,
  renderKitchenChangeTicket,
  renderKitchenTicket,
  renderReceipt,
  type CancelInfo,
  type CopyStamp,
  type FbrPrint,
  type MonoRaster,
  type PrinterAdapter,
  type PrintResult,
  type ReceiptDocument,
  type RefundSlipInfo,
  type RenderReceiptOpts,
  type TestPageOptions,
} from '@cheeseoclock/printer-core';
import {
  DRAWER_NOT_OPENED_CODE,
  DRAWER_TOO_LATE_CODE,
  DRAWER_UNSURE_CODE,
  kitchenTicketRules,
  type DrawerOutcome,
  type DrawerSettings,
  type KitchenChange,
  type OrderPapers,
  type OrderSnapshot,
  type OrderStatus,
  type PrintedDocument,
  type PrinterConnectionConfig,
  type PrinterWidth,
  type PrintPolicy,
  type ReceiptCopy,
  type ReprintResult,
} from '@cheeseoclock/shared-types';
import { makePrinterAdapter } from '../adapters/printer/factory.js';
import {
  DEFAULT_RECEIPT_CONFIG,
  getKitchenPrinterConfig,
  getPrintPolicy,
  getReceiptBranding,
  getReceiptLogo,
  getReceiptPrinterConfig,
  isNoPrinter,
  markReceiptLogoChecked,
  receiptLogoToPrint,
} from './printer-config.js';
import { logoTestOptions } from './receipt-logo.js';
import { getOrderSnapshot } from '../db/repositories/order-repo.js';
import { getFbrDebitNotes, getFbrRowByOrder, paymentTakenOnDevice } from '../db/repositories/fbr-queue-repo.js';
import {
  cancelPendingJobs,
  claimNextPendingJob,
  deferJob,
  enqueuePrintJob,
  findFailedOwnJob,
  findOpenJob,
  hasPrintJob,
  listDoneWithPlan,
  listInFlightWithPlan,
  markJobDone,
  markJobDoneKeepPlan,
  markJobFailedPermanently,
  recoverStuckInFlight,
  requeueFailedJob,
  rescheduleJob,
  retryNow,
  setSendingPlan,
  type KitchenJobPayload,
  type PrintJobPayload,
  type PrintJobRow,
  type ReceiptJobReason,
} from '../db/repositories/print-queue-repo.js';
import {
  MANUAL_REASON,
  docKeyFor,
  hasLoggedPaper,
  latestLoggedSaleFbr,
  legacyPrintCount,
  listOrderPapers,
  listSeriesPrints,
  recordDocumentPrint,
  userNames,
  type LoggedFbrMode,
  type PrintOutcome,
  type PrintReason,
  type PrintedCopy,
  type SeriesPrint,
} from '../db/repositories/document-print-repo.js';
import { getFbrMode } from './fbr-config.js';
import { KITCHEN_REPRINT_STATUSES } from './reprint-policy.js';
import { handReprintNumber, labelOrderPapers, seriesHasOriginal } from './order-papers.js';
import { kitchenHearsOfClose } from '@cheeseoclock/pos-domain';
import {
  ALREADY_OPEN_NOTE,
  ORDER_GONE_NOTE,
  PRINTER_STARTING_CODE,
  TOO_LATE_NOTE,
  drawerFailureText,
  drawerOutcome,
} from './drawer-outcome.js';
import { settleAbandonedDrawerOpens, settleDrawerOpen } from '../db/repositories/drawer-open-repo.js';

/**
 * Background print queue — backed by `print_queue` in SQLite so a crash
 * between tender and print doesn't lose the receipt. The in-memory work loop
 * polls the DB; enqueueing is a single INSERT + kick.
 *
 * **Print failure never blocks the sale.** The order is already saved when
 * a print job is enqueued.
 *
 * What prints when is decided in one place, `onOrderEvent`, from the policy
 * under Settings → Printer (see PrintPolicy in shared-types). Handlers only
 * report what happened to the order.
 *
 * The cash drawer: every cash payment or cash refund queues ONE drawer-only
 * job, first and ahead of any paper, so the drawer opens the moment the money
 * is taken — not after the logo, the FBR wait and the kitchen ticket.
 * Receipts never carry the pulse, so a receipt that is printed again can never
 * open the drawer twice. A drawer job is only retried while it can still go
 * out within a minute of the sale and only when the printer surely did not get
 * it; otherwise the cashier is told to use the key. And once any pulse goes
 * out — Open drawer, a cash in / out, another sale's retry — the pulses still
 * waiting for cash taken before it are dropped: the drawer already opened.
 */

/** Something that happened to an order which may deserve paper. */
export type OrderPrintEvent =
  /** Send to kitchen (till) or a website order arriving. */
  | 'sent_to_kitchen'
  /** Paid up front at the counter, straight from the cart. */
  | 'paid'
  /** Cash-on-delivery money taken on the board: served / delivered with a payment. */
  | 'payment_captured'
  /** A rider was assigned or the order was sent out: the food is leaving. */
  | 'dispatched'
  /**
   * Send out with "Paid now": the food is leaving and the outside rider paid
   * the shop in the same step (sendOutRiderPaid).
   */
  | 'sent_out_paid'
  | 'refunded'
  /** Cancelled or refunded in full while the kitchen still had it. */
  | 'cancelled';

type Station = 'receipt' | 'kitchen';

/**
 * One paper a job is about to send, and its place in the print log. Written
 * to the job (sending_plan_json) just before the bytes go out, and into the
 * log (document_prints) once the printer took them — or as 'unsure' when it
 * may have.
 */
interface PlannedPaper {
  orderNumber: string;
  document: PrintedDocument;
  docKey: string;
  copy: PrintedCopy;
  printNo: number;
  reason: PrintReason;
  requestedByUserId: string | null;
  approvedByUserId: string | null;
  fbrIrn: string | null;
  /** The QR and kind of that number (optional: plans written before these existed lack them). */
  fbrQrPayload?: string | null;
  fbrMode?: LoggedFbrMode | null;
}

/** What a reprint press would print, worked out before anything is queued. */
export interface ReprintPlan {
  orderId: string;
  /** "Order #0042" */
  orderLabel: string;
  status: OrderStatus;
  /** paid_at, or created_at while unpaid. */
  lastActivityAt: string;
  /** What the order prints as now. */
  document: 'receipt' | 'bill' | 'void';
  copy: ReceiptCopy;
  /** Papers of this series so far (0: none of this paper printed yet). */
  priorAll: number;
  /**
   * The number the press's paper will carry ("Reprint #N"): a paper printed
   * with a print button always says DUPLICATE (the owner's rule), so the first
   * hand press of a paper the till never printed by itself is Reprint #1.
   */
  reprintNo: number;
  /** Of those, printed by hand (distinct presses), the FBR copy not counted. */
  priorManual: number;
  /** The press prints the first paper that carries the FBR number. */
  fbrCopy: boolean;
  /** A job for this paper still waiting or printing: the press joins it. */
  openJob: PrintJobRow | null;
}

export interface ReprintOptions {
  copy?: ReceiptCopy;
  requestedByUserId?: string | null;
  approvedByUserId?: string | null;
  /**
   * Checked again right before queueing (the manager's PIN was awaited in
   * between): throws to refuse. Not called when the press joins a waiting job.
   */
  check?: (plan: ReprintPlan) => void;
}

/** Why a job was finished without printing: its order was cancelled. */
export const NOT_PRINTED_CANCELLED = 'Not printed: order cancelled';
/** Why a job was finished without printing: its order was deleted as a test (orders:deleteTest). */
export const NOT_PRINTED_DELETED_TEST = 'Not printed — the order was deleted as a test';

const MAX_ATTEMPTS = 5;
// Backoff schedule: ~immediate, 5s, 30s, 2m, 10m. Past MAX_ATTEMPTS we
// mark the job 'failed' and broadcast a toast.
const BACKOFF_MS = [0, 5_000, 30_000, 120_000, 600_000];
const TICK_INTERVAL_MS = 1_000;
/**
 * A drawer that opens by itself minutes after the sale — when the printer
 * finally comes back — is an open till nobody is standing at. A queued drawer
 * pulse that cannot go out within this long of the sale is dropped (and the
 * cashier told to use the key); none is retried past it.
 */
export const DRAWER_KICK_MAX_AGE_MS = 60_000;
/** A pulse from a button (Open drawer, Test drawer, cash in / out) goes now or not at all. */
export const MANUAL_KICK_MAX_WAIT_MS = 10_000;
/**
 * When someone is watching "Opening…" (Open drawer, Open drawer to count,
 * Test drawer), a printer that is still starting up — a USB print worker
 * getting ready after a printer change or at boot — gets up to this long
 * first. That wait is not the late, unattended open the limit above is for,
 * so it does not count against it.
 */
export const MANUAL_KICK_READY_MAX_MS = 30_000;
// kickDrawerNow's "printer still starting" code and the counter's words for a
// drawer that did not open live in drawer-outcome.ts (pure, shared with the log).
export { PRINTER_STARTING_CODE, drawerFailureText } from './drawer-outcome.js';
// How long a payment receipt waits for the FBR invoice number before printing
// with the "pending" placeholder, counted from when the sale queued it.
const FBR_IRN_GRACE_MS = 4_000;
// While it waits, the receipt steps aside this long at a time so the jobs
// behind it (the next sale's drawer, a kitchen ticket) are not held up.
const FBR_RECHECK_MS = 250;
// A sale paid this recently with no FBR row yet is about to get one ("not
// yet issued"); an older one never will ("not issued").
const FBR_NO_ROW_PENDING_MS = 10 * 60_000;

class PrintSpooler {
  private db: AppDatabase | null = null;
  private running = false;
  /** The drain loop in progress (resolved when idle). */
  private current: Promise<void> = Promise.resolve();
  private tickTimer: NodeJS.Timeout | null = null;
  private readonly adapters = new Map<Station, { adapter: PrinterAdapter; key: string }>();
  /**
   * One printer conversation at a time — the queue, the drawer buttons and
   * test pages all go through `exclusive`. Keeps bytes from interleaving on a
   * shared printer and lets an adapter be swapped only between sends.
   */
  private lock: Promise<unknown> = Promise.resolve();
  /**
   * When the last drawer pulse that went out (or may have) started to be
   * sent, epoch ms. A queued pulse for cash taken before then is already
   * served — that open was for it too — and is never sent: a drawer opened by
   * hand while a sale's pulse waits for the printer must not pop again later.
   */
  private drawerPulsedAt = 0;
  /** This till, for the print log. */
  private deviceId = 'unknown-device';
  /** Who is signed in now (the person a queued paper is put down to). */
  private currentUserId: () => string | null = () => null;
  /**
   * A printed job's papers could not go into the print log (finishPrinted):
   * they are noted (logKeptPlans) before the next job and before the next
   * reprint is worked out, so the next copy of that paper still says
   * DUPLICATE.
   */
  private logBacklog = false;

  init(db: AppDatabase, opts: { deviceId?: string; currentUserId?: () => string | null } = {}): void {
    this.db = db;
    this.drawerPulsedAt = 0;
    this.logBacklog = false;
    this.deviceId = opts.deviceId ?? readDeviceId(db);
    this.currentUserId = opts.currentUserId ?? (() => null);
    // Papers that were going out when the app last died may be on paper:
    // into the log as 'unsure', so their re-send says DUPLICATE.
    this.logCutOffSends(db);
    // Papers that printed but could not be noted last time: noted now.
    this.logKeptPlans();
    // Recover any jobs that were mid-flight when the app last died.
    const recovered = recoverStuckInFlight(db);
    if (recovered > 0) {
      log.info('Print spooler: recovered stuck in-flight jobs', { recovered });
    }
    // Drawer opens the till never learned the result of (it stopped first):
    // 'unsure' in the drawer log. Not those a waiting drawer job will settle.
    try {
      const abandoned = settleAbandonedDrawerOpens(db, this.deviceId);
      if (abandoned > 0) log.warn('Drawer log: opens with no result after a restart', { abandoned });
    } catch (e) {
      log.error('Drawer log: could not check opens left without a result', { error: String(e) });
    }
    // Periodic tick — picks up jobs whose next_attempt_at has come due.
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = setInterval(() => void this.drain(), TICK_INTERVAL_MS);
    this.warmUp();
    // Drain immediately on boot in case there are pending jobs already due.
    void this.drain();
  }

  /**
   * The one place that turns an order event into paper. `drawerOpenId`: the
   * drawer_opens row the repository wrote with the cash (a cash sale or a
   * cash refund) — the drawer opens for it, never for card or wallet
   * payments. No row, no pulse.
   */
  onOrderEvent(orderId: string, event: OrderPrintEvent, detail: { drawerOpenId?: string | null } = {}): void {
    if (!this.db) {
      log.warn('PrintSpooler not initialized; nothing printed', { orderId, event });
      return;
    }
    const db = this.db;
    const drawerOpenId = typeof detail.drawerOpenId === 'string' && detail.drawerOpenId ? detail.drawerOpenId : null;
    const snap = getOrderSnapshot(db, orderId);
    if (!snap) {
      if (drawerOpenId !== null) this.settleDrawer(drawerOpenId, 'not_opened', ORDER_GONE_NOTE);
      return;
    }
    const policy = getPrintPolicy(db);
    const delivery = snap.order.mode === 'delivery';
    const cash = drawerOpenId !== null;
    const copies: ReceiptCopy[] =
      policy.shopCopy === 'always' || (policy.shopCopy === 'delivery' && delivery)
        ? ['customer', 'shop']
        : ['customer'];
    const requestedByUserId = this.whoIsSignedIn();
    // Receipts never carry the drawer pulse: it goes as its own job, first.
    const receipt = (reason: ReceiptJobReason, c: ReceiptCopy[] = copies, extra: { refundAt?: string } = {}) =>
      this.enqueue({ kind: 'receipt', orderId, openDrawer: false, copies: c, reason, requestedByUserId, ...extra });
    // Cash changed hands: open the drawer now, ahead of any paper. Once per
    // event, for the row written with the cash.
    const drawer = () => {
      if (drawerOpenId !== null) this.enqueue({ kind: 'drawer', orderId, drawerOpenId });
    };

    switch (event) {
      case 'sent_to_kitchen':
        this.kitchenTicket(snap, policy);
        break;

      case 'paid':
        drawer();
        // Paid up front: the kitchen still has to cook it.
        this.kitchenTicket(snap, policy);
        // A delivery's bill prints when the rider leaves, marked PAID.
        if (!(delivery && policy.deliveryBillOnDispatch)) receipt('payment');
        break;

      case 'dispatched':
        // A rider was assigned or the order was sent out: the food is leaving.
        // Once per order, on either till — re-assigning a rider, Back to
        // Ready and Send out again, or the other till sending it out must
        // not print a second bill.
        if (delivery && policy.deliveryBillOnDispatch && !this.dispatchBillOut(db, orderId)) {
          receipt('dispatch');
        }
        break;

      case 'payment_captured':
        drawer();
        // The customer already holds the bill that left with the food (from
        // this till or the other one) when the rider brings the money back:
        // then the drawer is all.
        if (!this.dispatchBillOut(db, orderId)) receipt('payment');
        break;

      case 'sent_out_paid':
        // His cash opens the drawer first. Then ONE paper, after his money is
        // in, so its SHOP COPY says RIDER PAID THE SHOP (it is drawn when it
        // prints): the bill that leaves with the food, once per order on
        // either till as 'dispatched' prints it — or, with that bill off in
        // Settings → Printer, the paper his money brings, as 'payment_captured'
        // prints it. Never both.
        drawer();
        if (!this.dispatchBillOut(db, orderId)) receipt(delivery && policy.deliveryBillOnDispatch ? 'dispatch' : 'payment');
        break;

      case 'refunded': {
        drawer();
        // The slip is for THIS refund (its rows share one paid_at). Cash
        // handed back also gets a SHOP COPY the customer signs — the shop's
        // record of money that left the drawer (unless shop copies are off).
        const refundAt = latestRefundAt(snap);
        receipt('refund', cash && policy.shopCopy !== 'never' ? ['customer', 'shop'] : ['customer'], {
          ...(refundAt ? { refundAt } : {}),
        });
        break;
      }

      case 'cancelled':
        this.kitchenCancelSlip(snap, policy);
        break;
    }
  }

  /**
   * The bill that leaves with the food is already out for this order: a
   * 'dispatch' receipt job on this till (waiting, printing or done; a job
   * that gave up does not count), or a 'dispatch' paper in the print log,
   * which syncs, so the other till's bill counts too (print_queue is this
   * till's alone). A log that can't be read leaves this till's own queue to
   * decide, as before the log was asked: the order is already saved, and the
   * worst is a second bill.
   */
  private dispatchBillOut(db: AppDatabase, orderId: string): boolean {
    if (hasPrintJob(db, orderId, 'receipt', 'dispatch')) return true;
    try {
      return hasLoggedPaper(db, orderId, 'dispatch');
    } catch (e) {
      log.warn('Print log unreadable; the delivery bill decided by this till alone', { orderId, error: String(e) });
      return false;
    }
  }

  /**
   * What pressing "Reprint receipt" would print for this order now: which
   * paper (receipt, bill or cancelled-order slip — never chosen by the
   * button), how many of it went out before, how many of those by hand, and
   * whether a job for it is still waiting (the press then joins that job).
   */
  planReprint(orderId: string, copy: ReceiptCopy = 'customer'): ReprintPlan {
    if (!this.db) throw new Error('Printing is not ready yet');
    const db = this.db;
    // A paper that printed but is not in the log yet counts: note it first.
    if (this.logBacklog) this.logKeptPlans();
    // A draft has no bill. Printing one would hand the customer a "TO PAY"
    // slip for an order that can still be discarded without a trace.
    const snap = getOrderSnapshot(db, orderId);
    if (!snap) throw new Error('Order not found');
    if (snap.order.status === 'open') {
      throw new Error('This order has not been sent or paid yet — there is no bill to reprint');
    }
    const document = receiptDocumentFor(snap);
    const series = this.series(snap, document, document, copy);
    const fbrIrn = document === 'receipt' && copy === 'customer' ? this.fbrForReceipt(snap).fbr?.irn ?? null : null;
    const fbrCopy = isFbrCopy(series, fbrIrn);
    // Presses, not attempts (a press the printer fumbled twice is one), and
    // the paper that first carried the FBR number does not count.
    const fbrPaper = firstFbrCopyRow(series.rows);
    const manual = new Set(
      series.rows.filter((r) => r.reason === MANUAL_REASON && r.id !== fbrPaper?.id).map(jobKey),
    );
    return {
      orderId,
      orderLabel: orderLabel(snap),
      status: snap.order.status,
      lastActivityAt: snap.order.paidAt ?? snap.order.createdAt,
      document,
      copy,
      priorAll: series.prior,
      reprintNo: handReprintNumber(series.rows, series.legacy),
      priorManual: manual.size,
      fbrCopy,
      openJob: findOpenJob(db, orderId, 'receipt', copy),
    };
  }

  /**
   * Print the order's customer paper (or its SHOP COPY) by hand. What it
   * prints is decided when it prints, from the order — and, pressed by hand,
   * it always says DUPLICATE "Reprint #N" (the owner's rule: only the paper
   * the till prints by itself is the original). A press while that paper is
   * still waiting to print (printer busy, retrying after a failure, waiting
   * for FBR) joins the waiting job — one paper, printed as that job would
   * have been: the till's own paper stays the original. Never opens the
   * drawer, never sends anything to FBR again.
   */
  reprintReceipt(orderId: string, opts: ReprintOptions = {}): ReprintResult {
    if (!this.db) throw new Error('Printing is not ready yet');
    const copy = opts.copy ?? 'customer';
    const plan = this.planReprint(orderId, copy);
    if (plan.openJob) {
      if (plan.openJob.status === 'pending') retryNow(this.db, plan.openJob.id);
      void this.drain();
      const joinedByHand = plan.openJob.payload.kind === 'receipt' && plan.openJob.payload.reason === MANUAL_REASON;
      return { status: 'merged', document: plan.document, duplicate: joinedByHand, printNo: plan.priorAll };
    }
    opts.check?.(plan);
    this.enqueue({
      kind: 'receipt',
      orderId,
      openDrawer: false,
      copies: [copy],
      reason: 'reprint',
      requestedByUserId: opts.requestedByUserId ?? null,
      approvedByUserId: opts.approvedByUserId ?? null,
    });
    return { status: 'queued', document: plan.document, duplicate: true, printNo: plan.priorAll, reprintNo: plan.reprintNo };
  }

  /**
   * What the order's print button would print now (and the DUPLICATE number
   * it would carry), and every paper the order had on either till, labelled
   * as it printed — the order panel's "Papers printed" (order-papers.ts).
   * Read-only.
   */
  orderPapers(orderId: string): OrderPapers {
    if (!this.db) throw new Error('Printing is not ready yet');
    const db = this.db;
    if (this.logBacklog) this.logKeptPlans();
    const snap = getOrderSnapshot(db, orderId);
    if (!snap) throw new Error('Order not found');
    let next: OrderPapers['next'] = null;
    if (snap.order.status !== 'open') {
      const plan = this.planReprint(orderId, 'customer');
      next = {
        document: plan.document,
        printedBefore: plan.priorAll,
        reprintNo: plan.reprintNo,
        waiting: plan.openJob !== null,
        // The till's own paper failed and nothing came since: the panel sends
        // THAT again (the original) instead of printing a DUPLICATE.
        failedJobId: plan.openJob === null ? (findFailedOwnJob(db, orderId, 'customer')?.id ?? null) : null,
      };
    }
    const papers = labelOrderPapers(listOrderPapers(db, orderId), {
      legacy: (document, _docKey, copy) =>
        legacyPrintCount(db, { orderId, document, copy, paidAt: snap.order.paidAt }),
      paidAt: snap.order.paidAt,
      deviceId: this.deviceId,
    });
    return { next, papers };
  }

  /**
   * "Try again" on the failed-print note: the job the spooler gave up on goes
   * again as it was (print-queue-repo requeueFailedJob) — a paper the till
   * prints by itself stays the original. Returns the job's order, or null
   * when there was nothing to try again (already printed, a drawer pulse).
   */
  retryFailedJob(jobId: string): { orderId: string | null } | null {
    if (!this.db) throw new Error('Printing is not ready yet');
    const job = requeueFailedJob(this.db, jobId);
    if (!job) return null;
    log.info('Print job sent again by hand after it failed', { jobId, orderId: job.orderId });
    void this.drain();
    return { orderId: job.orderId };
  }

  /**
   * The kitchen ticket again — only while the kitchen still has the order
   * (sent, preparing, ready). It says REPRINT / SAME ORDER - DO NOT COOK
   * TWICE when a ticket surely printed (`duplicate`); RE-SENT / CHECK FOR
   * TICKET BEFORE COOKING when the only earlier tries may or may not have
   * (`resent`: the printer failed mid-way); when none ever went out it is
   * simply the kitchen's ticket. A press while a ticket is still waiting
   * joins it.
   */
  reprintKitchenTicket(orderId: string, opts: { requestedByUserId?: string | null } = {}): ReprintResult {
    if (!this.db) throw new Error('Printing is not ready yet');
    const db = this.db;
    const snap = getOrderSnapshot(db, orderId);
    if (!snap) throw new Error('Order not found');
    const status = snap.order.status;
    if (status === 'open') throw new Error('This order has not gone to the kitchen yet');
    if (status === 'void' || status === 'refunded') {
      throw new Error('This order was cancelled, so its kitchen ticket is not printed again');
    }
    if (!KITCHEN_REPRINT_STATUSES.includes(status)) {
      throw new Error('The kitchen is done with this order, so its ticket is not printed again');
    }
    const series = this.series(snap, 'kitchen', 'kitchen', 'kitchen');
    // The same test stampFor uses for the kitchen: REPRINT only after a
    // ticket that surely printed; only 'unsure' tries before → RE-SENT.
    const surely = series.legacy > 0 || series.rows.some((r) => r.outcome === 'printed');
    const marks = { duplicate: surely, printNo: series.prior, ...(series.prior > 0 && !surely ? { resent: true } : {}) };
    const open = findOpenJob(db, orderId, 'kitchen');
    if (open) {
      if (open.status === 'pending') retryNow(db, open.id);
      void this.drain();
      return { status: 'merged', document: 'kitchen', ...marks };
    }
    this.enqueue({ kind: 'kitchen', orderId, reprint: true, requestedByUserId: opts.requestedByUserId ?? null });
    return { status: 'queued', document: 'kitchen', ...marks };
  }

  /**
   * Pulse the cash drawer right now, straight through the receipt printer:
   * no order, no queue, one attempt. For the Open drawer and Test drawer
   * buttons, the float and drawer cash in / out. If the printer can't take it
   * within MANUAL_KICK_MAX_WAIT_MS it is not sent at all (DRAWER_TOO_LATE_CODE).
   * `watched`: someone is looking at "Opening…", so a printer that is still
   * starting up first gets MANUAL_KICK_READY_MAX_MS to get ready.
   *
   * `drawerOpenId` is REQUIRED: the drawer_opens row this pulse is for, on
   * record before the pulse (no row, no pulse). Its result is settled before
   * this returns.
   */
  async kickDrawerNow(opts: { drawerOpenId: string; watched?: boolean }): Promise<PrintResult> {
    if (!this.db) {
      return {
        ok: false,
        durationMs: 0,
        error: { code: 'not_ready', message: 'Spooler not initialized', recoverable: false },
      };
    }
    const pressedAt = Date.now();
    let notAfter = pressedAt + MANUAL_KICK_MAX_WAIT_MS;
    let result: PrintResult;
    try {
      result = await this.exclusive(async (): Promise<PrintResult> => {
        if (Date.now() > notAfter) return tooLate(pressedAt);
        const adapter = this.getAdapter('receipt');
        if (opts.watched) {
          const waitFrom = Date.now();
          if (!(await readyWithin(adapter, MANUAL_KICK_READY_MAX_MS))) return printerStarting(pressedAt);
          notAfter += Date.now() - waitFrom;
        }
        return this.sendPulse(adapter, renderDrawerKick(this.drawerSettings()), notAfter);
      });
      if (!result.ok) log.warn('Cash drawer did not open', { error: result.error });
    } catch (e) {
      result = {
        ok: false,
        durationMs: Date.now() - pressedAt,
        error: {
          code: 'spooler_exception',
          message: e instanceof Error ? e.message : String(e),
          recoverable: false,
        },
      };
    }
    const settled = drawerOutcome(result, this.noPrinterSetUp());
    this.settleDrawer(opts.drawerOpenId, settled.outcome, settled.note);
    return result;
  }

  /**
   * A receipt printer is set up (Settings → Printers): anything but the
   * "No printer" setup, whose papers only go to files. The shift report at
   * a close asks this first (no printer: no paper, and it says so). Never
   * throws; when the setup cannot be read it counts as a printer, so a paper
   * is tried and a failure shows rather than "no printer" said in silence.
   */
  hasReceiptPrinter(): boolean {
    return !this.noPrinterSetUp();
  }

  /**
   * Tell every till window the shift report did not print (the paper at a
   * close, or one printed again). It is not a print_queue job — the report
   * goes straight through printDocumentNow — so the note carries no jobId:
   * the queue's retry (printer:retryJob) never sees it, and the note's own
   * Try again prints the report again from the saved figures. It names the
   * shift, so a note about one shift never looks like another's. Never throws.
   */
  notifyShiftReportFailure(shiftId: string, error: { code: string; message: string } | null | undefined): void {
    const err = { code: error?.code ?? 'unknown', message: error?.message ?? 'Unknown print error' };
    log.error('Shift report did not print', { shiftId, error: err });
    let windows: BrowserWindow[] = [];
    try {
      windows = BrowserWindow.getAllWindows();
    } catch (e) {
      log.warn('Shift report: the till windows could not be told', { shiftId, error: String(e) });
    }
    for (const w of windows) {
      try {
        w.webContents.send('printer:failed', {
          jobKind: 'shift_report',
          shiftId,
          what: 'Shift report',
          error: err,
          retrying: false,
        });
      } catch (e) {
        log.warn('Shift report: a till window could not be told', { shiftId, error: String(e) });
      }
    }
  }

  /** No receipt printer is set up (Settings → Printers): a pulse "goes" nowhere. Never throws. */
  private noPrinterSetUp(): boolean {
    if (!this.db) return false;
    try {
      return isNoPrinter(getReceiptPrinterConfig(this.db) ?? DEFAULT_RECEIPT_CONFIG);
    } catch {
      return false;
    }
  }

  /**
   * The drawer log's result for a pulse (drawer-open-repo settleDrawerOpen:
   * the first result wins). Never throws: a result that can't be written is
   * logged, and the boot check marks the row 'unsure' later.
   */
  private settleDrawer(drawerOpenId: string | undefined, outcome: DrawerOutcome, note: string | null): void {
    if (!this.db || !drawerOpenId) return;
    try {
      settleDrawerOpen(this.db, drawerOpenId, outcome, note);
    } catch (e) {
      log.error('Drawer log: result not written', { drawerOpenId, outcome, error: String(e) });
    }
  }

  /**
   * Send a drawer pulse (inside `exclusive`) and remember when one went out,
   * or may have: every cash event queued before then is served by it.
   */
  private async sendPulse(adapter: PrinterAdapter, bytes: Uint8Array, notAfter: number): Promise<PrintResult> {
    const sentFrom = Date.now();
    const result = await adapter.send(bytes, { drawer: true, notAfter });
    if (result.ok || result.error?.maybeSent === true) {
      this.drawerPulsedAt = Math.max(this.drawerPulsedAt, sentFrom);
    }
    return result;
  }

  /** A pulse went out after this cash was taken (the job was queued), so the drawer already opened for it. */
  private drawerOpenedSince(queuedAt: number): boolean {
    return queuedAt < this.drawerPulsedAt;
  }

  /** The receipt printer's drawer pin and pulse, as saved now (the adapter is kept when only these change). */
  private drawerSettings(): DrawerSettings | undefined {
    if (!this.db) return undefined;
    return (getReceiptPrinterConfig(this.db) ?? DEFAULT_RECEIPT_CONFIG).drawer;
  }

  /**
   * kickDrawerNow without waiting, for the drawer_opens row the float or the
   * cash in / out wrote (required: no row, no pulse). A failure reaches the
   * till as a warning toast; the row is settled either way.
   */
  kickDrawerSoon(drawerOpenId: string): void {
    void this.kickDrawerNow({ drawerOpenId })
      .then((r) => {
        if (!r.ok) notifyDrawerNotOpened(undefined, drawerFailureText(r.error), r.error?.maybeSent === true);
      })
      .catch((e: unknown) => log.warn('Could not report the cash drawer', e));
  }

  /**
   * One kitchen ticket per order, when the policy wants one — not for an
   * order of only drinks while this till leaves drinks off its tickets
   * (Settings → Printers): there is nothing to cook. Items added later and
   * sent again still bring the ticket.
   */
  private kitchenTicket(snap: OrderSnapshot, policy: PrintPolicy): void {
    if (!policy.kitchenTicket || !this.db) return;
    if (!kitchenTicketRules(policy).drinks && snap.items.length > 0 && snap.items.every((it) => isDrinkLine(it))) return;
    if (hasPrintJob(this.db, snap.order.id, 'kitchen')) return;
    this.enqueue({ kind: 'kitchen', orderId: snap.order.id, reprint: false, requestedByUserId: this.whoIsSignedIn() });
  }

  /**
   * "CANCELLED — DO NOT MAKE" for the line, when the kitchen got a ticket for
   * this order from this till. Without it "Not made — put stock back" is only
   * a hope: the kitchen keeps cooking and the count ends up too high.
   *
   * First, whatever has not printed yet never will: a ticket still waiting
   * (a printer retry would otherwise land AFTER the CANCELLED slip, and look
   * like a new order) and, on a void, a bill not yet out. Then the slip goes
   * only if a ticket did print, may have (the printer failed mid-way), or is
   * printing right now — a CANCELLED slip for an order the kitchen never saw
   * only confuses the line.
   */
  private kitchenCancelSlip(snap: OrderSnapshot, policy: PrintPolicy): void {
    if (!this.db) return;
    const db = this.db;
    cancelPendingJobs(db, snap.order.id, { bills: snap.order.status === 'void', note: NOT_PRINTED_CANCELLED });
    if (!policy.kitchenTicket) return;
    const printing = findOpenJob(db, snap.order.id, 'kitchen')?.status === 'in_flight';
    if (!printing && this.series(snap, 'kitchen', 'kitchen', 'kitchen').prior === 0) return;
    this.enqueue({
      kind: 'kitchen',
      orderId: snap.order.id,
      reprint: false,
      cancelled: true,
      requestedByUserId: this.whoIsSignedIn(),
    });
  }

  /**
   * Edit order (v0.7.36): the kitchen's CHANGE slip for an edit just saved
   * (orders:saveEdit, after its commit) — only what it added and took off,
   * frozen in the job, when this till prints kitchen tickets. Not when the
   * order's own ticket is still waiting to print: that ticket prints the
   * order as it is when its turn comes, edit included, so a slip would make
   * the kitchen add it twice. Not when every line it changed is a drink and
   * this till leaves drinks off its tickets. Never throws: print failure never
   * blocks the edit.
   */
  onOrderEdited(orderId: string, change: KitchenChange): void {
    if (!this.db) return;
    const db = this.db;
    try {
      const policy = getPrintPolicy(db);
      if (!policy.kitchenTicket) return;
      const rules = kitchenTicketRules(policy);
      const lines = [...change.added, ...change.removed];
      if (lines.length === 0 || (!rules.drinks && lines.every((l) => l.drink))) return;
      const ticket = findOpenJob(db, orderId, 'kitchen');
      if (ticket?.status === 'pending') return;
      this.enqueue({ kind: 'kitchen', orderId, reprint: false, change, requestedByUserId: change.byUserId ?? this.whoIsSignedIn() });
    } catch (e) {
      log.error('Could not queue the kitchen change slip', { orderId, error: String(e) });
    }
  }

  /**
   * An order was just deleted as a test (orders:deleteTest, after its
   * transaction): whatever has not printed for it never will — tickets and
   * bills still waiting (a payment receipt or a drawer pulse still waiting
   * is finished quietly when its turn comes: runJob) — and, when the kitchen
   * got (or may have got) a ticket and the food had not been handed over, a
   * CANCELLED slip goes to the line. Never throws: print failure never
   * blocks anything.
   */
  onOrderDeleted(orderId: string, statusBefore: OrderStatus): void {
    if (!this.db) return;
    const db = this.db;
    try {
      cancelPendingJobs(db, orderId, { bills: true, note: NOT_PRINTED_DELETED_TEST });
      // A cancelled or refunded order's kitchen already heard (its CANCELLED
      // slip printed then); food handed over needs no slip.
      if (statusBefore === 'void' || statusBefore === 'refunded' || !kitchenHearsOfClose(statusBefore)) return;
      const snap = getOrderSnapshot(db, orderId, { includeDeleted: true });
      if (!snap) return;
      const policy = getPrintPolicy(db);
      if (!policy.kitchenTicket) return;
      const printing = findOpenJob(db, orderId, 'kitchen')?.status === 'in_flight';
      if (!printing && this.series(snap, 'kitchen', 'kitchen', 'kitchen').prior === 0) return;
      this.enqueue({
        kind: 'kitchen',
        orderId,
        reprint: false,
        cancelled: true,
        requestedByUserId: this.whoIsSignedIn(),
      });
    } catch (e) {
      log.error('Could not tidy the printer queue after a test order was deleted', { orderId, error: String(e) });
    }
  }

  /** The person signed in now, never throwing. */
  private whoIsSignedIn(): string | null {
    try {
      return this.currentUserId();
    } catch {
      return null;
    }
  }

  /**
   * Papers of one series in the print log (plus any the version before the
   * log printed): how many there were, and the rows themselves.
   */
  private series(
    snap: OrderSnapshot,
    document: PrintedDocument,
    docKey: string,
    copy: PrintedCopy,
  ): { rows: SeriesPrint[]; legacy: number; prior: number } {
    if (!this.db) return { rows: [], legacy: 0, prior: 0 };
    const rows = listSeriesPrints(this.db, snap.order.id, docKey, copy);
    const legacy = legacyPrintCount(this.db, { orderId: snap.order.id, document, copy, paidAt: snap.order.paidAt });
    return { rows, legacy, prior: rows.length + legacy };
  }

  /** Put what may be on paper from a send the app died in the middle of into the log. Never throws. */
  private logCutOffSends(db: AppDatabase): void {
    try {
      for (const { job, plan } of listInFlightWithPlan(db)) {
        const papers = readPlan(plan);
        if (papers.length === 0) continue;
        this.logPapers(job, papers, 'unsure');
        setSendingPlan(db, job.id, null);
        log.warn('Print spooler: a job was cut off mid-send; its paper may exist', { jobId: job.id, orderId: job.orderId });
      }
    } catch (e) {
      log.warn('Print spooler: could not check jobs cut off mid-send', e);
    }
  }

  /**
   * Papers into the print log, one row each (row + sync + audit). `printedAt`:
   * when they printed, for papers noted late (logKeptPlans).
   */
  private logPapers(job: PrintJobRow, papers: PlannedPaper[], outcome: PrintOutcome, printedAt?: string | null): void {
    if (!this.db) return;
    const db = this.db;
    const orderId = job.payload.orderId;
    db.transaction(() => {
      for (const p of papers) {
        recordDocumentPrint(
          db,
          {
            orderId,
            orderNumber: p.orderNumber,
            document: p.document,
            docKey: p.docKey,
            copy: p.copy,
            printNo: p.printNo,
            outcome,
            reason: p.reason,
            requestedByUserId: p.requestedByUserId,
            approvedByUserId: p.approvedByUserId,
            printJobId: job.id,
            fbrIrn: p.fbrIrn,
            fbrQrPayload: typeof p.fbrQrPayload === 'string' ? p.fbrQrPayload : null,
            fbrMode: p.fbrMode === 'sandbox' || p.fbrMode === 'production' ? p.fbrMode : null,
            ...(printedAt ? { createdAt: printedAt } : {}),
          },
          this.deviceId,
        );
      }
    })();
  }

  /**
   * The printer took the job: its papers into the log and the job done, in
   * one transaction (a crash in between would log them twice). The log must
   * never keep a printed job open: if it can't be written, the job is still
   * marked done — KEEPING its sending plan, so the papers are noted before
   * the next job and the next reprint (logKeptPlans) and the next copy of
   * that paper still says DUPLICATE. No toast: nobody at the counter can act
   * on it.
   */
  private finishPrinted(job: PrintJobRow, papers: PlannedPaper[]): void {
    if (!this.db) return;
    const db = this.db;
    try {
      db.transaction(() => {
        if (papers.length > 0) this.logPapers(job, papers, 'printed');
        markJobDone(db, job.id);
      })();
    } catch (e) {
      log.error('Print log not written for a printed job; kept to note later', {
        jobId: job.id,
        orderId: job.orderId,
        error: String(e),
      });
      try {
        if (papers.length > 0) {
          markJobDoneKeepPlan(db, job.id);
          this.logBacklog = true;
        } else {
          markJobDone(db, job.id);
        }
      } catch (e2) {
        // The job stays in flight with its plan: the next boot notes its
        // papers as 'unsure' (logCutOffSends), so a copy still says DUPLICATE.
        log.error('Printed job could not be marked done', { jobId: job.id, error: String(e2) });
      }
    }
  }

  /**
   * Note the papers of printed jobs that could not go into the log when the
   * printer took them (finishPrinted), at the time they printed, and clear
   * their plans — each job in one transaction, so a paper is never noted
   * twice. At boot, then before the next job and the next reprint while any
   * are waiting. Never throws; what still fails is tried again next time.
   */
  private logKeptPlans(): void {
    if (!this.db) return;
    const db = this.db;
    let failed = false;
    let kept: Array<{ job: PrintJobRow; plan: unknown }>;
    try {
      kept = listDoneWithPlan(db);
    } catch (e) {
      log.error('Print spooler: could not read printed jobs still to note', { error: String(e) });
      this.logBacklog = true;
      return;
    }
    for (const { job, plan } of kept) {
      try {
        const papers = readPlan(plan);
        db.transaction(() => {
          if (papers.length > 0) this.logPapers(job, papers, 'printed', job.completedAt);
          setSendingPlan(db, job.id, null);
        })();
        log.info('Print spooler: noted a printed job late', { jobId: job.id, orderId: job.orderId, papers: papers.length });
      } catch (e) {
        failed = true;
        log.error('Print spooler: a printed job still could not be noted', { jobId: job.id, error: String(e) });
      }
    }
    this.logBacklog = failed;
  }

  /** The printer failed after bytes may have gone out: those papers may exist. */
  private noteUnsure(job: PrintJobRow, papers: PlannedPaper[]): void {
    if (!this.db || papers.length === 0) return;
    const db = this.db;
    try {
      db.transaction(() => {
        this.logPapers(job, papers, 'unsure');
        setSendingPlan(db, job.id, null);
      })();
    } catch (e) {
      log.warn('Print log not written for a job that may have printed', { jobId: job.id, error: String(e) });
    }
  }

  private enqueue(payload: PrintJobPayload): void {
    if (!this.db) {
      log.warn('PrintSpooler not initialized; dropping print job', { kind: payload.kind });
      return;
    }
    enqueuePrintJob(this.db, payload);
    void this.drain();
  }

  /**
   * Synchronous test print for the settings page — bypasses the queue
   * entirely so the manager can see immediate success/failure.
   */
  async testPrintNow(station: Station = 'receipt'): Promise<PrintResult> {
    if (!this.db) {
      return {
        ok: false,
        durationMs: 0,
        error: { code: 'not_ready', message: 'Spooler not initialized', recoverable: false },
      };
    }
    const db = this.db;
    try {
      return await this.exclusive(async () => {
        const adapter = this.getAdapter(station);
        // The page says which printer it was asked for — and when a kitchen
        // test came out of the receipt printer because none is set up.
        const stationPage: TestPageOptions =
          station === 'kitchen' && !this.stationConfig('kitchen')
            ? {
                station: 'kitchen',
                stationNote: 'Kitchen test - no kitchen printer set up, printed on the receipt printer',
              }
            : { station };
        // Only the receipt printer's page shows the logo; a kitchen test (even
        // one that falls back to the receipt printer) never does.
        if (station !== 'receipt') return adapter.testPrint(stationPage);
        const logoTest = this.logoTest(adapter);
        const result = await adapter.testPrint({ ...logoTest.options, ...stationPage });
        if (result.ok && logoTest.printed) {
          try {
            markReceiptLogoChecked(db, logoTest.printed, adapter.config);
          } catch (e) {
            log.warn('Could not note the logo test print', e);
          }
        }
        return result;
      });
    } catch (e) {
      return {
        ok: false,
        durationMs: 0,
        error: {
          code: 'spooler_exception',
          message: e instanceof Error ? e.message : String(e),
          recoverable: false,
        },
      };
    }
  }

  /**
   * A paper that is not about an order (the recipe calculator's prep list),
   * straight to the receipt printer — like the test page, in turn with the
   * queue (`exclusive`), so its bytes never interleave with a receipt's. No
   * print_queue row (that table holds order papers only) and no print-log
   * row: it is not a document of a sale. `render` gets the paper's width
   * (58 or 80 mm) as set for the receipt printer. Never throws: a failure
   * comes back as a PrintResult for the till to show, and nothing waits on it.
   */
  async printDocumentNow(render: (width: PrinterWidth) => Uint8Array): Promise<PrintResult> {
    if (!this.db) {
      return {
        ok: false,
        durationMs: 0,
        error: { code: 'not_ready', message: 'Spooler not initialized', recoverable: false },
      };
    }
    try {
      return await this.exclusive(async () => {
        const adapter = this.getAdapter('receipt');
        return adapter.send(render(adapter.config.width ?? 48));
      });
    } catch (e) {
      return {
        ok: false,
        durationMs: 0,
        error: {
          code: 'spooler_exception',
          message: e instanceof Error ? e.message : String(e),
          recoverable: true,
        },
      };
    }
  }

  /**
   * The logo part of the receipt printer's test page, and the logo it prints
   * (to note the check afterwards). Never throws: at worst the page has no logo.
   */
  private logoTest(adapter: PrinterAdapter): { options: TestPageOptions; printed: string | null } {
    if (!this.db) return { options: {}, printed: null };
    try {
      const branding = getReceiptBranding(this.db);
      const logo = getReceiptLogo(this.db, adapter.config.width ?? 48, branding);
      const options = logoTestOptions(logo, logo.enabled);
      return { options, printed: options.logo && branding.logoUrl ? branding.logoUrl : null };
    } catch (e) {
      log.warn('Test page without the logo', e);
      return { options: {}, printed: null };
    }
  }

  /**
   * The adapter for a station. Kitchen tickets use the kitchen printer when
   * one is set up and otherwise share the receipt printer's adapter (one
   * connection, one queue, no interleaving). Called inside `exclusive`, so
   * an adapter it replaces is never mid-send.
   */
  private getAdapter(station: Station): PrinterAdapter {
    if (!this.db) throw new Error('Spooler not initialized');
    const config = this.stationConfig(station);
    if (!config) return this.getAdapter('receipt');
    const key = adapterKey(config);
    const cached = this.adapters.get(station);
    if (cached && cached.key === key) return cached.adapter;
    if (cached) void cached.adapter.disconnect();
    const adapter = makePrinterAdapter(config);
    this.adapters.set(station, { adapter, key });
    return adapter;
  }

  /** A station's own printer setup; null for a kitchen that shares the receipt printer. */
  private stationConfig(station: Station): PrinterConnectionConfig | null {
    if (!this.db) return null;
    if (station === 'kitchen') return getKitchenPrinterConfig(this.db);
    return getReceiptPrinterConfig(this.db) ?? DEFAULT_RECEIPT_CONFIG;
  }

  /**
   * Called after printer settings change. A printer that is still the same
   * printer keeps its adapter — changing only the drawer pin or pulse must
   * not restart a USB print worker (seconds on a slow PC, right when the
   * owner presses Test drawer). The others are shut down only once the send
   * in progress (if any) is over: a USB print worker killed mid drawer-send
   * could leave the pulse in the Windows queue. The receipt printer then
   * gets ready again straight away.
   */
  resetAdapter(): void {
    void this.exclusive(async () => {
      for (const [station, cached] of [...this.adapters]) {
        const config = this.stationConfig(station);
        if (config && adapterKey(config) === cached.key) continue;
        this.adapters.delete(station);
        void cached.adapter.disconnect();
      }
    }).catch((e: unknown) => log.warn('Could not refresh the printers', e));
    this.warmUp();
  }

  /** Get the receipt printer ready (e.g. start the USB print worker). Never throws. */
  private warmUp(): void {
    if (!this.db) return;
    void this.exclusive(async () => {
      this.getAdapter('receipt')
        .connect()
        .catch((e: unknown) => log.warn('Receipt printer not ready yet', e));
    }).catch((e: unknown) => log.warn('Receipt printer not ready yet', e));
  }

  /** Run `fn` when no other printer conversation is going on. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn);
    this.lock = run.catch(() => undefined);
    return run;
  }

  /** Work through every due job; returns the loop in progress if one is running. */
  private drain(): Promise<void> {
    if (!this.db) return Promise.resolve();
    if (this.running) return this.current;
    const db = this.db;
    this.running = true;
    this.current = (async () => {
      try {
        // One job at a time keeps prints to a physical printer in order.
        while (true) {
          // A printed paper not in the log yet is noted before the next job
          // is rendered: that job may be its copy.
          if (this.logBacklog) this.logKeptPlans();
          const job = claimNextPendingJob(db);
          if (!job) break;
          await this.runJob(job);
        }
      } finally {
        this.running = false;
      }
    })();
    return this.current;
  }

  /** Resolves once every job that is due now has been tried (for tests). */
  whenIdle(): Promise<void> {
    return this.drain();
  }

  private async runJob(job: PrintJobRow): Promise<void> {
    if (!this.db) return;
    const db = this.db;
    const isDrawer = job.payload.kind === 'drawer';
    // The drawer_opens row this pulse is for (none on a pulse an older version queued).
    const drawerOpenId = job.payload.kind === 'drawer' ? job.payload.drawerOpenId : undefined;
    const queuedAt = Date.parse(job.createdAt);
    const deadline = queuedAt + DRAWER_KICK_MAX_AGE_MS;
    const served = () => {
      log.info('Cash drawer already opened since this sale; pulse not sent again', {
        jobId: job.id,
        orderId: job.orderId,
      });
      markJobDone(db, job.id, ALREADY_OPENED_NOTE);
      this.settleDrawer(drawerOpenId, 'already_open', ALREADY_OPEN_NOTE);
    };
    let result: PrintResult | typeof ALREADY_OPENED;
    /** The papers this send carries, for the print log. */
    let papers: PlannedPaper[] = [];
    try {
      let snap = getOrderSnapshot(db, job.payload.orderId);
      if (!snap) {
        const gone = getOrderSnapshot(db, job.payload.orderId, { includeDeleted: true });
        if (gone && gone.order.deleteKind === 'test') {
          // Deleted as a test order (orders:deleteTest). Only the kitchen's
          // CANCELLED slip still prints — the line may be cooking it; nothing
          // else does, and nobody at the counter is bothered with a toast.
          if (job.payload.kind === 'kitchen' && job.payload.cancelled === true) {
            snap = gone;
          } else {
            markJobDone(db, job.id, NOT_PRINTED_DELETED_TEST);
            this.settleDrawer(drawerOpenId, 'not_opened', ORDER_GONE_NOTE);
            return;
          }
        } else {
          markJobFailedPermanently(db, job.id, 'Order no longer exists');
          this.settleDrawer(drawerOpenId, 'not_opened', ORDER_GONE_NOTE);
          notifyPrintFailure(job, {
            code: 'order_missing',
            message: 'Order no longer exists',
          }, false, failedPaperWords(db, job));
          return;
        }
      }
      if (cancelledMeanwhile(job.payload, snap)) {
        // The order was cancelled after this was queued: a ticket for the
        // kitchen (or the till's own bill) must not come out now.
        markJobDone(db, job.id, NOT_PRINTED_CANCELLED);
        return;
      }
      if (isDrawer && this.drawerOpenedSince(queuedAt)) {
        served();
        return;
      }
      if (isDrawer && Date.now() > deadline) {
        log.info('Dropped a late cash-drawer pulse', { jobId: job.id, orderId: job.orderId });
        markJobFailedPermanently(db, job.id, 'Too late to open the drawer');
        this.settleDrawer(drawerOpenId, 'not_opened', TOO_LATE_NOTE);
        notifyDrawerNotOpened(
          job.orderId,
          `${orderLabel(snap)}: the printer did not answer within a minute of the sale.`,
        );
        return;
      }
      if (this.waitingForFbr(job, snap)) {
        deferJob(db, job.id, FBR_RECHECK_MS);
        setTimeout(() => void this.drain(), FBR_RECHECK_MS + 10);
        return;
      }
      let payload = job.payload;
      if (payload.kind === 'receipt' && payload.openDrawer) {
        // Queued by a till before 0.7.7 with the pulse inside the receipt.
        // Receipts no longer open the drawer (a retry could open it twice).
        payload = { ...payload, openDrawer: false };
        if (job.attempts === 0) {
          notifyDrawerNotOpened(job.orderId, `${orderLabel(snap)} printed without opening the drawer.`);
        }
      }
      const toSend = payload;
      const order: OrderSnapshot = snap;
      result = await this.exclusive(async (): Promise<PrintResult | typeof ALREADY_OPENED> => {
        if (isDrawer) {
          // The lock may have kept a drawer pulse waiting — behind a slow
          // send, or an Open drawer that opened it meanwhile: check again.
          if (this.drawerOpenedSince(queuedAt)) return ALREADY_OPENED;
          if (Date.now() > deadline) return tooLate(queuedAt);
        }
        const rendered = this.render(job, toSend, order);
        papers = rendered.papers;
        // Just before the bytes go out: if the app dies mid-send, boot finds
        // this and logs the papers as 'unsure' (their re-send says DUPLICATE).
        if (papers.length > 0) setSendingPlan(db, job.id, { papers });
        return isDrawer ? this.sendPulse(rendered.adapter, rendered.bytes, deadline) : rendered.adapter.send(rendered.bytes);
      });
    } catch (e) {
      result = {
        ok: false,
        durationMs: 0,
        error: {
          code: 'spooler_exception',
          message: e instanceof Error ? e.message : String(e),
          recoverable: false,
        },
      };
    }

    if (result === ALREADY_OPENED) {
      served();
      return;
    }
    if (result.ok) {
      this.finishPrinted(job, papers);
      if (isDrawer) {
        const settled = drawerOutcome(result, this.noPrinterSetUp());
        this.settleDrawer(drawerOpenId, settled.outcome, settled.note);
      }
      return;
    }
    // Part of it may be on paper: the log says so, and the retry says
    // DUPLICATE (printer retry). A definite failure logs nothing, so the
    // retry is still the original.
    if (!isDrawer && result.error?.maybeSent === true) this.noteUnsure(job, papers);
    const attempts = job.attempts + 1;
    const backoff = BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length - 1)]!;
    if (isDrawer) {
      const err = result.error;
      const unsure = err?.maybeSent === true;
      if (unsure || !err?.recoverable || attempts >= MAX_ATTEMPTS || Date.now() + backoff > deadline) {
        // Never retried when it may have gone out (it would open twice), nor
        // when the retry would come too late to be any use.
        markJobFailedPermanently(db, job.id, err?.message ?? 'Unknown printer error');
        if (err?.code === DRAWER_TOO_LATE_CODE) {
          this.settleDrawer(drawerOpenId, 'not_opened', TOO_LATE_NOTE);
        } else {
          const settled = drawerOutcome(result, false);
          this.settleDrawer(drawerOpenId, settled.outcome, settled.note);
        }
        notifyDrawerNotOpened(job.orderId, drawerFailureText(err), unsure);
        return;
      }
      // Retried in a moment: the result is not known yet (the row stays open).
    } else if (!result.error?.recoverable || attempts >= MAX_ATTEMPTS) {
      markJobFailedPermanently(
        db,
        job.id,
        result.error?.message ?? 'Unknown print error',
      );
      notifyPrintFailure(job, result.error, false, failedPaperWords(db, job));
      return;
    }
    rescheduleJob(db, job.id, result.error?.message ?? 'unknown', backoff);
    // Say so on the first miss, not after ~12 minutes of silent retries: the
    // kitchen is waiting on that ticket now (it keeps retrying on its own).
    if (attempts === 1) notifyPrintFailure(job, result.error, true, failedPaperWords(db, job));
    log.warn('Print job will retry', {
      jobId: job.id,
      jobKind: job.jobKind,
      attempts,
      inMs: backoff,
      error: result.error?.message,
    });
  }

  /**
   * A customer receipt should carry the FBR invoice number. The FBR worker
   * runs right after the sale commits, so give it a moment before printing
   * the payment receipt — but never hold the paper for long: past the grace
   * period (counted from when the sale queued it) the receipt prints saying
   * the number is not issued yet. While waiting it steps aside (see runJob).
   *
   * Only a RECEIPT waits (a cash-on-delivery bill has no FBR row until the
   * rider brings the money: it prints at once). With FBR live it also waits
   * when the sale's row is not queued yet — the receipt is claimed before
   * the tender queues it — but only when this till took the money: a sale
   * paid on the other till has its FBR row there, never here, so waiting
   * would only hold the paper. A refund slip waits the same way for its
   * debit note when the sale was fiscalised.
   */
  private waitingForFbr(job: PrintJobRow, snap: OrderSnapshot): boolean {
    if (!this.db || job.payload.kind !== 'receipt') return false;
    if (Date.now() >= Date.parse(job.createdAt) + FBR_IRN_GRACE_MS) return false;
    const db = this.db;
    const reason = job.payload.reason;
    if (reason === 'payment' || reason === 'dispatch') {
      if (receiptDocumentFor(snap) !== 'receipt') return false;
      const row = getFbrRowByOrder(db, job.payload.orderId);
      if (row) return row.modeAtEnqueue !== 'noop' && row.status === 'pending';
      if (getFbrMode(db) === 'noop') return false;
      if (latestLoggedSaleFbr(db, job.payload.orderId)) return false;
      return paymentTakenOnDevice(db, job.payload.orderId, this.deviceId);
    }
    if (reason === 'refund') {
      const sale = getFbrRowByOrder(db, job.payload.orderId);
      if (!sale || sale.status !== 'sent' || !sale.irn || sale.modeAtEnqueue === 'noop') return false;
      const refundAt = job.payload.refundAt ?? latestRefundAt(snap);
      const ids = refundRows(snap, refundAt).map((p) => p.id);
      const notes = getFbrDebitNotes(db, job.payload.orderId, ids);
      return !notes.some((n) => n.status === 'sent' || n.status === 'failed' || n.status === 'skipped');
    }
    return false;
  }

  /**
   * The sale's FBR number for a customer receipt, or why a live till has none.
   * In `noop` mode (the default) nothing: the adapter makes up a NOOP-…
   * number to exercise the queue, and that must never reach paper — nor a
   * promise of a fiscal QR that will never come.
   *
   * fbr_submission_queue is per till. With no row here, the number (and its
   * QR) may be on a receipt the other till printed — the print log syncs —
   * and a duplicate must carry exactly that. A sale paid on the other till
   * with no number known here prints nothing about FBR: this till cannot
   * tell "not issued" from "issued there", and must not say either.
   */
  private fbrForReceipt(snap: OrderSnapshot): { fbr: FbrPrint | null; missing: 'pending' | 'failed' | null } {
    const none = { fbr: null, missing: null };
    if (!this.db) return none;
    const db = this.db;
    const row = getFbrRowByOrder(db, snap.order.id);
    if (row) {
      if (row.modeAtEnqueue === 'noop') return none;
      if (row.status === 'sent' && row.irn) {
        return { fbr: { irn: row.irn, qrPayload: row.qrPayload, test: row.modeAtEnqueue === 'sandbox' }, missing: null };
      }
      return { fbr: null, missing: row.status === 'failed' || row.status === 'skipped' ? 'failed' : 'pending' };
    }
    const logged = latestLoggedSaleFbr(db, snap.order.id);
    if (logged) return { fbr: { irn: logged.irn, qrPayload: logged.qrPayload, test: logged.mode === 'sandbox' }, missing: null };
    if (getFbrMode(db) === 'noop') return none;
    if (!paymentTakenOnDevice(db, snap.order.id, this.deviceId)) return none;
    // Taken here with no row: queued any moment now for a sale just paid; an
    // older sale (from before FBR was switched on, say) never will be.
    const paidMs = Date.parse(snap.order.paidAt ?? snap.order.createdAt);
    return { fbr: null, missing: Date.now() - paidMs < FBR_NO_ROW_PENDING_MS ? 'pending' : 'failed' };
  }

  /** A refund's own FBR number (its debit note), when the sale was fiscalised. */
  private fbrForRefund(
    snap: OrderSnapshot,
    rows: OrderSnapshot['payments'],
  ): Pick<RefundSlipInfo, 'debitNote' | 'debitNoteMissing'> {
    if (!this.db) return {};
    const sale = getFbrRowByOrder(this.db, snap.order.id);
    if (!sale || sale.status !== 'sent' || !sale.irn || sale.modeAtEnqueue === 'noop') return {};
    const notes = getFbrDebitNotes(this.db, snap.order.id, rows.map((p) => p.id));
    const sent = notes.find((n) => n.status === 'sent' && n.irn);
    if (sent?.irn) {
      return {
        debitNote: {
          irn: sent.irn,
          qrPayload: sent.qrPayload,
          test: sent.modeAtEnqueue === 'sandbox',
          saleIrn: sale.irn,
        },
      };
    }
    return { debitNoteMissing: notes.some((n) => n.status === 'failed' || n.status === 'skipped') ? 'failed' : 'pending' };
  }

  /**
   * How a paper of this series is marked — THE OWNER'S RULE (27 Sep 2026, in
   * full in order-papers.ts and Settings → Printing rules): a paper the till
   * prints by itself in the normal flow is the ORIGINAL; every paper printed
   * with a print button says DUPLICATE, even the first of its kind.
   *  - By hand (`manual`): "Reprint #N | time | by X" (and "Approved by"),
   *    N from handReprintNumber — the first hand press of a paper the till
   *    never printed by itself is Reprint #1.
   *  - By the till: nothing on the first (hand-pressed copies before it do
   *    not count: the till's own paper is the original); a retry of this very
   *    job after the printer failed mid-way says "Printer retry" (a paper may
   *    already exist); a second paper the till printed itself "Copy #N".
   *    A job that failed outright logged nothing, so its retry — the
   *    spooler's own, or "Try again" on the failed-print note — is the
   *    original.
   *  - Kitchen tickets: REPRINT / RE-SENT as before (a hand-pressed ticket
   *    when none ever went out is simply the kitchen's ticket).
   * A paid RECEIPT after a BILL is its own series, and so is the SHOP COPY.
   */
  private stampFor(
    series: { rows: SeriesPrint[]; legacy: number; prior: number },
    ctx: {
      jobId: string;
      manual: boolean;
      kitchen: boolean;
      requestedBy: string | null;
      approvedBy: string | null;
      names: Map<string, string>;
      fbrCopy: boolean;
    },
  ): CopyStamp | null {
    const now = new Date();
    const byName = ctx.requestedBy ? (ctx.names.get(ctx.requestedBy) ?? null) : null;
    const approvedByName = ctx.approvedBy ? (ctx.names.get(ctx.approvedBy) ?? null) : null;
    // The papers before this job (its own earlier tries are the same paper).
    const others = series.rows.filter((r) => r.printJobId !== ctx.jobId);
    const earlierPapers = new Set(others.map(jobKey)).size + series.legacy;
    // The first paper, when the log has it (one the old version printed is unknown).
    const firstPrintedAt = series.legacy === 0 && series.rows[0] ? new Date(series.rows[0].createdAt) : null;

    if (ctx.kitchen) {
      if (series.prior === 0) return null;
      // Nothing but this job's own fumbled attempts — or nothing that surely
      // printed: the kitchen may have no ticket at all.
      const nothingSurelyPrinted = series.legacy === 0 && series.rows.every((r) => r.outcome === 'unsure');
      if (earlierPapers === 0 || nothingSurelyPrinted) return { kind: 'retry', number: 0, printedAt: now, firstPrintedAt };
      if (ctx.manual) return { kind: 'reprint', number: earlierPapers, printedAt: now, byName, approvedByName, firstPrintedAt };
      return { kind: 'copy', number: earlierPapers + 1, printedAt: now, firstPrintedAt };
    }

    // "Original: <time>" names the paper that printed as the original (none
    // yet when only hand-pressed copies went out; unknown for one the version
    // before the log printed).
    const original = series.legacy === 0 ? others.find((r) => r.printNo === 0) : undefined;
    const originalAt = original ? new Date(original.createdAt) : null;
    if (ctx.manual) {
      return {
        kind: 'reprint',
        number: handReprintNumber(others, series.legacy),
        printedAt: now,
        byName,
        approvedByName,
        firstPrintedAt: originalAt,
        ...(ctx.fbrCopy ? { fbrCopy: true } : {}),
      };
    }

    // Printed by the till itself.
    if (!seriesHasOriginal(others, series.legacy)) {
      // The original — unless this job already tried and the paper may exist.
      return others.length < series.rows.length ? { kind: 'retry', number: 0, printedAt: now, firstPrintedAt } : null;
    }
    return { kind: 'copy', number: earlierPapers + 1, printedAt: now, firstPrintedAt: originalAt };
  }

  /**
   * An Edit order's CHANGE slip (v0.7.36): what the edit added and took off,
   * as frozen in the job, on the kitchen printer, with the till's kitchen
   * rules (phone, drinks, copies). Its own series in the print log
   * (`kitchen_change:<n>`): a retry after a printer error says RE-SENT, and it
   * never makes the order's ticket read as a REPRINT.
   */
  private renderChangeSlip(
    job: PrintJobRow,
    payload: KitchenJobPayload,
    change: KitchenChange,
    snap: OrderSnapshot,
    adapter: PrinterAdapter,
  ): { adapter: PrinterAdapter; bytes: Uint8Array; papers: PlannedPaper[] } {
    const db = this.db!;
    const document: PrintedDocument = 'kitchen_change';
    const docKey = `kitchen_change:${change.editNo}`;
    const requestedBy = payload.requestedByUserId ?? null;
    let stamp: CopyStamp | null = null;
    let printNo = 0;
    let names = new Map<string, string>();
    try {
      const series = this.series(snap, document, docKey, 'kitchen');
      names = userNames(db, [requestedBy, change.byUserId]);
      stamp = this.stampFor(series, { jobId: job.id, manual: false, kitchen: true, requestedBy, approvedBy: null, names, fbrCopy: false });
      printNo = series.prior;
    } catch (e) {
      log.warn('Print log unreadable; change slip printed without its stamp', { jobId: job.id, error: String(e) });
    }
    const rules = kitchenTicketRules(getPrintPolicy(db));
    const copies = rules.copies;
    const slip = (n: number) =>
      renderKitchenChangeTicket(snap, change, {
        width: adapter.config.width ?? 48,
        stamp,
        queuedAt: new Date(job.createdAt),
        byName: change.byUserId ? (names.get(change.byUserId) ?? null) : null,
        showPhone: rules.phone,
        showDrinks: rules.drinks,
        copyOf: copies > 1 ? { n, of: copies } : null,
      });
    return {
      adapter,
      bytes: copies > 1 ? concat(Array.from({ length: copies }, (_, i) => slip(i + 1))) : slip(1),
      papers: [
        {
          orderNumber: snap.order.orderNumber,
          document,
          docKey,
          copy: 'kitchen',
          printNo,
          reason: 'auto',
          requestedByUserId: requestedBy,
          approvedByUserId: null,
          fbrIrn: null,
        },
      ],
    };
  }

  /** Bytes for a job, the printer they go to, and the papers they carry (for the print log). */
  private render(
    job: PrintJobRow,
    payload: PrintJobPayload,
    snap: OrderSnapshot,
  ): { adapter: PrinterAdapter; bytes: Uint8Array; papers: PlannedPaper[] } {
    if (!this.db) throw new Error('Spooler not initialized');
    const db = this.db;
    const orderNumber = snap.order.orderNumber;
    switch (payload.kind) {
      case 'kitchen': {
        const adapter = this.getAdapter('kitchen');
        // An Edit order's CHANGE slip (v0.7.36): its own paper and series, what the edit changed.
        if (payload.change) return this.renderChangeSlip(job, payload, payload.change, snap, adapter);
        const cancelled = payload.cancelled === true;
        const document: PrintedDocument = cancelled ? 'kitchen_cancel' : 'kitchen';
        const reason: PrintReason = cancelled ? 'cancel' : payload.reprint ? MANUAL_REASON : 'auto';
        const requestedBy = payload.requestedByUserId ?? null;
        let stamp: CopyStamp | null = null;
        let printNo = 0;
        let names = new Map<string, string>();
        try {
          const series = this.series(snap, document, document, 'kitchen');
          names = userNames(db, [requestedBy, snap.order.voidedBy, snap.order.deletedBy ?? null]);
          stamp = this.stampFor(series, {
            jobId: job.id,
            manual: reason === MANUAL_REASON,
            kitchen: true,
            requestedBy,
            approvedBy: null,
            names,
            fbrCopy: false,
          });
          printNo = series.prior;
        } catch (e) {
          if (reason === MANUAL_REASON) {
            // Pressed by hand and the log can't say whether a ticket already
            // printed: RE-SENT / CHECK FOR TICKET BEFORE COOKING — never an
            // unmarked ticket the kitchen might cook twice.
            log.warn('Print log unreadable; ticket re-sent marked RE-SENT', { jobId: job.id, error: String(e) });
            stamp = { kind: 'retry', number: 0, printedAt: new Date() };
            printNo = 1;
          } else {
            log.warn('Print log unreadable; ticket printed without its stamp', { jobId: job.id, error: String(e) });
          }
        }
        // Cancelled, refunded, or deleted as a test order while the kitchen had it.
        const deletedAsTest = snap.order.deleteKind === 'test' && !!snap.order.deletedAt;
        const cancelledBy = snap.order.voidedBy ?? (deletedAsTest ? (snap.order.deletedBy ?? null) : null);
        const cancelledAt = snap.order.voidedAt ?? (deletedAsTest ? (snap.order.deletedAt ?? null) : null);
        const cancelInfo: CancelInfo | null = cancelled
          ? {
              at: cancelledAt ? new Date(cancelledAt) : null,
              byName: cancelledBy ? (names.get(cancelledBy) ?? null) : null,
              reason:
                snap.order.voidReason ??
                (deletedAsTest ? `Test order${snap.order.deleteReason ? `: ${snap.order.deleteReason}` : ''}` : null),
            }
          : null;
        // This till's kitchen-ticket rules (Settings → Printers): the phone and the drinks, and how
        // many tickets the kitchen gets — each marked COPY n OF N. One printed by hand is one; its
        // copies are the same ticket, one paper in the print log.
        const rules = kitchenTicketRules(getPrintPolicy(db));
        const copies = reason === MANUAL_REASON ? 1 : rules.copies;
        const ticket = (n: number) =>
          renderKitchenTicket(snap, {
            width: adapter.config.width ?? 48,
            cancelled,
            cancelInfo,
            stamp,
            queuedAt: new Date(job.createdAt),
            showPhone: rules.phone,
            showDrinks: rules.drinks,
            copyOf: copies > 1 ? { n, of: copies } : null,
          });
        return {
          adapter,
          bytes: copies > 1 ? concat(Array.from({ length: copies }, (_, i) => ticket(i + 1))) : ticket(1),
          papers: [
            {
              orderNumber,
              document,
              docKey: document,
              copy: 'kitchen',
              printNo,
              reason,
              requestedByUserId: requestedBy,
              approvedByUserId: null,
              fbrIrn: null,
            },
          ],
        };
      }
      case 'drawer': {
        const adapter = this.getAdapter('receipt');
        return { adapter, bytes: renderDrawerKick(this.drawerSettings()), papers: [] };
      }
      default: {
        const adapter = this.getAdapter('receipt');
        const width = adapter.config.width ?? 48;
        const branding = getReceiptBranding(db);
        // The logo, when there is a usable one and receipts are set to print it.
        const logo = receiptLogoToPrint(db, width, branding);

        // What this paper is, decided now from the order — never from the
        // button: a cancelled order prints as cancelled, whatever asked.
        const refundAt = payload.reason === 'refund' ? (payload.refundAt ?? latestRefundAt(snap)) : null;
        const thisRefund = refundAt ? refundRows(snap, refundAt) : [];
        const document: ReceiptDocument = payload.reason === 'refund' && thisRefund.length > 0 ? 'refund' : receiptDocumentFor(snap);
        const docKey = docKeyFor(document, refundAt);
        const manual = payload.reason === MANUAL_REASON;
        const requestedBy = payload.requestedByUserId ?? null;
        const approvedBy = payload.approvedByUserId ?? null;
        const names = userNames(db, [
          requestedBy,
          approvedBy,
          snap.order.voidedBy,
          ...thisRefund.map((p) => p.receivedByUserId),
        ]);

        const fbrSale = document === 'receipt' ? this.fbrForReceipt(snap) : { fbr: null, missing: null };
        const refund: RefundSlipInfo | undefined =
          document === 'refund' && refundAt
            ? {
                refundedAt: new Date(refundAt),
                rows: thisRefund.map((p) => ({ method: p.method, amountCents: -p.amountCents })),
                reason: refundReason(thisRefund, snap),
                refundedByName: requestedBy ? (names.get(requestedBy) ?? null) : null,
                approvedByName: thisRefund[0] ? (names.get(thisRefund[0].receivedByUserId) ?? null) : null,
                totalRefundedCents: -snap.payments
                  .filter((p) => p.amountCents < 0 && p.paidAt <= refundAt)
                  .reduce((n, p) => n + p.amountCents, 0),
                ...this.fbrForRefund(snap, thisRefund),
                // Back through an outside rider, or no cash at all (a refused item): the SHOP COPY says so.
                handedTo: refundHandOver(snap, refundAt),
              }
            : undefined;
        const cancelled: CancelInfo | null =
          document === 'void'
            ? {
                at: snap.order.voidedAt ? new Date(snap.order.voidedAt) : null,
                byName: snap.order.voidedBy ? (names.get(snap.order.voidedBy) ?? null) : null,
                reason: snap.order.voidReason,
              }
            : null;

        // Each copy is its own series: the SHOP COPY is never a duplicate of
        // the customer's.
        const copies = payload.copies.map((copy) => {
          // The FBR number this paper carries (the customer's copy only).
          const fbrPrinted = copy === 'customer' ? (fbrSale.fbr ?? refund?.debitNote ?? null) : null;
          const fbrIrn = fbrPrinted?.irn ?? null;
          let stamp: CopyStamp | null = null;
          let printNo = 0;
          try {
            const series = this.series(snap, document, docKey, copy);
            stamp = this.stampFor(series, {
              jobId: job.id,
              manual,
              kitchen: false,
              requestedBy,
              approvedBy,
              names,
              fbrCopy: document === 'receipt' && copy === 'customer' && isFbrCopy(series, fbrSale.fbr?.irn ?? null),
            });
            // 0 = it printed as the original; a DUPLICATE is at least 1 (a
            // hand-pressed first paper too — order-papers.ts).
            printNo = stamp === null ? 0 : Math.max(series.prior, 1);
          } catch (e) {
            if (manual) {
              // Pressed for by hand and the log can't say whether this paper
              // already printed: fail safe — it says DUPLICATE, without a
              // number (and counts as a reprint in the log). A paper the till
              // prints by itself (payment, dispatch, refund) prints unmarked:
              // a sale's first receipt is never marked DUPLICATE by an error.
              log.warn('Print log unreadable; paper pressed for by hand marked DUPLICATE', {
                jobId: job.id,
                error: String(e),
              });
              stamp = {
                kind: 'reprint',
                number: 0,
                numberUnknown: true,
                printedAt: new Date(),
                byName: requestedBy ? (names.get(requestedBy) ?? null) : null,
                approvedByName: approvedBy ? (names.get(approvedBy) ?? null) : null,
              };
              printNo = 1;
            } else {
              log.warn('Print log unreadable; receipt printed without its stamp', { jobId: job.id, error: String(e) });
            }
          }
          const opts: Omit<RenderReceiptOpts, 'logo'> = {
            width,
            branding,
            copy,
            document,
            stamp,
            openDrawer: false,
            cutPaper: true,
            ...(fbrSale.fbr ? { fbr: fbrSale.fbr } : {}),
            ...(fbrSale.missing ? { fbrMissing: fbrSale.missing } : {}),
            ...(refund ? { refund } : {}),
            ...(cancelled ? { cancelled } : {}),
          };
          const paper: PlannedPaper = {
            orderNumber,
            document,
            docKey,
            copy,
            printNo,
            reason: payload.reason,
            requestedByUserId: requestedBy,
            approvedByUserId: approvedBy,
            fbrIrn,
            fbrQrPayload: fbrPrinted?.qrPayload ?? null,
            fbrMode: fbrPrinted ? (fbrPrinted.test ? 'sandbox' : 'production') : null,
          };
          return { opts, paper };
        });
        // All copies on one strip, one send. Never a drawer pulse: that is
        // its own job (see onOrderEvent).
        const renderAll = (withLogo: MonoRaster | null) =>
          copies.map((c) => renderReceipt(snap, { ...c.opts, logo: withLogo }));
        // The logo is never the reason a receipt fails: if anything about it
        // goes wrong, the receipt prints without it.
        let parts: Uint8Array[];
        try {
          parts = renderAll(logo);
        } catch (e) {
          if (!logo) throw e;
          log.warn('Receipt printed without the logo', e);
          parts = renderAll(null);
        }
        return { adapter, bytes: concat(parts), papers: copies.map((c) => c.paper) };
      }
    }
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function orderLabel(snap: OrderSnapshot): string {
  return `Order #${snap.order.orderNumber.split('-').pop() ?? snap.order.orderNumber}`;
}

/** This till's id (device_info), for the print log. */
function readDeviceId(db: AppDatabase): string {
  try {
    const row = db.prepare(`SELECT device_id FROM device_info WHERE id = 'singleton'`).get() as
      | { device_id: string }
      | undefined;
    return row?.device_id ?? 'unknown-device';
  } catch {
    return 'unknown-device';
  }
}

/** When the order's latest refund happened (its rows share this paid_at), or null. */
function latestRefundAt(snap: OrderSnapshot): string | null {
  let at: string | null = null;
  for (const p of snap.payments) if (p.amountCents < 0 && (at === null || p.paidAt > at)) at = p.paidAt;
  return at;
}

/** The refund rows (negative payments) written together at `at`. */
function refundRows(snap: OrderSnapshot, at: string | null): OrderSnapshot['payments'] {
  if (!at) return [];
  return snap.payments.filter((p) => p.amountCents < 0 && p.paidAt === at);
}

/** Why the money went back: the reason typed with a part refund, else the order's. */
function refundReason(rows: OrderSnapshot['payments'], snap: OrderSnapshot): string | null {
  for (const p of rows) {
    const m = /^(?:partial-refund|refund-rest):\s*(.+)$/.exec(p.referenceNo ?? '');
    if (m?.[1]) return m[1].trim();
  }
  return snap.order.voidReason;
}

/**
 * A job that must not print because its order was cancelled after it was
 * queued: a kitchen ticket (not the CANCELLED slip) for a cancelled or fully
 * refunded order, and the till's own bill or receipt for a cancelled one. A
 * reprint pressed for a cancelled order still prints — as CANCELLED ORDER.
 */
function cancelledMeanwhile(payload: PrintJobPayload, snap: OrderSnapshot): boolean {
  const status = snap.order.status;
  if (payload.kind === 'kitchen') return payload.cancelled !== true && (status === 'void' || status === 'refunded');
  if (payload.kind === 'receipt') return status === 'void' && (payload.reason === 'payment' || payload.reason === 'dispatch');
  return false;
}

/** The papers in a stored sending plan (whatever shape it has). */
function readPlan(plan: unknown): PlannedPaper[] {
  const papers = (plan as { papers?: unknown } | null)?.papers;
  if (!Array.isArray(papers)) return [];
  return papers.filter(
    (p): p is PlannedPaper =>
      !!p &&
      typeof p === 'object' &&
      typeof (p as PlannedPaper).document === 'string' &&
      typeof (p as PlannedPaper).docKey === 'string' &&
      typeof (p as PlannedPaper).copy === 'string' &&
      typeof (p as PlannedPaper).printNo === 'number',
  );
}

/** One press or print job (its attempts are one paper, as far as counting goes). */
function jobKey(r: SeriesPrint): string {
  return r.printJobId ?? r.id;
}

/**
 * The paper that first carried the FBR number, when an earlier one of the
 * series went out without it: the customer's fiscal copy, not a spare.
 */
function firstFbrCopyRow(rows: SeriesPrint[]): SeriesPrint | null {
  const i = rows.findIndex((r) => !!r.fbrIrn);
  return i > 0 ? (rows[i] ?? null) : null;
}

/** Printing `fbrIrn` now would be the first paper of the series to carry it. */
function isFbrCopy(series: { rows: SeriesPrint[]; legacy: number }, fbrIrn: string | null): boolean {
  return !!fbrIrn && series.legacy === 0 && series.rows.length > 0 && series.rows.every((r) => !r.fbrIrn);
}

function tooLate(since: number): PrintResult {
  return {
    ok: false,
    durationMs: Date.now() - since,
    error: { code: DRAWER_TOO_LATE_CODE, message: 'The printer was busy for too long', recoverable: false },
  };
}

function printerStarting(since: number): PrintResult {
  return {
    ok: false,
    durationMs: Date.now() - since,
    error: { code: PRINTER_STARTING_CODE, message: 'The printer was still getting ready', recoverable: false },
  };
}

/** A queued drawer pulse that an earlier-sent one already served (runJob). */
const ALREADY_OPENED = Symbol('already opened');
const ALREADY_OPENED_NOTE = 'Not sent: the drawer was opened after this sale by another pulse';

/**
 * Wait for the printer to get ready (e.g. a USB print worker starting up),
 * at most `ms`. False only when it is still not ready by then; a printer that
 * failed to start counts as ready, so the send reports the real reason.
 */
async function readyWithin(adapter: PrinterAdapter, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      adapter.connect().then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Whether two setups are the same printer. The drawer pin and pulse are left
 * out: they only change the bytes of a pulse, which are made from the saved
 * setting each time.
 */
function adapterKey(config: PrinterConnectionConfig): string {
  const { drawer: _drawer, ...printer } = config;
  return JSON.stringify(printer);
}

/**
 * Tell every till window the drawer did not open (warning toast "use the
 * key"), or — `unsure` — that it may or may not have opened.
 */
export function notifyDrawerNotOpened(
  orderId: string | null | undefined,
  message: string,
  unsure = false,
): void {
  log.warn('Cash drawer did not open', { orderId, unsure, message });
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send('printer:failed', {
      jobKind: 'drawer',
      orderId: orderId ?? undefined,
      retrying: false,
      error: { code: unsure ? DRAWER_UNSURE_CODE : DRAWER_NOT_OPENED_CODE, message },
    });
  }
}

/**
 * What failed, in the note's words: "Receipt for Order #0041", "Kitchen
 * ticket for Order #0042", "Refund slip for Order #0031". Two failures with
 * the same printer error must never look like one note — each has its own
 * "Try again", the only way to still get the till's ORIGINAL paper. Never
 * throws (a note without the order is better than none).
 */
export function failedPaperWords(db: AppDatabase, job: PrintJobRow): string | null {
  const p = job.payload;
  try {
    const snap = job.orderId ? getOrderSnapshot(db, job.orderId, { includeDeleted: true }) : null;
    const order = snap ? ` for ${orderLabel(snap)}` : '';
    let paper: string;
    if (p.kind === 'kitchen') paper = p.cancelled === true ? 'Kitchen CANCELLED slip' : p.change ? 'Kitchen CHANGE slip' : 'Kitchen ticket';
    else if (p.kind === 'drawer') paper = 'Cash drawer';
    else if (p.reason === 'refund') paper = 'Refund slip';
    else if (!snap) paper = 'Receipt';
    else {
      const doc = receiptDocumentFor(snap);
      paper = doc === 'bill' ? 'Bill' : doc === 'void' ? 'Cancelled-order slip' : 'Receipt';
    }
    if (p.kind === 'receipt' && p.reason === MANUAL_REASON) paper = `${paper} copy`;
    return `${paper}${order}`;
  } catch {
    return null;
  }
}

function notifyPrintFailure(
  job: PrintJobRow,
  error?: { code: string; message: string },
  retrying = false,
  what: string | null = null,
): void {
  if (!retrying) {
    log.error('Print job failed permanently', {
      jobId: job.id,
      jobKind: job.jobKind,
      orderId: job.orderId,
      attempts: job.attempts + 1,
      error,
    });
  }
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send('printer:failed', {
      // "Try again" on the note sends this very job again (printer:retryJob).
      jobId: job.id,
      jobKind: job.jobKind,
      orderId: job.orderId ?? undefined,
      // Which paper of which order ("Receipt for Order #0041"): notes about
      // two orders never look like one.
      ...(what ? { what } : {}),
      error,
      retrying,
    });
  }
}

export const printSpooler = new PrintSpooler();
