import Database, { type Database as DBType, type Statement } from 'better-sqlite3';
import log from 'electron-log/main';

let db: DBType | null = null;

/**
 * Distinct SQL texts that keep a compiled statement. The repositories have a
 * few hundred fixed queries; the rest are `IN (?, ?, …)` lists whose length
 * varies. Least recently used ones are dropped past this.
 */
const STATEMENT_CACHE_SIZE = 500;

export function initDatabase(filePath: string): DBType {
  if (db) return db;
  db = new Database(filePath, { fileMustExist: false });
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  // 32 MB of page cache instead of SQLite's 2 MB default: the menu, today's
  // orders and the indexes the till reads all day stay decoded in memory
  // instead of being re-read from the OS on every call.
  db.pragma('cache_size = -32000');
  // Sorts and GROUP BYs (reports, history) in memory, not in temp files.
  db.pragma('temp_store = MEMORY');
  reuseCompiledStatements(db);
  log.info('SQLite opened', { filePath });
  return db;
}

/**
 * better-sqlite3 compiles the SQL again on every `db.prepare()` and keeps no
 * statement cache of its own, and the repositories call `db.prepare(...)`
 * inline for every query. Compiling was most of the cost of a read: one Live
 * Orders refresh (about eight statements per order) measured 9.6 ms for 40
 * orders compiling each time and 2.4 ms reusing compiled statements. Every
 * IPC call waits behind the main process, so this is paid on every tap.
 *
 * One rule for callers: a statement from `db.prepare()` is shared, so never
 * switch its mode for good (`.bind()`, `.safeIntegers()`). The output modes
 * (`.pluck()`, `.raw()`, `.expand()`) are reset each time it is handed out,
 * and a statement still open in `.iterate()` is never handed out twice: that
 * caller gets a private one.
 */
function reuseCompiledStatements(conn: DBType): void {
  const compile = conn.prepare.bind(conn) as (sql: string) => Statement<unknown[], unknown>;
  const cache = new Map<string, Statement<unknown[], unknown>>();
  const prepare = (sql: string): Statement<unknown[], unknown> => {
    const hit = cache.get(sql);
    if (hit) {
      if (hit.busy) return compile(sql);
      // Map order is the recency order: move to the back.
      cache.delete(sql);
      cache.set(sql, hit);
      if (hit.reader) hit.raw(false).pluck(false).expand(false);
      return hit;
    }
    const stmt = compile(sql);
    cache.set(sql, stmt);
    if (cache.size > STATEMENT_CACHE_SIZE) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    return stmt;
  };
  conn.prepare = prepare as DBType['prepare'];
}

export function getDatabase(): DBType {
  if (!db) throw new Error('Database not initialized — call initDatabase first');
  return db;
}

export function closeDatabase(): void {
  if (!db) return;
  try {
    db.close();
  } catch (err) {
    log.warn('Error closing database', err);
  }
  db = null;
}

export type AppDatabase = DBType;
