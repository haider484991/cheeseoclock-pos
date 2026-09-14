import log from 'electron-log/main';
import { BrowserWindow } from 'electron';
import type { AppDatabase } from '../db/connection.js';
import {
  renderDrawerKick,
  renderKitchenTicket,
  renderReceipt,
  type PrinterAdapter,
  type PrintResult,
} from '@cheeseoclock/printer-core';
import type { OrderSnapshot, PrintPolicy, ReceiptCopy } from '@cheeseoclock/shared-types';
import { makePrinterAdapter } from '../adapters/printer/factory.js';
import {
  DEFAULT_RECEIPT_CONFIG,
  getKitchenPrinterConfig,
  getPrintPolicy,
  getReceiptBranding,
  getReceiptPrinterConfig,
} from './printer-config.js';
import { getOrderSnapshot } from '../db/repositories/order-repo.js';
import { getFbrRowByOrder } from '../db/repositories/fbr-queue-repo.js';
import {
  claimNextPendingJob,
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

class PrintSpooler {
  private db: AppDatabase | null = null;
  private running = false;
  private tickTimer: NodeJS.Timeout | null = null;
  private readonly adapters = new Map<Station, { adapter: PrinterAdapter; key: string }>();

  init(db: AppDatabase): void {
    this.db = db;
    // Recover any jobs that were mid-flight when the app last died.
    const recovered = recoverStuckInFlight(db);
    if (recovered > 0) {
      log.info('Print spooler: recovered stuck in-flight jobs', { recovered });
    }
    // Periodic tick — picks up jobs whose next_attempt_at has come due.
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = setInterval(() => void this.drain(), TICK_INTERVAL_MS);
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
    const receipt = (reason: ReceiptJobReason, openDrawer: boolean, c: ReceiptCopy[] = copies) =>
      this.enqueue({ kind: 'receipt', orderId, openDrawer, copies: c, reason });

    switch (event) {
      case 'sent_to_kitchen':
        this.kitchenTicket(snap, policy);
        break;

      case 'paid':
        // Paid up front: the kitchen still has to cook it.
        this.kitchenTicket(snap, policy);
        if (delivery && policy.deliveryBillOnDispatch) {
          // The bill prints when the rider leaves, marked PAID. Just take the
          // cash in now.
          if (cash) this.enqueue({ kind: 'drawer', orderId });
        } else {
          receipt('payment', cash);
        }
        break;

      case 'dispatched':
        // Once per order — re-assigning a rider must not print a second bill.
        if (
          delivery &&
          policy.deliveryBillOnDispatch &&
          !hasPrintJob(db, orderId, 'receipt', 'dispatch')
        ) {
          receipt('dispatch', false);
        }
        break;

      case 'payment_captured':
        if (hasPrintJob(db, orderId, 'receipt', 'dispatch')) {
          // The customer already holds the bill that left with the food; the
          // rider is handing the money over. Drawer only.
          if (cash) this.enqueue({ kind: 'drawer', orderId });
        } else {
          receipt('payment', cash);
        }
        break;

      case 'refunded':
        receipt('refund', cash, ['customer']);
        break;
    }
  }

  /** Manual reprint of the customer receipt (history, board, receipt dialog). */
  reprintReceipt(orderId: string): void {
    this.enqueue({ kind: 'receipt', orderId, openDrawer: false, copies: ['customer'], reason: 'reprint' });
  }

  /** Manual reprint of the kitchen ticket — stamped REPRINT. */
  reprintKitchenTicket(orderId: string): void {
    this.enqueue({ kind: 'kitchen', orderId, reprint: true });
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
    try {
      const adapter = this.getAdapter(station);
      return await adapter.testPrint();
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
   * The adapter for a station. Kitchen tickets use the kitchen printer when
   * one is set up and otherwise share the receipt printer's adapter (one
   * connection, one queue, no interleaving).
   */
  private getAdapter(station: Station): PrinterAdapter {
    if (!this.db) throw new Error('Spooler not initialized');
    let config = getReceiptPrinterConfig(this.db) ?? DEFAULT_RECEIPT_CONFIG;
    if (station === 'kitchen') {
      const kitchen = getKitchenPrinterConfig(this.db);
      if (!kitchen) return this.getAdapter('receipt');
      config = kitchen;
    }
    const key = JSON.stringify(config);
    const cached = this.adapters.get(station);
    if (cached && cached.key === key) return cached.adapter;
    if (cached) void cached.adapter.disconnect();
    const adapter = makePrinterAdapter(config);
    this.adapters.set(station, { adapter, key });
    return adapter;
  }

  /** Invalidate the cached adapters — called after config changes. */
  resetAdapter(): void {
    for (const { adapter } of this.adapters.values()) void adapter.disconnect();
    this.adapters.clear();
  }

  private async drain(): Promise<void> {
    if (this.running || !this.db) return;
    this.running = true;
    try {
      // One claim per tick keeps things simple + serializes prints to a
      // single physical printer.
      while (true) {
        const job = claimNextPendingJob(this.db);
        if (!job) break;
        await this.runJob(job);
      }
    } finally {
      this.running = false;
    }
  }

  private async runJob(job: PrintJobRow): Promise<void> {
    if (!this.db) return;
    let result: PrintResult;
    try {
      const snap = getOrderSnapshot(this.db, job.payload.orderId);
      if (!snap) {
        markJobFailedPermanently(this.db, job.id, 'Order no longer exists');
        notifyPrintFailure(job, {
          code: 'order_missing',
          message: 'Order no longer exists',
        });
        return;
      }
      const { adapter, bytes } = this.render(job.payload, snap);
      result = await adapter.send(bytes);
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

    if (result.ok) {
      markJobDone(this.db, job.id);
      return;
    }
    const attempts = job.attempts + 1;
    if (!result.error?.recoverable || attempts >= MAX_ATTEMPTS) {
      markJobFailedPermanently(
        this.db,
        job.id,
        result.error?.message ?? 'Unknown print error',
      );
      notifyPrintFailure(job, result.error);
      return;
    }
    const backoff = BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length - 1)]!;
    rescheduleJob(this.db, job.id, result.error?.message ?? 'unknown', backoff);
    log.warn('Print job will retry', {
      jobId: job.id,
      attempts,
      inMs: backoff,
      error: result.error?.message,
    });
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
      case 'drawer':
        return { adapter: this.getAdapter('receipt'), bytes: renderDrawerKick() };
      default: {
        const adapter = this.getAdapter('receipt');
        const branding = getReceiptBranding(this.db);
        // Embed FBR IRN/QR if the worker has resolved one by now.
        const fbrRow = getFbrRowByOrder(this.db, payload.orderId);
        const fbrBlock =
          fbrRow && fbrRow.status === 'sent' && fbrRow.irn
            ? { irn: fbrRow.irn, qrPayload: fbrRow.qrPayload }
            : undefined;
        // All copies on one strip, one send: the drawer opens with the first.
        const parts = payload.copies.map((copy, i) =>
          renderReceipt(snap, {
            width: adapter.config.width ?? 48,
            branding,
            copy,
            openDrawer: payload.openDrawer && i === 0,
            cutPaper: true,
            ...(fbrBlock ? { fbr: fbrBlock } : {}),
          }),
        );
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

function notifyPrintFailure(
  job: PrintJobRow,
  error?: { code: string; message: string },
): void {
  log.error('Print job failed permanently', {
    jobId: job.id,
    jobKind: job.jobKind,
    orderId: job.orderId,
    attempts: job.attempts + 1,
    error,
  });
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send('printer:failed', {
      jobKind: job.jobKind,
      orderId: job.orderId ?? undefined,
      error,
    });
  }
}

export const printSpooler = new PrintSpooler();
