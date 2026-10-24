import { sql } from './db';
import { probeThenCreate } from './schema-on-demand';

/**
 * Columns added to web_orders for pickup orders. Created on demand as well as
 * in db/schema.sql (the store_status pattern), so the live database picks
 * them up on the first request after a deploy without anyone re-running
 * db:init. Every route that reads or writes these columns awaits this first.
 */
let ready: Promise<void> | null = null;

export function ensureWebOrderColumns(): Promise<void> {
  if (!ready) {
    // The newest column answers for the lot (schema-on-demand): one read per instance, the ALTERs only when it is missing.
    ready = probeThenCreate(() => sql()`SELECT discount_parts_json FROM web_orders LIMIT 0`, async () => {
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
      // v0.7.50 (WEBSITE DISCOUNT BY CATEGORY): the parts of an order's discount, when a category's own %
      // took something off (shared-types WebDiscountPart[] as JSON); NULL on every other order.
      await sql()`
        ALTER TABLE web_orders ADD COLUMN IF NOT EXISTS discount_parts_json TEXT
      `;
    }).catch((e) => {
      // Let the next call retry rather than caching the failure forever.
      ready = null;
      throw e;
    });
  }
  return ready;
}
