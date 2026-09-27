/**
 * What the till's main process and the Reports worker thread say to each
 * other (costing spec Phase 3). Types and constants only: both sides load it.
 */
import type { BusinessReportRequest, ReportTab } from '@cheeseoclock/shared-types';
import type { OwnerWeekJob } from './owner-week.js';
import type { TrendsJob } from './trends.js';

/**
 * What the worker works out besides the six tabs (costing spec Phase 7):
 * Reports → Overview's trend strip and 12 months, and the owner's week
 * (the Dashboard card and the weekly sheet).
 */
export const EXTRA_ANALYTICS = ['trends', 'ownerWeek'] as const;
export type ExtraAnalytics = (typeof EXTRA_ANALYTICS)[number];

/** Everything the worker is asked for: a tab, or one of the extras. */
export type AnalyticsKind = ReportTab | ExtraAnalytics;

/** What each kind is asked with. */
export type AnalyticsRequest<K extends AnalyticsKind> = K extends ReportTab
  ? BusinessReportRequest
  : K extends 'trends'
    ? TrendsJob
    : K extends 'ownerWeek'
      ? OwnerWeekJob
      : never;

/**
 * The worker's file, next to the main bundle (out/main). electron.vite.config.ts
 * builds it under this name; electron-builder.yml unpacks it from app.asar.
 * `.cjs`: CommonJS whatever package.json says, since the unpacked copy has
 * no package.json beside it.
 */
export const WORKER_FILE = 'analytics-worker.cjs';

/** Marks workerData as ours, so importing worker.ts anywhere else never starts a worker. */
export const WORKER_TAG = 'coc-analytics-worker';

export interface AnalyticsWorkerData {
  tag: typeof WORKER_TAG;
  /** The till's database file, the same one the main process has open. */
  dbPath: string;
  /** 'better-sqlite3' in the till; 'node:sqlite' only for the bench under plain Node. */
  driver: 'better-sqlite3' | 'node:sqlite';
  /**
   * better-sqlite3's entry file, as the main process resolved it (in an
   * installed till: its copy in app.asar.unpacked). Null: load it by name.
   */
  betterSqlite3Path?: string | null;
  /** Its compiled .node file, so the worker never has to search for it. Null: let it search. */
  nativeBinding?: string | null;
}

/** Work out one tab (or extra). `id` pairs the answer with the question. */
export interface RunRequest {
  type: 'run';
  id: number;
  kind: AnalyticsKind;
  /** AnalyticsRequest<kind>: the period for a tab, the job for an extra. */
  request: unknown;
  /** The main process's clock (which orders count as "still open from earlier days"). */
  nowIso: string;
}

/**
 * The till is closing: close the read connection, then end the thread. Sent
 * before the main process closes its own connection, so the main one is the
 * last to close and folds the write-ahead log into the file (a read-only
 * connection left open would stop that; worker-client.ts `stop`).
 */
export interface CloseRequest {
  type: 'close';
}

/** Everything the main process sends the worker. */
export type WorkerRequest = RunRequest | CloseRequest;

export type WorkerReply =
  /** The connection is open and the tables are there: send work. */
  | { type: 'ready'; journalMode: string; ms: number }
  /** It could not open the database (or load SQLite): the main process falls back. */
  | { type: 'startFailed'; reason: string }
  | { type: 'result'; id: number; ok: true; data: unknown; ms: number }
  | { type: 'result'; id: number; ok: false; message: string; ms: number };

export function isWorkerData(x: unknown): x is AnalyticsWorkerData {
  return typeof x === 'object' && x !== null && (x as { tag?: unknown }).tag === WORKER_TAG;
}
