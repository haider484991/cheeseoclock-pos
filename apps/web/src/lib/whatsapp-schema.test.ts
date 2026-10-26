/**
 * The WhatsApp tables are made on demand (ensureWhatsappSchema), so the live database needs no hand migration: the
 * first message works on a database without them, and they are exactly db/schema.sql's.
 */
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({ pg: null as unknown as { query: (t: string, v: unknown[]) => Promise<{ rows: unknown[] }> } }));
vi.mock('@/lib/db', () => ({
  sql: () => (strings: TemplateStringsArray, ...values: unknown[]) =>
    db.pg.query(strings.reduce((acc, s, i) => acc + (i > 0 ? `$${i}` : '') + s, ''), values).then((r) => r.rows),
}));
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

async function columns(pg: PGlite): Promise<string[]> {
  const r = await pg.query<{ c: string }>(
    `SELECT table_name || '.' || column_name || ' ' || data_type || ' ' || is_nullable AS c
       FROM information_schema.columns WHERE table_schema = 'public' AND table_name LIKE 'wa\_%' ORDER BY 1`,
  );
  return r.rows.map((x) => x.c);
}

describe('ensureWhatsappSchema', () => {
  it('makes the tables at the first message on a database that has none — the same as db/schema.sql', async () => {
    vi.resetModules();
    const bare = new PGlite();
    db.pg = bare as unknown as typeof db.pg;
    const store = await import('@/lib/whatsapp-store');
    expect(await columns(bare)).toEqual([]);
    expect(
      await store.recordInbound({ messageId: 'wamid.1', waId: '923001234500', profileName: null, kind: 'text', at: new Date(), ad: null }),
    ).toBe(true);
    expect(await store.createLink('923001234500')).toMatch(/^[A-Za-z0-9]{12}$/);

    const full = new PGlite();
    await full.exec(readFileSync(new URL('../../db/schema.sql', import.meta.url), 'utf8'));
    expect(await columns(bare)).toEqual(await columns(full));
    expect((await columns(bare)).length).toBeGreaterThan(20);
  });
});
