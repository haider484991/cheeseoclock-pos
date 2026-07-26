import { createHash } from 'node:crypto';
import { sql } from './db';

/**
 * Flood protection for the public COD order endpoint.
 *
 * COD has no payment step, so nothing stops a script (or a bored teenager)
 * from firing hundreds of orders at fake addresses and sending every rider
 * out on a fool's errand. The honeypot field only stops naive bots.
 *
 * Two independent layers:
 *  - per phone, counted straight off `web_orders` (uses the existing
 *    idx_web_orders_phone index, so no migration is needed)
 *  - per client IP, counted off `order_rate_events` — a tiny append-only
 *    table this module creates on demand
 *
 * FAIL-OPEN by design: if any part of this throws, the order is allowed.
 * Losing a real dinner order because the limiter had a bad day costs more
 * than letting one extra fake order through.
 */

export const ORDER_RATE_LIMITS = {
  windowMinutes: 15,
  /** A household re-ordering a forgotten drink is normal; 4+ is not. */
  maxPerPhone: 3,
  /** Offices and apartment blocks share an IP, so this is looser. */
  maxPerIp: 6,
} as const;

export interface RateVerdict {
  allowed: boolean;
  reason?: 'phone' | 'ip';
  retryAfterSec: number;
}

/**
 * Stable, non-reversible per-client key. We deliberately never store a raw
 * IP — the hash is enough to count with, and keeps the table free of
 * personal data.
 */
export function clientIpHash(req: Request): string | null {
  const fwd = req.headers.get('x-forwarded-for') ?? '';
  const ip =
    fwd.split(',')[0]?.trim() ||
    req.headers.get('x-real-ip')?.trim() ||
    '';
  if (!ip) return null;
  const salt = process.env['BRIDGE_SECRET'] ?? 'cheeseoclock';
  return createHash('sha256').update(`${salt}:${ip}`).digest('hex').slice(0, 32);
}

/**
 * Created lazily rather than in db/schema.sql alone, so the limiter works on
 * an already-provisioned database without anyone re-running db:init. The
 * statements are IF NOT EXISTS, so this is idempotent and also lives in
 * schema.sql for fresh installs. Runs once per cold start.
 */
let tableReady: Promise<void> | null = null;
function ensureRateTable(): Promise<void> {
  if (!tableReady) {
    tableReady = (async () => {
      await sql()`
        CREATE TABLE IF NOT EXISTS order_rate_events (
          id         BIGSERIAL PRIMARY KEY,
          ip_hash    TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `;
      await sql()`
        CREATE INDEX IF NOT EXISTS idx_order_rate_events_ip
          ON order_rate_events(ip_hash, created_at)
      `;
    })().catch((e: unknown) => {
      tableReady = null; // let the next request retry
      throw e;
    });
  }
  return tableReady;
}

/**
 * The window start as an ISO timestamp, computed here rather than in SQL.
 *
 * The obvious `now() - make_interval(mins => ${n})` does not survive being
 * parameterized: Postgres cannot infer the type of a bare parameter in
 * named-argument position and errors out with "could not determine data type
 * of parameter $1". Because this limiter fails open, that error was invisible
 * — every request sailed through while the limit looked installed. Comparing
 * against a plain timestamp parameter types cleanly off `created_at`.
 */
function windowStartIso(): string {
  return new Date(
    Date.now() - ORDER_RATE_LIMITS.windowMinutes * 60_000,
  ).toISOString();
}

async function countRecentForPhone(phone: string): Promise<number> {
  const rows = (await sql()`
    SELECT count(*)::int AS n
      FROM web_orders
     WHERE customer_phone = ${phone}
       AND created_at > ${windowStartIso()}
  `) as Array<{ n: number }>;
  return rows[0]?.n ?? 0;
}

async function countRecentForIp(ipHash: string): Promise<number> {
  await ensureRateTable();
  await sql()`INSERT INTO order_rate_events (ip_hash) VALUES (${ipHash})`;
  const rows = (await sql()`
    SELECT count(*)::int AS n
      FROM order_rate_events
     WHERE ip_hash = ${ipHash}
       AND created_at > ${windowStartIso()}
  `) as Array<{ n: number }>;
  // Opportunistic pruning — the table is write-heavy and read-tiny, and a
  // day of events is far more history than the window needs.
  if (Math.random() < 0.02) {
    await sql()`DELETE FROM order_rate_events WHERE created_at < now() - interval '1 day'`;
  }
  return rows[0]?.n ?? 0;
}

/**
 * Attempts are counted, not just successes: the IP row is inserted before the
 * count, so a caller who is already being rejected still accrues against the
 * window rather than getting free retries.
 */
export async function checkOrderRate(
  phone: string,
  ipHash: string | null,
): Promise<RateVerdict> {
  const retryAfterSec = ORDER_RATE_LIMITS.windowMinutes * 60;
  try {
    const recentForPhone = await countRecentForPhone(phone);
    if (recentForPhone >= ORDER_RATE_LIMITS.maxPerPhone) {
      return { allowed: false, reason: 'phone', retryAfterSec };
    }
    if (ipHash) {
      const recentForIp = await countRecentForIp(ipHash);
      if (recentForIp > ORDER_RATE_LIMITS.maxPerIp) {
        return { allowed: false, reason: 'ip', retryAfterSec };
      }
    }
    return { allowed: true, retryAfterSec };
  } catch (e) {
    console.error('rate limit check failed — allowing the order', e);
    return { allowed: true, retryAfterSec };
  }
}
