/**
 * The Reports page, section by section. Each section answers one plain
 * question ("When do we sell?", "What sells?") from the one BusinessReport
 * the page fetched — nothing here queries or recalculates money.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { cn } from '@cheeseoclock/ui';
import { formatCents } from '@cheeseoclock/pos-domain';
import type { BusinessReport } from '@cheeseoclock/shared-types';
import {
  Bike,
  Clock,
  Percent,
  Receipt,
  Store,
  UsersRound,
  UtensilsCrossed,
  Wheat,
} from 'lucide-react';
import type { ReportPeriod } from './dateRange';
import { ColumnChart, ShareBar } from './charts';
import { DataTable, Note, Panel, Section, useShowAll } from './reportUi';
import {
  CHANNEL_LABEL,
  DRAWER_OPEN_WHY,
  daySeries,
  fmtMinutes,
  fmtQty,
  fmtWhen,
  hourLabel,
  hourSeries,
  methodLabel,
  percentOf,
  weekdayAverages,
} from './reportFormat';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ------------------------------------------------------------------- when --

export function WhenSection({ report, period, now }: { report: BusinessReport; period: ReportPeriod; now: Date }) {
  const hours = hourSeries(report.byHour);
  const busiest = hours.reduce<(typeof hours)[number] | null>((m, h) => (!m || h.netSalesCents > m.netSalesCents ? h : m), null);
  const days = daySeries(report.byDay, period, now);
  const bestDay = days.bars.reduce<(typeof days.bars)[number] | null>(
    (m, d) => (!m || d.netSalesCents > m.netSalesCents ? d : m),
    null,
  );
  const weekdays = period.days >= 14 ? weekdayAverages(report.byDay, period, now) : [];
  const bestWeekday = weekdays.reduce<(typeof weekdays)[number] | null>(
    (m, d) => (!m || d.avgSalesCents > m.avgSalesCents ? d : m),
    null,
  );
  const hasSales = report.kpis.orderCount > 0;

  return (
    <Section id="when" icon={Clock} title="When you sell" subtitle="Pakistan time. The trading day runs 5 am to 5 am, so a 1 am sale is part of the night before.">
      {!hasSales ? (
        <Panel>
          <p className="py-4 text-center text-sm text-stone-500">No sales in this period yet.</p>
        </Panel>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          <Panel
            title={period.days === 1 ? 'Sales by hour' : 'Busiest hours (all days added up)'}
            note={
              busiest && busiest.netSalesCents > 0
                ? `Busiest hour: ${hourLabel(busiest.hour)} – ${hourLabel((busiest.hour + 1) % 24)}, ${formatCents(busiest.netSalesCents)} from ${plural(busiest.orderCount, 'order')}.`
                : undefined
            }
          >
            <ColumnChart
              ariaLabel="Sales by hour"
              bars={hours.map((h) => ({
                key: String(h.hour),
                label: hourLabel(h.hour).replace(' ', ''),
                title: `${hourLabel(h.hour)}: ${formatCents(h.netSalesCents)} · ${plural(h.orderCount, 'order')}`,
                value: h.netSalesCents,
              }))}
            />
          </Panel>

          {period.days > 1 && (
            <Panel
              title={days.unit === 'day' ? 'Sales by day' : 'Sales by month'}
              note={
                bestDay && bestDay.netSalesCents > 0
                  ? `Best ${days.unit}: ${bestDay.title}, ${formatCents(bestDay.netSalesCents)} from ${plural(bestDay.orderCount, 'order')}.`
                  : undefined
              }
            >
              <ColumnChart
                ariaLabel={days.unit === 'day' ? 'Sales by day' : 'Sales by month'}
                bars={days.bars.map((d) => ({
                  key: d.key,
                  label: d.label,
                  title: `${d.title}: ${formatCents(d.netSalesCents)} · ${plural(d.orderCount, 'order')}`,
                  value: d.netSalesCents,
                }))}
              />
            </Panel>
          )}

          {weekdays.length > 0 && (
            <Panel
              title="An average day, by weekday"
              className="xl:col-span-2"
              note={
                bestWeekday && bestWeekday.avgSalesCents > 0
                  ? `${bestWeekday.weekday} is your strongest day on average. Days you were shut count as zero.`
                  : undefined
              }
            >
              <DataTable
                columns={[{ label: 'Day' }, { label: 'Days in period', right: true }, { label: 'Average orders', right: true }, { label: 'Average sales', right: true }, { label: '', className: 'w-1/3' }]}
                rows={weekdays.map((w) => [
                  w.weekday,
                  w.days,
                  w.avgOrders,
                  formatCents(w.avgSalesCents),
                  <ShareBar key="b" value={w.avgSalesCents} total={Math.max(...weekdays.map((x) => x.avgSalesCents), 1)} />,
                ])}
                empty="No days yet."
              />
            </Panel>
          )}
        </div>
      )}
    </Section>
  );
}

// ------------------------------------------------------------------ items --

export function ItemsSection({ report }: { report: BusinessReport }) {
  const [sortBy, setSortBy] = useState<'sales' | 'qty'>('sales');
  const items = sortBy === 'sales' ? report.items : [...report.items].sort((a, b) => b.quantity - a.quantity || b.salesCents - a.salesCents);
  const { shown, toggle } = useShowAll(items, 10);
  const total = report.kpis.menuSalesCents;

  return (
    <Section
      id="items"
      icon={UtensilsCrossed}
      title="What sells"
      subtitle="At menu price, before order discounts. Refunded-in-full and cancelled orders are left out."
    >
      <div className="grid gap-4 xl:grid-cols-5">
        <Panel className="xl:col-span-3">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold tracking-tight text-stone-700 dark:text-stone-200">Items</h3>
            <div className="flex rounded-lg bg-stone-100 p-0.5 text-xs font-semibold dark:bg-stone-800" role="group" aria-label="Sort items">
              {(['sales', 'qty'] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  aria-pressed={sortBy === s}
                  onClick={() => setSortBy(s)}
                  className={cn(
                    'rounded-md px-3 py-1.5',
                    sortBy === s ? 'bg-white shadow-sm dark:bg-stone-700' : 'text-stone-500',
                  )}
                >
                  {s === 'sales' ? 'Most money' : 'Most sold'}
                </button>
              ))}
            </div>
          </div>
          <DataTable
            columns={[{ label: '#', className: 'w-8 text-stone-400' }, { label: 'Item' }, { label: 'Sold', right: true }, { label: 'Sales', right: true }, { label: 'Share', right: true }]}
            rows={shown.map((i, n) => [
              n + 1,
              <div key="n">
                <div className="font-medium">{i.name}</div>
                <div className="text-xs text-stone-500">{i.categoryName}</div>
              </div>,
              i.quantity,
              formatCents(i.salesCents),
              percentOf(i.salesCents, total),
            ])}
            footer={items.length > 0 ? ['', 'All items', report.kpis.itemCount, formatCents(total), ''] : undefined}
            empty="Nothing sold in this period."
          />
          {toggle}
        </Panel>

        <Panel title="Categories" className="xl:col-span-2">
          {report.categories.length === 0 ? (
            <p className="py-4 text-center text-sm text-stone-500">Nothing sold in this period.</p>
          ) : (
            <ul className="space-y-3">
              {report.categories.map((c) => (
                <li key={c.categoryId ?? c.name}>
                  <div className="mb-1 flex items-baseline justify-between gap-2 text-sm">
                    <span className="truncate font-medium">{c.name}</span>
                    <span className="whitespace-nowrap tabular-nums">
                      {formatCents(c.salesCents)} <span className="text-xs text-stone-500">· {c.quantity} sold</span>
                    </span>
                  </div>
                  <ShareBar value={c.salesCents} total={total} />
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </Section>
  );
}

// --------------------------------------------------------------- channels --

export function ChannelsSection({ report }: { report: BusinessReport }) {
  const net = report.kpis.netSalesCents;
  return (
    <Section id="types" icon={Store} title="Where orders come from">
      <Panel>
        <DataTable
          columns={[{ label: 'Order type' }, { label: 'Orders', right: true }, { label: 'Sales', right: true }, { label: 'Average order', right: true }, { label: 'Share', right: true }, { label: '', className: 'hidden w-1/4 md:table-cell' }]}
          rows={report.channels.map((c) => [
            <span key="l" className="font-medium">{CHANNEL_LABEL[c.channel]}</span>,
            c.orderCount,
            formatCents(c.netSalesCents),
            formatCents(c.orderCount > 0 ? Math.round(c.netSalesCents / c.orderCount) : 0),
            percentOf(c.netSalesCents, net),
            <ShareBar key="b" value={c.netSalesCents} total={net} tone="sky" />,
          ])}
          footer={
            report.channels.length > 0
              ? ['All orders', report.kpis.orderCount, formatCents(net), formatCents(report.kpis.avgOrderCents), '100%', '']
              : undefined
          }
          empty="No sales in this period yet."
        />
      </Panel>
    </Section>
  );
}

// ------------------------------------------------------------------ staff --

/** " · cash in/out 3× · drawer opened 2× with no sale" — what else opened the drawer on a shift. */
function shiftDrawerNote(s: BusinessReport['shifts'][number]): string {
  let note = '';
  if (s.cashMovementCount > 0) note += ` · cash in/out ${s.cashMovementCount}×`;
  if (s.noSaleOpens > 0) note += ` · drawer opened ${s.noSaleOpens}× with no sale`;
  return note;
}

