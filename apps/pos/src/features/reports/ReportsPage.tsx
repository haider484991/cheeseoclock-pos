/**
 * Reports — how the shop did, at a glance.
 *
 * One period at a time (Today, This week…), compared with the same stretch
 * just before. The top row answers "how much did we sell, to how many, how
 * did they pay"; the sections below answer one plain question each. Every
 * figure comes from one `reports:business` call, built from the till's stored
 * order totals — print and the Excel file use the same data, so they agree.
 */
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Button, Card, cn } from '@cheeseoclock/ui';
import { formatCents } from '@cheeseoclock/pos-domain';
import type { BusinessReport } from '@cheeseoclock/shared-types';
import { CalendarDays, FileSpreadsheet, Loader2, Printer, RefreshCw } from 'lucide-react';
import { ipc } from '../../ipc/client';
import { fmtDateInput, periodFor, type RangePreset } from './dateRange';
import { buildCsv, buildPrintBody, csvFileName, downloadText, PRINT_CSS, PRINT_SHEET_CLASS } from './exporters';
import { changeOf, PAYMENT_LABEL, PAYMENT_ORDER, percentOf } from './reportFormat';
import { Kpi, Note, Panel } from './reportUi';
import { ShareBar } from './charts';
import {
  ChannelsSection,
  DeliveriesSection,
  DiscountsSection,
  FoodCostSection,
  ItemsSection,
  RefundsSection,
  StaffSection,
  WhenSection,
} from './ReportSections';

const PRESETS: Array<{ id: RangePreset; label: string }> = [
  { id: 'today', label: 'Today' },
  { id: 'yesterday', label: 'Yesterday' },
  { id: 'thisWeek', label: 'This week' },
  { id: 'last7', label: 'Last 7 days' },
  { id: 'thisMonth', label: 'This month' },
  { id: 'lastMonth', label: 'Last month' },
  { id: 'custom', label: 'Pick dates' },
];

