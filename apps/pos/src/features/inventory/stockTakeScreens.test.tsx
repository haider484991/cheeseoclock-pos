/**
 * Inventory → Stock takes (costing spec Phase 8) renders what it is given:
 * a smoke render (react-dom/server, no browser) of the list, the count
 * sheet (a blank box per line, shelf by shelf, kilos or packs + loose — and
 * nothing about what the till expects), and a count box as the Stock button
 * shows it. Nothing calls the till. Every name and quantity is made up.
 */
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { StockCountDetail, StockCountLine, StockCountSummary } from '@cheeseoclock/shared-types';
import { ToastProvider } from '../../components/toast/ToastProvider';
import { CountEntryInput, CountSheet, STOCK_COUNTS_KEY, countSheetState } from './CountSheet';
import { StockTakesTab } from './StockTakesTab';

function render(node: ReactNode, seed: Array<[readonly unknown[], unknown]>): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  for (const [key, data] of seed) qc.setQueryData(key, data);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ToastProvider>{node}</ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const consoleError = console.error;
beforeAll(() => {
  vi.spyOn(console, 'error').mockImplementation((msg: unknown, ...rest: unknown[]) => {
    if (String(msg).includes('useLayoutEffect does nothing on the server')) return;
    consoleError(msg, ...rest);
  });
});
afterAll(() => vi.restoreAllMocks());

const summary = (over: Partial<StockCountSummary>): StockCountSummary => ({
  id: 'c1',
  scope: 'key_items',
  status: 'done',
  startedAt: '2026-09-21T01:00:00.000Z',
  finishedAt: '2026-09-21T01:40:00.000Z',
  countedByName: 'Test Manager',
  notes: null,
  lineCount: 6,
  countedCount: 6,
  shortCents: 240_000,
  overCents: 7_500,
  thisTill: true,
  ...over,
});

const line = (over: Partial<StockCountLine> & Pick<StockCountLine, 'ingredientId' | 'name'>): StockCountLine => ({
  unit: 'g',
  shelf: 'cheese',
  packSize: null,
  countedQty: null,
  expectedQty: null,
  expectedFrom: null,
  tillQty: null,
  differenceQty: null,
  differenceCents: null,
  valueCents: null,
  unitCostMc: null,
  ...over,
});

