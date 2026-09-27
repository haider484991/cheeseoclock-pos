/**
 * Reports — how the shop did, a tab at a time (costing spec Phase 3).
 *
 * One period at a time (Today, This week… This year), compared with the
 * same stretch just before. Six tabs — Overview, When, Menu, Channels &
 * delivery, Food cost & stock, Team & leakage — each loads only its own
 * figures from its own channel (reports:<tab>), worked out in the till's
 * Reports worker thread so a year never holds up the counter. Every figure
 * comes from the till's stored order totals. Print and "Download for Excel"
 * take the tab on screen; "Print everything" takes every tab this login
 * sees. The page opens on the tab last looked at.
 */
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Card, cn } from '@cheeseoclock/ui';
import { COST_CAPABILITY, REPORT_TAB_LABEL, type ReportTab, type ReportTabData } from '@cheeseoclock/shared-types';
import {
  BarChart3,
  CalendarDays,
  Clock,
  FileSpreadsheet,
  Loader2,
  Printer,
  RefreshCw,
  Store,
  UsersRound,
  UtensilsCrossed,
  Wheat,
  type LucideIcon,
} from 'lucide-react';
import { ipc } from '../../ipc/client';
import { useSessionStore } from '../../stores/sessionStore';
import { useToast } from '../../components/toast/ToastProvider';
import { autoRefreshes, fmtDateInput, periodFor, type RangePreset, type ReportPeriod } from './dateRange';
import {
  buildPrintEverything,
  buildTabCsv,
  buildTabPrintBody,
  csvFileName,
  downloadText,
  PRINT_CSS,
  PRINT_SHEET_CLASS,
  type SomeReportTabs,
} from './exporters';
import { browserStorage, readLastTab, tabQueryKey, tabRequest, visibleReportTabs, writeLastTab } from './reportTabs';
import { Note } from './reportUi';
import { OverviewTab } from './tabs/OverviewTab';
import { WhenTab } from './tabs/WhenTab';
import { MenuTab } from './tabs/MenuTab';
import { ChannelsTab } from './tabs/ChannelsTab';
import { FoodCostStockTab } from './tabs/FoodCostStockTab';
import { TeamLeakageTab } from './tabs/TeamLeakageTab';

const PRESETS: Array<{ id: RangePreset; label: string }> = [
  { id: 'today', label: 'Today' },
  { id: 'yesterday', label: 'Yesterday' },
  { id: 'thisWeek', label: 'This week' },
  { id: 'last7', label: 'Last 7 days' },
  { id: 'thisMonth', label: 'This month' },
  { id: 'lastMonth', label: 'Last month' },
  { id: 'thisYear', label: 'This year' },
  { id: 'last12', label: 'Last 12 months' },
  { id: 'lastYear', label: 'Last year' },
  { id: 'custom', label: 'Pick dates' },
];

const TAB_ICON: Record<ReportTab, LucideIcon> = {
  overview: BarChart3,
  when: Clock,
  menu: UtensilsCrossed,
  channels: Store,
  foodStock: Wheat,
  team: UsersRound,
};

/** Each tab's channel. */
const FETCH: { [K in ReportTab]: (req: ReturnType<typeof tabRequest>) => Promise<ReportTabData[K]> } = {
  overview: (req) => ipc.reports.overview(req),
  when: (req) => ipc.reports.when(req),
  menu: (req) => ipc.reports.menu(req),
  channels: (req) => ipc.reports.channels(req),
  foodStock: (req) => ipc.reports.foodStock(req),
  team: (req) => ipc.reports.team(req),
};

/** A tab's figures with the tab and the period they are for, so screen, paper and file always pair them. */
type TabResult = { [K in ReportTab]: { tab: K; period: ReportPeriod; data: ReportTabData[K] } }[ReportTab];

async function fetchTab(tab: ReportTab, period: ReportPeriod): Promise<TabResult> {
  const data = await FETCH[tab](tabRequest(tab, period));
  return { tab, period, data } as TabResult;
}

