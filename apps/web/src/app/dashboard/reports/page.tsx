import type { Metadata } from 'next';
import { WASTE_REASON_DEFAULT_LABEL } from '@cheeseoclock/shared-types';
import { BarList, ShareBar, StepList, type Step } from '@/components/dashboard/bars';
import { ColumnChart, Heatmap, type ColumnPoint } from '@/components/dashboard/charts';
import { PeriodBar } from '@/components/dashboard/PeriodBar';
import { Shell } from '@/components/dashboard/Shell';
import { Card, Empty, Note, PageHeader, Row, StatTile, TD, TD_NUM, TH, TableWrap } from '@/components/dashboard/ui';
import {
  CAME_BY_WORDS,
  CHANNEL_WORDS,
  METHOD_WORDS,
  PROFIT_STEP_WORDS,
  bpsPercent,
  changePercent,
  count,
  counted,
  hourWord,
  money,
  moneyWhole,
  percent,
  wasteWord,
} from '@/lib/dashboard/format';
import { dayLabel, eachDay, periodFrom, todayOf, weekStart } from '@/lib/dashboard/period';
import { seesCosts, seesProfit, seesReports } from '@/lib/dashboard/perms';
import {
  getCameBy,
  getCategories,
  getChannels,
  getDeliveries,
  getDeliveryCharges,
  getFirstDay,
  getFoodFigures,
  getHeatmap,
  getPaymentMethods,
  getSalesByDay,
  getSalesByHour,
  getSalesSummary,
  getStaff,
  getTopItems,
} from '@/lib/dashboard/queries';
import { requireUser } from '@/lib/dashboard/session';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Reports' };

/** The website and its two kinds of order are one channel on the share bar (four colours at most). */
const SHARE_ORDER = ['takeaway', 'delivery', 'website', 'foodpanda'];
const shareKey = (channel: string) => (channel === 'web_delivery' || channel === 'web_pickup' ? 'website' : channel);
const SHARE_WORDS: Record<string, string> = { takeaway: 'Takeaway', delivery: 'Delivery', website: 'Website', foodpanda: 'foodpanda' };