describe('Inventory → Stock takes', () => {
  it('the list: start one, carry on the one being counted, and what each finished one found', () => {
    const html = render(<StockTakesTab />, [
      [
        [...STOCK_COUNTS_KEY, 'list'],
        [summary({ id: 'open', status: 'open', finishedAt: null, countedCount: 2, shortCents: null, overCents: null, scope: 'full', lineCount: 90 }), summary({})],
      ],
    ]);
    for (const text of ['Count the key items', 'Full stock take', 'Pick what to count', 'Being counted: Full stock take', '2 of 90 counted', 'Carry on counting', 'Key items', 'Rs 2,400 short, Rs 75 over']) {
      expect(html).toContain(text);
    }
  });

  it('the count sheet: shelf by shelf, a blank box per line in kilos or packs, and nothing of what the till expects', () => {
    const count: StockCountDetail = {
      ...summary({ id: 'c2', status: 'open', finishedAt: null, countedCount: 1, shortCents: null, overCents: null }),
      lines: [
        line({ ingredientId: 'mozz', name: 'Test mozzarella', packSize: 2_000, countedQty: 2_350 }),
        line({ ingredientId: 'chick', name: 'Test chicken', shelf: 'meat' }),
        line({ ingredientId: 'box', name: 'Test pizza box', shelf: 'packaging', unit: 'pcs', packSize: 50 }),
      ],
    };
    const html = render(<CountSheet countId="c2" onClose={() => {}} onDone={() => {}} />, [[[...STOCK_COUNTS_KEY, 'one', 'c2'], count]]);
    for (const text of ['Cheese &amp; Dairy', 'Meat &amp; Chicken', 'Packaging', 'Test mozzarella', 'value="2.35"', '>kg<', '>packs<', 'Finish', 'Cancel stock take', 'A blank box is not counted']) {
      expect(html).toContain(text);
    }
    // One shelf at a time: the first.
    expect(html).not.toContain('Test chicken');
    // A blind sheet: no figure from the till beside the boxes.
    expect(html).not.toMatch(/expected|till count/i);
  });

  it("the Stock button's count box: packs of the pack size plus what is loose", () => {
    const html = renderToStaticMarkup(
      <CountEntryInput id="x" unit="g" packSize={2_000} entry={{ mode: 'packs', amount: '3', loose: '250' }} onChange={() => {}} />,
    );
    expect(html).toContain('packs of 2 kg +');
    expect(html).toContain('value="250"');
    expect(html).toContain('g loose');
    // What it was read as, exactly.
    expect(html).toContain('= 6.25 kg');
  });

  it('a count box says the unit it is in beside it, and what it was read as — "2500" in a kilo box shows as 2,500 kg', () => {
    const kilos = renderToStaticMarkup(<CountEntryInput id="x" unit="g" packSize={null} entry={{ mode: 'big', amount: '2500' }} onChange={() => {}} />);
    expect(kilos).toContain('>kg</span>');
    expect(kilos).toContain('= 2,500 kg');
    const grams = renderToStaticMarkup(<CountEntryInput id="x" unit="g" packSize={null} entry={{ mode: 'base', amount: '2500' }} onChange={() => {}} />);
    expect(grams).toContain('>g</span>');
    expect(grams).toContain('= 2.5 kg');
    // "2,5" in kilos is 2.5 kg (it was read as 25 kg).
    expect(renderToStaticMarkup(<CountEntryInput id="x" unit="g" packSize={null} entry={{ mode: 'big', amount: '2,5' }} onChange={() => {}} />)).toContain('= 2.5 kg');
    // Blank or unreadable: nothing read back.
    expect(renderToStaticMarkup(<CountEntryInput id="x" unit="g" packSize={null} entry={{ mode: 'big', amount: '' }} onChange={() => {}} />)).not.toContain('count-read-back');
    expect(renderToStaticMarkup(<CountEntryInput id="x" unit="g" packSize={null} entry={{ mode: 'big', amount: 'two' }} onChange={() => {}} />)).not.toContain('count-read-back');
  });

  it('one box that cannot be read never holds back the rest: everything else that changed is saved, and its shelf is named', () => {
    const shelves = [
      { shelf: 'cheese', label: 'Cheese & Dairy', lines: [{ ingredientId: 'mozz', unit: 'g', packSize: 2_000 }, { ingredientId: 'cream', unit: 'ml', packSize: null }] },
      { shelf: 'meat', label: 'Meat & Chicken', lines: [{ ingredientId: 'chick', unit: 'g', packSize: null }, { ingredientId: 'patty', unit: 'pcs', packSize: 24 }] },
      { shelf: 'packaging', label: 'Packaging', lines: [{ ingredientId: 'box', unit: 'pcs', packSize: 50 }] },
    ];
    const saved = new Map<string, number | null>([['cream', 1_000]]);
    const state = countSheetState(
      shelves,
      {
        // 2.5 whole packs: can't be read.
        mozz: { mode: 'packs', amount: '2.5', loose: '' },
        cream: { mode: 'big', amount: '1' },
        chick: { mode: 'big', amount: '4.2' },
        patty: { mode: 'packs', amount: '3', loose: '5' },
        box: { mode: 'base', amount: '' },
      },
      saved,
    );
    expect(state.changed).toEqual([
      { ingredientId: 'chick', countedQty: 4_200 },
      { ingredientId: 'patty', countedQty: 77 },
    ]);
    expect(state.problems).toEqual(['mozz']);
    expect(state.problemShelves).toEqual([{ shelf: 'cheese', label: 'Cheese & Dairy', n: 1 }]);
    expect(state.countedNow).toBe(3);
    // Cleared back to blank: saved as blank (null), not skipped.
    expect(countSheetState(shelves, { cream: { mode: 'big', amount: '' } }, saved).changed).toEqual([{ ingredientId: 'cream', countedQty: null }]);
  });
});
