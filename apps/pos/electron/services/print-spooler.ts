import log from 'electron-log/main';
import { BrowserWindow } from 'electron';
import type { AppDatabase } from '../db/connection.js';
import {
  renderReceipt,
  type PrinterAdapter,
  type PrintResult,
} from '@cheeseoclock/printer-core';
import type { OrderSnapshot } from '@cheeseoclock/shared-types';
import { makePrinterAdapter } from '../adapters/printer/factory.js';
import {
  DEFAULT_RECEIPT_CONFIG,
  getReceiptBranding,
  getReceiptPrinterConfig,
} from './printer-config.js';
import { getOrderSnapshot } from '../db/repositories/order-repo.js';
import { getFbrRowByOrder } from '../db/repositories/fbr-queue-repo.js';

/**
 * Background print queue. Adding a job is fire-and-forget — the spooler runs
 * jobs serially per device (single physical printer, single thread), retries
 * recoverable failures with backoff, and tells the UI about final failures.
 *
 * **Print failure never blocks the sale.** The order is already saved when a
 * print job is enqueued.
 */

interface ReceiptJob {
  kind: 'receipt';
  orderId: string;
  attempts: number;
  enqueuedAt: number;
  openDrawer: boolean;
}
interface BytesJob {
  kind: 'bytes';
  bytes: Uint8Array;
  attempts: number;
  enqueuedAt: number;
  label: string;
}
type Job = ReceiptJob | BytesJob;

const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [500, 2_000, 5_000];

class PrintSpooler {
  private db: AppDatabase | null = null;
  private queue: Job[] = [];
  private running = false;
  private cachedAdapter: PrinterAdapter | null = null;
  private cachedAdapterConfigJson: string | null = null;

  init(db: AppDatabase): void {
    this.db = db;
  }

  enqueueReceipt(orderId: string, openDrawer = false): void {
    if (!this.db) {
      log.warn('PrintSpooler not initialized; dropping receipt job');
      return;
    }
    this.queue.push({
      kind: 'receipt',
      orderId,
      attempts: 0,
      enqueuedAt: Date.now(),
      openDrawer,
    });
    void this.drain();
  }

  enqueueBytes(bytes: Uint8Array, label = 'test'): void {
    this.queue.push({
      kind: 'bytes',
      bytes,
      attempts: 0,
      enqueuedAt: Date.now(),
      label,
    });
    void this.drain();
  }

  /** Synchronous test print for the settings page — returns the result. */
  async testPrintNow(): Promise<PrintResult> {
    if (!this.db) {
      return {
        ok: false,
        durationMs: 0,
        error: { code: 'not_ready', message: 'Spooler not initialized', recoverable: false },
      };
    }
    const adapter = this.getAdapter();
    return adapter.testPrint();
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
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length > 0) {
        const job = this.queue[0]!;
        const result = await this.runJob(job);
        if (result.ok) {
          this.queue.shift();
          continue;
        }
        if (!result.error?.recoverable || job.attempts >= MAX_ATTEMPTS) {
          this.queue.shift();
          notifyPrintFailure(job, result);
          continue;
        }
        // Retry after backoff
        job.attempts += 1;
        const wait = BACKOFF_MS[Math.min(job.attempts - 1, BACKOFF_MS.length - 1)]!;
        log.warn('Print job will retry', {
          attempts: job.attempts,
          inMs: wait,
          error: result.error.message,
        });
        await new Promise((r) => setTimeout(r, wait));
      }
    } finally {
      this.running = false;
    }
  }

  private async runJob(job: Job): Promise<PrintResult> {
    if (!this.db) {
      return {
        ok: false,
        durationMs: 0,
        error: { code: 'not_ready', message: 'No DB', recoverable: false },
      };
    }
    try {
      const adapter = this.getAdapter();
      if (job.kind === 'receipt') {
        const snap = getOrderSnapshot(this.db, job.orderId);
        if (!snap) {
          return {
            ok: false,
            durationMs: 0,
            error: { code: 'order_missing', message: 'Order vanished', recoverable: false },
          };
        }
        const branding = getReceiptBranding(this.db);
        // If the FBR worker has already resolved an IRN for this order, embed it on the printed
        // receipt. Otherwise the receipt prints with the "pending" placeholder.
        const fbrRow = getFbrRowByOrder(this.db, job.orderId);
        const fbrBlock =
          fbrRow && fbrRow.status === 'sent' && fbrRow.irn
            ? { irn: fbrRow.irn, qrPayload: fbrRow.qrPayload }
            : undefined;
        const bytes = renderReceipt(snap, {
          width: adapter.config.width ?? 48,
          branding,
          openDrawer: job.openDrawer,
          cutPaper: true,
          ...(fbrBlock ? { fbr: fbrBlock } : {}),
        });
        return adapter.send(bytes);
      }
      return adapter.send(job.bytes);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return {
        ok: false,
        durationMs: 0,
        error: {
          code: 'spooler_exception',
          message,
          // Adapter selection errors (unsupported transport, bad config) are not recoverable.
          recoverable: false,
        },
      };
    }
  }
}

function notifyPrintFailure(job: Job, result: PrintResult): void {
  log.error('Print job failed permanently', {
    job: job.kind === 'receipt' ? `receipt:${job.orderId}` : `bytes:${job.label}`,
    attempts: job.attempts,
    error: result.error,
  });
  // Push a toast to every open renderer window. Renderer listens for 'printer:failed'.
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send('printer:failed', {
      jobKind: job.kind,
      orderId: job.kind === 'receipt' ? job.orderId : undefined,
      error: result.error,
    });
  }
}

export const printSpooler = new PrintSpooler();
