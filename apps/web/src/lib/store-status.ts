import {
  LEGACY_PICKUP_DISCOUNT_PERCENT,
  PICKUP_DISCOUNT_PERCENT,
  WEBSITE_PICKUP_MAX_PERCENT,
  type PublishedPickup,
} from '@cheeseoclock/shared-types';
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

/**
 * How long a placed order may sit unconfirmed ('new', never acked by the
 * till) before the site gives up on it. The same failure mode as a stale
 * heartbeat, one step later: an order the POS never picked up — laptop shut
 * right after checkout, bridge wedged — must not be cooked an hour on when
 * the till comes back, and the customer must be told to call. Mirrored in
 * the POS bridge as MAX_IMPORT_AGE_MS so a late pull refuses it too.
 */
export const UNCONFIRMED_ORDER_TTL_MS = 45 * 60_000;

/** ISO cutoff for the unconfirmed-order sweep: anything created before it is expired. */
export function unconfirmedOrderCutoff(now: number = Date.now()): string {
  return new Date(now - UNCONFIRMED_ORDER_TTL_MS).toISOString();
}

export interface StoreStatus {
  /** The answer the checkout acts on: heartbeat says yes AND is fresh. */
  acceptingOrders: boolean;
  /** What the till last told us, ignoring age. */
  posAcceptingOrders: boolean;
  /** When the till last spoke, or null if it never has. */
  updatedAt: string | null;
  /** True when the till has gone quiet — treated as closed. */
  stale: boolean;
  /**
   * The checkout may offer pickup: the shop is taking orders AND the till
   * announced it can import pickup orders (POS heartbeat `features`) AND —
   * once the owner's settings block is stored — the owner offers it
   * (block pickup.offered). A till that predates pickup would book them as
   * deliveries at full price.
   */
  pickupAvailable: boolean;
  /**
   * The pickup discount the site shows and prices: the owner's % from the
   * settings block once one is stored (the till bills the % the web order
   * carries); before that, what the listening till announces in its
   * heartbeat, and the legacy 10% from a till that never said (v0.7.0).
   */
  pickupDiscountPercent: number;
  /**
   * The % off a DELIVERY's food (WEBSITE DELIVERY DISCOUNT, v0.7.37); 0 =
   * deliveries pay full price. The block's % only while the stored block
   * says `alsoDelivery` AND the listening till announced 'delivery_discount'
   * (it bills it at import; an older till would not) AND the shop is taking
   * orders.
   */
  deliveryDiscountPercent: number;
}

export const CLOSED: StoreStatus = {
  acceptingOrders: false,
  posAcceptingOrders: false,
  updatedAt: null,
  stale: true,
  pickupAvailable: false,
  pickupDiscountPercent: PICKUP_DISCOUNT_PERCENT,
  deliveryDiscountPercent: 0,
};

/**
 * The pick-up offer of a stored settings block (site_menu.menu_json →
 * settings → pickup), or null when there is none or it is unreadable: then
 * the heartbeat decides, exactly as before the block.
 */
