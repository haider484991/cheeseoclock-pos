/**
 * The Dashboard "This week" card (costing spec Phase 7), rendered to static
 * markup (react-dom/server, no browser, nothing asks the till):
 *   - hidden until tapped: the first render has the button and no figure;
 *   - not there at all for a cashier;
 *   - the figures: at most five numbers (each with how it moved, never
 *     last week's amount too) and the "Do this" list, never profit; without
 *     costs, no food cost, no waste and no cost line;
 *   - missing costs' rupees read as food cost not seen yet, not as a loss;
 *     a key ingredient at or below zero reads as out on the till's count.
 * Every name and price is made up.
 */
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import type { OwnerWeek } from '@cheeseoclock/shared-types';
import { OwnerWeekPanel, OwnerWeekView } from './OwnerWeekCard';
import type { CardLogin } from './ownerCardClock';

const html = (node: ReactNode) =>
  renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>{node}</MemoryRouter>
    </QueryClientProvider>,
  );

const MANAGER: CardLogin = { who: 'u_mgr:manager', stepInEndsAt: null, stepInHeld: false };

/** A manager's week, made up: every kind of "Do this" line. */
const WEEK: OwnerWeek = {
  week: 'this',
  sinceIso: '2026-09-28T00:00:00.000Z',
  untilIso: '2026-09-30T10:00:00.000Z',
  compareSinceIso: '2026-09-21T00:00:00.000Z',
  compareUntilIso: '2026-09-23T10:00:00.000Z',
  firstDay: '2026-09-28',
  lastDay: '2026-10-04',
  isCurrent: true,
  engine: 'worker',
  current: { netSalesCents: 4_560_000, orderCount: 38, avgOrderCents: 120_000 },
  previous: { netSalesCents: 4_000_000, orderCount: 40, avgOrderCents: 100_000 },
  change: { sales: { kind: 'pct', bps: 1_400 }, orders: { kind: 'pct', bps: -500 }, avgOrder: { kind: 'pct', bps: 2_000 } },
  costs: { foodCostBps: 2_910, coverageBps: 9_400, wasteCents: 185_000, hasCosts: true },
  doThis: [
    { kind: 'low_stock', key: 'low_stock:i1', weekCents: null, pinned: true, cost: false, ingredientId: 'i1', name: 'Test cheese', unit: 'g', currentQty: 2_400, lowThreshold: 5_000 },
    { kind: 'red_item', key: 'red_item:m1', weekCents: 120_000, pinned: false, cost: true, menuItemId: 'm1', name: 'Test Fajita — Large', foodCostBps: 3_900, targetBps: 3_000, soldLast28: 40 },
    { kind: 'price_alert', key: 'price_alert:a1', weekCents: 60_000, pinned: false, cost: true, alertId: 'a1', alertKind: 'price_jump', ingredientName: 'Test chicken', changeBps: 1_800, dishes: 6 },
    { kind: 'missing_costs', key: 'missing_costs', weekCents: 45_000, pinned: false, cost: true, things: 4, dishes: 3 },
  ],
  doThisMore: 0,
  doThisFailed: [],
  // The card never asks for the sheet's lines.
  sheet: null,
};

/** The page's words without its markup. */
const text = (markup: string) => markup.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ').trim();