export function StaffSection({ report }: { report: BusinessReport }) {
  const net = report.kpis.netSalesCents;
  const opens = useShowAll(report.drawerOpens, 8);
  const closed = report.shifts.filter((s) => s.closedAt !== null && s.varianceCents !== null);
  const drawer = closed.reduce((sum, s) => sum + (s.varianceCents ?? 0), 0);
  return (
    <Section id="staff" icon={UsersRound} title="Staff and cash drawer">
      <div className="grid gap-4 xl:grid-cols-2">
        <Panel title="Orders taken" note="Website orders come in by themselves, so they have their own line.">
          <DataTable
            columns={[{ label: 'Taken by' }, { label: 'Orders', right: true }, { label: 'Sales', right: true }, { label: 'Discounts', right: true }, { label: 'Cancelled', right: true }, { label: 'No-sale opens', right: true }]}
            rows={report.staff.map((s) => [
              <span key="n" className={cn('font-medium', s.isWebsite && 'text-sky-700 dark:text-sky-300')}>{s.name}</span>,
              s.orderCount,
              <span key="s">
                {formatCents(s.netSalesCents)} <span className="text-xs text-stone-500">{percentOf(s.netSalesCents, net)}</span>
              </span>,
              s.discountCents > 0 ? formatCents(s.discountCents) : '—',
              s.voidCount > 0 ? <span key="v" className="font-semibold text-amber-700 dark:text-amber-400">{s.voidCount}</span> : '—',
              s.noSaleOpens > 0 ? <span key="d" className="font-semibold text-amber-700 dark:text-amber-400">{s.noSaleOpens}</span> : '—',
            ])}
            empty="No orders in this period yet."
          />
        </Panel>

        <Panel
          title="Shifts — cash in the drawer"
          note="Expected = float + cash sales − cash refunds + cash put in − cash taken out. Figures are the ones saved when the shift was closed."
        >
          {closed.length > 0 && (
            <div
              className={cn(
                'mb-3 rounded-lg px-3 py-2 text-sm font-semibold',
                drawer === 0
                  ? 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300'
                  : drawer > 0
                    ? 'bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300'
                    : 'bg-red-50 text-red-800 dark:bg-red-950/40 dark:text-red-300',
              )}
            >
              {drawer === 0
                ? `Every closed drawer matched (${plural(closed.length, 'shift')}).`
                : `${drawer > 0 ? 'Over' : 'Short'} ${formatCents(Math.abs(drawer))} in all, over ${plural(closed.length, 'closed shift')}.`}
            </div>
          )}
          <DataTable
            columns={[{ label: 'Shift' }, { label: 'Float', right: true }, { label: 'Taken out', right: true }, { label: 'Expected', right: true }, { label: 'Counted', right: true }, { label: 'Result', right: true }]}
            rows={report.shifts.map((s) => [
              <div key="w">
                <div className="font-medium">{fmtWhen(s.openedAt)}</div>
                <div className="text-xs text-stone-500">
                  {s.closedAt ? `to ${fmtWhen(s.closedAt)} · closed by ${s.closedBy ?? 'unknown'}` : `still open · opened by ${s.openedBy}`}
                  {shiftDrawerNote(s)}
                </div>
              </div>,
              formatCents(s.openingCashCents),
              s.cashOutCents > 0 ? formatCents(s.cashOutCents) : '—',
              s.expectedCashCents === null ? '—' : formatCents(s.expectedCashCents),
              s.countedCashCents === null ? '—' : formatCents(s.countedCashCents),
              s.varianceCents === null ? (
                '—'
              ) : s.varianceCents === 0 ? (
                <span key="r" className="font-semibold text-emerald-700 dark:text-emerald-400">Matched</span>
              ) : (
                <span key="r" className={cn('font-semibold', s.varianceCents > 0 ? 'text-amber-700 dark:text-amber-400' : 'text-red-700 dark:text-red-400')}>
                  {s.varianceCents > 0 ? 'Over' : 'Short'} {formatCents(Math.abs(s.varianceCents))}
                </span>
              ),
            ])}
            empty="No shifts were opened in this period."
          />
        </Panel>

        <Panel
          title={`Cash drawer opened by hand — ${plural(report.drawerOpenCount, 'time')}`}
          note="Opened with no sale: the Open drawer button, “Open drawer to count” at close, and Test drawer. A cashier needs a manager's PIN or password."
          className="xl:col-span-2"
        >
          <DataTable
            columns={[{ label: 'When' }, { label: 'Why' }, { label: 'Opened by' }, { label: 'Approved by' }]}
            rows={opens.shown.map((d) => [
              <div key="w">
                <div>{fmtWhen(d.createdAt)}</div>
                {d.outsideShift && <div className="text-xs text-amber-700 dark:text-amber-400">No shift open</div>}
              </div>,
              <div key="k">
                <div>{DRAWER_OPEN_WHY[d.kind]}</div>
                {d.reason && <div className="text-xs text-stone-500">{d.reason}</div>}
              </div>,
              d.openedBy,
              d.approvedBy ?? '—',
            ])}
            empty="The drawer was not opened by hand in this period."
          />
          {opens.toggle}
          {report.drawerOpens.length < report.drawerOpenCount && (
            <p className="mt-2 text-xs text-stone-500">
              Showing the latest {report.drawerOpens.length} of {report.drawerOpenCount}. The counts per person and per
              shift include all of them.
            </p>
          )}
        </Panel>
      </div>
    </Section>
  );
}