export function blockPickupOf(raw: unknown): PublishedPickup | null {
  let v: unknown = raw;
  if (typeof raw === 'string') {
    try {
      v = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!v || typeof v !== 'object') return null;
  const { offered, percent, alsoDelivery } = v as { offered?: unknown; percent?: unknown; alsoDelivery?: unknown };
  if (typeof offered !== 'boolean' || typeof percent !== 'number') return null;
  if (!Number.isInteger(percent) || percent < 0 || percent > WEBSITE_PICKUP_MAX_PERCENT) return null;
  // Only an exact true turns the delivery % on (a block before v0.7.37 has no key: deliveries pay full price).
  return alsoDelivery === true ? { offered, percent, alsoDelivery: true } : { offered, percent };
}

/**
 * Pure decision so it can be tested without a database: a heartbeat only
 * counts while it is both affirmative and recent. `settings_pickup` is the
 * stored settings block's pick-up offer (absent or null = no block).
 */
export function evaluateStatus(
  row: {
    accepting_orders: boolean;
    updated_at: string | Date;
    pickup?: boolean | null;
    pickup_discount_pct?: number | null;
    /** The listening till bills the website's delivery % (heartbeat 'delivery_discount', v0.7.37). */
    delivery_discount?: boolean | null;
    settings_pickup?: unknown;
  } | null,
  now: number = Date.now(),
): StoreStatus {
  if (!row) return CLOSED;
  const updatedAt = row.updated_at instanceof Date ? row.updated_at : new Date(row.updated_at);
  const ms = updatedAt.getTime();
  if (!Number.isFinite(ms)) return CLOSED;
  // A clock ahead of ours is still a live beat; only age closes the shop.
  const stale = now - ms > HEARTBEAT_STALE_MS;
  const posAccepting = row.accepting_orders === true;
  // Once the owner's block is stored it decides whether pick-up is offered and
  // at what %; the heartbeat still says whether the listening till can import one.
  const block = blockPickupOf(row.settings_pickup);
  return {
    acceptingOrders: posAccepting && !stale,
    posAcceptingOrders: posAccepting,
    updatedAt: updatedAt.toISOString(),
    stale,
    pickupAvailable: posAccepting && !stale && row.pickup === true && (block ? block.offered : true),
    pickupDiscountPercent: block ? block.percent : (row.pickup_discount_pct ?? LEGACY_PICKUP_DISCOUNT_PERCENT),
    // Never without the owner's block saying so, nor while the listening till could not bill it.
    deliveryDiscountPercent:
      posAccepting && !stale && row.delivery_discount === true && block?.alsoDelivery === true ? block.percent : 0,
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
      // Added with pickup orders; a table from before then gains it here.
      await sql()`
        ALTER TABLE store_status ADD COLUMN IF NOT EXISTS pickup BOOLEAN NOT NULL DEFAULT false
      `;
      // The percent the till applies to pickups; null = a till that never said.
      await sql()`
        ALTER TABLE store_status ADD COLUMN IF NOT EXISTS pickup_discount_pct INT
      `;
      // The till bills the website's delivery % (heartbeat 'delivery_discount', v0.7.37).
      await sql()`
        ALTER TABLE store_status ADD COLUMN IF NOT EXISTS delivery_discount BOOLEAN NOT NULL DEFAULT false
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
  // Local preview without a database (see app/menu/page.tsx DEV_MENU_FILE):
  // `next dev` only, never a production build.
  if (process.env.NODE_ENV === 'development' && process.env['DEV_MENU_FILE']) {
    const open = process.env['DEV_ACCEPTING_ORDERS'] === '1';
    const pickupAvailable = open && process.env['DEV_PICKUP'] === '1';
    return {
      acceptingOrders: open,
      posAcceptingOrders: open,
      updatedAt: null,
      stale: false,
      pickupAvailable,
      pickupDiscountPercent: PICKUP_DISCOUNT_PERCENT,
      deliveryDiscountPercent: open && process.env['DEV_DELIVERY_DISCOUNT'] === '1' ? PICKUP_DISCOUNT_PERCENT : 0,
    };
  }
  try {
    await ensureStatusTable();
    // One read with the stored settings block's pick-up offer, so the two
    // can't disagree (fail-closed: if it can't be read, the shop is closed).
    const rows = (await sql()`
      SELECT s.accepting_orders, s.updated_at, s.pickup, s.pickup_discount_pct, s.delivery_discount,
             (SELECT m.menu_json -> 'settings' -> 'pickup' FROM site_menu m WHERE m.id = 1) AS settings_pickup
        FROM store_status s
       WHERE s.id = 1
    `) as Array<{
      accepting_orders: boolean;
      updated_at: string | Date;
      pickup: boolean;
      pickup_discount_pct: number | null;
      delivery_discount: boolean;
      settings_pickup: unknown;
    }>;
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
  /** The till can import pickup orders (its heartbeat lists 'pickup'). */
  pickup?: boolean;
  /** The pickup discount it applies; omitted by v0.7.0 tills. */
  pickupDiscountPercent?: number | null;
  /** The till bills the website's delivery % (its heartbeat lists 'delivery_discount', v0.7.37). */
  deliveryDiscount?: boolean;
}): Promise<StoreStatus> {
  await ensureStatusTable();
  const pickup = input.pickup === true;
  const deliveryDiscount = input.deliveryDiscount === true;
  const pct = input.pickupDiscountPercent ?? null;
  await sql()`
    INSERT INTO store_status (id, accepting_orders, device_id, pickup, pickup_discount_pct, delivery_discount, updated_at)
    VALUES (1, ${input.acceptingOrders}, ${input.deviceId ?? null}, ${pickup}, ${pct}, ${deliveryDiscount}, now())
    ON CONFLICT (id) DO UPDATE
      SET accepting_orders    = EXCLUDED.accepting_orders,
          device_id           = EXCLUDED.device_id,
          pickup              = EXCLUDED.pickup,
          pickup_discount_pct = EXCLUDED.pickup_discount_pct,
          delivery_discount   = EXCLUDED.delivery_discount,
          updated_at          = now()
  `;
  return {
    acceptingOrders: input.acceptingOrders,
    posAcceptingOrders: input.acceptingOrders,
    updatedAt: new Date().toISOString(),
    stale: false,
    pickupAvailable: input.acceptingOrders && pickup,
    pickupDiscountPercent: pct ?? LEGACY_PICKUP_DISCOUNT_PERCENT,
    // The heartbeat alone (no block here, as for the % above): the GET and the checkout read the block.
    deliveryDiscountPercent: 0,
  };
}
