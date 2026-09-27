/**
 * The Dashboard's "This week" card (costing spec Phase 7, D15): at most five
 * numbers — sales, orders and the average order against last week by now,
 * food cost (with how much of it is known) and waste — and ONE ranked "Do
 * this" list, each line with what it costs per week and a button to where it
 * is fixed. Never rupee profit.
 *
 * The home screen stands at the counter, so the figures are hidden until a
 * manager or the owner taps "Show this week's figures", and hide again after
 * 2 minutes, on the idle lock, when someone else signs in, and when a
 * stepping-in login starts or is held (ownerCardClock.ts). Hidden, nothing is
 * asked of the till and nothing is kept in the screen's memory.
 *
 * report.view to see the card at all (the main process refuses anyone else);
 * food cost, waste and every line with costs only for COST_CAPABILITY (the
 * main process leaves them out for anyone else).
 */
import { useCallback, useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Button, Card, cn } from '@cheeseoclock/ui';
import { formatCents } from '@cheeseoclock/pos-domain';
import { COST_CAPABILITY, type DoThisItem, type OwnerWeek } from '@cheeseoclock/shared-types';
import { CalendarDays, ChevronRight, Eye, EyeOff, ListChecks, Loader2, Pin } from 'lucide-react';
import { ipc } from '../../ipc/client';
import { useSessionStore } from '../../stores/sessionStore';
import { whoKey } from '../../stores/forgetOnSignOut';
import { Kpi } from '../reports/reportUi';
import { coverageText } from '../reports/reportFormat';
import { doThisWords, trendChangeOf, weekDates } from '../reports/ownerWeekFormat';
import { formatBps } from '../costing/costingFormat';
import { openCostingTab, openDishInCosting, openLowStockInInventory, openStockVariance } from '../costing/deepLinks';
import { cardHideReason, cardHidesInMs, cardMayShow, type CardLogin, type CardShown } from './ownerCardClock';

/** The card is read at a glance: whole rupees ("Rs 11,512", not "Rs 11,511.50"). */
function wholeRupees(cents: number): string {
  return formatCents(Math.round(cents / 100) * 100);
}

export const OWNER_WEEK_KEY = ['reports', 'ownerWeek'] as const;

export function OwnerWeekCard() {
  const user = useSessionStore((s) => s.user);
  const can = useSessionStore((s) => s.can);
  if (!user) return null;
  return (
    <OwnerWeekPanel
      login={{ who: whoKey(user), stepInEndsAt: user.stepInEndsAt ?? null, stepInHeld: user.stepInHeld === true }}
      canSeeReports={can('report.view')}
      canSeeCosts={can(COST_CAPABILITY)}
      canOpenStock={can('menu.manage')}
    />
  );
}

/** The card for the login at the till (exported for the tests, which render it with no store). */
export function OwnerWeekPanel({
  login,
  canSeeReports,
  canSeeCosts,
  canOpenStock,
}: {
  login: CardLogin;
  canSeeReports: boolean;
  canSeeCosts: boolean;
  canOpenStock: boolean;
}) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [shown, setShown] = useState<CardShown | null>(null);

  const hide = useCallback(() => {
    setShown(null);
    // Nothing of the figures stays in the screen's memory once they are hidden.
    qc.removeQueries({ queryKey: OWNER_WEEK_KEY });
  }, [qc]);

  // Hide on a change of login (idle lock, sign-out, someone else), a step-in, or after 2 minutes.
  const who = login.who;
  const stepInEndsAt = login.stepInEndsAt;
  const stepInHeld = login.stepInHeld;
  useEffect(() => {
    if (!shown) return;
    const now = Date.now();
    if (cardHideReason(shown, { who, stepInEndsAt, stepInHeld }, now) !== null) {
      hide();
      return;
    }
    const t = window.setTimeout(hide, cardHidesInMs(shown, now));
    return () => window.clearTimeout(t);
  }, [shown, who, stepInEndsAt, stepInHeld, hide]);
  // Leaving the Dashboard hides them too.
  useEffect(() => () => qc.removeQueries({ queryKey: OWNER_WEEK_KEY }), [qc]);

  const q = useQuery({
    queryKey: [...OWNER_WEEK_KEY, 'this', who],
    queryFn: () => ipc.reports.ownerWeek({ week: 'this' }),
    enabled: shown !== null,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });

  if (!canSeeReports || login.who === null) return null;

  const show = () => {
    if (!login.who || !cardMayShow(login)) return;
    setShown({ atMs: Date.now(), who: login.who, stepInEndsAt: login.stepInEndsAt });
  };

  const open = (item: DoThisItem) => {
    switch (item.kind) {
      case 'low_stock':
        openLowStockInInventory(navigate, { id: item.ingredientId, name: item.name });
        return;
      case 'red_item':
        openDishInCosting(navigate, { id: item.menuItemId, name: item.name });
        return;
      case 'missing_costs':
        openCostingTab(navigate, 'missing');
        return;
      case 'price_alert':
        openCostingTab(navigate, 'alerts');
        return;
      case 'stock_variance':
        openStockVariance(navigate, { fromCountId: item.fromCountId, toCountId: item.toCountId });
        return;
    }
  };

  return (
    <Card className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-xl font-bold tracking-tight">
            <CalendarDays className="h-5 w-5 text-amber-600 dark:text-amber-400" />
            This week
          </h2>
          <p className="mt-0.5 text-sm text-stone-500 dark:text-stone-400">
            {shown && q.data
              ? `${weekDates(q.data.firstDay, q.data.lastDay)} so far, compared with last week by now. This till's orders.`
              : "Sales, food cost and what to fix first. Hidden until you tap, so they are never left on the counter screen."}
          </p>
        </div>
        {shown ? (
          <Button variant="secondary" onClick={hide}>
            <EyeOff className="h-4 w-4" />
            Hide
          </Button>
        ) : (
          <Button variant="primary" onClick={show} disabled={!cardMayShow(login)}>
            <Eye className="h-4 w-4" />
            Show this week&apos;s figures
          </Button>
        )}
      </div>

      {shown &&
        (q.data ? (
          <OwnerWeekView week={q.data} canSeeCosts={canSeeCosts} canOpenStock={canOpenStock} onOpen={open} />
        ) : q.isError ? (
          <p className="text-sm text-red-700 dark:text-red-400">
            {q.error instanceof Error ? q.error.message : 'The figures could not be worked out.'}{' '}
            <button type="button" className="font-semibold underline" onClick={() => void q.refetch()}>
              Try again
            </button>
          </p>
        ) : (
          <p className="flex items-center gap-2 text-sm text-stone-500">
            <Loader2 className="h-4 w-4 animate-spin" />
            Working out the figures…
          </p>
        ))}
    </Card>
  );
}

