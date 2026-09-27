/**
 * Reports → When's Phase 7 figures (costing spec 4.10): the weekday × hour
 * heatmap, the parts of the day, and the period's day notes. Worked out in
 * the Reports worker with the rest of the When tab, from the same single
 * read of the period's counted orders (business-report.ts buildWhenTab).
 *
 *  - Heatmap: an average day per weekday and hour. The days counted are the
 *    period's WHOLE trading days from this till's first order up to
 *    yesterday, less the days marked closed (their sales are left out too).
 *    A day still to come, or before the till was in use, is not a quiet day;
 *    nor is the rest of today: today is left out, sales and all, until it is
 *    over, or every hour still to come would read one day quieter.
 *  - Parts of the day: Lunch, Afternoon, Dinner, Late (the owner's own, from
 *    Costing → Targets), with anything outside them as "Other hours".
 *  - Day notes: every note still on for the period's days, oldest day first.
 *
 * Read-only, and never loads Electron: it runs in the worker thread.
 */
import { DEFAULT_DAYPARTS, type ReportWhenTab } from '@cheeseoclock/shared-types';
import { DAY_MS, buildHeatmap, dayNumberOfYmd, dayYmd, pakistanHourOfMs, splitDayparts, tradingDayOfMs, type HourTally } from '@cheeseoclock/pos-domain';
import type { AppDatabase } from '../../db/connection.js';
import { getBusinessSetting } from '../../db/business-settings-read.js';
import { readDayNotes } from '../../db/day-notes-read.js';
import { firstOrderMs } from './sql.js';

/** A counted order as the When tab's single read gives it. */
export interface WhenSaleRow {
  createdAt: string;
  total: number;
  refunded: number;
}

/** The parts of the day in force: the owner's, or the till's own. */
export function daypartsInForce(db: AppDatabase) {
  const saved = getBusinessSetting(db, 'analytics.dayparts');
  return { dayparts: saved?.value ?? [...DEFAULT_DAYPARTS], isDefault: saved === null, savedAt: saved?.updatedAt ?? null };
}

/** The heatmap, the parts of the day and the day notes for [since, until), from the period's counted orders. */
export function whenExtras(
  db: AppDatabase,
  range: { sinceIso: string; untilIso: string },
  rows: readonly WhenSaleRow[],
  byHour: ReportWhenTab['byHour'],
  now: Date,
): Pick<ReportWhenTab, 'heatmap' | 'dayparts' | 'dayNotes'> {
  const firstDay = tradingDayOfMs(Date.parse(range.sinceIso));
  const lastDay = tradingDayOfMs(Date.parse(range.untilIso) - 1);
  const dayNotes = readDayNotes(db, dayYmd(firstDay), dayYmd(lastDay));
  const closedDays = new Set<number>();
  for (const n of dayNotes) {
    const d = n.tag === 'closed' ? dayNumberOfYmd(n.day) : null;
    if (d !== null) closedDays.add(d);
  }

  // Sales per trading day and Pakistan hour, from the rows already read.
  const byDayHour = new Map<number, HourTally>();
  for (const r of rows) {
    const at = Date.parse(r.createdAt);
    const dayNumber = Math.floor(at / DAY_MS);
    const hour = pakistanHourOfMs(at);
    const key = dayNumber * 24 + hour;
    const net = r.total - r.refunded;
    const t = byDayHour.get(key);
    if (t) {
      t.orderCount += 1;
      t.netSalesCents += net;
    } else byDayHour.set(key, { dayNumber, hour, orderCount: 1, netSalesCents: net });
  }
  // The days an average is over: from the till's first order (or the period's start) to yesterday (or the
  // period's end). Today's tallies fall outside [from, to], so buildHeatmap leaves them out with the day.
  const first = firstOrderMs(db);
  const from = first === null ? lastDay + 1 : Math.max(firstDay, tradingDayOfMs(first));
  const to = Math.min(lastDay, tradingDayOfMs(now.getTime()) - 1);
  const heatmap = buildHeatmap({ tallies: [...byDayHour.values()], firstDay: from, lastDay: to, closedDays });

  const parts = daypartsInForce(db);
  const split = splitDayparts(byHour, parts.dayparts);
  return {
    heatmap,
    dayparts: { lines: split.lines, other: split.other, isDefault: parts.isDefault },
    dayNotes,
  };
}
