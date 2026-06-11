import { neon } from '@neondatabase/serverless';

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