/**
 * The figures themselves: five numbers at most, then "Do this". What the main
 * process sent is all there is: a login without costs gets no food cost, no
 * waste and no cost lines (and `canSeeCosts` hides them again here).
 *
 * Five numbers means five (costing spec D15): each tile is its figure with
 * how it moved against last week ("▲ 12%"), never last week's amount beside
 * it too — that is for Reports → Overview and the printed sheet.
 */
export function OwnerWeekView({
  week,
  canSeeCosts,
  canOpenStock,
  onOpen,
}: {
  week: OwnerWeek;
  canSeeCosts: boolean;
  canOpenStock: boolean;
  onOpen?: (item: DoThisItem) => void;
}) {
  const c = week.current;
  const costs = canSeeCosts ? week.costs : null;
  const lines = canSeeCosts ? week.doThis : week.doThis.filter((i) => !i.cost);
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <Kpi label="Sales" value={wholeRupees(c.netSalesCents)} change={trendChangeOf(week.change.sales)} goodWhen="up" sub="Tax included" />
        <Kpi label="Orders" value={String(c.orderCount)} change={trendChangeOf(week.change.orders)} goodWhen="up" />
        <Kpi label="Average order" value={wholeRupees(c.avgOrderCents)} change={trendChangeOf(week.change.avgOrder)} goodWhen="up" />
        {costs && (
          <>
            <Kpi
              label="Food cost"
              value={costs.foodCostBps === null ? '—' : formatBps(costs.foodCostBps)}
              sub={costs.coverageBps === null ? 'No food sold yet' : coverageText({ coverageBps: costs.coverageBps })}
            />
            <Kpi label="Waste" value={wholeRupees(costs.wasteCents)} sub={costs.hasCosts ? 'Thrown away, at cost' : 'Set prices to see it'} />
          </>
        )}
      </div>

      <div>
        <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold uppercase tracking-widest text-stone-500">
          <ListChecks className="h-4 w-4" />
          Do this
        </h3>
        {lines.length === 0 ? (
          <p className="text-sm text-stone-500">Nothing needs you right now.</p>
        ) : (
          <ol className="space-y-2">
            {lines.map((item, i) => {
              const words = doThisWords(item);
              const canOpen = item.kind !== 'low_stock' || canOpenStock;
              return (
                <li
                  key={item.key}
                  className={cn(
                    'flex flex-wrap items-center gap-3 rounded-xl border px-3 py-2',
                    item.pinned ? 'border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/40' : 'border-stone-200 dark:border-stone-800',
                  )}
                >
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-stone-100 text-xs font-bold tabular-nums dark:bg-stone-800">
                    {item.pinned ? <Pin className="h-3.5 w-3.5 text-amber-600" aria-label="Pinned" /> : i + 1}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="font-semibold">{words.title}</div>
                    <div className="text-xs text-stone-500 dark:text-stone-400">{words.detail}</div>
                  </div>
                  {words.amount && (
                    <span
                      className={cn(
                        'whitespace-nowrap text-sm font-semibold tabular-nums',
                        // A loss in red; missing costs' figure is food cost the till can't see yet, not a loss.
                        words.amount.tone === 'loss' ? 'text-red-700 dark:text-red-400' : 'text-stone-600 dark:text-stone-300',
                      )}
                    >
                      {words.amount.text}
                    </span>
                  )}
                  {onOpen && canOpen && (
                    <button
                      type="button"
                      onClick={() => onOpen(item)}
                      className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-sm font-semibold text-amber-700 hover:bg-amber-50 dark:text-amber-300 dark:hover:bg-amber-950/40"
                    >
                      {words.action}
                      <ChevronRight className="h-4 w-4" />
                    </button>
                  )}
                </li>
              );
            })}
          </ol>
        )}
        {week.doThisMore > 0 && (
          <p className="mt-2 text-xs text-stone-500">
            And {week.doThisMore} more, smaller {week.doThisMore === 1 ? 'one' : 'ones'}: see Costing.
          </p>
        )}
        {week.doThisFailed.length > 0 && (
          <p className="mt-2 text-xs text-amber-700 dark:text-amber-400">Some checks could not run this time, so the list may be short.</p>
        )}
      </div>
    </div>
  );
}
