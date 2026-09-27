/**
 * Starts and ends the Reports worker thread in the till (costing spec
 * Phase 3). The rules for talking to it are in worker-client.ts; this only
 * finds the files and makes the thread.
 *
 * The log says which way Reports run, once, at start:
 *   "analytics worker ready"                                   — in the worker;
 *   "analytics worker failed, using main-thread fallback: …"   — on the main
 *     process, periods of 31 days or less (the page shows a note).
 * Before either, "analytics worker starting" names the files it uses. Start
 * the till with COC_ANALYTICS_WORKER=off to see the fallback on purpose.
 */
import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import log from 'electron-log/main';
import { AnalyticsWorkerClient, resolveWorkerPaths } from './worker-client.js';
import { WORKER_TAG, type AnalyticsWorkerData } from './worker-protocol.js';

let client: AnalyticsWorkerClient | null = null;

/** Start the worker on the till's database file (after migrations: it reads the current tables). */
export function startAnalyticsWorker(dbPath: string): AnalyticsWorkerClient {
  if (client) return client;
  // This file is bundled into out/main/index.js, so this is out/main (in an
  // installed till, resources/app.asar/out/main).
  const mainDir = path.dirname(fileURLToPath(import.meta.url));
  const load = createRequire(import.meta.url);
  const paths = resolveWorkerPaths({ mainDir, exists: (p) => fs.existsSync(p), resolveModule: (id) => load.resolve(id) });
  log.info('analytics worker starting', paths);
  const data: AnalyticsWorkerData = {
    tag: WORKER_TAG,
    dbPath,
    driver: 'better-sqlite3',
    betterSqlite3Path: paths.betterSqlite3,
    nativeBinding: paths.nativeBinding,
  };
  // COC_ANALYTICS_WORKER=off: try the main-thread fallback on purpose (the
  // banner, the 31-day limit) without taking the worker out of the install.
  const off = process.env['COC_ANALYTICS_WORKER'] === 'off';
  client = new AnalyticsWorkerClient({
    spawn: () => {
      if (off) throw new Error('turned off with COC_ANALYTICS_WORKER=off');
      const w = new Worker(paths.script, { workerData: data, name: 'coc-analytics' });
      // Never what keeps the till's process alive on quit.
      w.unref();
      return w;
    },
    log: {
      info: (message, meta) => (meta ? log.info(message, meta) : log.info(message)),
      warn: (message, meta) => (meta ? log.warn(message, meta) : log.warn(message)),
    },
  });
  client.start();
  return client;
}

/** The running worker's client, or null before start. */
export function getAnalyticsWorker(): AnalyticsWorkerClient | null {
  return client;
}

/**
 * The till is closing (quit, or a restore restart): the worker closes its
 * read connection and the thread ends (a couple of seconds at most). Await it
 * BEFORE closeDatabase(): the till's connection must be the last one open to
 * fold the write-ahead log into cheeseoclock.sqlite. Never rejects.
 */
export function stopAnalyticsWorker(): Promise<void> {
  return client ? client.stop() : Promise.resolve();
}