const JUMPS: Array<{ id: string; label: string }> = [
  { id: 'when', label: 'When' },
  { id: 'items', label: 'What sells' },
  { id: 'types', label: 'Order types' },
  { id: 'staff', label: 'Staff & cash' },
  { id: 'discounts', label: 'Discounts' },
  { id: 'refunds', label: 'Refunds' },
  { id: 'food', label: 'Food cost' },
  { id: 'deliveries', label: 'Deliveries' },
];

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function ReportsPage() {
  const [preset, setPreset] = useState<RangePreset>('today');
  const [now, setNow] = useState(() => new Date());
  const [customFrom, setCustomFrom] = useState(() => fmtDateInput(new Date().toISOString()));
  const [customTo, setCustomTo] = useState(() => fmtDateInput(new Date().toISOString()));
  // An id per click, so printing the same report twice prints twice.
  const [printJob, setPrintJob] = useState<{ id: number; html: string } | null>(null);

  // A running period ("today so far") moves with the clock: the comparison
  // follows ("yesterday by this time") and the figures refresh every minute.
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);

  const period = useMemo(
    () => periodFor(preset, now, preset === 'custom' ? { from: customFrom, to: customTo } : undefined),
    [preset, now, customFrom, customTo],
  );

  const query = useQuery({
    queryKey: ['reports', 'business', period.sinceIso, period.untilIso, period.compare?.sinceIso, period.compare?.untilIso],
    // The report travels with the period it was asked for, so the sections,
    // the printout and the file always pair figures with their own dates —
    // also while the next period is still loading.
    queryFn: async () => ({
      period,
      report: await ipc.reports.business({
        sinceIso: period.sinceIso,
        untilIso: period.untilIso,
        ...(period.compare ? { compareSinceIso: period.compare.sinceIso, compareUntilIso: period.compare.untilIso } : {}),
      }),
    }),
    placeholderData: keepPreviousData,
  });
  const lowStock = useQuery({ queryKey: ['reports', 'lowStock'], queryFn: () => ipc.reports.lowStock() });

  const report = query.data?.report;
  const shownPeriod = query.data?.period ?? period;
  // While another period loads, the old figures stay up (dimmed) instead of
  // flashing to blank. The once-a-minute refresh of the same period is not
  // "stale": nothing dims and the buttons stay usable.
  const stale = shownPeriod.sinceIso !== period.sinceIso || shownPeriod.untilIso !== period.untilIso;

  // Print: render the sheet next to the app, print, then take it away again.
  useEffect(() => {
    if (printJob === null) return;
    const done = () => setPrintJob(null);
    window.addEventListener('afterprint', done, { once: true });
    const t = setTimeout(() => window.print(), 60);
    return () => {
      clearTimeout(t);
      window.removeEventListener('afterprint', done);
    };
  }, [printJob]);

  const choose = (id: RangePreset) => {
    setNow(new Date());
    setPreset(id);
  };

  return (
    <div className="mx-auto max-w-7xl space-y-8 pb-16">
      {/* ---------------------------------------------------------- header */}
      <header className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-4xl font-bold tracking-tight">Reports</h1>
            <p className="mt-1 text-stone-500 dark:text-stone-400">How the shop did. Every figure comes from the orders saved on this till.</p>
          </div>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              disabled={!report || stale}
              onClick={() => report && setPrintJob({ id: Date.now(), html: buildPrintBody(report, shownPeriod, new Date()) })}
            >
              <Printer className="h-4 w-4" />
              Print
            </Button>
            <Button
              variant="secondary"
              disabled={!report || stale}
              onClick={() => report && downloadText(csvFileName(shownPeriod), buildCsv(report, shownPeriod, new Date()))}
            >
              <FileSpreadsheet className="h-4 w-4" />
              Download for Excel
            </Button>
          </div>
        </div>

        <Card className="space-y-3">
          <div className="flex flex-wrap gap-2" role="group" aria-label="Period">
            {PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                aria-pressed={preset === p.id}
                onClick={() => choose(p.id)}
                className={cn(
                  'h-11 rounded-xl px-4 text-sm font-semibold transition-colors',
                  preset === p.id
                    ? 'bg-gradient-to-b from-amber-400 to-amber-500 text-stone-900 shadow-soft-sm'
                    : 'bg-stone-100 text-stone-700 hover:bg-stone-200 dark:bg-stone-800 dark:text-stone-300 dark:hover:bg-stone-700',
                )}
              >
                {p.label}
              </button>
            ))}
          </div>

          {preset === 'custom' && (
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-2 text-sm font-medium">
                From
                <input
                  type="date"
                  value={customFrom}
                  onChange={(e) => e.target.value && setCustomFrom(e.target.value)}
                  className="h-11 rounded-xl border border-stone-300 bg-white px-3 font-mono text-sm dark:border-stone-700 dark:bg-stone-800"
                />
              </label>
              <label className="flex items-center gap-2 text-sm font-medium">
                To
                <input
                  type="date"
                  value={customTo}
                  onChange={(e) => e.target.value && setCustomTo(e.target.value)}
                  className="h-11 rounded-xl border border-stone-300 bg-white px-3 font-mono text-sm dark:border-stone-700 dark:bg-stone-800"
                />
              </label>
              <span className="text-xs text-stone-500">Each day runs 5 am to 5 am.</span>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
            <CalendarDays className="h-4 w-4 text-amber-600 dark:text-amber-400" />
            <span className="font-semibold">{period.dates}</span>
            <span className="text-stone-500 dark:text-stone-400">
              {period.isCurrent ? 'so far' : ''}
              {period.compare ? `${period.isCurrent ? ' · ' : ''}compared with ${period.compare.label}` : ''}
            </span>
            {query.isFetching && <Loader2 className="h-4 w-4 animate-spin text-stone-400" aria-label="Updating" />}
          </div>
        </Card>
      </header>

      {query.isError ? (
        <Card className="space-y-3 text-center">
          <p className="font-semibold">The report could not be loaded.</p>
          <p className="text-sm text-stone-500">{query.error instanceof Error ? query.error.message : 'Please try again.'}</p>
          <div>
            <Button variant="secondary" onClick={() => void query.refetch()}>
              <RefreshCw className="h-4 w-4" />
              Try again
            </Button>
          </div>
        </Card>
      ) : (
        <div className={cn('space-y-10 transition-opacity', stale && 'opacity-60')}>
          <Summary report={report} />

          {report && (
            <>
              <nav className="flex flex-wrap gap-2" aria-label="Jump to a section">
                {JUMPS.map((j) => (
                  <button
                    key={j.id}
                    type="button"
                    onClick={() => document.getElementById(j.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
                    className="rounded-full bg-white px-3 py-1.5 text-xs font-semibold text-stone-600 ring-1 ring-stone-200 hover:bg-stone-50 dark:bg-stone-900 dark:text-stone-300 dark:ring-stone-700 dark:hover:bg-stone-800"
                  >
                    {j.label}
                  </button>
                ))}
              </nav>
              <WhenSection report={report} period={shownPeriod} now={now} />
              <ItemsSection report={report} />
              <ChannelsSection report={report} />
              <StaffSection report={report} />
              <DiscountsSection report={report} />
              <RefundsSection report={report} />
              <FoodCostSection report={report} lowStockCount={lowStock.data ? lowStock.data.length : null} />
              <DeliveriesSection report={report} />
            </>
          )}
        </div>
      )}

      {printJob !== null &&
        createPortal(
          <div className={PRINT_SHEET_CLASS}>
            <style>{PRINT_CSS}</style>
            {/* Built by buildPrintBody, which escapes every value. */}
            <div dangerouslySetInnerHTML={{ __html: printJob.html }} />
          </div>,
          document.body,
        )}
    </div>
  );
}

// ----------------------------------------------------------------- summary --

function Summary({ report }: { report: BusinessReport | undefined }) {
  const k = report?.kpis;
  const p = report?.previous ?? null;
  const dash = '—';
  const refunds = k ? k.partialRefundCents + k.fullRefundCents : 0;
  const prevRefunds = p ? p.partialRefundCents + p.fullRefundCents : null;

  return (
    <section className="space-y-4" aria-label="Summary">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <div className="col-span-2 md:col-span-1">
          <Kpi
            big
            label="Sales"
            value={k ? formatCents(k.netSalesCents) : dash}
            loading={!k}
            change={k ? changeOf(k.netSalesCents, p?.netSalesCents) : undefined}
            goodWhen="up"
            was={p ? formatCents(p.netSalesCents) : undefined}
            sub="After discounts and refunds. Tax included."
          />
        </div>
        <Kpi
          label="Orders"
          value={k ? String(k.orderCount) : dash}
          loading={!k}
          change={k ? changeOf(k.orderCount, p?.orderCount) : undefined}
          goodWhen="up"
          was={p ? String(p.orderCount) : undefined}
          sub={k ? `${plural(k.itemCount, 'item')} sold` : undefined}
        />
        <Kpi
          label="Average order"
          value={k ? formatCents(k.avgOrderCents) : dash}
          loading={!k}
          change={k ? changeOf(k.avgOrderCents, p?.avgOrderCents) : undefined}
          goodWhen="up"
          was={p ? formatCents(p.avgOrderCents) : undefined}
        />
        <Kpi
          label="Discounts given"
          value={k ? formatCents(k.discountCents) : dash}
          loading={!k}
          change={k ? changeOf(k.discountCents, p?.discountCents) : undefined}
          goodWhen="down"
          was={p ? formatCents(p.discountCents) : undefined}
          sub={k ? `on ${plural(k.discountedOrderCount, 'order')}` : undefined}
        />
        <Kpi
          label="Refunds"
          value={k ? formatCents(refunds) : dash}
          loading={!k}
          change={k ? changeOf(refunds, prevRefunds) : undefined}
          goodWhen="down"
          was={prevRefunds !== null ? formatCents(prevRefunds) : undefined}
          sub={
            k
              ? k.voidCount > 0
                ? `Also ${plural(k.voidCount, 'order')} cancelled before paying`
                : 'No cancelled orders'
              : undefined
          }
        />
        <Kpi
          label="Tax collected"
          value={k ? formatCents(k.taxCents) : dash}
          loading={!k}
          change={k ? changeOf(k.taxCents, p?.taxCents) : undefined}
          goodWhen="neutral"
          was={p ? formatCents(p.taxCents) : undefined}
          sub="Included in sales"
        />
      </div>

      {k && (
        <>
          {k.unpaidCount > 0 && (
            <Note>
              {plural(k.unpaidCount, 'order')} worth {formatCents(k.unpaidCents)} {k.unpaidCount === 1 ? 'is' : 'are'} not paid yet
              (still on the Orders board). {k.unpaidCount === 1 ? 'It counts' : 'They count'} once paid.
            </Note>
          )}
          {k.unrecordedPaymentCents !== 0 && (
            <Note tone="warn">
              {formatCents(k.unrecordedPaymentCents)} of these sales has no payment method on record (older orders). It is shown
              as “No method recorded” below.
            </Note>
          )}

          <div className="grid gap-4 lg:grid-cols-2">
            <Panel title="How customers paid" note="Refunds are taken off the method the money went back on.">
              <ul className="space-y-3">
                {PAYMENT_ORDER.map((g) => (
                  <li key={g}>
                    <div className="mb-1 flex items-baseline justify-between gap-2 text-sm">
                      <span className="font-medium">{PAYMENT_LABEL[g]}</span>
                      <span className="tabular-nums">
                        <span className="font-semibold">{formatCents(k.payments[g])}</span>{' '}
                        <span className="text-xs text-stone-500">{percentOf(k.payments[g], k.netSalesCents)}</span>
                      </span>
                    </div>
                    <ShareBar value={k.payments[g]} total={k.netSalesCents} tone="emerald" />
                  </li>
                ))}
                {k.unrecordedPaymentCents !== 0 && (
                  <li className="flex justify-between text-sm text-stone-500">
                    <span>No method recorded</span>
                    <span className="tabular-nums">{formatCents(k.unrecordedPaymentCents)}</span>
                  </li>
                )}
              </ul>
            </Panel>

            <Panel
              title="How the sales add up"
              note={
                k.fullRefundCount > 0 || k.voidCount > 0
                  ? `Not in these figures: ${[
                      k.fullRefundCount > 0 ? `${plural(k.fullRefundCount, 'order')} refunded in full (${formatCents(k.fullRefundCents)})` : null,
                      k.voidCount > 0 ? `${plural(k.voidCount, 'cancelled order')} (${formatCents(k.voidCents)})` : null,
                    ]
                      .filter(Boolean)
                      .join(' and ')}.`
                  : undefined
              }
            >
              <dl className="space-y-1.5 text-sm">
                <Line label="Items at menu price" value={formatCents(k.menuSalesCents)} />
                <Line label="− Discounts" value={formatCents(k.discountCents)} />
                <Line label="+ Tax" value={formatCents(k.taxCents)} />
                {k.partialRefundCents > 0 && <Line label="− Part refunds on these orders" value={formatCents(k.partialRefundCents)} />}
                <div className="flex justify-between border-t border-stone-200 pt-1.5 text-base font-bold dark:border-stone-700">
                  <dt>= Sales</dt>
                  <dd className="tabular-nums">{formatCents(k.netSalesCents)}</dd>
                </div>              </dl>
            </Panel>
          </div>
        </>
      )}
    </section>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <dt>{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );
}
