import log from 'electron-log/main';
import { BrowserWindow } from 'electron';
import type { AppDatabase } from '../db/connection.js';
import {
  claimNextPendingJob,
  markFbrFailed,
  markFbrSent,
} from '../db/repositories/fbr-queue-repo.js';
import { getFbrConfig, toAdapterConfig } from './fbr-config.js';
import { makeFbrAdapter } from '../adapters/fbr/factory.js';
import type { FbrAdapter, FbrInvoicePayload } from '@cheeseoclock/fbr-core';

/**
 * Polls fbr_submission_queue for pending rows and submits via the configured
 * adapter. Runs forever as long as the app is open. Idle when there's nothing
 * to submit (or when paused / no credentials).
 */
class FbrWorker {
  private db: AppDatabase | null = null;
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private cachedAdapter: FbrAdapter | null = null;
  private cachedAdapterKey: string | null = null;

  init(db: AppDatabase): void {
    this.db = db;
    this.scheduleNext(2_000);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Invalidate cached adapter — call after settings change. */
  resetAdapter(): void {
    this.cachedAdapter = null;
    this.cachedAdapterKey = null;
  }

  /** Wake immediately (used right after enqueue). */
  kick(): void {
    if (this.busy) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), 50);
  }

  private scheduleNext(ms: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), ms);
  }

  private async tick(): Promise<void> {
    if (!this.db || this.busy) {
      this.scheduleNext(10_000);
      return;
    }
    this.busy = true;
    try {
      const config = getFbrConfig(this.db);
      if (config.paused) {
        this.scheduleNext(15_000);
        return;
      }

      const job = claimNextPendingJob(this.db);
      if (!job) {
        this.scheduleNext(10_000);
        return;
      }

      const adapter = this.getAdapter();
      const payload = job.payload as FbrInvoicePayload;
      log.info('FBR submitting', { id: job.id, attempts: job.attempts, mode: config.mode });
      const result = await adapter.submitInvoice(payload);

      if (result.ok && result.irn) {
        markFbrSent(this.db, job.id, result.irn, result.qrPayload ?? null);
        broadcastQueueStatsChanged();
      } else {
        const err = result.error;
        const retryable = err?.retryable ?? false;
        const backoffMs = Math.min(60_000 * Math.pow(2, Math.max(0, job.attempts - 1)), 30 * 60_000);
        markFbrFailed(
          this.db,
          job.id,
          err?.message ?? 'unknown error',
          retryable && job.attempts < 6,
          backoffMs,
        );
        log.warn('FBR submission failed', {
          id: job.id,
          retryable,
          attempts: job.attempts,
          error: err?.message,
        });
        broadcastQueueStatsChanged();
      }

      // If there might be more work, poll again quickly. Otherwise back off.
      this.scheduleNext(500);
    } catch (e) {
      log.error('FBR worker exception', e);
      this.scheduleNext(30_000);
    } finally {
      this.busy = false;
    }
  }

  private getAdapter(): FbrAdapter {
    if (!this.db) throw new Error('Worker not initialized');
    const cfg = getFbrConfig(this.db);
    const key = JSON.stringify({
      mode: cfg.mode,
      endpoint: cfg.endpoint,
      bearerToken: cfg.bearerToken,
    });
    if (this.cachedAdapter && this.cachedAdapterKey === key) return this.cachedAdapter;
    this.cachedAdapter = makeFbrAdapter(toAdapterConfig(cfg));
    this.cachedAdapterKey = key;
    return this.cachedAdapter;
  }
}

function broadcastQueueStatsChanged(): void {
  for (const w of BrowserWindow.getAllWindows()) {
    w.webContents.send('fbr:queue-changed');
  }
}

export const fbrWorker = new FbrWorker();
