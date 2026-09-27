/**
 * The Reports worker thread (costing spec Phase 3).
 *
 * A year of Reports used to be worked out on the till's main process, which
 * also answers every tap at the counter: a long report stalled the till for
 * a second or two. The tabs are now worked out here, in a worker_threads
 * worker with its OWN read connection to the same database file:
 *  - read-only (and PRAGMA query_only), so nothing here can ever write;
 *  - WAL (the till's journal mode), so reading never blocks the till's
 *    writes and the till's writes never block reading;
 *  - busy_timeout as on the main connection, the same page cache and
 *    in-memory sorts, and the same compiled-statement cache.
 * The main process keeps the rules (who may see which tab, and costs) and
 * sends one tab at a time (worker-client.ts).
 *
 * Built by electron.vite.config.ts into out/main/analytics-worker.cjs, with
 * everything bundled except SQLite: better-sqlite3 is loaded from the path
 * the main process found it at (in an installed till, its unpacked copy),
 * with its .node file named, so nothing has to be resolved from inside
 * app.asar. It must never load Electron (the build refuses it).
 */
import { createRequire } from 'node:module';
import { parentPort, workerData, type MessagePort } from 'node:worker_threads';
import type { AppDatabase } from '../../db/connection.js';
import { reuseCompiledStatements } from '../../db/statement-cache.js';
import { buildAnalytics, isAnalyticsKind } from './report-tabs.js';
import { warmOwnerWeek } from './owner-week.js';
import { DAY_MS } from './sql.js';
import { isWorkerData, type AnalyticsWorkerData, type RunRequest, type WorkerReply, type WorkerRequest } from './worker-protocol.js';

/** The same wait as the till's own connection (connection.ts) when the file is briefly locked. */
const BUSY_TIMEOUT_MS = 5000;

/** Work out one tab (or the trends, or the owner's week) and say how it went. Never throws: a failure is an answer. */
export function handleRunRequest(db: AppDatabase, msg: RunRequest): WorkerReply {
  const t0 = performance.now();
  try {
    if (!isAnalyticsKind(msg.kind)) throw new Error(`Unknown report tab: ${String(msg.kind)}`);
    const now = new Date(msg.nowIso);
    const data = buildAnalytics(db, msg.kind, msg.request, Number.isFinite(now.getTime()) ? now : new Date());
    return { type: 'result', id: msg.id, ok: true, data, ms: Math.round(performance.now() - t0) };
  } catch (e) {
    return { type: 'result', id: msg.id, ok: false, message: e instanceof Error ? e.message : String(e), ms: Math.round(performance.now() - t0) };
  }
}

interface ReadConnection {
  db: AppDatabase;
  journalMode: string;
  close: () => void;
}

/** The worker's own read connection to the till's database. */
export function openReadConnection(data: AnalyticsWorkerData): ReadConnection {
  const conn = data.driver === 'node:sqlite' ? openNodeSqlite(data.dbPath) : openBetterSqlite3(data);
  // The tables the tabs read must be there (the main process migrated them before starting us).
  conn.db.prepare(`SELECT COUNT(*) AS n FROM orders WHERE 0`).get();
  return conn;
}

function openBetterSqlite3(data: AnalyticsWorkerData): ReadConnection {
  const load = createRequire(import.meta.url);
  const Database = load(data.betterSqlite3Path ?? 'better-sqlite3') as typeof import('better-sqlite3');
  const db = new Database(data.dbPath, {
    readonly: true,
    fileMustExist: true,
    timeout: BUSY_TIMEOUT_MS,
    ...(data.nativeBinding ? { nativeBinding: data.nativeBinding } : {}),
  });
  db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
  db.pragma('query_only = ON');
  // As on the till's connection: 32 MB of page cache, sorts and GROUP BYs in memory.
  db.pragma('cache_size = -32000');
  db.pragma('temp_store = MEMORY');
  // WAL is a property of the file (the till set it); a read-only connection reports it.
  const journalMode = String(db.pragma('journal_mode', { simple: true }));
  reuseCompiledStatements(db);
  return { db, journalMode, close: () => db.close() };
}

