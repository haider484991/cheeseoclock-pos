import { neon, neonConfig } from '@neondatabase/serverless';

// Development only: scripts/dev-neon-shim.mjs answers the driver's HTTP
// protocol from an in-process Postgres, so `next dev` runs every page and
// route on a real database without a Neon project. Never in production.
if (process.env.NODE_ENV !== 'production' && process.env['DEV_NEON_ENDPOINT']) {
  neonConfig.fetchEndpoint = process.env['DEV_NEON_ENDPOINT'];
}

/**
 * Neon serverless SQL client. Each invocation is an HTTP round-trip —
 * perfect for Vercel functions (no connection pool to leak).
 *
 * `cache: 'no-store'` is critical: the driver issues each query as a fetch,
 * and Next.js will otherwise cache that fetch keyed by the SQL string. That
 * cached a query's first (empty) result forever — e.g. the bridge order-pull
 * kept returning `[]` from before any orders existed, and `/api/menu` kept
 * saying "not published" after publishing. no-store makes every query hit the
 * live database.
 */
export function sql() {
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('DATABASE_URL is not configured');
  return neon(url, { fetchOptions: { cache: 'no-store' } });
}