describe('the "This week" card', () => {
  it('is hidden until tapped: the button, and no figure at all', () => {
    const out = html(<OwnerWeekPanel login={MANAGER} canSeeReports canSeeCosts canOpenStock />);
    expect(out).toContain('This week');
    expect(out).toContain('Show this week&#x27;s figures');
    expect(out).toContain('Hidden until you tap');
    expect(out).not.toContain('Rs ');
    expect(out).not.toContain('Do this');
    expect(out).not.toContain('Food cost');
  });

  it('is not there for a cashier (no report.view), nor on the PIN pad', () => {
    expect(html(<OwnerWeekPanel login={{ ...MANAGER, who: 'u_cash:cashier' }} canSeeReports={false} canSeeCosts={false} canOpenStock={false} />)).toBe('');
    expect(html(<OwnerWeekPanel login={{ ...MANAGER, who: null }} canSeeReports canSeeCosts canOpenStock />)).toBe('');
  });

  it('five numbers means five: each figure with how it moved, and not last week\'s amount beside it', () => {
    const out = text(html(<OwnerWeekView week={{ ...WEEK, doThis: [] }} canSeeCosts canOpenStock />));
    expect(out).not.toMatch(/\bwas\b/);
    // Every figure on the card: the five values, how the first three moved, and how much of the food cost is known.
    const figures = out.match(/Rs [\d,]+(\.\d+)?|\d[\d,.]*%?/g);
    expect(figures).toEqual(['Rs 45,600', '14%', '38', '5%', 'Rs 1,200', '20%', '29.1%', '94%', 'Rs 1,850']);
  });

  it('tapped: five numbers and one ranked "Do this" list with rupees a week; never profit', () => {
    const out = html(<OwnerWeekView week={WEEK} canSeeCosts canOpenStock onOpen={() => {}} />);
    for (const label of ['Sales', 'Orders', 'Average order', 'Food cost', 'Waste']) expect(out).toContain(label);
    // The tile keeps "Rs" and its number together (a no-break space); read as text.
    expect(text(out)).toContain('Rs 45,600');
    expect(out).toContain('▲ 14%');
    expect(out).toContain('costs known for 94%');
    expect(out).toContain('Running low: Test cheese');
    expect(out).toContain('Test Fajita — Large costs too much to make');
    expect(out).toContain('Rs 1,200 a week');
    expect(out).toContain('Test chicken went up 18%');
    expect(out).toContain('Fill in 4 missing costs');
    expect(out).toContain('Open stock');
    expect(out).not.toMatch(/profit|you keep/i);
  });

  it("missing costs' rupees are food cost the till can't see yet, not a loss: said so, and not in red", () => {
    const out = html(<OwnerWeekView week={{ ...WEEK, doThis: WEEK.doThis.filter((i) => i.kind === 'missing_costs') }} canSeeCosts canOpenStock />);
    expect(text(out)).toContain("The rupees are roughly their food cost a week, which the till can't see yet: not money lost.");
    expect(out).toMatch(/<span class="[^"]*text-stone-600[^"]*">about Rs 450 a week<\/span>/);
    // Nothing in the list is drawn as a loss (the tiles' own changes are another matter).
    expect(out.slice(out.indexOf('Do this'))).not.toContain('text-red-700');
    // A real loss stays red.
    const loss = html(<OwnerWeekView week={{ ...WEEK, doThis: WEEK.doThis.filter((i) => i.kind === 'red_item') }} canSeeCosts canOpenStock />);
    expect(loss).toMatch(/<span class="[^"]*text-red-700[^"]*">Rs 1,200 a week<\/span>/);
  });

  it("a key ingredient at or below zero on the till's count: out, and what to do — not \"0 g left, you reorder at 0 g\"", () => {
    const out = text(
      html(
        <OwnerWeekView
          week={{
            ...WEEK,
            doThis: [{ kind: 'low_stock', key: 'low_stock:i2', weekCents: null, pinned: true, cost: false, ingredientId: 'i2', name: 'Test mozzarella', unit: 'g', currentQty: -3_000, lowThreshold: 0 }],
          }}
          canSeeCosts
          canOpenStock
        />,
      ),
    );
    expect(out).toContain("Out on this till's count: Test mozzarella");
    expect(out).toContain('Record the delivery, or count it');
    expect(out).not.toContain('reorder at');
    expect(out).not.toContain('0 g left');
  });

  it('without costs: no food cost, no waste, no cost line — even if they were sent', () => {
    const out = html(<OwnerWeekView week={WEEK} canSeeCosts={false} canOpenStock={false} onOpen={() => {}} />);
    expect(out).toContain('Sales');
    expect(out).not.toContain('Food cost');
    expect(out).not.toContain('Waste');
    expect(out).toContain('Running low: Test cheese');
    expect(out).not.toContain('Test Fajita');
    expect(out).not.toContain('a week');
    // Inventory is a manager's screen: no button to it for a login that cannot open it.
    expect(out).not.toContain('Open stock');
  });

  it('"no data then" when the till has no figures for last week', () => {
    const out = html(
      <OwnerWeekView
        week={{ ...WEEK, previous: null, change: { sales: { kind: 'noData' }, orders: { kind: 'noData' }, avgOrder: { kind: 'noData' } }, doThis: [] }}
        canSeeCosts
        canOpenStock
      />,
    );
    expect(out).toContain('No data then');
    expect(out).toContain('Nothing needs you right now.');
  });
});