interface NodeSqliteStatement {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): unknown;
}
interface NodeSqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): NodeSqliteStatement;
  close(): void;
}
type NodeSqliteCtor = new (path: string, options?: { readOnly?: boolean }) => NodeSqliteDatabase;

/**
 * Node's own SQLite behind the shape the builders use (prepare, exec,
 * transaction), for the bench: better-sqlite3 in this repo is built for
 * Electron and does not load under plain Node. Never used by the till.
 */
function openNodeSqlite(dbPath: string): ReadConnection {
  const load = createRequire(import.meta.url);
  const { DatabaseSync } = load(['node', 'sqlite'].join(':')) as { DatabaseSync: NodeSqliteCtor };
  const raw = new DatabaseSync(dbPath, { readOnly: true });
  raw.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  raw.exec('PRAGMA query_only = ON');
  raw.exec('PRAGMA cache_size = -32000');
  raw.exec('PRAGMA temp_store = MEMORY');
  const mode = raw.prepare('PRAGMA journal_mode').get() as { journal_mode?: string } | undefined;
  const statements = new Map<string, NodeSqliteStatement>();
  const db = {
    exec: (sql: string) => raw.exec(sql),
    prepare: (sql: string) => {
      let s = statements.get(sql);
      if (!s) statements.set(sql, (s = raw.prepare(sql)));
      return s;
    },
    transaction:
      <A extends unknown[], R>(fn: (...a: A) => R) =>
      (...a: A): R => {
        raw.exec('BEGIN');
        try {
          const out = fn(...a);
          raw.exec('COMMIT');
          return out;
        } catch (e) {
          raw.exec('ROLLBACK');
          throw e;
        }
      },
  };
  return { db: db as unknown as AppDatabase, journalMode: String(mode?.journal_mode ?? 'unknown'), close: () => raw.close() };
}

/**
 * The thread's life: open the connection, say ready (or why not), then answer
 * one tab at a time until told to close. Exported for the tests, which drive
 * it over a MessageChannel with node:sqlite.
 */
export function serve(port: MessagePort, data: AnalyticsWorkerData): void {
  const t0 = performance.now();
  let conn: ReadConnection;
  try {
    conn = openReadConnection(data);
  } catch (e) {
    // The main process falls back to working reports out itself (a month at most) and ends this thread.
    port.postMessage({ type: 'startFailed', reason: e instanceof Error ? e.message : String(e) } satisfies WorkerReply);
    return;
  }
  let closed = false;
  // The Dashboard card's "Do this" reads four weeks of order lines once a trading day (owner-week.ts): read
  // them as the worker starts and again just after each trading day begins (05:00 Pakistan time = 00:00 UTC),
  // between asks, so the first tap of the day does not wait for them. Never keeps the thread alive.
  let warmTimer: ReturnType<typeof setTimeout> | null = null;
  const warm = () => {
    if (closed) return;
    try {
      warmOwnerWeek(conn.db, new Date());
    } catch {
      // The card reads them itself when it is asked.
    }
    const now = Date.now();
    warmTimer = setTimeout(warm, (Math.floor(now / DAY_MS) + 1) * DAY_MS + 1_000 - now);
    warmTimer.unref?.();
  };
  port.on('message', (msg: WorkerRequest) => {
    if (closed) return;
    if (msg?.type === 'close') {
      // The till is closing. Close the read connection first: the till's own
      // connection must be the last one open, or it cannot fold the
      // write-ahead log back into the file when it closes. Closing the port
      // then lets the thread end.
      closed = true;
      if (warmTimer) clearTimeout(warmTimer);
      try {
        conn.close();
      } catch {
        // Nothing more to do: the thread ends either way.
      }
      port.close();
      return;
    }
    if (msg?.type !== 'run') return;
    port.postMessage(handleRunRequest(conn.db, msg));
  });
  port.postMessage({ type: 'ready', journalMode: conn.journalMode, ms: Math.round(performance.now() - t0) } satisfies WorkerReply);
  warmTimer = setTimeout(warm, 0);
  warmTimer.unref?.();
}

if (parentPort && isWorkerData(workerData)) serve(parentPort, workerData);
