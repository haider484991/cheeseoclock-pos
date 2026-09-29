/**
 * After a deploy, the kept (ISR) pages the build rendered without the database
 * are refreshed by the first till heartbeat: one revalidatePath('/', 'layout')
 * per server instance, none when the build had the database.
 */
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({ revalidate: [] as Array<[string, string | undefined]> }));
vi.mock('next/cache', () => ({
  revalidatePath: (path: string, type?: string) => {
    calls.revalidate.push([path, type]);
  },
}));
const db = vi.hoisted(() => ({ pg: null as unknown as { query: (t: string, v: unknown[]) => Promise<{ rows: unknown[] }> } }));
vi.mock('@/lib/db', () => ({
  sql: () => (strings: TemplateStringsArray, ...values: unknown[]) =>
    db.pg.query(strings.reduce((acc, s, i) => acc + (i > 0 ? `$${i}` : '') + s, ''), values).then((r) => r.rows),
}));

const { refreshPagesAfterDeployOnce, forgetDeployRefresh } = await import('@/lib/deploy-refresh');
const bridgeStatus = await import('@/app/api/bridge/status/route');

const SECRET = 'test-bridge-secret-0123456789';
const heartbeat = () =>
  bridgeStatus.PUT(
    new Request('https://site.test/api/bridge/status', {
      method: 'PUT',
      headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' },
      body: JSON.stringify({ acceptingOrders: true, deviceId: 'till-1' }),
    }),
  );

beforeAll(async () => {
  process.env['BRIDGE_SECRET'] = SECRET;
  db.pg = new PGlite() as unknown as typeof db.pg;
  await (db.pg as unknown as PGlite).exec(readFileSync(new URL('../../db/schema.sql', import.meta.url), 'utf8'));
});
beforeEach(() => {
  calls.revalidate = [];
  forgetDeployRefresh();
  delete process.env['COC_BUILT_WITH_DB'];
});
afterEach(() => {
  delete process.env['COC_BUILT_WITH_DB'];
});

describe('refreshing the kept pages after a deploy', () => {
  it('a build without the database: the first heartbeat refreshes every page once, later ones do not', async () => {
    process.env['COC_BUILT_WITH_DB'] = '0';
    expect((await heartbeat()).status).toBe(200);
    expect(calls.revalidate).toEqual([['/', 'layout']]);
    expect((await heartbeat()).status).toBe(200);
    expect((await heartbeat()).status).toBe(200);
    expect(calls.revalidate).toEqual([['/', 'layout']]);
  });

  it('a build that had the database: nothing to refresh', async () => {
    process.env['COC_BUILT_WITH_DB'] = '1';
    expect((await heartbeat()).status).toBe(200);
    expect(calls.revalidate).toEqual([]);
  });

  it('a refused heartbeat (no secret) refreshes nothing', async () => {
    const res = await bridgeStatus.PUT(
      new Request('https://site.test/api/bridge/status', { method: 'PUT', body: JSON.stringify({ acceptingOrders: true }) }),
    );
    expect(res.status).toBe(401);
    expect(calls.revalidate).toEqual([]);
  });

  it('a refresh that throws (outside a Next request) never breaks the heartbeat', () => {
    const boom = () => {
      throw new Error('outside a request');
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(refreshPagesAfterDeployOnce(boom)).toBe(false);
    expect(refreshPagesAfterDeployOnce(boom)).toBe(false); // and it is not tried again on this instance
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('next.config.mjs tells the server whether the build had the database', () => {
    const config = readFileSync(new URL('../../next.config.mjs', import.meta.url), 'utf8');
    expect(config).toMatch(/COC_BUILT_WITH_DB:\s*process\.env\.DATABASE_URL \? '1' : '0'/);
  });
});
