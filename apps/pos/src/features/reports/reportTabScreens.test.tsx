/**
 * The Reports tabs render what their channel sends (costing spec Phase 3):
 * a smoke render (react-dom/server, no browser) of each tab with made-up
 * figures, and the Team tab as a login without costs sees it. Nothing calls
 * the till. Every name and price is made up.
 */
import type { ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { ReportFoodCost, ReportKpis, ReportTabData } from '@cheeseoclock/shared-types';
import { periodFor } from './dateRange';
import { OverviewTab } from './tabs/OverviewTab';
import { WhenTab } from './tabs/WhenTab';
import { MenuTab } from './tabs/MenuTab';
import { ChannelsTab } from './tabs/ChannelsTab';
import { FoodCostStockTab } from './tabs/FoodCostStockTab';
import { TeamLeakageTab } from './tabs/TeamLeakageTab';

const SAT_3PM = new Date('2026-09-26T10:00:00.000Z');
const base = { sinceIso: '2026-09-26T00:00:00.000Z', untilIso: '2026-09-27T00:00:00.000Z', engine: 'worker' as const };

const kpis: ReportKpis = {
  orderCount: 3,
  itemCount: 4,
  menuSalesCents: 300_000,
  discountCents: 0,
  discountedOrderCount: 0,
  taxCents: 0,
  billedCents: 300_000,
  partialRefundCents: 0,
  partialRefundOrderCount: 0,
  netSalesCents: 300_000,
  avgOrderCents: 100_000,
  fullRefundCount: 0,
  fullRefundCents: 0,
  voidCount: 1,
  voidCents: 80_000,
  unpaidCount: 0,
  unpaidCents: 0,
  payments: { cash: 200_000, card: 0, foodpanda: 0, transfer: 100_000 },
  unrecordedPaymentCents: 0,
};

const food: ReportFoodCost = {
  foodSalesCents: 290_000,
  feeSalesCents: 10_000,
  costOfSalesCents: 87_000,
  knownSalesCents: 290_000,
  knownCostCents: 87_000,
  foodCostBps: 3_000,
  knownMenuSalesCents: 290_000,
  menuFoodCostBps: 3_000,
  coverageBps: 10_000,
  estimatedOrders: 0,
  estimatedCostCents: 0,
  costingStartedAt: '2026-09-20T07:00:00.000Z',
  missingSales: [],
  missingSalesCents: 0,
  wasteCents: 18_000,
  wasteByReason: [{ reason: 'cancelled_made', times: 1, cents: 18_000 }],
  wasteIngredients: [],
  cancelledWasteCents: 18_000,
  cancelledOrderCount: 1,
  putBackAfterCookingCount: 0,
  sentNotPaid: { orderCount: 0, costCents: 0, estimatedOrders: 0 },
  stillOpen: { orderCount: 0, costCents: 0, estimatedOrders: 0 },
  hasCosts: true,
  hasUsage: true,
};

const team = (withCosts: boolean): ReportTabData['team'] => ({
  ...base,
  kpis: { netSalesCents: 300_000, menuSalesCents: 300_000, partialRefundCents: 0, fullRefundCents: 0, voidCount: 1, voidCents: 80_000 },
  staff: [{ key: 'u1', name: 'Ali', isWebsite: false, orderCount: 3, netSalesCents: 300_000, discountCents: 0, voidCount: 1, noSaleOpens: 0, reprints: 0 }],
  shifts: [],
  discounts: { totalCount: 0, totalCents: 0, byReason: [], byPerson: [], recent: [] },
  refunds: [],
  voids: [
    {
      orderId: 'o9',
      orderNumber: '20260926-0009',
      createdAt: '2026-09-26T09:00:00.000Z',
      voidedAt: '2026-09-26T09:10:00.000Z',
      amountCents: 80_000,
      reason: 'Not collected',
      approvedBy: 'Sara',
      takenBy: 'Ali',
      stock: { outcome: 'wasted', answer: 'made', wasteCents: withCosts ? 18_000 : 0, statusBefore: 'ready', flagged: false },
      billPrinted: false,
    },
  ],
  drawerOpens: [],
  drawerOpenCount: 0,
  foodCost: withCosts ? { hasCosts: true } : null,
});

const html = (node: ReactNode) => renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);

describe('the Reports tabs render their own figures', () => {
  it('Overview: the headline, how customers paid, and website vs till', () => {
    const out = html(
      <OverviewTab
        data={{
          ...base,
          kpis,
          previous: null,
          channels: [
            { channel: 'takeaway', orderCount: 2, netSalesCents: 200_000 },
            { channel: 'web_delivery', orderCount: 1, netSalesCents: 100_000 },
          ],
        }}
      />,
    );
    expect(out).toContain('How customers paid');
    expect(out).toContain('Website vs till');
    expect(out).toContain('Website (pick-up and delivery)');
    // While the first figures load, the tiles are there (loading).
    expect(html(<OverviewTab data={undefined} />)).toContain('Average order');
  });

  it('When, Menu, Channels & delivery', () => {
    const period = periodFor('today', SAT_3PM);
    expect(
      html(
        <WhenTab
          data={{ ...base, kpis: { orderCount: 3, netSalesCents: 300_000 }, byDay: [{ day: '2026-09-26', orderCount: 3, netSalesCents: 300_000 }], byHour: [{ hour: 20, orderCount: 3, netSalesCents: 300_000 }] }}
          period={period}
          now={SAT_3PM}
        />,
      ),
    ).toContain('When you sell');
    const menu = html(
      <MenuTab
        data={{
          ...base,
          kpis: { menuSalesCents: 300_000, itemCount: 4 },
          items: [{ key: 'm1', name: 'Test Pizza', categoryId: 'c1', categoryName: 'Pizzas', quantity: 4, salesCents: 300_000 }],
          categories: [{ categoryId: 'c1', name: 'Pizzas', quantity: 4, salesCents: 300_000 }],
        }}
      />,
    );
    expect(menu).toContain('What sells');
    expect(menu).toContain('Test Pizza');
    const channels = html(
      <ChannelsTab
        data={{
          ...base,
          kpis: { orderCount: 3, netSalesCents: 300_000, avgOrderCents: 100_000 },
          channels: [{ channel: 'delivery', orderCount: 3, netSalesCents: 300_000 }],
          deliveries: { byRider: [{ riderId: 'r1', name: 'Bilal', deliveries: 3, netSalesCents: 300_000, avgMinutesOut: 25 }], byArea: [] },
        }}
      />,
    );
    expect(channels).toContain('Where orders come from');
    expect(channels).toContain('Bilal');
  });

  it('Food cost & stock, and the ingredients running low', () => {
    const out = html(<FoodCostStockTab data={{ ...base, kpis: { partialRefundCents: 0 }, foodCost: food }} lowStockCount={2} />);
    expect(out).toContain('Food cost');
    expect(out).toContain('30%');
    expect(out).toContain('2 ingredients are running low right now.');
  });

  it('Team & leakage: waste rupees on the Stock column only for a login with costs', () => {
    const withCosts = html(<TeamLeakageTab data={team(true)} />);
    expect(withCosts).toContain('Staff and cash drawer');
    expect(withCosts).toContain('Refunds and cancelled orders');
    expect(withCosts).toContain('Wasted · Rs 180');
    const without = html(<TeamLeakageTab data={team(false)} />);
    expect(without).toContain('Wasted');
    expect(without).not.toContain('Rs 180');
  });
});
