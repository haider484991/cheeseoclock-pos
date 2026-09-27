/**
 * Reports → When (costing spec Phase 3): sales by day (or by month over two
 * months) and by Pakistan clock hour. The section moved here unchanged from
 * ReportSections.tsx; the tab loads only these figures (reports:when).
 */
import { formatCents } from '@cheeseoclock/pos-domain';
import type { ReportWhenTab } from '@cheeseoclock/shared-types';
import { Clock } from 'lucide-react';
import type { ReportPeriod } from '../dateRange';
import { ColumnChart, ShareBar } from '../charts';
import { DataTable, Panel, Section } from '../reportUi';
import { daySeries, hourLabel, hourSeries, weekdayAverages } from '../reportFormat';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function WhenTab({ data, period, now }: { data: ReportWhenTab; period: ReportPeriod; now: Date }) {
  return <WhenSection report={data} period={period} now={now} />;
}

export function WhenSection({ report, period, now }: { report: Pick<ReportWhenTab, 'kpis' | 'byDay' | 'byHour'>; period: ReportPeriod; now: Date }) {
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