export default async function ReportsPage({ searchParams }: { searchParams: { p?: string; from?: string; to?: string } }) {
  const user = await requireUser('/dashboard/reports');
  if (!seesReports(user)) {
    return (
      <Shell user={user}>
        <PageHeader title="Reports" />
        <Empty title="Reports are the owner’s">The owner can let you see them from the till: Settings → Online orders → Phone dashboard.</Empty>
      </Shell>
    );
  }
  const now = new Date();
  const today = todayOf(now);
  const period = periodFrom(searchParams, now);
  const prev = period.previous;
  const costs = seesCosts(user);
  const [first, summary, before, byDay, byHour, heat, channels, cameBy, methods, items, categories, staff, deliveries, charges, food] = await Promise.all([
    getFirstDay(),
    getSalesSummary(period.from, period.to),
    getSalesSummary(prev.from, prev.to),
    getSalesByDay(period.from, period.to),
    getSalesByHour(period.from, period.to),
    period.days >= 7 ? getHeatmap(period.from, period.to) : Promise.resolve([]),
    getChannels(period.from, period.to),
    getCameBy(period.from, period.to),
    getPaymentMethods(period.from, period.to),
    getTopItems(period.from, period.to, 15),
    getCategories(period.from, period.to),
    getStaff(period.from, period.to),
    getDeliveries(period.from, period.to),
    getDeliveryCharges(period.from, period.to),
    costs ? getFoodFigures(period.from, period.to) : Promise.resolve(null),
  ]);
  const vs = `vs ${prev.label}`;
  // The tills' records start inside the period before: a change against part of a period would mislead.
  const comparable = first !== null && first <= prev.from;
  const none = first ? `the records start ${dayLabel(first)}, nothing full to compare` : undefined;
  const delta = (now_: number, then: number) => ({ pct: comparable ? changePercent(now_, then) : null, vs, none });

  // Sales over time: by hour for one day, by day up to two months, by week beyond.
  let timePoints: ColumnPoint[];
  let timeTitle: string;
  if (period.days === 1) {
    const used = byHour.map((h) => (h.hour + 19) % 24);
    const order = Array.from({ length: 24 }, (_, i) => (i + 5) % 24);
    const span = used.length > 0 ? order.slice(Math.min(...used), Math.max(...used) + 1) : [];
    timePoints = span.map((h) => {
      const x = byHour.find((p) => p.hour === h);
      return { key: String(h), axis: hourWord(h).replace(' ', ''), title: hourWord(h), value: x?.netCents ?? 0, extra: counted(x?.orders ?? 0, 'order') };
    });
    timeTitle = 'Sales by hour';
  } else if (period.days <= 62) {
    timePoints = eachDay(period.from, period.to).map((d) => {
      const x = byDay.find((p) => p.day === d);
      return { key: d, axis: String(Number(d.slice(8))), title: dayLabel(d), value: x?.netCents ?? 0, extra: counted(x?.orders ?? 0, 'order') };
    });
    timeTitle = 'Sales by day';
  } else {
    const weeks = new Map<string, { net: number; orders: number }>();
    for (const d of eachDay(period.from, period.to)) weeks.set(weekStart(d), weeks.get(weekStart(d)) ?? { net: 0, orders: 0 });
    for (const p of byDay) {
      const w = weeks.get(weekStart(p.day));
      if (w) {
        w.net += p.netCents;
        w.orders += p.orders;
      }
    }
    timePoints = [...weeks.entries()].map(([w, v]) => ({ key: w, axis: dayLabel(w).split(' ').slice(1).join(' '), title: `Week of ${dayLabel(w)}`, value: v.net, extra: counted(v.orders, 'order') }));
    timeTitle = 'Sales by week';
  }

  const share = new Map<string, { net: number; orders: number }>();
  for (const c of channels) {
    const k = shareKey(c.key);
    const cur = share.get(k) ?? { net: 0, orders: 0 };
    cur.net += c.netCents;
    cur.orders += c.orders;
    share.set(k, cur);
  }
  const moneyIn = methods.filter((m) => m.cents > 0);
  const handedBack = summary.partRefundCents + summary.fullRefundCents;

  const steps: Step[] = [];
  if (food?.profit) {
    for (const s of food.profit.steps) steps.push({ key: s.key, label: PROFIT_STEP_WORDS[s.key] ?? s.key, cents: s.cents, shown: s.key === 'sales' ? money(s.cents) : `${s.cents < 0 ? '−' : '+'} ${money(Math.abs(s.cents))}` });
    steps.push({ key: 'profit', label: 'Profit before overheads', cents: food.profit.profitCents, shown: money(food.profit.profitCents), total: true });
  }
  const salesStep = food?.profit?.steps.find((s) => s.key === 'sales')?.cents ?? 0;

  return (
    <Shell user={user}>
      <PageHeader title="Reports" sub={`${period.label}${period.days > 1 ? ` · ${period.days} days` : ''} · compared with ${prev.label}`} />
      <PeriodBar period={period} base="/dashboard/reports" today={today} />

      <div className="mb-4 grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <StatTile label="Sales" value={moneyWhole(summary.netCents)} delta={delta(summary.netCents, before.netCents)} />
        <StatTile label="Orders" value={count(summary.orders)} delta={delta(summary.orders, before.orders)} />
        <StatTile label="Average order" value={summary.orders > 0 ? moneyWhole(summary.avgCents) : '–'} delta={delta(summary.avgCents, before.avgCents)} />
        <StatTile label="Items sold" value={count(summary.items)} delta={delta(summary.items, before.items)} />
      </div>

      {summary.orders === 0 ? (
        <Empty title="No sales in this period">Pick another period above.</Empty>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <Card title={timeTitle} sub="Sales after refunds, with tax" className="lg:col-span-2">
            <ColumnChart points={timePoints} caption={timeTitle} highlightKey={period.days === 1 ? undefined : today} />
          </Card>

          {heat.length > 0 ? (
            <Card title="Busy hours" sub="Sales by weekday and hour, darker is busier" className="lg:col-span-2">
              <Heatmap caption="Sales by weekday and hour" cells={heat.map((c) => ({ dow: c.dow, hour: c.hour, value: c.netCents, orders: c.orders }))} />
            </Card>
          ) : null}

          <Card title="Where the orders came from">
            <ShareBar
              order={SHARE_ORDER}
              slices={[...share.entries()].map(([k, v]) => ({ key: k, label: SHARE_WORDS[k] ?? CHANNEL_WORDS[k] ?? k, value: v.net, shown: money(v.net) }))}
            />
            <div className="mt-4">
              <BarList
                rows={channels.map((c) => ({
                  key: c.key,
                  label: CHANNEL_WORDS[c.key] ?? c.key,
                  value: c.netCents,
                  shown: money(c.netCents),
                  sub: `${counted(c.orders, 'order')} · ${money(c.orders > 0 ? Math.round(c.netCents / c.orders) : 0)} average`,
                }))}
              />
            </div>
          </Card>

          <Card title="How customers reached you" sub="Asked at the till (the website and foodpanda say so themselves)">
            <BarList
              rows={cameBy.map((c) => ({
                key: c.key,
                label: CAME_BY_WORDS[c.key] ?? c.key,
                value: c.orders,
                shown: counted(c.orders, 'order'),
                sub: `${money(c.netCents)} · ${percent(c.orders, summary.orders)} of orders`,
              }))}
            />
          </Card>

          <Card title="How they paid" sub={handedBack > 0 ? `Money taken; ${money(handedBack)} was handed back in refunds` : 'Money taken'}>
            <BarList
              rows={moneyIn.map((m) => ({
                key: m.method,
                label: METHOD_WORDS[m.method] ?? m.method,
                value: m.cents,
                shown: money(m.cents),
                sub: `${counted(m.orders, 'order')} · ${percent(m.cents, moneyIn.reduce((t, x) => t + x.cents, 0))}`,
              }))}
            />
          </Card>

          <Card title="Best sellers" sub="By what they took at menu price">
            <BarList rows={items.map((i) => ({ key: i.key, label: i.name, value: i.salesCents, shown: money(i.salesCents), sub: `${count(i.qty)} sold${i.category ? ` · ${i.category}` : ''}` }))} />
          </Card>

          <Card title="By category" sub="Items sold at menu price">
            <BarList rows={categories.map((c) => ({ key: c.key, label: c.key, value: c.netCents, shown: money(c.netCents), sub: `${count(c.orders)} sold` }))} />
            {charges.count > 0 ? <Note>Plus {count(charges.count)} delivery charges: {money(charges.cents)}.</Note> : null}
          </Card>

          <Card title="Discounts, refunds and cancels">
            <div className="text-sm">
              <Row label={`Discounts given (${counted(summary.discountedOrders, 'order')})`} value={money(summary.discountCents)} />
              <Row label={`Part refunds (${counted(summary.partRefundOrders, 'order')})`} value={money(summary.partRefundCents)} />
              <Row label={`Full refunds (${counted(summary.fullRefunds, 'order')})`} value={money(summary.fullRefundCents)} />
              <Row label={`Cancelled (${counted(summary.cancels, 'order')})`} value={money(summary.cancelCents)} />
              <Row label={`Not paid yet (${counted(summary.unpaid, 'order')})`} value={money(summary.unpaidCents)} />
              <Row label="Tax collected" value={money(summary.taxCents)} muted />
            </div>
          </Card>

          <Card title="Team" sub="Orders each person took" flush className="lg:col-span-2">
            <TableWrap caption="Orders by the person who took them">
              <thead className="border-y border-dash-line bg-dash-sunk">
                <tr>
                  <th className={TH}>Who</th>
                  <th className={`${TH} text-right`}>Orders</th>
                  <th className={`${TH} text-right`}>Sales</th>
                  <th className={`${TH} text-right`}>Discounts</th>
                  <th className={`${TH} text-right`}>Cancelled</th>
                </tr>
              </thead>
              <tbody>
                {staff.map((s) => (
                  <tr key={s.name} className="border-b border-dash-line last:border-0">
                    <td className={`${TD} font-medium text-dash-ink`}>{s.name}</td>
                    <td className={TD_NUM}>{count(s.orders)}</td>
                    <td className={TD_NUM}>{money(s.netCents)}</td>
                    <td className={TD_NUM}>{s.discountCents > 0 ? money(s.discountCents) : '–'}</td>
                    <td className={TD_NUM}>{s.cancels > 0 ? count(s.cancels) : '–'}</td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
          </Card>

          {deliveries.areas.length > 0 ? (
            <>
              <Card title="Deliveries by area">
                <BarList rows={deliveries.areas.map((a) => ({ key: a.key, label: a.key, value: a.orders, shown: counted(a.orders, 'order'), sub: money(a.netCents) }))} />
              </Card>
              <Card title="Deliveries by rider">
                <BarList rows={deliveries.riders.map((r) => ({ key: r.key, label: r.key, value: r.orders, shown: counted(r.orders, 'order'), sub: money(r.netCents) }))} />
              </Card>
            </>
          ) : null}

          {food ? (
            <Card title="Food cost and waste" sub="Worked out by the till, day by day" className={seesProfit(user) ? '' : 'lg:col-span-2'}>
              {food.daysWithFigures === 0 ? (
                <p className="text-sm text-dash-muted">No food cost figures for this period yet (a till sends them once it has the update).</p>
              ) : (
                <>
                  <p className="text-xs font-medium text-dash-muted">Food cost</p>
                  <p className="text-3xl font-semibold tracking-tight text-dash-ink">{bpsPercent(food.knownSalesCents > 0 ? Math.round((food.knownCostCents * 10_000) / food.knownSalesCents) : null)}</p>
                  <p className="text-sm text-dash-soft">
                    of food sales, on the {percent(food.knownSalesCents, food.foodSalesCents)} whose cost is known
                  </p>
                  <div className="mt-3 text-sm">
                    <Row label="Food sales (before tax)" value={money(food.foodSalesCents)} />
                    <Row label="Cost of that food" value={money(food.costOfSalesCents)} />
                    {food.estimatedOrders > 0 ? <Row label={`Of it estimated (${counted(food.estimatedOrders, 'older order')})`} value={money(food.estimatedCostCents)} muted /> : null}
                    <Row label="Waste" value={money(food.wasteCents)} />
                    {food.purchasesCents > 0 ? <Row label="Stock bought" value={money(food.purchasesCents)} muted /> : null}
                  </div>
                  {food.wasteByReason.length > 0 ? (
                    <div className="mt-3">
                      <p className="mb-1 text-xs font-semibold text-dash-muted">Waste by reason</p>
                      <BarList
                        rows={food.wasteByReason.map((w) => ({
                          key: w.reason,
                          label: wasteWord(w.reason, WASTE_REASON_DEFAULT_LABEL),
                          value: Math.abs(w.cents),
                          shown: money(Math.abs(w.cents)),
                          sub: counted(w.times, 'time'),
                        }))}
                      />
                    </div>
                  ) : null}
                </>
              )}
            </Card>
          ) : null}

          {seesProfit(user) && food ? (
            <Card title="Profit" sub="Before rent, salaries and bills (they are not on the till)">
              {food.profit === null || steps.length === 0 ? (
                <p className="text-sm text-dash-muted">No profit figures for this period yet.</p>
              ) : (
                <>
                  <p className="text-3xl font-semibold tracking-tight text-dash-ink">{money(food.profit.profitCents)}</p>
                  <p className="mb-2 text-sm text-dash-soft">{salesStep > 0 ? `${percent(food.profit.profitCents, salesStep)} of sales before tax` : ''}</p>
                  <StepList steps={steps} base={Math.max(salesStep, 1)} />
                </>
              )}
            </Card>
          ) : null}
        </div>
      )}
      <Note>
        Sales are dated by the trading day an order was started ({hourWord(5)} to {hourWord(5)}), and count once paid, after refunds — the
        same as the till’s Reports. Compared with {prev.label}, the same number of days just before.
      </Note>
    </Shell>
  );
}
