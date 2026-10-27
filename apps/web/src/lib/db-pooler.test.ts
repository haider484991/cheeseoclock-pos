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

/**
 * On Cloudflare Workers a socket belongs to the request that opened it, so no pool can serve two requests: the Worker's
 * entry (cloudflare/worker.mjs) runs each request in a scope holding a map, and lib/db.ts keeps that request's own small
 * pool there. Without a scope (Vercel, Node) it is one pool per instance, as before. The database is reached through
 * Hyperdrive there (Supabase's certificate is from its own root CA, which a Worker's TLS refuses): plain TCP to it.
 */
describe('the TCP client on Cloudflare Workers', () => {
  const SCOPE = Symbol.for('site.request-scope');
  const g = globalThis as unknown as Record<symbol, { getStore(): { pools: Map<string, unknown> } | undefined } | undefined>;
  const inRequest = async (store: { pools: Map<string, unknown> }, run: () => Promise<unknown>) => {
    g[SCOPE] = { getStore: () => store };
    try {
      await run();
    } finally {
      delete g[SCOPE];
    }
  };

  it('keeps one pool per instance off Workers, and gives each request its own small one on Workers', async () => {
    vi.stubEnv('DEV_NEON_ENDPOINT', '');
    vi.stubEnv('DATABASE_URL', 'postgresql://aws-0-ap-southeast-1.pooler.supabase.com:6543/postgres');
    const { sql } = await import('./db');
    const before = made.length;
    await sql()`SELECT 1`;
    await sql()`SELECT 2`;
    expect(made.length - before).toBeLessThanOrEqual(1); // the instance's pool, made once (maybe by the test above)

    const first = { pools: new Map<string, unknown>() };
    const second = { pools: new Map<string, unknown>() };
    const n = made.length;
    await inRequest(first, async () => {
      await sql()`SELECT 1`;
      await sql()`SELECT 2`;
    });
    await inRequest(second, () => sql()`SELECT 3`);
    expect(made.length - n).toBe(2); // one pool per request, not per query
    for (const m of made.slice(n)) expect(m.options).toMatchObject({ max: 2, fetch_types: false, idle_timeout: 2, max_pipeline: 0 });
    expect(first.pools.size).toBe(1);
    expect(second.pools.size).toBe(1);
  });

  it('talks plain TCP to Hyperdrive (inside Cloudflare) and TLS to Supabase', async () => {
    vi.stubEnv('DEV_NEON_ENDPOINT', '');
    const { sql } = await import('./db');
    vi.stubEnv('DATABASE_URL', 'postgresql://cheeseoclock@a1b2c3.hyperdrive.local:5432/postgres');
    await inRequest({ pools: new Map() }, () => sql()`SELECT 1`);
    expect(made.at(-1)!.options).toMatchObject({ ssl: false });
    vi.stubEnv('DATABASE_URL', 'postgresql://aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres');
    await inRequest({ pools: new Map() }, () => sql()`SELECT 1`);
    expect(made.at(-1)!.options).toMatchObject({ ssl: 'require' });
  });
});
