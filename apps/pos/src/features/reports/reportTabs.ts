/**
 * The Reports page's tabs, the screen side (costing spec Phase 3): which a
 * login sees, which one opens, and what each asks the till for. Pure, so it
 * is unit-tested (reportTabs.test.ts).
 */
import { REPORT_TABS, type ReportTab, type ReportTabRequest } from '@cheeseoclock/shared-types';
import type { ReportPeriod } from './dateRange';

/** The tabs this login sees, in the page's order: Food cost & stock only with costs (the till refuses it anyway). */
export function visibleReportTabs(canSeeCosts: boolean): ReportTab[] {
  return REPORT_TABS.filter((t) => t !== 'foodStock' || canSeeCosts);
}

export const LAST_TAB_KEY = 'coc.reports.lastTab';

/** Team & leakage's shift history panel: its id, for the top bar's "Shift history" to scroll to. */
export const SHIFT_HISTORY_ANCHOR = 'shift-history';

/** How much of a part must be on screen below its top to count as showing: its name and a line or two. */
export const SHOWING_ROOM_PX = 200;

/** A part of the page as bringIntoView sees it: an element (a stand-in in tests). */
export interface ScrollTarget {
  getBoundingClientRect(): { top: number };
  /** The page it scrolls in: the shell's <main>, under the top bar. */
  closest(selector: 'main'): { getBoundingClientRect(): { top: number; bottom: number } } | null;
  scrollIntoView(options: ScrollIntoViewOptions): void;
}

/**
 * A link's "show me this part" (the top bar's "Shift history"): scroll only
 * when the part is not already showing, and then as little as it takes.
 * Pulling a part that already showed up to the top took the page's header
 * off the screen for nothing — the period, its dates and the tabs — so the
 * shifts showed with no period named. True when it scrolled.
 */
export function bringIntoView(part: ScrollTarget | null, windowHeight: number): boolean {
  if (!part) return false;
  const page = part.closest('main')?.getBoundingClientRect();
  const viewTop = Math.max(page?.top ?? 0, 0);
  const viewBottom = Math.min(page?.bottom ?? windowHeight, windowHeight);
  const top = part.getBoundingClientRect().top;
  if (top >= viewTop && top + SHOWING_ROOM_PX <= viewBottom) return false;
  part.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  return true;
}

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

/** What a tab asks the till for: the period, and for the Overview its comparison. */
export function tabRequest(tab: ReportTab, period: Pick<ReportPeriod, 'sinceIso' | 'untilIso' | 'compare'>): ReportTabRequest {
  return {
    sinceIso: period.sinceIso,
    untilIso: period.untilIso,
    ...(tab === 'overview' && period.compare ? { compareSinceIso: period.compare.sinceIso, compareUntilIso: period.compare.untilIso } : {}),
  };
}

/**
 * The cache key of a tab's figures: what it asks for, and for a period still
 * running the clock tick (so it refreshes once a minute while on screen, as
 * the page did before it had tabs; dateRange.ts autoRefreshes).
 */
export function tabQueryKey(tab: ReportTab, period: Pick<ReportPeriod, 'sinceIso' | 'untilIso' | 'compare' | 'isCurrent'>, now: Date): unknown[] {
  const req = tabRequest(tab, period);
  return ['reports', 'tab', tab, req.sinceIso, req.untilIso, req.compareSinceIso ?? null, req.compareUntilIso ?? null, period.isCurrent ? now.getTime() : null];
}
