/**
 * Reports — how the shop did, a tab at a time (costing spec Phase 3).
 *
 * One period at a time (Today, This week… This year), compared with the
 * same stretch just before. Seven tabs — Overview, When, Menu, Channels &
 * delivery, Food cost & stock, Team & leakage, Profit (costing spec Phase 9,
 * profit.view) — each loads only its own
 * figures from its own channel (reports:<tab>), worked out in the till's
 * Reports worker thread so a year never holds up the counter. Every figure
 * comes from the till's stored order totals. Print and "Download for Excel"
 * take the tab on screen; "Print everything" takes every tab this login
 * sees. The page opens on the tab last looked at, or where a link from
 * elsewhere says (costing/deepLinks.ts: a stock take, the top bar's "Shift
 * history").
 */
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLocation } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Card, cn } from '@cheeseoclock/ui';
import {
  COST_CAPABILITY,
  PROFIT_CAPABILITY,
  REPORT_TAB_LABEL,
  STOCK_COUNT_SCOPE_LABEL,
  type DayNoteInput,
  type OwnerWeekWhich,
  type ReportTab,
  type ReportTabData,
  type StockCountSummary,
} from '@cheeseoclock/shared-types';
import {
  BarChart3,
  CalendarDays,
  Clock,
  Coins,
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
import {
  autoRefreshes,
  fmtDateInput,
  fmtMoment,
  periodFor,
  pickStockTakePair,
  stockTakesAfterToChange,
  stockTakesPeriod,
  type RangePreset,
  type ReportPeriod,
} from './dateRange';
import { hasOneShotLink, useOneShotLink } from '../../components/list';
import { REPORTS_DEEP_LINK, type ReportsDeepLink } from '../costing/deepLinks';
import type { VarianceView } from './tabs/VarianceSection';
import {
  buildPrintEverything,
  buildTabCsv,
  buildTabPrintBody,
  type ReportExtras,
  csvFileName,
  downloadText,
  PRINT_CSS,
  PRINT_SHEET_CLASS,
  type SomeReportTabs,
} from './exporters';
import { bringIntoView, browserStorage, readLastTab, tabQueryKey, tabRequest, visibleReportTabs, writeLastTab } from './reportTabs';
import { Note } from './reportUi';
import { fetchTeamExtras, teamExtrasFailedText, type TeamExtras, type TeamExtrasReaders } from './teamExtras';
import { OverviewTab } from './tabs/OverviewTab';
import { WhenTab } from './tabs/WhenTab';
import { MenuTab, type MenuMapView } from './tabs/MenuTab';
import { ChannelsTab } from './tabs/ChannelsTab';
import { FoodCostStockTab } from './tabs/FoodCostStockTab';
import { TeamLeakageTab } from './tabs/TeamLeakageTab';
import { ProfitTab } from './tabs/ProfitTab';
import type { DayNoteEditor } from './tabs/WhenExtras';
import { buildWeeklySheet, WeeklySheetButtons } from './WeeklySheet';
import { dayNoteAddedText } from './ownerWeekFormat';

const PRESETS: Array<{ id: RangePreset; label: string; costsOnly?: boolean }> = [
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
  // Stock takes are the owner's and managers' (costing spec Phase 8): only with costs.
  { id: 'stockTakes', label: 'Between stock takes', costsOnly: true },
];

/** A finished stock take as the "Between stock takes" pickers name it. */
function stockTakeLabel(c: StockCountSummary): string {
  return `${c.finishedAt ? fmtMoment(c.finishedAt) : '-'} · ${STOCK_COUNT_SCOPE_LABEL[c.scope]}`;
}

const TAB_ICON: Record<ReportTab, LucideIcon> = {
  overview: BarChart3,
  when: Clock,
  menu: UtensilsCrossed,
  channels: Store,
  foodStock: Wheat,
  team: UsersRound,
  profit: Coins,
};

/** Each tab's channel. */
const FETCH: { [K in ReportTab]: (req: ReturnType<typeof tabRequest>) => Promise<ReportTabData[K]> } = {
  overview: (req) => ipc.reports.overview(req),
  when: (req) => ipc.reports.when(req),
  menu: (req) => ipc.reports.menu(req),
  channels: (req) => ipc.reports.channels(req),
  foodStock: (req) => ipc.reports.foodStock(req),
  team: (req) => ipc.reports.team(req),
  profit: (req) => ipc.reports.profit(req),
};

/** A tab's figures with the tab and the period they are for, so screen, paper and file always pair them. */
type TabResult = { [K in ReportTab]: { tab: K; period: ReportPeriod; data: ReportTabData[K] } }[ReportTab];

async function fetchTab(tab: ReportTab, period: ReportPeriod): Promise<TabResult> {
  const data = await FETCH[tab](tabRequest(tab, period));
  return { tab, period, data } as TabResult;
}

function printTab<K extends ReportTab>(r: { tab: K; period: ReportPeriod; data: ReportTabData[K] }, extras: ReportExtras): string {
  return buildTabPrintBody(r.tab, r.data, r.period, new Date(), extras);
}

function csvTab<K extends ReportTab>(r: { tab: K; period: ReportPeriod; data: ReportTabData[K] }, extras: ReportExtras): string {
  return buildTabCsv(r.tab, r.data, r.period, new Date(), extras);
}

/** Overview's trend strip (its own channel): the same query on screen, on paper and in the file. */
const TRENDS_KEY = ['reports', 'trends'] as const;

/** Team & leakage's own lists for paper and file, read from the till (teamExtras.ts). */
const TEAM_EXTRAS_IPC: TeamExtrasReaders = {
  drawerLog: (q) => ipc.reports.drawerLog(q),
  deletedTests: (q) => ipc.orders.listDeletedTests(q),
};

export function ReportsPage() {
  // The page reads its link (costing/deepLinks.ts) as it opens. A link that
  // comes while Reports is already open (the top bar's "Shift history")
  // opens it afresh on that link; going to Reports without one changes nothing.
  const navigation = useLocation().key;
  const [openedFor, setOpenedFor] = useState(navigation);
  if (navigation !== openedFor && hasOneShotLink(REPORTS_DEEP_LINK)) setOpenedFor(navigation);
  return <ReportsScreen key={openedFor} />;
}

function ReportsScreen() {
  const canSeeCosts = useSessionStore((s) => s.can(COST_CAPABILITY));
  // Rupee profit (costing spec Phase 9): profit.view, and costs (profit says what things cost).
  const canSeeProfit = useSessionStore((s) => s.can(PROFIT_CAPABILITY)) && canSeeCosts;
  const tabs = useMemo(() => visibleReportTabs(canSeeCosts, canSeeProfit), [canSeeCosts, canSeeProfit]);
  // A link from elsewhere: a finished stock take or the Dashboard (Food cost &
  // stock, between those two stock takes), or the top bar's "Shift history"
  // (Team & leakage, the last 7 days, scrolled to the shifts).
  const deepLink = useOneShotLink<ReportsDeepLink>(REPORTS_DEEP_LINK);
  const [chosenTab, setChosenTab] = useState<ReportTab>(
    () => deepLink?.tab ?? readLastTab(browserStorage(), visibleReportTabs(canSeeCosts, canSeeProfit)),
  );
  const tab: ReportTab = tabs.includes(chosenTab) ? chosenTab : 'overview';
  const [preset, setPreset] = useState<RangePreset>(deepLink?.preset ?? 'today');
  const [pickedPair, setPickedPair] = useState<{ fromCountId: string; toCountId: string } | null>(deepLink?.stockTakes ?? null);
  // What the link asked to bring into view, until the tab's figures are on screen.
  const [scrollTo, setScrollTo] = useState<string | null>(deepLink?.scrollTo ?? null);
  const [now, setNow] = useState(() => new Date());
  const [customFrom, setCustomFrom] = useState(() => fmtDateInput(new Date().toISOString()));
  const [customTo, setCustomTo] = useState(() => fmtDateInput(new Date().toISOString()));
  // An id per click, so printing the same report twice prints twice.
  const [printJob, setPrintJob] = useState<{ id: number; html: string } | null>(null);
  const [printingAll, setPrintingAll] = useState(false);
  const queryClient = useQueryClient();
  const { toast } = useToast();

  // "Between stock takes": the finished stock takes to pick from, newest first.
  const stockCounts = useQuery({
    queryKey: ['inventory', 'stockCounts', 'list'],
    queryFn: () => ipc.inventory.stockCountList({ limit: 200 }),
    enabled: canSeeCosts && preset === 'stockTakes',
  });
  const doneCounts = useMemo(
    () =>
      (stockCounts.data ?? [])
        .filter((c) => c.status === 'done' && c.finishedAt !== null)
        .sort((a, b) => (b.finishedAt ?? '').localeCompare(a.finishedAt ?? '')),
    [stockCounts.data],
  );
  const pair = useMemo(() => pickStockTakePair(doneCounts, pickedPair), [doneCounts, pickedPair]);

  const period = useMemo(() => {
    if (preset === 'stockTakes') {
      // Until two stock takes are finished there is no window: today, with a note.
      return pair
        ? stockTakesPeriod({ id: pair.from.id, finishedAt: pair.from.finishedAt ?? '' }, { id: pair.to.id, finishedAt: pair.to.finishedAt ?? '' })
        : periodFor('today', now);
    }
    return periodFor(preset, now, preset === 'custom' ? { from: customFrom, to: customTo } : undefined);
  }, [preset, now, customFrom, customTo, pair]);

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
  // Food cost & stock, "Between stock takes" (costing spec Phase 8): used vs should have used, its own channel.
  const stockTakes = period.stockTakes;
  const varianceQ = useQuery({
    queryKey: ['reports', 'variance', stockTakes?.fromCountId ?? null, stockTakes?.toCountId ?? null],
    queryFn: () => ipc.reports.variance(stockTakes),
    enabled: tab === 'foodStock' && stockTakes !== undefined,
    retry: false,
  });
  const variance: VarianceView | null =
    tab !== 'foodStock' || preset !== 'stockTakes'
      ? null
      : stockTakes
        ? {
            data: varianceQ.data,
            loading: varianceQ.isFetching,
            error: varianceQ.isError ? (varianceQ.error instanceof Error ? varianceQ.error.message : 'It could not be worked out.') : null,
          }
        : // "Between stock takes" picked, but fewer than two are finished.
          {
            data: undefined,
            loading: stockCounts.isLoading,
            error: stockCounts.isLoading ? null : 'This needs two finished stock takes. Count under Inventory → Stock takes, and again a week later.',
          };
  const varianceForPaper = stockTakes && varianceQ.data ? varianceQ.data : undefined;
  // Menu → the menu map (costing spec Phase 9, profit.view): the last 28 days, or the period picked.
  const [menuMapLastDays, setMenuMapLastDays] = useState(true);
  const menuMapReq = menuMapLastDays ? undefined : { sinceIso: period.sinceIso, untilIso: period.untilIso };
  const menuMapQ = useQuery({
    queryKey: ['reports', 'menuMap', menuMapReq?.sinceIso ?? null, menuMapReq?.untilIso ?? null],
    queryFn: () => ipc.reports.menuMap(menuMapReq),
    enabled: tab === 'menu' && canSeeProfit,
    staleTime: 60_000,
    retry: false,
  });
  const menuMap: MenuMapView | null = canSeeProfit
    ? {
        data: menuMapQ.data,
        loading: menuMapQ.isFetching,
        error: menuMapQ.isError ? (menuMapQ.error instanceof Error ? menuMapQ.error.message : 'The menu map could not be worked out.') : null,
        lastDays: menuMapLastDays,
        setLastDays: setMenuMapLastDays,
      }
    : null;
  // Overview's trend strip and 12 months (costing spec Phase 7): not tied to
  // the period; refreshed every 5 minutes while on screen.
  const trends = useQuery({
    queryKey: TRENDS_KEY,
    queryFn: () => ipc.reports.trends(),
    enabled: tab === 'overview',
    staleTime: 5 * 60_000,
    refetchInterval: () => (document.visibilityState === 'visible' ? 5 * 60_000 : false),
    retry: false,
  });
  // Notes on days (When): added here, then the When tab is worked out again.
  const noteMut = useMutation({
    mutationFn: async (a: { add: DayNoteInput } | { remove: string }) => {
      if ('add' in a) await ipc.reports.addDayNote(a.add);
      else await ipc.reports.removeDayNote(a.remove);
    },
    onSuccess: (_d, a) => {
      toast({
        title: 'add' in a ? 'Note added' : 'Note taken off',
        description: 'add' in a ? dayNoteAddedText(a.add.day, period) : undefined,
        variant: 'success',
      });
      void queryClient.invalidateQueries({ queryKey: ['reports', 'tab', 'when'] });
    },
    onError: (e) => toast({ title: 'That did not work', description: e instanceof Error ? e.message : 'Please try again.', variant: 'error' }),
  });
  const todayYmd = fmtDateInput(new Date().toISOString());
  const noteEditor: DayNoteEditor = {
    // The toast says what went wrong; the form keeps what was typed.
    add: (input) => noteMut.mutateAsync({ add: input }).then(
      () => true,
      () => false,
    ),
    remove: (id) => noteMut.mutateAsync({ remove: id }).then(
      () => true,
      () => false,
    ),
    busy: noteMut.isPending,
    defaultDay: period.lastDay < todayYmd ? period.lastDay : todayYmd,
    maxDay: fmtDateInput(new Date(Date.now() + 365 * 86_400_000).toISOString()),
  };
  // The weekly owner sheet (one A4 page): this week so far, or last week in full.
  const [printingWeek, setPrintingWeek] = useState(false);
  const printWeek = async (week: OwnerWeekWhich) => {
    setPrintingWeek(true);
    try {
      const data = await ipc.reports.ownerWeek({ week, sheet: true });
      setPrintJob({ id: Date.now(), html: buildWeeklySheet(data, { canSeeCosts, canSeeProfit }) });
    } catch (e) {
      toast({ title: 'Could not print the week', description: e instanceof Error ? e.message : 'Please try again.', variant: 'error' });
    } finally {
      setPrintingWeek(false);
    }
  };

  const result = query.data?.tab === tab ? query.data : undefined;
  const shownPeriod = result?.period ?? period;
  // The once-a-minute refresh of the same period is not "stale": nothing dims
  // and the buttons stay usable.
  const stale = shownPeriod.sinceIso !== period.sinceIso || shownPeriod.untilIso !== period.untilIso;

  // A link's part of the tab ("Shift history"): once that tab's figures for
  // the linked period are on screen, bring it into view, once — without
  // scrolling if it already shows, so the period and the tabs stay in sight.
  useEffect(() => {
    if (scrollTo === null || !result || stale) return;
    bringIntoView(document.getElementById(scrollTo), window.innerHeight);
    setScrollTo(null);
  }, [scrollTo, result, stale]);

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

  // Print this tab / Download for Excel: Team & leakage adds its drawer log and deleted test orders.
  // Part of Team & leakage could not be read: the paper / file says so in
  // its place, and so does the screen.
  const teamExtrasFor = async (p: Pick<ReportPeriod, 'sinceIso' | 'untilIso'>): Promise<Omit<TeamExtras, 'failed'>> => {
    const { failed, ...got } = await fetchTeamExtras(p, TEAM_EXTRAS_IPC);
    const note = teamExtrasFailedText(failed);
    if (note) toast({ title: 'Part of Team & leakage is missing', description: note, variant: 'warning' });
    return got;
  };

  const exportTab = async (how: 'print' | 'csv') => {
    if (!result) return;
    const extras: ReportExtras = {
      trends: trends.data,
      variance: varianceForPaper,
      menuMap: menuMapQ.data,
      ...(result.tab === 'team' ? await teamExtrasFor(result.period) : {}),
    };
    if (how === 'print') setPrintJob({ id: Date.now(), html: printTab(result, extras) });
    else downloadText(csvFileName(result.period, result.tab), csvTab(result, extras));
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
      // Overview's trends go with it when the till can work them out; the rest prints without them.
      const trendsNow = tabs.includes('overview')
        ? await queryClient
            .fetchQuery({ queryKey: TRENDS_KEY, queryFn: () => ipc.reports.trends(), staleTime: 5 * 60_000, retry: false })
            .catch(() => undefined)
        : undefined;
      // "Between stock takes": what was used against what should have been goes on the paper too.
      const between = period.stockTakes;
      const varianceNow =
        between && tabs.includes('foodStock')
          ? await queryClient
              .fetchQuery({
                queryKey: ['reports', 'variance', between.fromCountId, between.toCountId],
                queryFn: () => ipc.reports.variance(between),
                staleTime: 60_000,
                retry: false,
              })
              .catch(() => undefined)
          : undefined;
      // Team & leakage: its drawer log and deleted test orders (the owner's).
      const teamNow = tabs.includes('team') ? await teamExtrasFor(period) : {};
      // The menu map goes with Menu for profit.view.
      const menuMapNow =
        canSeeProfit && tabs.includes('menu')
          ? await queryClient
              .fetchQuery({
                queryKey: ['reports', 'menuMap', menuMapReq?.sinceIso ?? null, menuMapReq?.untilIso ?? null],
                queryFn: () => ipc.reports.menuMap(menuMapReq),
                staleTime: 60_000,
                retry: false,
              })
              .catch(() => undefined)
          : undefined;
      setPrintJob({
        id: Date.now(),
        html: buildPrintEverything(all, period, new Date(), { trends: trendsNow, variance: varianceNow, menuMap: menuMapNow, ...teamNow }),
      });
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
              onClick={() => void exportTab('print')}
            >
              <Printer className="h-4 w-4" />
              Print this tab
            </Button>
            <Button
              variant="secondary"
              disabled={!result || stale}
              onClick={() => void exportTab('csv')}
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
            {PRESETS.filter((p) => !p.costsOnly || canSeeCosts).map((p) => (
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

          {preset === 'stockTakes' && (
            <div className="flex flex-wrap items-center gap-3">
              {pair ? (
                <>
                  <label className="flex items-center gap-2 text-sm font-medium">
                    From
                    <select
                      value={pair.from.id}
                      onChange={(e) => setPickedPair({ fromCountId: e.target.value, toCountId: pair.to.id })}
                      className="h-11 rounded-xl border border-stone-300 bg-white px-3 text-sm dark:border-stone-700 dark:bg-stone-800"
                    >
                      {doneCounts
                        .filter((c) => (c.finishedAt ?? '') < (pair.to.finishedAt ?? ''))
                        .map((c) => (
                          <option key={c.id} value={c.id}>
                            {stockTakeLabel(c)}
                          </option>
                        ))}
                    </select>
                  </label>
                  <label className="flex items-center gap-2 text-sm font-medium">
                    To
                    <select
                      value={pair.to.id}
                      onChange={(e) => setPickedPair(stockTakesAfterToChange(doneCounts, pair.from.id, e.target.value))}
                      className="h-11 rounded-xl border border-stone-300 bg-white px-3 text-sm dark:border-stone-700 dark:bg-stone-800"
                    >
                      {doneCounts.slice(0, -1).map((c) => (
                        <option key={c.id} value={c.id}>
                          {stockTakeLabel(c)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <span className="text-xs text-stone-500">Sales, waste and purchases below are for the time between the two.</span>
                </>
              ) : (
                <span className="text-sm text-stone-600 dark:text-stone-300">
                  {stockCounts.isLoading
                    ? 'Loading the stock takes…'
                    : 'This needs two finished stock takes (Inventory → Stock takes). Until then the figures below are for today.'}
                </span>
              )}
            </div>
          )}

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
            <TabBody
              result={result}
              now={now}
              lowStockCount={lowStock.data ? lowStock.data.length : null}
              trends={{
                data: trends.data,
                error: trends.isError ? (trends.error instanceof Error ? trends.error.message : 'The trends could not be worked out.') : null,
                sheetButtons: <WeeklySheetButtons onPrint={(w) => void printWeek(w)} busy={printingWeek} />,
              }}
              notes={noteEditor}
              variance={variance}
              onPrint={(html) => setPrintJob({ id: Date.now(), html })}
              menuMap={menuMap}
            />
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

function TabBody({
  result,
  now,
  lowStockCount,
  trends,
  notes,
  variance,
  onPrint,
  menuMap,
}: {
  result: TabResult;
  now: Date;
  lowStockCount: number | null;
  trends: NonNullable<Parameters<typeof OverviewTab>[0]['trends']>;
  notes: DayNoteEditor;
  variance: VarianceView | null;
  /** Prints an HTML body with the report sheet (a shift's drawer log). */
  onPrint: (html: string) => void;
  menuMap: MenuMapView | null;
}) {
  switch (result.tab) {
    case 'overview':
      return <OverviewTab data={result.data} trends={trends} />;
    case 'when':
      return <WhenTab data={result.data} period={result.period} now={now} notes={notes} />;
    case 'menu':
      return <MenuTab data={result.data} menuMap={menuMap} />;
    case 'channels':
      return <ChannelsTab data={result.data} />;
    case 'foodStock':
      return <FoodCostStockTab data={result.data} lowStockCount={lowStockCount} variance={variance} />;
    case 'team':
      return <TeamLeakageTab data={result.data} now={now} period={result.period} onPrint={onPrint} />;
    case 'profit':
      return <ProfitTab data={result.data} />;
  }
}
