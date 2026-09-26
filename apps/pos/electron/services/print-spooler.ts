import log from 'electron-log/main';
import { BrowserWindow } from 'electron';
import type { AppDatabase } from '../db/connection.js';
import {
  renderDrawerKick,
  renderKitchenTicket,
  renderReceipt,
  type MonoRaster,
  type PrinterAdapter,
  type PrintResult,
  type TestPageOptions,
} from '@cheeseoclock/printer-core';
import {
  DRAWER_NOT_OPENED_CODE,
  DRAWER_TOO_LATE_CODE,
  DRAWER_UNSURE_CODE,
  type DrawerSettings,
  type OrderSnapshot,
  type PrinterConnectionConfig,
  type PrintPolicy,
  type ReceiptCopy,
} from '@cheeseoclock/shared-types';
import { makePrinterAdapter } from '../adapters/printer/factory.js';
import {
  DEFAULT_RECEIPT_CONFIG,
  getKitchenPrinterConfig,
  getPrintPolicy,
  getReceiptBranding,
  getReceiptLogo,
  getReceiptPrinterConfig,
  markReceiptLogoChecked,
  receiptLogoToPrint,
} from './printer-config.js';
import { logoTestOptions } from './receipt-logo.js';
import { getOrderSnapshot } from '../db/repositories/order-repo.js';
import { getFbrRowByOrder } from '../db/repositories/fbr-queue-repo.js';
import {
  claimNextPendingJob,
  deferJob,
  enqueuePrintJob,
  hasPrintJob,
  markJobDone,
  markJobFailedPermanently,
  recoverStuckInFlight,
  rescheduleJob,
  type PrintJobPayload,
  type PrintJobRow,
  type ReceiptJobReason,
} from '../db/repositories/print-queue-repo.js';

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
  /** A rider was assigned: the food is leaving. */
  | 'dispatched'
  | 'refunded';

