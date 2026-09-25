import { sql } from './db';

/**
 * Columns added to web_orders for pickup orders. Created on demand as well as
 * in db/schema.sql (the store_status pattern), so the live database picks
 * them up on the first request after a deploy without anyone re-running
 * db:init. Every route that reads or writes these columns awaits this first.
 */
let ready: Promise<void> | null = null;

export function ensureWebOrderColumns(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      await sql()`
        ALTER TABLE web_orders ADD COLUMN IF NOT EXISTS fulfilment TEXT NOT NULL DEFAULT 'delivery'
      `;
      await sql()`
        ALTER TABLE web_orders ADD COLUMN IF NOT EXISTS discount_cents INT NOT NULL DEFAULT 0
      `;
      // Which till is importing a 'new' order (api/bridge/orders GET), so two
      // tills polling at once don't both cook it.
      await sql()`
        ALTER TABLE web_orders ADD COLUMN IF NOT EXISTS claimed_by TEXT
      `;
      await sql()`
        ALTER TABLE web_orders ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ
      `;
    })().catch((e) => {
      // Let the next call retry rather than caching the failure forever.
      ready = null;
      throw e;
    });
  }
  return ready;
}
