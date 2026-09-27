/**
 * The Reports page's tabs, the screen side (costing spec Phase 3): which a
 * login sees, which one opens, and what each asks the till for. Pure, so it
 * is unit-tested (reportTabs.test.ts).
 */
import { REPORT_TABS, type ReportTab, type ReportTabRequest } from '@cheeseoclock/shared-types';
import type { ReportPeriod } from './dateRange';

/**
 * The tabs this login sees, in the page's order: Food cost & stock only with
 * costs, Profit only with profit.view and costs (costing spec Phase 9) — the
 * till refuses them anyway.
 */
export function visibleReportTabs(canSeeCosts: boolean, canSeeProfit = false): ReportTab[] {
  return REPORT_TABS.filter((t) => (t !== 'foodStock' || canSeeCosts) && (t !== 'profit' || (canSeeProfit && canSeeCosts)));
}

export const LAST_TAB_KEY = 'coc.reports.lastTab';

/** Storage as the page uses it (window.localStorage, or a stand-in in tests). */
export interface TabStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * The tab the page opens on: the last one looked at, if this login still
 * sees it, else Overview. Storage that is blocked or throws just means
 * Overview.
 */
export function readLastTab(storage: TabStorage | undefined, visible: readonly ReportTab[]): ReportTab {
  try {
    const v = storage?.getItem(LAST_TAB_KEY) ?? null;
    return v !== null && (visible as readonly string[]).includes(v) ? (v as ReportTab) : 'overview';
  } catch {
    return 'overview';
  }
}

/** Remember the tab for next time; never fails the page. */
export function writeLastTab(storage: TabStorage | undefined, tab: ReportTab): void {
  try {
    storage?.setItem(LAST_TAB_KEY, tab);
  } catch {
    // Blocked or full storage: the page opens on Overview next time.
  }
}

/** window.localStorage, or undefined where even reading it throws. */
export function browserStorage(): TabStorage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

/**
 * What a tab asks the till for: the period, for the Overview its comparison,
 * and for Profit — "Between stock takes" — the two stock takes (its stock
 * loss step).
 */
export function tabRequest(tab: ReportTab, period: Pick<ReportPeriod, 'sinceIso' | 'untilIso' | 'compare' | 'stockTakes'>): ReportTabRequest {
  return {
    sinceIso: period.sinceIso,
    untilIso: period.untilIso,
    ...(tab === 'overview' && period.compare ? { compareSinceIso: period.compare.sinceIso, compareUntilIso: period.compare.untilIso } : {}),
    ...(tab === 'profit' && period.stockTakes ? { stockTakes: period.stockTakes } : {}),
  };
}

/**
 * The cache key of a tab's figures: what it asks for, and for a period still
 * running the clock tick (so it refreshes once a minute while on screen, as
 * the page did before it had tabs; dateRange.ts autoRefreshes).
 */
export function tabQueryKey(tab: ReportTab, period: Pick<ReportPeriod, 'sinceIso' | 'untilIso' | 'compare' | 'isCurrent' | 'stockTakes'>, now: Date): unknown[] {
  const req = tabRequest(tab, period);
  return [
    'reports',
    'tab',
    tab,
    req.sinceIso,
    req.untilIso,
    req.compareSinceIso ?? null,
    req.compareUntilIso ?? null,
    req.stockTakes?.fromCountId ?? null,
    req.stockTakes?.toCountId ?? null,
    period.isCurrent ? now.getTime() : null,
  ];
}
