/**
 * Recent Orders (the counter's list) says when a delivery's refused item is
 * still to refund (v0.7.34, review fixes B: Delivered + Pay with "Customer
 * refused an item" leaves the drawer short by the item until its part refund
 * is done). Rendered to static markup (react-dom/server, no browser); the
 * list is the till's answer, seeded. Every name and number is made up.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RecentCounterOrder } from '@cheeseoclock/shared-types';
import { RecentOrdersPage } from './RecentOrdersPage';
import { REFUSED_ITEM_OWED_CHIP, REFUSED_ITEM_OWED_TEXT, refusedItemOwedLine } from './refusedItemWords';

// MemoryRouter's layout effect has nothing to do on a server render.
const consoleError = console.error;
beforeAll(() => {
  vi.spyOn(console, 'error').mockImplementation((msg: unknown, ...rest: unknown[]) => {
    if (String(msg).includes('useLayoutEffect does nothing on the server')) return;
    consoleError(msg, ...rest);
  });
});
afterAll(() => vi.restoreAllMocks());

const decode = (s: string) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const text = (markup: string) => decode(markup.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

const row = (n: number, over: Partial<RecentCounterOrder> = {}): RecentCounterOrder => ({
  id: `o${n}`,
  orderNumber: `20261002-00${n}`,
  mode: 'delivery',
  source: 'pos',
  status: 'paid',
  createdAt: '2026-10-02T14:00:00.000Z',
  paid: true,
  ...over,
});

function page(rows: RecentCounterOrder[]): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(['orders', 'recent', null], rows);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <RecentOrdersPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Each row's markup by its short number ("#0042"). */
function rowsOf(html: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of html.split('<li').slice(1)) {
    const n = /#(\d{4})/.exec(part)?.[1];
    if (n) out.set(`#${n}`, part);
  }
  return out;
}

describe('Recent Orders: a refused item still to refund', () => {
  it('the row says "Refund not done", with the whole sentence as its title; other rows say nothing', () => {
    const rows = rowsOf(page([row(42, { refusedItemRefundOwed: true }), row(43)]));
    expect(REFUSED_ITEM_OWED_CHIP).toBe('Refund not done');
    expect(text(rows.get('#0042')!)).toContain('Refund not done');
    expect(decode(rows.get('#0042')!)).toContain(`title="${REFUSED_ITEM_OWED_TEXT}"`);
    expect(text(rows.get('#0043')!)).not.toContain('Refund not done');
  });

  it('the words, as the order and the Close shift box say them', () => {
    expect(REFUSED_ITEM_OWED_TEXT).toBe('Customer refused an item - refund not done yet');
    expect(refusedItemOwedLine('20261002-0042')).toBe('#0042: customer refused an item - refund not done yet');
  });
});