function printTab<K extends ReportTab>(r: { tab: K; period: ReportPeriod; data: ReportTabData[K] }): string {
  return buildTabPrintBody(r.tab, r.data, r.period, new Date());
}

function csvTab<K extends ReportTab>(r: { tab: K; period: ReportPeriod; data: ReportTabData[K] }): string {
  return buildTabCsv(r.tab, r.data, r.period, new Date());
}

export function ReportsPage() {
  const canSeeCosts = useSessionStore((s) => s.can(COST_CAPABILITY));
  const tabs = useMemo(() => visibleReportTabs(canSeeCosts), [canSeeCosts]);
  const [chosenTab, setChosenTab] = useState<ReportTab>(() => readLastTab(browserStorage(), visibleReportTabs(canSeeCosts)));
  const tab: ReportTab = tabs.includes(chosenTab) ? chosenTab : 'overview';
  const [preset, setPreset] = useState<RangePreset>('today');
  const [now, setNow] = useState(() => new Date());
  const [customFrom, setCustomFrom] = useState(() => fmtDateInput(new Date().toISOString()));
  const [customTo, setCustomTo] = useState(() => fmtDateInput(new Date().toISOString()));
  // An id per click, so printing the same report twice prints twice.
  const [printJob, setPrintJob] = useState<{ id: number; html: string } | null>(null);
  const [printingAll, setPrintingAll] = useState(false);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const period = useMemo(
    () => periodFor(preset, now, preset === 'custom' ? { from: customFrom, to: customTo } : undefined),
    [preset, now, customFrom, customTo],
  );

  // A running period ("today so far") moves with the clock: the comparison
  // follows ("yesterday by this time") and the figures refresh every minute —
  // but only while the window is on screen and the period is at most 31 days
  // (autoRefreshes): a long report is never re-run behind the cashier's back.
  // Coming back to the window catches up at once.
  useEffect(() => {
    const tick = () => {
      if (autoRefreshes(period, document.visibilityState === 'visible')) setNow(new Date());
    };
    const t = setInterval(tick, 60_000);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [period]);

  const query = useQuery({
    queryKey: tabQueryKey(tab, period, now),
    queryFn: () => fetchTab(tab, period),
    // While another period loads, the tab's old figures stay up (dimmed)
    // instead of flashing to blank — but never another tab's.
    placeholderData: (previous) => (previous && previous.tab === tab ? previous : undefined),
    // A report that failed says why at once, with "Try again".
    retry: false,
  });
  const lowStock = useQuery({
    queryKey: ['reports', 'lowStock'],
    queryFn: () => ipc.reports.lowStock(),
    enabled: tab === 'foodStock',
  });

  const result = query.data?.tab === tab ? query.data : undefined;
  const shownPeriod = result?.period ?? period;
  // The once-a-minute refresh of the same period is not "stale": nothing dims
  // and the buttons stay usable.
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

  const chooseTab = (t: ReportTab) => {
    setChosenTab(t);
    writeLastTab(browserStorage(), t);
  };

  // Every tab this login sees, for the period on screen, as one printout.
  // Tabs already loaded come from the cache; the till works the rest out one
  // after another, in the background.
  const printEverything = async () => {
    setPrintingAll(true);
    try {
      const got = await Promise.all(
        tabs.map((t) =>
          queryClient.fetchQuery({ queryKey: tabQueryKey(t, period, now), queryFn: () => fetchTab(t, period), staleTime: 60_000, retry: false }),
        ),
      );
      const all: SomeReportTabs = {};
      for (const r of got) Object.assign(all, { [r.tab]: r.data });
      setPrintJob({ id: Date.now(), html: buildPrintEverything(all, period, new Date()) });
    } catch (e) {
      toast({ title: 'Could not print everything', description: e instanceof Error ? e.message : 'Please try again.', variant: 'error' });
    } finally {
      setPrintingAll(false);
    }
  };

  return (
    <div className="mx-auto max-w-7xl space-y-6 pb-16">
      {/* ---------------------------------------------------------- header */}
      <header className="space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-4xl font-bold tracking-tight">Reports</h1>
            <p className="mt-1 text-stone-500 dark:text-stone-400">How the shop did. Every figure comes from the orders saved on this till.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              disabled={!result || stale}
              onClick={() => result && setPrintJob({ id: Date.now(), html: printTab(result) })}
            >
              <Printer className="h-4 w-4" />
              Print this tab
            </Button>
            <Button
              variant="secondary"
              disabled={!result || stale}
              onClick={() => result && downloadText(csvFileName(result.period, result.tab), csvTab(result))}
            >
              <FileSpreadsheet className="h-4 w-4" />
              Download for Excel
            </Button>
            <Button variant="secondary" disabled={printingAll || stale} onClick={() => void printEverything()}>
              {printingAll ? <Loader2 className="h-4 w-4 animate-spin" /> : <Printer className="h-4 w-4" />}
              Print everything
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
              {tab === 'overview' && period.compare ? `${period.isCurrent ? ' · ' : ''}compared with ${period.compare.label}` : ''}
            </span>
            {query.isFetching && <Loader2 className="h-4 w-4 animate-spin text-stone-400" aria-label="Updating" />}
          </div>
        </Card>

        <nav className="flex gap-1 overflow-x-auto overflow-y-hidden border-b border-stone-200 dark:border-stone-800" aria-label="Report tabs">
          {tabs.map((t) => {
            const Icon = TAB_ICON[t];
            const active = tab === t;
            return (
              <button
                key={t}
                type="button"
                onClick={() => chooseTab(t)}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  '-mb-px flex items-center gap-2 whitespace-nowrap border-b-2 px-4 py-3 text-sm font-medium transition-colors',
                  active
                    ? 'border-amber-500 text-amber-700 dark:text-amber-300'
                    : 'border-transparent text-stone-600 hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-100',
                )}
              >
                <Icon className="h-4 w-4" />
                {REPORT_TAB_LABEL[t]}
              </button>
            );
          })}
        </nav>
      </header>

      {result?.data.engine === 'main' && (
        <Note tone="warn">
          Reports are being worked out on the till itself for now, so a report can cover 31 days at most. Restarting the till
          usually fixes this.
        </Note>
      )}

      {query.isError && !result ? (
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
        <div className={cn('transition-opacity', stale && 'opacity-60')}>
          {result ? (
            <TabBody result={result} now={now} lowStockCount={lowStock.data ? lowStock.data.length : null} />
          ) : tab === 'overview' ? (
            <OverviewTab data={undefined} />
          ) : (
            <Card className="flex items-center justify-center gap-2 py-10 text-sm text-stone-500">
              <Loader2 className="h-4 w-4 animate-spin" />
              Working out the figures…
            </Card>
          )}
        </div>
      )}

      {printJob !== null &&
        createPortal(
          <div className={PRINT_SHEET_CLASS}>
            <style>{PRINT_CSS}</style>
            {/* Built by the exporters, which escape every value. */}
            <div dangerouslySetInnerHTML={{ __html: printJob.html }} />
          </div>,
          document.body,
        )}
    </div>
  );
}

function TabBody({ result, now, lowStockCount }: { result: TabResult; now: Date; lowStockCount: number | null }) {
  switch (result.tab) {
    case 'overview':
      return <OverviewTab data={result.data} />;
    case 'when':
      return <WhenTab data={result.data} period={result.period} now={now} />;
    case 'menu':
      return <MenuTab data={result.data} />;
    case 'channels':
      return <ChannelsTab data={result.data} />;
    case 'foodStock':
      return <FoodCostStockTab data={result.data} lowStockCount={lowStockCount} />;
    case 'team':
      return <TeamLeakageTab data={result.data} />;
  }
}
