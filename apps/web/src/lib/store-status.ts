import { sql } from './db';

/**
 * Whether the website may take orders right now.
 *
 * The POS is the only authority on this: a customer order that nobody is
 * watching is worse than no order at all — it is taken, paid for on delivery,
 * and never cooked. So the till heartbeats its "Accept online orders" setting
 * to the site, and the site refuses checkout unless that heartbeat says yes
 * AND is recent.
 *
 * Two ways the shop is closed, and both must work:
 *  - the cashier unticks "Accept online orders" — the POS pushes false at once
 *  - the laptop is shut, crashes, or loses the internet — no push arrives, so
 *    the last one goes stale and the site closes on its own
 *
 * FAIL-CLOSED, the opposite of the rate limiter: if we cannot prove the till
 * is listening, we do not take the order. An unanswered order costs a customer;
 * a refused one costs a click, and the page still offers WhatsApp.
 */

/**
 * How long a heartbeat stays good. The till polls every 10s, so this tolerates
 * a long run of missed beats (flaky shop Wi-Fi) while still closing the site a
 * few minutes after the laptop goes down.
 */
export const HEARTBEAT_STALE_MS = 3 * 60_000;

export interface StoreStatus {
  /** The answer the checkout acts on: heartbeat says yes AND is fresh. */
  acceptingOrders: boolean;
  /** What the till last told us, ignoring age. */
  posAcceptingOrders: boolean;
  /** When the till last spoke, or null if it never has. */
  updatedAt: string | null;
  /** True when the till has gone quiet — treated as closed. */
  stale: boolean;
}

export const CLOSED: StoreStatus = {
  acceptingOrders: false,
  posAcceptingOrders: false,
  updatedAt: null,
  stale: true,
};

/**
 * Pure decision so it can be tested without a database: a heartbeat only
 * counts while it is both affirmative and recent.
 */
export function evaluateStatus(
  row: { accepting_orders: boolean; updated_at: string | Date } | null,
  now: number = Date.now(),
): StoreStatus {
  if (!row) return CLOSED;
  const updatedAt = row.updated_at instanceof Date ? row.updated_at : new Date(row.updated_at);
  const ms = updatedAt.getTime();
  if (!Number.isFinite(ms)) return CLOSED;
  // A clock ahead of ours is still a live beat; only age closes the shop.
  const stale = now - ms > HEARTBEAT_STALE_MS;
  const posAccepting = row.accepting_orders === true;
  return {
    acceptingOrders: posAccepting && !stale,
    posAcceptingOrders: posAccepting,
    updatedAt: updatedAt.toISOString(),
    stale,
  };
}

/**
 * Created on demand as well as in db/schema.sql, so a database provisioned
 * before this feature picks it up without anyone re-running db:init. Defaults
 * to NOT accepting: a site that has never heard from a till is closed.
 */
let tableReady: Promise<void> | null = null;
function ensureStatusTable(): Promise<void> {
  if (!tableReady) {
    tableReady = (async () => {
      await sql()`
        CREATE TABLE IF NOT EXISTS store_status (
          id               INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
          accepting_orders BOOLEAN NOT NULL DEFAULT false,
          device_id        TEXT,
          updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
    })().catch((e) => {
      // Let the next call retry rather than caching the failure forever.
      tableReady = null;
      throw e;
    });
  }
  return tableReady;
}

/** Current status. Any failure reads as closed — see the fail-closed note. */
export async function getStoreStatus(): Promise<StoreStatus> {
  try {
    await ensureStatusTable();
    const rows = (await sql()`
      SELECT accepting_orders, updated_at FROM store_status WHERE id = 1
    `) as Array<{ accepting_orders: boolean; updated_at: string | Date }>;
    return evaluateStatus(rows[0] ?? null);
  } catch (e) {
    console.error('store status read failed', e);
    return CLOSED;
  }
}

/** The till's heartbeat. `now()` is the server's clock, never the client's. */
export async function setStoreStatus(input: {
  acceptingOrders: boolean;
  deviceId?: string | null;
}): Promise<StoreStatus> {
  await ensureStatusTable();
  await sql()`
    INSERT INTO store_status (id, accepting_orders, device_id, updated_at)
    VALUES (1, ${input.acceptingOrders}, ${input.deviceId ?? null}, now())
    ON CONFLICT (id) DO UPDATE
      SET accepting_orders = EXCLUDED.accepting_orders,
          device_id        = EXCLUDED.device_id,
          updated_at       = now()
  `;
  return {
    acceptingOrders: input.acceptingOrders,
    posAcceptingOrders: input.acceptingOrders,
    updatedAt: new Date().toISOString(),
    stale: false,
  };
}
