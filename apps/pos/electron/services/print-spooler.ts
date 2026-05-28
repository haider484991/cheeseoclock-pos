import log from 'electron-log/main';
import { BrowserWindow } from 'electron';
import type { AppDatabase } from '../db/connection.js';
import {
  renderReceipt,
  type PrinterAdapter,
  type PrintResult,
} from '@cheeseoclock/printer-core';
import { makePrinterAdapter } from '../adapters/printer/factory.js';
import {
  DEFAULT_RECEIPT_CONFIG,
  getReceiptBranding,
  getReceiptPrinterConfig,
} from './printer-config.js';
import { getOrderSnapshot } from '../db/repositories/order-repo.js';
import { getFbrRowByOrder } from '../db/repositories/fbr-queue-repo.js';
import {
  claimNextPendingJob,
  enqueueReceiptJob,
  markJobDone,
  markJobFailedPermanently,
  recoverStuckInFlight,
  rescheduleJob,
  type PrintJobRow,
} from '../db/repositories/print-queue-repo.js';

/**
 * Background print queue — now backed by `print_queue` in SQLite so a crash
 * between tender and print doesn't lose the receipt. The in-memory work loop
 * polls the DB; enqueueReceipt is a single INSERT + kick.
 *
 * **Print failure never blocks the sale.** The order is already saved when
 * a print job is enqueued.
 */

const MAX_ATTEMPTS = 5;
// Backoff schedule: ~immediate, 5s, 30s, 2m, 10m. Past MAX_ATTEMPTS we
// mark the job 'failed' and broadcast a toast.
const BACKOFF_MS = [0, 5_000, 30_000, 120_000, 600_000];
const TICK_INTERVAL_MS = 1_000;

class PrintSpooler {
  private db: AppDatabase | null = null;
  private running = false;
  private tickTimer: NodeJS.Timeout | null = null;
  private cachedAdapter: PrinterAdapter | null = null;
  private cachedAdapterConfigJson: string | null = null;

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

  enqueueReceipt(orderId: string, openDrawer = false): void {
    if (!this.db) {
      log.warn('PrintSpooler not initialized; dropping receipt job');
      return;
    }
    enqueueReceiptJob(this.db, { orderId, openDrawer });
    void this.drain();
  }

  /**
   * Synchronous test print for the settings page — bypasses the queue
   * entirely so the manager can see immediate success/failure.
   */
  async testPrintNow(): Promise<PrintResult> {
    if (!this.db) {
      return {
        ok: false,
        durationMs: 0,
        error: { code: 'not_ready', message: 'Spooler not initialized', recoverable: false },
      };
    }
    try {
      const adapter = this.getAdapter();
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

  private getAdapter(): PrinterAdapter {
    if (!this.db) throw new Error('Spooler not initialized');
    const config = getReceiptPrinterConfig(this.db) ?? DEFAULT_RECEIPT_CONFIG;
    const configKey = JSON.stringify(config);
    if (this.cachedAdapter && this.cachedAdapterConfigJson === configKey) {
      return this.cachedAdapter;
    }
    if (this.cachedAdapter) void this.cachedAdapter.disconnect();
    this.cachedAdapter = makePrinterAdapter(config);
    this.cachedAdapterConfigJson = configKey;
    return this.cachedAdapter;
  }

  /** Invalidate the cached adapter — called after config changes. */
  resetAdapter(): void {
    if (this.cachedAdapter) void this.cachedAdapter.disconnect();
    this.cachedAdapter = null;
    this.cachedAdapterConfigJson = null;
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
      const adapter = this.getAdapter();
      const snap = getOrderSnapshot(this.db, job.payload.orderId);
      if (!snap) {
        markJobFailedPermanently(this.db, job.id, 'Order no longer exists');
        notifyPrintFailure(job, {
          code: 'order_missing',
          message: 'Order no longer exists',
        });
        return;
      }
      const branding = getReceiptBranding(this.db);
      // Embed FBR IRN/QR if the worker has resolved one by now.
      const fbrRow = getFbrRowByOrder(this.db, job.payload.orderId);
      const fbrBlock =
        fbrRow && fbrRow.status === 'sent' && fbrRow.irn
          ? { irn: fbrRow.irn, qrPayload: fbrRow.qrPayload }
          : undefined;
      const bytes = renderReceipt(snap, {
        width: adapter.config.width ?? 48,
        branding,
        openDrawer: job.payload.openDrawer,
        cutPaper: true,
        ...(fbrBlock ? { fbr: fbrBlock } : {}),
      });
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
}

function notifyPrintFailure(
  job: PrintJobRow,
  error?: { code: string; message: string },
): void {
  log.error('Print job failed permanently', {
    jobId: job.id,
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
