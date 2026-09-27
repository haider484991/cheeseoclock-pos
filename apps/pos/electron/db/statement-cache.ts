/**
 * The compiled-statement cache every better-sqlite3 connection of the till
 * uses: the main connection (connection.ts) and the Reports worker's own
 * read connection (services/analytics/worker.ts). No Electron here, so the
 * worker thread can load it.
 */
import type { Database as DBType, Statement } from 'better-sqlite3';

/**
 * Distinct SQL texts that keep a compiled statement. The repositories have a
 * few hundred fixed queries; the rest are `IN (?, ?, …)` lists whose length
 * varies. Least recently used ones are dropped past this.
 */
const STATEMENT_CACHE_SIZE = 500;

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
export function reuseCompiledStatements(conn: DBType): void {
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