// -------------------------------------------------------------- discounts --

export function DiscountsSection({ report }: { report: BusinessReport }) {
  const d = report.discounts;
  const { shown, toggle } = useShowAll(d.recent, 8);
  return (
    <Section
      id="discounts"
      icon={Percent}
      title="Discounts given"
      subtitle={
        d.totalCount > 0
          ? `${formatCents(d.totalCents)} off ${plural(d.totalCount, 'order')} — ${percentOf(d.totalCents, report.kpis.menuSalesCents)} of menu-price sales.`
          : undefined
      }
    >
      {d.totalCount === 0 ? (
        <Panel>
          <p className="py-4 text-center text-sm text-stone-500">No discounts in this period.</p>
        </Panel>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          <Panel title="Why">
            <DataTable
              columns={[{ label: 'Reason' }, { label: 'Times', right: true }, { label: 'Amount', right: true }]}
              rows={d.byReason.map((r) => [r.reason, r.count, formatCents(r.amountCents)])}
              empty="None."
            />
          </Panel>
          <Panel title="Who gave them" note="“Manager OK” = a manager's PIN or password approved it.">
            <DataTable
              columns={[{ label: 'Given by' }, { label: 'Times', right: true }, { label: 'Amount', right: true }, { label: 'Manager OK', right: true }]}
              rows={d.byPerson.map((p) => [p.name, p.count, formatCents(p.amountCents), p.approvedCount || '—'])}
              empty="None."
            />
          </Panel>
          <Panel title="Each discount" className="xl:col-span-2">
            <DataTable
              columns={[{ label: 'When' }, { label: 'Order' }, { label: 'Discount', right: true }, { label: 'Reason' }, { label: 'Given by' }, { label: 'Approved by' }]}
              rows={shown.map((x) => [
                fmtWhen(x.createdAt),
                <span key="o" className="font-mono text-xs">{x.orderNumber}</span>,
                <span key="a">
                  {formatCents(x.amountCents)}
                  {x.entered && <span className="ml-1 text-xs text-stone-500">({x.entered})</span>}
                </span>,
                x.reason,
                x.givenBy,
                x.approvedBy ?? '—',
              ])}
              empty="None."
            />
            {toggle}
            {d.recent.length < d.totalCount && (
              <p className="mt-2 text-xs text-stone-500">
                Showing the latest {d.recent.length} of {d.totalCount}. The totals above include all of them.
              </p>
            )}
          </Panel>
        </div>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------- refunds --

export function RefundsSection({ report }: { report: BusinessReport }) {
  const k = report.kpis;
  const refunds = useShowAll(report.refunds, 8);
  const voids = useShowAll(report.voids, 8);
  return (
    <Section
      id="refunds"
      icon={Receipt}
      title="Refunds and cancelled orders"
      subtitle="Refunds are money handed back. Cancelled orders were never paid, so no money moved."
    >
      <div className="grid gap-4 xl:grid-cols-2">
        <Panel
          title={`Refunds — ${formatCents(k.partialRefundCents + k.fullRefundCents)}`}
          note="Listed against the day the order was taken, whenever the money went back."
        >
          <DataTable
            columns={[{ label: 'When' }, { label: 'Amount', right: true }, { label: 'Reason' }, { label: 'Approved by' }]}
            rows={refunds.shown.map((x) => [
              <div key="w">
                <div>{fmtWhen(x.refundedAt)}</div>
                <div className="font-mono text-xs text-stone-500">{x.orderNumber}</div>
              </div>,
              <div key="a">
                <div>{formatCents(x.amountCents)}</div>
                <div className="text-xs text-stone-500">
                  {methodLabel(x.method)} · {x.full ? 'whole order' : 'part'}
                </div>
              </div>,
              x.reason,
              x.approvedBy,
            ])}
            empty="No refunds in this period."
          />
          {refunds.toggle}
        </Panel>
        <Panel title={`Cancelled before payment — ${plural(k.voidCount, 'order')}`} note={k.voidCount > 0 ? `Worth ${formatCents(k.voidCents)} at the time. Not in the sales.` : undefined}>
          <DataTable
            columns={[{ label: 'When' }, { label: 'Value', right: true }, { label: 'Reason' }, { label: 'Approved by' }, { label: 'Taken by' }]}
            rows={voids.shown.map((v) => [
              <div key="w">
                <div>{fmtWhen(v.voidedAt ?? v.createdAt)}</div>
                <div className="font-mono text-xs text-stone-500">{v.orderNumber}</div>
              </div>,
              formatCents(v.amountCents),
              v.reason,
              v.approvedBy,
              v.takenBy,
            ])}
            empty="No cancelled orders in this period."
          />
          {voids.toggle}
        </Panel>
      </div>
    </Section>
  );
}

// -------------------------------------------------------------- food cost --

export function FoodCostSection({ report, lowStockCount }: { report: BusinessReport; lowStockCount: number | null }) {
  const f = report.foodCost;
  const salesExTax = report.kpis.netSalesCents - report.kpis.taxCents;
  const { shown, toggle } = useShowAll(f.ingredients, 12);
  const lowStock =
    lowStockCount !== null && lowStockCount > 0 ? (
      <Note tone="warn">
        {plural(lowStockCount, 'ingredient is', 'ingredients are')} running low right now.{' '}
        <Link to="/inventory" className="font-semibold underline">
          Open Inventory
        </Link>
      </Note>
    ) : null;

  return (
    <Section
      id="food"
      icon={Wheat}
      title="Ingredients and food cost"
      subtitle="What went out of stock with the sales. Valued at today's ingredient prices in Inventory, so it is an estimate."
    >
      {!f.hasUsage ? (
        <div className="space-y-3">
          <Panel>
            <p className="py-4 text-center text-sm text-stone-500">
              No ingredient use recorded in this period. Items need recipes in Inventory before their ingredients are counted.
            </p>
          </Panel>
          {lowStock}
        </div>
      ) : (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-3">
            <Panel>
              <div className="text-[11px] font-semibold uppercase tracking-widest text-stone-500">Food cost</div>
              <div className="mt-1 text-2xl font-bold tabular-nums">{f.hasCosts ? formatCents(f.usedCents) : '—'}</div>
            </Panel>
            <Panel>
              <div className="text-[11px] font-semibold uppercase tracking-widest text-stone-500">Of sales before tax</div>
              <div className="mt-1 text-2xl font-bold tabular-nums">{f.hasCosts && salesExTax > 0 ? percentOf(f.usedCents, salesExTax) : '—'}</div>
            </Panel>
            <Panel>
              <div className="text-[11px] font-semibold uppercase tracking-widest text-stone-500">Wasted</div>
              <div className="mt-1 text-2xl font-bold tabular-nums">{f.wasteCents > 0 ? formatCents(f.wasteCents) : '—'}</div>
            </Panel>
          </div>
          {!f.hasCosts && <Note>No prices are set on these ingredients yet. Add what you pay for them in Inventory to see the food cost.</Note>}
          {lowStock}
          <Panel>
            <DataTable
              columns={[{ label: 'Ingredient' }, { label: 'Used', right: true }, { label: 'Cost', right: true }, { label: 'Wasted', right: true }, { label: 'Waste cost', right: true }]}
              rows={shown.map((i) => [
                <span key="n" className="font-medium">{i.name}</span>,
                fmtQty(i.usedQty, i.unit),
                i.usedCents ? formatCents(i.usedCents) : '—',
                i.wastedQty ? fmtQty(i.wastedQty, i.unit) : '—',
                i.wastedCents ? formatCents(i.wastedCents) : '—',
              ])}
              footer={['All ingredients', '', formatCents(f.usedCents), '', f.wasteCents ? formatCents(f.wasteCents) : '—']}
              empty="None."
            />
            {toggle}
          </Panel>
        </div>
      )}
    </Section>
  );
}

// ------------------------------------------------------------- deliveries --

export function DeliveriesSection({ report }: { report: BusinessReport }) {
  const riders = report.deliveries.byRider;
  const areas = useShowAll(report.deliveries.byArea, 10);
  return (
    <Section id="deliveries" icon={Bike} title="Deliveries" subtitle="Your own riders — phone and website deliveries. Foodpanda brings its own.">
      {riders.length === 0 ? (
        <Panel>
          <p className="py-4 text-center text-sm text-stone-500">No deliveries in this period.</p>
        </Panel>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          <Panel title="By rider" note="Time on the road = from “out for delivery” to “delivered”, when both were marked.">
            <DataTable
              columns={[{ label: 'Rider' }, { label: 'Deliveries', right: true }, { label: 'Sales', right: true }, { label: 'Avg time', right: true }]}
              rows={riders.map((r) => [
                <span key="n" className={cn('font-medium', r.riderId === null && 'text-stone-500')}>{r.name}</span>,
                r.deliveries,
                formatCents(r.netSalesCents),
                fmtMinutes(r.avgMinutesOut),
              ])}
              empty="None."
            />
          </Panel>
          <Panel title="By area">
            <DataTable
              columns={[{ label: 'Area' }, { label: 'Orders', right: true }, { label: 'Sales', right: true }]}
              rows={areas.shown.map((a) => [a.area, a.orderCount, formatCents(a.netSalesCents)])}
              empty="None."
            />
            {areas.toggle}
          </Panel>
        </div>
      )}
    </Section>
  );
}
