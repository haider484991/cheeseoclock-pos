/**
 * The Vouchers page (v0.7.48): each client's vouchers, and for each one what
 * the paper log at the counter used to say. Rendered to static markup
 * (react-dom/server, no browser; nothing calls the till) with the answers
 * vouchers:listBatches and vouchers:getBatch give. Every name, code and
 * number is made up.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import type { VoucherBatchDetail, VoucherBatchSummary, VoucherRow } from '@cheeseoclock/shared-types';
import { ToastProvider } from '../../components/toast/ToastProvider';
import { VouchersPage } from './VouchersPage';

const BATCH: VoucherBatchSummary = {
  id: 'b1',
  name: 'abhi',
  gives: 'One Large pizza from the Regular menu',
  coversCents: 189_900,
  goodUntil: null,
  for: { categoryIds: ['c1'], size: 'Large', wholeItem: true },
  forCategoryNames: ['Pizza'],
  createdAt: '2026-10-12T09:00:00.000Z',
  createdByName: 'Test Owner',
  count: 3,
  used: 1,
  onOrder: 1,
  notUsed: 1,
  firstNumber: 1,
  lastNumber: 3,
};

const onOrder = (orderNumber: string, paidAt: string | null) => ({
  orderId: `o-${orderNumber}`,
  orderNumber,
  at: '2026-10-14T10:00:00.000Z',
  paidAt,
  refunded: false,
  item: 'Test Fajita Pizza — Large',
  amountCents: 189_900,
  staffName: 'Test Cashier',
  customerName: 'Test Customer',
  customerPhone: null,
});

const ROWS: VoucherRow[] = [
  { id: 'v1', number: 1, code: 'AB3C', state: 'used', use: onOrder('20261014-0042', '2026-10-14T10:05:00.000Z'), alsoOn: [] },
  { id: 'v2', number: 2, code: 'XK7P', state: 'on_order', use: onOrder('20261014-0043', null), alsoOn: [] },
  { id: 'v3', number: 3, code: 'RT9D', state: 'not_used', use: null, alsoOn: [] },
];

function render(batches: VoucherBatchSummary[], detail: VoucherBatchDetail | null): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(['vouchers', 'batches'], batches);
  if (detail) qc.setQueryData(['vouchers', 'batch', detail.batch.id], detail);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <VouchersPage />
      </ToastProvider>
    </QueryClientProvider>,
  );
}
const decode = (s: string) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const text = (markup: string) => decode(markup.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

describe('the Vouchers page', () => {
  it('each client’s card says how many are used, and the list says what the paper log did', () => {
    const words = text(render([BATCH], { batch: BATCH, vouchers: ROWS }));
    expect(words).toContain('abhi No. 001–003 One Large pizza from the Regular menu');
    expect(words).toContain('1 of 3 used · 1 on an order not paid yet · 1 not used');
    expect(words).toContain('Large · Pizza · the whole item · no end date');
    // The used one: its day, its order, what it was used on, the customer and who put it on.
    expect(words).toContain('001 AB3C Used 14 Oct, 3:05 pm #0042 Test Fajita Pizza — Large (−Rs 1,899) Test Customer Test Cashier');
    expect(words).toContain('002 XK7P On an order 14 Oct, 3:00 pm #0043');
    expect(words).toContain('003 RT9D Not used — — — — —');
    // A batch with a voucher on an order can't be deleted from here.
    expect(words).not.toContain('Delete');
    expect(words).toContain('Copy list');
  });

  it('a voucher on two orders (both tills took it offline) is flagged to check', () => {
    const twice: VoucherRow = { ...ROWS[0]!, alsoOn: [onOrder('20261014-0050', '2026-10-14T11:00:00.000Z')] };
    const words = text(render([BATCH], { batch: BATCH, vouchers: [twice, ROWS[1]!, ROWS[2]!] }));
    expect(words).toContain('One voucher was used on two orders');
    expect(words).toContain('No. 001. Check those orders.');
    expect(words).toContain('#0042 + #0050');
  });

  it('none used yet: the batch can be deleted', () => {
    const fresh = { ...BATCH, used: 0, onOrder: 0, notUsed: 3 };
    expect(text(render([fresh], { batch: fresh, vouchers: ROWS.map((r) => ({ ...r, state: 'not_used' as const, use: null })) }))).toContain('Delete');
  });

  it('no vouchers yet: how to add them', () => {
    expect(text(render([], null))).toContain(
      'No vouchers yet. Add a client’s vouchers: choose the CSV of the printed list, or let the till make the codes. Settings → Vouchers says what they are for.',
    );
  });
});
