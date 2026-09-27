/**
 * Reports → Overview, Phase 7 (costing spec 4.10): the trend strip — today,
 * this week, month and year so far against the stretch before, to the
 * minute, and against the same stretch a year ago — and the last 12 months.
 * Not tied to the dates picked above. The weekly owner sheet prints from here.
 *
 * Every figure is on the screen itself, not only in a tooltip (a touch
 * screen has no hover): the 12 months have their table under the bars.
 * Stretches still going (today, this week, this month) are left off the
 * small lines and drawn hollow in the bars, so a day half over never reads
 * as a fall.
 */
import { formatCents } from '@cheeseoclock/pos-domain';
import type { ReportTrendLine, ReportTrends, TrendComparison } from '@cheeseoclock/shared-types';
import { TrendingUp } from 'lucide-react';
import { MonthBars, Sparkline } from '../charts';
import { ChangeText, DataTable, Note, Panel, Section } from '../reportUi';
import { fmtMonth } from '../dateRange';
import { TREND_LABEL, monthNote, trendChangeOf, trendSparklines, type Sparkline as SparklineData } from '../ownerWeekFormat';
import { formatBps } from '../../costing/costingFormat';
import type { ReactNode } from 'react';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function OverviewTrends({ trends, error, sheetButtons }: { trends: ReportTrends | undefined; error?: string | null; sheetButtons?: ReactNode }) {
  return (
    <Section
      id="trends"
      icon={TrendingUp}
      title="How the shop is trending"
      subtitle="Not tied to the dates above. Every figure is for the orders on this till, to the minute."
      action={sheetButtons}
    >
      {error ? (
        <Note tone="warn">{error}</Note>
      ) : !trends ? (
        <Panel>
          <p className="py-4 text-center text-sm text-stone-500">Working out the trends…</p>
        </Panel>
      ) : (
        <TrendsBody trends={trends} />
      )}
    </Section>
  );
}

function TrendsBody({ trends }: { trends: ReportTrends }) {
  const spark = trendSparklines(trends);
  const costs = new Map((trends.monthCosts ?? []).map((m) => [m.month, m]));
  const lastIndex = trends.months.length - 1;
  return (
    <div className="space-y-4">
      {trends.partial && (
        <Note tone="warn">
          The trends are being worked out on the till itself for now, so only stretches of 31 days or less are shown. Restarting the
          till usually fixes this.
        </Note>
      )}
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        {trends.lines.map((line) => (
          <TrendCard key={line.period} line={line} spark={spark[line.period]} />
        ))}
      </div>
      {trends.months.length > 0 && (
        <Panel
          title="The last 12 months"
          note={`Sales by month, tax included, after discounts and refunds. This month is so far (the hollow bar).${
            trends.monthCosts ? ' Food cost as Food cost & stock works it out.' : ''
          }`}
        >
          <MonthBars
            ariaLabel="Sales by month"
            bars={trends.months.map((m, i) => {
              const c = costs.get(m.month);
              const note = monthNote(m, i === lastIndex);
              return {
                key: m.month,
                label: fmtMonth(`${m.month}-01`).slice(0, 3),
                title:
                  note === 'no data then'
                    ? `${fmtMonth(`${m.month}-01`)}: no data then`
                    : `${fmtMonth(`${m.month}-01`)}${note === 'so far' ? ' so far' : ''}: ${formatCents(m.netSalesCents)} · ${plural(m.orderCount, 'order')} · average ${formatCents(m.avgOrderCents)}${c?.foodCostBps != null ? ` · food cost ${formatBps(c.foodCostBps)}` : ''}${note && note !== 'so far' ? ` (${note})` : ''}`,
                value: m.netSalesCents,
                partial: i === lastIndex,
                under: trends.monthCosts ? (c?.foodCostBps != null ? formatBps(c.foodCostBps) : '—') : null,
              };
            })}
          />
          <div className="mt-4">
            <DataTable
              columns={[
                { label: 'Month' },
                { label: 'Sales', right: true },
                { label: 'Orders', right: true },
                { label: 'Average order', right: true },
                ...(trends.monthCosts ? [{ label: 'Food cost', right: true }] : []),
              ]}
              // Newest first: last month is what the owner looks for.
              rows={trends.months
                .map((m, i) => {
                  const note = monthNote(m, i === lastIndex);
                  const c = costs.get(m.month);
                  const none = note === 'no data then';
                  return [
                    <span key="m">
                      {fmtMonth(`${m.month}-01`)}
                      {note && <span className="text-xs text-stone-500"> · {note}</span>}
                    </span>,
                    none ? '—' : formatCents(m.netSalesCents),
                    none ? '—' : m.orderCount,
                    none || m.orderCount === 0 ? '—' : formatCents(m.avgOrderCents),
                    ...(trends.monthCosts ? [c?.foodCostBps != null ? formatBps(c.foodCostBps) : '—'] : []),
                  ];
                })
                .reverse()}
              empty="No months yet."
            />
          </div>
        </Panel>
      )}
    </div>
  );
}

function TrendCard({ line, spark }: { line: ReportTrendLine; spark: SparklineData | undefined }) {
  const label = TREND_LABEL[line.period];
  const f = line.current.figures;
  return (
    <Panel>
      <div className="text-[11px] font-semibold uppercase tracking-widest text-stone-500">{label.title}</div>
      <div className="mt-1 text-2xl font-bold tabular-nums tracking-tight">{formatCents(f.netSalesCents)}</div>
      <div className="text-xs text-stone-500">
        {plural(f.orderCount, 'order')} · average {formatCents(f.avgOrderCents)}
      </div>
      <dl className="mt-2 space-y-1 text-xs">
        <CompareLine label={`vs ${label.previous}`} c={line.previous} />
        {line.lastYear && label.lastYear && <CompareLine label={`vs ${label.lastYear}`} c={line.lastYear} />}
      </dl>
      {spark && spark.values.some((v) => v > 0) && (
        <div className="mt-2">
          <Sparkline values={spark.values} ariaLabel={`${label.title}: ${spark.caption}`} />
          <div className="text-[10px] text-stone-500">{spark.caption}</div>
        </div>
      )}
    </Panel>
  );
}

function CompareLine({ label, c }: { label: string; c: TrendComparison }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-2">
      <dt className="text-stone-500 dark:text-stone-400">{label}</dt>
      <dd>
        <ChangeText change={trendChangeOf(c.change.sales)} goodWhen="up" was={c.figures ? formatCents(c.figures.netSalesCents) : undefined} />
      </dd>
    </div>
  );
}
