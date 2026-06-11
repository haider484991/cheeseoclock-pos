import { neon } from '@neondatabase/serverless';

/**
 * Neon serverless SQL client. Each invocation is an HTTP round-trip —
 * perfect for Vercel functions (no connection pool to leak).
 */
export function sql() {
  const url = process.env['DATABASE_URL'];
  if (!url) throw new Error('DATABASE_URL is not configured');
  return neon(url);
}
