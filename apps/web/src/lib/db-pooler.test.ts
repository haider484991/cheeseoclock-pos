/**
 * Through Supabase's transaction pooler, postgres.js sends one statement at a time on a connection (lib/db.ts;
 * 27 Oct 2026). Left to itself it sends the next query before the one ahead has answered, and the pooler hands
 * the server connection on when the first one ends, so the later query never answers. The dashboard's pages run
 * eight queries at once and hung until Vercel's 300 s limit. Found against the pooler itself: a query without
 * values and one with values, sent at once on one connection, hung every time, and with max_pipeline 0 none did.
 * The in-memory Postgres of db-driver.test.ts answers either way, so this test checks the options themselves.
 */
import { describe, expect, it, vi } from 'vitest';

const made: Array<{ url: string; options: Record<string, unknown> }> = [];
vi.mock('postgres', () => ({
  default: (url: string, options: Record<string, unknown>) => {
    made.push({ url, options });
    const run = () => Promise.resolve([]);
    return Object.assign(run, { unsafe: run });
  },
}));

describe('the TCP client, through a transaction pooler', () => {
  it('never sends a query before the one ahead of it has answered (max_pipeline 0), and prepares nothing', async () => {
    vi.stubEnv('DEV_NEON_ENDPOINT', '');
    vi.stubEnv('DATABASE_URL', 'postgresql://aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres');
    const { sql } = await import('./db');
    await sql()`SELECT 1`;
    expect(made).toHaveLength(1);
    expect(made[0]!.options).toMatchObject({ max_pipeline: 0, prepare: false });
  });
});