type Station = 'receipt' | 'kitchen';

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
/** kickDrawerNow's answer when the printer did not get ready in time: nothing was sent. */
export const PRINTER_STARTING_CODE = 'printer_starting';
// How long a payment receipt waits for the FBR invoice number before printing
// with the "pending" placeholder, counted from when the sale queued it.
const FBR_IRN_GRACE_MS = 4_000;
// While it waits, the receipt steps aside this long at a time so the jobs
// behind it (the next sale's drawer, a kitchen ticket) are not held up.
const FBR_RECHECK_MS = 250;

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

  init(db: AppDatabase): void {
    this.db = db;
    this.drawerPulsedAt = 0;
    // Recover any jobs that were mid-flight when the app last died.
    const recovered = recoverStuckInFlight(db);
    if (recovered > 0) {
      log.info('Print spooler: recovered stuck in-flight jobs', { recovered });
    }
    // Periodic tick — picks up jobs whose next_attempt_at has come due.
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = setInterval(() => void this.drain(), TICK_INTERVAL_MS);
    this.warmUp();
    // Drain immediately on boot in case there are pending jobs already due.
    void this.drain();
  }

  /**
   * The one place that turns an order event into paper. `cash` says whether
   * cash just changed hands (the drawer opens for cash, never for card or
   * wallet payments).
   */
  onOrderEvent(orderId: string, event: OrderPrintEvent, detail: { cash?: boolean } = {}): void {
    if (!this.db) {
      log.warn('PrintSpooler not initialized; nothing printed', { orderId, event });
      return;
    }
    const db = this.db;
    const snap = getOrderSnapshot(db, orderId);
    if (!snap) return;
    const policy = getPrintPolicy(db);
    const delivery = snap.order.mode === 'delivery';
    const cash = detail.cash === true;
    const copies: ReceiptCopy[] =
      policy.shopCopy === 'always' || (policy.shopCopy === 'delivery' && delivery)
        ? ['customer', 'shop']
        : ['customer'];
    // Receipts never carry the drawer pulse: it goes as its own job, first.
    const receipt = (reason: ReceiptJobReason, c: ReceiptCopy[] = copies) =>
      this.enqueue({ kind: 'receipt', orderId, openDrawer: false, copies: c, reason });
    // Cash changed hands: open the drawer now, ahead of any paper. Once per event.
    const drawer = () => {
      if (cash) this.enqueue({ kind: 'drawer', orderId });
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
        // Once per order — re-assigning a rider must not print a second bill.
        if (
          delivery &&
          policy.deliveryBillOnDispatch &&
          !hasPrintJob(db, orderId, 'receipt', 'dispatch')
        ) {
          receipt('dispatch');
        }
        break;

      case 'payment_captured':
        drawer();
        // The customer already holds the bill that left with the food when
        // the rider brings the money back: then the drawer is all.
        if (!hasPrintJob(db, orderId, 'receipt', 'dispatch')) receipt('payment');
        break;

      case 'refunded':
        drawer();
        receipt('refund', ['customer']);
        break;
    }
  }

  /** Manual reprint of the customer receipt (history, board, receipt dialog). */
  reprintReceipt(orderId: string): void {
    if (!this.db) return;
    // A draft has no bill. Printing one would hand the customer a "TO PAY"
    // slip for an order that can still be discarded without a trace.
    const snap = getOrderSnapshot(this.db, orderId);
    if (!snap) throw new Error('Order not found');
    if (snap.order.status === 'open') {
      throw new Error('This order has not been sent or paid yet — there is no bill to reprint');
    }
    this.enqueue({ kind: 'receipt', orderId, openDrawer: false, copies: ['customer'], reason: 'reprint' });
  }

  /** Manual reprint of the kitchen ticket — stamped REPRINT. */
  reprintKitchenTicket(orderId: string): void {
    this.enqueue({ kind: 'kitchen', orderId, reprint: true });
  }

  /**
   * Pulse the cash drawer right now, straight through the receipt printer:
   * no order, no queue, one attempt. For the Open drawer and Test drawer
   * buttons and drawer cash in / out. If the printer can't take it within
   * MANUAL_KICK_MAX_WAIT_MS it is not sent at all (DRAWER_TOO_LATE_CODE).
   * `watched`: someone is looking at "Opening…", so a printer that is still
   * starting up first gets MANUAL_KICK_READY_MAX_MS to get ready.
   */
  async kickDrawerNow(opts: { watched?: boolean } = {}): Promise<PrintResult> {
    if (!this.db) {
      return {
        ok: false,
        durationMs: 0,
        error: { code: 'not_ready', message: 'Spooler not initialized', recoverable: false },
      };
    }
    const pressedAt = Date.now();
    let notAfter = pressedAt + MANUAL_KICK_MAX_WAIT_MS;
    try {
      const result = await this.exclusive(async (): Promise<PrintResult> => {
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
      return result;
    } catch (e) {
      return {
        ok: false,
        durationMs: Date.now() - pressedAt,
        error: {
          code: 'spooler_exception',
          message: e instanceof Error ? e.message : String(e),
          recoverable: false,
        },
      };
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

  /** kickDrawerNow without waiting: a failure reaches the till as a warning toast. */
  kickDrawerSoon(): void {
    void this.kickDrawerNow()
      .then((r) => {
        if (!r.ok) notifyDrawerNotOpened(undefined, drawerFailureText(r.error), r.error?.maybeSent === true);
      })
      .catch((e: unknown) => log.warn('Could not report the cash drawer', e));
  }

  /** One kitchen ticket per order, when the policy wants one. */
  private kitchenTicket(snap: OrderSnapshot, policy: PrintPolicy): void {
    if (!policy.kitchenTicket || !this.db) return;
    if (hasPrintJob(this.db, snap.order.id, 'kitchen')) return;
    this.enqueue({ kind: 'kitchen', orderId: snap.order.id, reprint: false });
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
        // Only the receipt printer's page shows the logo; a kitchen test (even
        // one that falls back to the receipt printer) never does.
        if (station !== 'receipt') return adapter.testPrint();
        const logoTest = this.logoTest(adapter);
        const result = await adapter.testPrint(logoTest.options);
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
    const queuedAt = Date.parse(job.createdAt);
    const deadline = queuedAt + DRAWER_KICK_MAX_AGE_MS;
    const served = () => {
      log.info('Cash drawer already opened since this sale; pulse not sent again', {
        jobId: job.id,
        orderId: job.orderId,
      });
      markJobDone(db, job.id, ALREADY_OPENED_NOTE);
    };
    let result: PrintResult | typeof ALREADY_OPENED;
    try {
      const snap = getOrderSnapshot(db, job.payload.orderId);
      if (!snap) {
        markJobFailedPermanently(db, job.id, 'Order no longer exists');
        notifyPrintFailure(job, {
          code: 'order_missing',
          message: 'Order no longer exists',
        });
        return;
      }
      if (isDrawer && this.drawerOpenedSince(queuedAt)) {
        served();
        return;
      }
      if (isDrawer && Date.now() > deadline) {
        log.info('Dropped a late cash-drawer pulse', { jobId: job.id, orderId: job.orderId });
        markJobFailedPermanently(db, job.id, 'Too late to open the drawer');
        notifyDrawerNotOpened(
          job.orderId,
          `${orderLabel(snap)}: the printer did not answer within a minute of the sale.`,
        );
        return;
      }
      if (this.waitingForFbr(job)) {
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
      result = await this.exclusive(async (): Promise<PrintResult | typeof ALREADY_OPENED> => {
        if (isDrawer) {
          // The lock may have kept a drawer pulse waiting — behind a slow
          // send, or an Open drawer that opened it meanwhile: check again.
          if (this.drawerOpenedSince(queuedAt)) return ALREADY_OPENED;
          if (Date.now() > deadline) return tooLate(queuedAt);
        }
        const { adapter, bytes } = this.render(toSend, snap);
        return isDrawer ? this.sendPulse(adapter, bytes, deadline) : adapter.send(bytes);
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
      markJobDone(db, job.id);
      return;
    }
    const attempts = job.attempts + 1;
    const backoff = BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length - 1)]!;
    if (isDrawer) {
      const err = result.error;
      const unsure = err?.maybeSent === true;
      if (unsure || !err?.recoverable || attempts >= MAX_ATTEMPTS || Date.now() + backoff > deadline) {
        // Never retried when it may have gone out (it would open twice), nor
        // when the retry would come too late to be any use.
        markJobFailedPermanently(db, job.id, err?.message ?? 'Unknown printer error');
        notifyDrawerNotOpened(job.orderId, drawerFailureText(err), unsure);
        return;
      }
    } else if (!result.error?.recoverable || attempts >= MAX_ATTEMPTS) {
      markJobFailedPermanently(
        db,
        job.id,
        result.error?.message ?? 'Unknown print error',
      );
      notifyPrintFailure(job, result.error);
      return;
    }
    rescheduleJob(db, job.id, result.error?.message ?? 'unknown', backoff);
    // Say so on the first miss, not after ~12 minutes of silent retries: the
    // kitchen is waiting on that ticket now (it keeps retrying on its own).
    if (attempts === 1) notifyPrintFailure(job, result.error, true);
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
   * period (counted from when the sale queued it) the receipt prints with the
   * "pending" placeholder instead. While waiting it steps aside (see runJob).
   */
  private waitingForFbr(job: PrintJobRow): boolean {
    if (!this.db || job.payload.kind !== 'receipt') return false;
    if (job.payload.reason !== 'payment' && job.payload.reason !== 'dispatch') return false;
    if (Date.now() >= Date.parse(job.createdAt) + FBR_IRN_GRACE_MS) return false;
    const row = getFbrRowByOrder(this.db, job.payload.orderId);
    return !!row && row.modeAtEnqueue !== 'noop' && row.status === 'pending';
  }

  /** Bytes for a job, and the printer they go to. */
  private render(
    payload: PrintJobPayload,
    snap: OrderSnapshot,
  ): { adapter: PrinterAdapter; bytes: Uint8Array } {
    if (!this.db) throw new Error('Spooler not initialized');
    switch (payload.kind) {
      case 'kitchen': {
        const adapter = this.getAdapter('kitchen');
        return {
          adapter,
          bytes: renderKitchenTicket(snap, {
            width: adapter.config.width ?? 48,
            reprint: payload.reprint,
          }),
        };
      }
      case 'drawer': {
        const adapter = this.getAdapter('receipt');
        return { adapter, bytes: renderDrawerKick(this.drawerSettings()) };
      }
      default: {
        const adapter = this.getAdapter('receipt');
        const width = adapter.config.width ?? 48;
        const branding = getReceiptBranding(this.db);
        // The logo, when there is a usable one and receipts are set to print it.
        const logo = receiptLogoToPrint(this.db, width, branding);
        // Embed FBR IRN/QR if the worker has resolved one by now. In `noop`
        // mode the adapter fabricates a NOOP-… number so the queue can be
        // exercised; that must never reach paper as a fiscal invoice.
        const fbrRow = getFbrRowByOrder(this.db, payload.orderId);
        const fbrBlock =
          fbrRow && fbrRow.status === 'sent' && fbrRow.irn && fbrRow.modeAtEnqueue !== 'noop'
            ? { irn: fbrRow.irn, qrPayload: fbrRow.qrPayload }
            : undefined;
        // All copies on one strip, one send. Never a drawer pulse: that is
        // its own job (see onOrderEvent).
        const renderAll = (withLogo: MonoRaster | null) =>
          payload.copies.map((copy) =>
            renderReceipt(snap, {
              width,
              branding,
              logo: withLogo,
              copy,
              openDrawer: false,
              cutPaper: true,
              ...(fbrBlock ? { fbr: fbrBlock } : {}),
            }),
          );
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
        return { adapter, bytes: concat(parts) };
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
 * Why the drawer did not open, in words for the counter. Never says "try
 * again" when the pulse may already have gone out.
 */
export function drawerFailureText(err?: PrintResult['error']): string {
  if (!err) return 'The printer did not take the drawer pulse.';
  if (err.maybeSent) {
    return 'The printer had a problem mid-way. Check the drawer: if it is shut, use the key. It may still open by itself when the printer is fixed.';
  }
  switch (err.code) {
    case DRAWER_TOO_LATE_CODE:
      return 'The printer was busy or slow for too long, so the till did not open the drawer late.';
    case PRINTER_STARTING_CODE:
      return 'The till is still getting the printer ready, so nothing was sent. Try again in a few seconds.';
    case 'printer_offline':
      return err.message
        ? `The printer is not ready. ${err.message}`
        : 'The printer is off, offline, out of paper or its lid is open.';
    case 'printer_not_sent':
      return `Windows did not take the drawer pulse. Check the printer is on and plugged in. (${err.message})`;
    case 'network_error':
    case 'timeout':
      return "The printer didn't answer. Check it is switched on and connected.";
    case 'no_config':
    case 'bad_printer_name':
      return 'No receipt printer is set up (Settings → Printers).';
    default:
      return err.message || 'The printer did not take the drawer pulse.';
  }
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

function notifyPrintFailure(
  job: PrintJobRow,
  error?: { code: string; message: string },
  retrying = false,
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
      jobKind: job.jobKind,
      orderId: job.orderId ?? undefined,
      error,
      retrying,
    });
  }
}

export const printSpooler = new PrintSpooler();
