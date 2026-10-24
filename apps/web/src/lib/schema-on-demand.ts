/**
 * The tables and columns the website creates on demand (store_status,
 * web_orders' later columns, order_rate_events…) are there on the live
 * database long since. Each new server instance used to run every
 * `CREATE TABLE IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS` one after another
 * before its first read — five or more sequential Neon round trips on the
 * first /menu, store-status or checkout request it served (24 Oct 2026: "the
 * website's API is so slow"), each ALTER also taking the table's lock.
 *
 * Now the read (or a one-row probe) goes first, and the DDL runs only when
 * Postgres says the table or column is missing.
 */

/** Postgres: undefined_table, undefined_column. */
const MISSING_SCHEMA_CODES = new Set(['42P01', '42703']);

/** Is this the error of a statement that named a table or column the database does not have (yet)? */
export function isMissingSchema(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false;
  const code = (e as { code?: unknown }).code;
  if (typeof code === 'string') return MISSING_SCHEMA_CODES.has(code);
  // A driver that gives no SQLSTATE: Postgres's own words.
  const message = (e as { message?: unknown }).message;
  return typeof message === 'string' && /\b(relation|column) "[^"]+" (of relation "[^"]+" )?does not exist\b/.test(message);
}

/** `run`; if the database lacks what it names, `ensure` the schema once and `run` again. */
export async function withSchema<T>(ensure: () => Promise<void>, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (!isMissingSchema(e)) throw e;
    await ensure();
    return run();
  }
}

/**
 * An ensure function's body: `probe` (one cheap read of the newest table or
 * column, e.g. `SELECT x FROM t LIMIT 0`) first, and `create` only when the
 * probe finds it missing — one round trip per instance instead of one per
 * statement.
 */
export async function probeThenCreate(probe: () => Promise<unknown>, create: () => Promise<void>): Promise<void> {
  try {
    await probe();
  } catch (e) {
    if (!isMissingSchema(e)) throw e;
    await create();
  }
}
