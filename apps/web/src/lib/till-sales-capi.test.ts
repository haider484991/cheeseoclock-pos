/**
 * Till sales to Meta (lib/till-sales-capi, 26 Oct 2026): the paid till orders of the last week with a Pakistani
 * mobile number go to Meta as shop Purchases, hashed, each once; website and foodpanda orders do not; a refused
 * send is tried again at the next push.
 */
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sha256Hex } from './sha256';

const db = vi.hoisted(() => ({ pg: null as unknown as { query: (t: string, v: unknown[]) => Promise<{ rows: unknown[] }> } }));
vi.mock('@/lib/db', () => ({
  sql: () => (strings: TemplateStringsArray, ...values: unknown[]) =>
    db.pg.query(strings.reduce((acc, s, i) => acc + (i > 0 ? `$${i}` : '') + s, ''), values).then((r) => r.rows),
}));
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const { sendTillSales, tillSaleEvent } = await import('./till-sales-capi');

const NOW = new Date('2026-10-26T12:00:00Z');
async function order(id: string, o: { phone?: string | null; name?: string; source?: string; mode?: string; paid?: string | null; net?: number; counted?: boolean }) {
  const paid = o.paid === undefined ? '2026-10-26T10:00:00Z' : o.paid;
  await db.pg.query(
    `INSERT INTO dash_orders (id, device_id, number, status, mode, source, channel, created_at, paid_at, trading_day, hour, counted,
                              subtotal_cents, discount_cents, tax_cents, total_cents, refunded_cents, net_cents, customer_name, customer_phone,
                              item_count, doc, doc_updated_at)
     VALUES ($1, 'till-1', $1, 'paid', $2, $3, $2, COALESCE($4::timestamptz, now()), $4, '2026-10-26', 10, $5,
             $6, 0, 0, $6, 0, $6, $7, $8, 1, '{}', now())`,
    [id, o.mode ?? 'takeaway', o.source ?? 'pos', paid, o.counted ?? true, o.net ?? 180_000, o.name ?? 'Ali Raza', o.phone === undefined ? '0300 1112233' : o.phone],
  );
}

const calls: Array<{ data: Array<Record<string, unknown>>; access_token: string }> = [];
let answer: () => Response = () => Response.json({ events_received: 1 });
const fakeFetch = (async (_url: string, init: RequestInit) => {
  calls.push(JSON.parse(String(init.body)));
  return answer();
}) as unknown as typeof fetch;

beforeAll(async () => {
  db.pg = new PGlite() as unknown as typeof db.pg;
  await (db.pg as unknown as PGlite).exec(readFileSync(new URL('../../db/schema.sql', import.meta.url), 'utf8'));
  Object.assign(process.env, { TILL_SALES_TO_META: 'on', META_CAPI_ACCESS_TOKEN: 'EAAtesttoken0123456789abcdef', NEXT_PUBLIC_META_PIXEL_ID: '1794891064972562' });
  await order('walk-in', {});
  await order('phone-order', { phone: '+923211234567', name: 'Bilal', mode: 'delivery' });
  await order('web', { source: 'web' });
  await order('panda', { mode: 'foodpanda' });
  await order('no-phone', { phone: null });
  await order('not-a-mobile', { phone: '12345' });
  await order('unpaid', { paid: null });
  await order('voided', { counted: false });
  await order('last-month', { paid: '2026-10-01T10:00:00Z' });
});

beforeEach(() => {
  calls.length = 0;
  answer = () => Response.json({ events_received: 2 });
});

describe('till sales to Meta', () => {
  it('a sale is a shop Purchase: hashed number and name, its value in rupees, its own event id', () => {
    const e = tillSaleEvent({ id: 'o1', paidAt: NOW, netCents: 180_000, phone: '0300 1112233', name: 'Ali Raza' })!;
    expect(e).toMatchObject({
      event_name: 'Purchase',
      event_time: Math.floor(NOW.getTime() / 1000),
      event_id: 'till-o1',
      action_source: 'physical_store',
      custom_data: { currency: 'PKR', value: 1800, order_id: 'o1' },
    });
    const u = e['user_data'] as Record<string, string[]>;
    expect(u['ph']).toEqual([sha256Hex('923001112233')]);
    expect(u['fn']).toEqual([sha256Hex('ali')]);
    expect(u['ln']).toEqual([sha256Hex('raza')]);
    expect(JSON.stringify(e)).not.toContain('1112233');
    expect(tillSaleEvent({ id: 'o2', paidAt: NOW, netCents: 100, phone: '12345', name: null })).toBeNull();
    expect(tillSaleEvent({ id: 'o3', paidAt: NOW, netCents: 0, phone: '0300 1112233', name: null })).toBeNull();
  });

  it('a refused send is not counted as sent; the next push sends the same sales', async () => {
    answer = () => Response.json({ error: { code: 100, message: 'Invalid parameter' } }, { status: 400 });
    expect(await sendTillSales(NOW, fakeFetch)).toMatchObject({ sent: 0, error: '100: Invalid parameter' });
    expect((await db.pg.query(`SELECT 1 FROM capi_till_sales WHERE order_id IN ('walk-in', 'phone-order')`, [])).rows).toEqual([]);
  });

  it('sends only the week’s paid shop sales with a mobile number, once', async () => {
    expect(await sendTillSales(NOW, fakeFetch)).toEqual({ sent: 2 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.data.map((e) => e['event_id']).sort()).toEqual(['till-phone-order', 'till-walk-in']);
    expect(calls[0]!.access_token).toBe('EAAtesttoken0123456789abcdef');
    expect(await sendTillSales(NOW, fakeFetch)).toEqual({ sent: 0 });
    expect(calls).toHaveLength(1);
  });

  it('switched off: nothing is read or sent', async () => {
    process.env['TILL_SALES_TO_META'] = 'off';
    await order('later', { paid: '2026-10-26T11:00:00Z' });
    expect(await sendTillSales(NOW, fakeFetch)).toEqual({ sent: 0 });
    expect(calls).toHaveLength(0);
    process.env['TILL_SALES_TO_META'] = 'on';
  });
});
