/**
 * The owner's week in plain words (costing spec Phase 7): how a figure moved
 * ("▲ 12%", "New", "No data then"), and each "Do this" line as a sentence
 * the owner can act on, with its rupees a week. Pure (no React, no DOM), so
 * the Dashboard card, the Overview's trend strip and the printed weekly sheet
 * all say the same thing, and it is tested.
 */
import { formatCents } from '@cheeseoclock/pos-domain';
import type { DayNoteTag, DoThisItem, ReportHeatmap, ReportMonthPoint, ReportTrendPeriod, ReportTrends, TrendChange } from '@cheeseoclock/shared-types';
import { DAY_NOTE_TAG_LABEL } from '@cheeseoclock/shared-types';
import { formatBps } from '../costing/costingFormat';
import { fmtDay } from './dateRange';
import { hourLabel, type Change } from './reportFormat';

/** A trend change as the Kpi tile and ChangeText show it. */
export function trendChangeOf(c: TrendChange): Change {
  switch (c.kind) {
    case 'noData':
      return { text: 'No data then', direction: 'flat' };
    case 'new':
      return { text: 'New', direction: 'up' };
    case 'pct': {
      if (c.bps === 0) return { text: 'Same', direction: 'flat' };
      const pct = Math.round(Math.abs(c.bps) / 100);
      const text = pct === 0 ? '<1%' : `${pct}%`;
      return { text: `${c.bps > 0 ? '▲' : '▼'} ${text}`, direction: c.bps > 0 ? 'up' : 'down' };
    }
  }
}

/** "Rs 1,200 a week". */
export function perWeekText(cents: number): string {
  return `${formatCents(cents)} a week`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "2,400 g". */
function qty(n: number, unit: string): string {
  return `${new Intl.NumberFormat('en-PK').format(n)} ${unit}`;
}

export interface DoThisWords {
  title: string;
  detail: string;
  /** The button that takes the owner to where it is fixed. */
  action: string;
  /**
   * The rupees a week beside the line, or null when it has none. 'loss' is
   * money going out (a dish over target, a price rise), shown in red;
   * 'unseen' is missing costs' figure — food cost the till cannot see yet,
   * not a loss — shown plainly (costing spec 4.17's proxy, kept for the
   * ranking).
   */
  amount: { text: string; tone: 'loss' | 'unseen' } | null;
}

/** A "Do this" line in the owner's words. */
export function doThisWords(item: DoThisItem): DoThisWords {
  const loss = item.weekCents !== null && item.weekCents > 0 ? { text: perWeekText(item.weekCents), tone: 'loss' as const } : null;
  switch (item.kind) {
    case 'low_stock':
      // At or below zero (counts go negative when a delivery is not recorded), or with no reorder level set:
      // "0 g left, you reorder at 0 g" would make no sense.
      if (item.currentQty <= 0 || item.lowThreshold <= 0) {
        return {
          title: `Out on this till's count: ${item.name}`,
          detail: 'Record the delivery, or count it, so the till knows what is there.',
          action: 'Open stock',
          amount: null,
        };
      }
      return {
        title: `Running low: ${item.name}`,
        detail: `${qty(item.currentQty, item.unit)} left. You reorder at ${qty(item.lowThreshold, item.unit)}.`,
        action: 'Open stock',
        amount: null,
      };
    case 'red_item':
      return {
        title: `${item.name} costs too much to make`,
        detail: `Food cost ${formatBps(item.foodCostBps)} against a target of ${formatBps(item.targetBps)}. Check its price or recipe.`,
        action: 'Open costing',
        amount: loss,
      };
    case 'missing_costs':
      return {
        title: `Fill in ${plural(item.things, 'missing cost')}`,
        detail:
          item.dishes > 0
            ? `${plural(item.dishes, 'dish', 'dishes')} can't be costed yet. The rupees are roughly ${item.dishes === 1 ? 'its' : 'their'} food cost a week, which the till can't see yet: not money lost.`
            : 'Some prices or recipes are not filled in yet.',
        action: 'Open missing costs',
        amount: item.weekCents !== null && item.weekCents > 0 ? { text: `about ${perWeekText(item.weekCents)}`, tone: 'unseen' } : null,
      };
    case 'price_alert':
      if (item.alertKind === 'weekly_digest') {
        return {
          title: `${plural(item.dishes, 'dish', 'dishes')} moved past ${item.dishes === 1 ? 'its' : 'their'} target this week`,
          detail: "This week's price changes. Look at their prices or recipes.",
          action: 'Open alerts',
          amount: loss,
        };
      }
      return {
        title:
          item.changeBps !== null && item.changeBps > 0
            ? `${item.ingredientName ?? 'An ingredient'} went up ${formatBps(item.changeBps)}`
            : `${item.ingredientName ?? 'An ingredient'} changed price`,
        detail: `It changes the cost of ${plural(item.dishes, 'dish', 'dishes')}.`,
        action: 'Open alerts',
        amount: loss,
      };
    case 'stock_variance':
      return {
        title: `Stock doesn't add up: ${formatBps(item.varianceBps)} of food sales`,
        detail: `Between the last two stock takes more went than sales, batches and logged waste explain${
          item.topIngredient ? `, most of it ${item.topIngredient}` : ''
        }. Check portions, waste and deliveries.`,
        action: 'Open used vs should have used',
        amount: loss,
      };
    case 'stock_take_due':
      return stockTakeDueWords(item);
  }
}

/**
 * The owner's stock-take reminder (Settings → Kitchen & stock) as a "Do
 * this" line: "Count the key items — the key items were last counted 9
 * days ago; you asked for a count every 7 days." Built from the values.
 * A full stock take counts the key items too, so the key-items line says
 * when they were last COUNTED (by either kind), never that a key-items
 * count happened when it was a full one.
 */
export function stockTakeDueWords(item: Pick<Extract<DoThisItem, { kind: 'stock_take_due' }>, 'scope' | 'everyDays' | 'daysSince'>): DoThisWords {
  const full = item.scope === 'full';
  const every = `you asked for ${full ? 'one' : 'a count'} every ${plural(item.everyDays, 'day')}`;
  const when = (d: number) => (d === 0 ? 'today' : d === 1 ? 'yesterday' : `${plural(d, 'day')} ago`);
  const last = full
    ? item.daysSince === null
      ? 'No full stock take yet'
      : `The last full stock take was ${when(item.daysSince)}`
    : item.daysSince === null
      ? 'The key items have never been counted'
      : `The key items were last counted ${when(item.daysSince)}`;
  return {
    title: item.scope === 'full' ? 'Time for a full stock take' : 'Count the key items',
    detail: `${last}; ${every} (Settings → Kitchen & stock).`,
    action: 'Open stock takes',
    amount: null,
  };
}

/** "Today", "This week"… and what each is compared with (the trend strip). */
export const TREND_LABEL: Record<ReportTrendPeriod, { title: string; previous: string; lastYear: string | null }> = {
  today: { title: 'Today so far', previous: 'same day last week', lastYear: 'same day last year' },
  week: { title: 'This week so far', previous: 'last week by now', lastYear: 'same week last year' },
  month: { title: 'This month so far', previous: 'last month by this date', lastYear: 'this month last year' },
  year: { title: 'This year so far', previous: 'last year by this date', lastYear: null },
};

/** "Mon 21 Sep – Sun 27 Sep 2026". */
export function weekDates(firstDay: string, lastDay: string): string {
  const sameYear = firstDay.slice(0, 4) === lastDay.slice(0, 4);
  return `${fmtDay(firstDay, !sameYear)} – ${fmtDay(lastDay)}`;
}

/**
 * The heatmap shows once it averages a week of whole days or more (an
 * average weekday of one day says nothing). Counted from the days it is
 * over, not the period's length: today (until it is over), days still to
 * come, days before the till's first order and closed days are not in it.
 */
export const HEATMAP_MIN_DAYS = 7;

/** The whole trading days the heatmap's averages are over (closed days left out). */
export function heatmapDaysCounted(hm: Pick<ReportHeatmap, 'dayCounts'>): number {
  return hm.dayCounts.reduce((s, n) => s + n, 0);
}

/** Whether the heatmap has enough to show: an hour with a sale, over a week of whole days or more. */
export function heatmapShown(hm: Pick<ReportHeatmap, 'dayCounts' | 'hours'>): boolean {
  return hm.hours.length > 0 && heatmapDaysCounted(hm) >= HEATMAP_MIN_DAYS;
}

/** A part of the day's hours: "12 pm – 3:59 pm", "11 pm – 4:59 am"; "the rest of the day" for Other hours. */
export function daypartHoursText(fromHour: number, toHour: number): string {
  if (fromHour < 0) return 'the rest of the day';
  const end = `${toHour % 12 === 0 ? 12 : toHour % 12}:59 ${toHour < 12 ? 'am' : 'pm'}`;
  return `${hourLabel(fromHour)} – ${end}`;
}

/** A trading day (YYYY-MM-DD) outside the dates picked on Reports. */
export function dayOutsidePeriod(day: string, period: { firstDay: string; lastDay: string }): boolean {
  return day < period.firstDay || day > period.lastDay;
}

/**
 * What the till says once a note is added: for a day outside the dates on
 * screen, that it is kept and where to find it (the list shows only the
 * period's notes, so without this it looks as if nothing happened).
 */
export function dayNoteAddedText(day: string, period: { firstDay: string; lastDay: string }): string {
  return dayOutsidePeriod(day, period)
    ? `Added for ${fmtDay(day)}. Pick dates that include it to see it in the list.`
    : `Added for ${fmtDay(day)}.`;
}

/** "Eid · Closed all day" and the like: the tag, then the note. */
export function dayNoteText(n: { tag: DayNoteTag; note: string | null }): string {
  return n.note ? `${DAY_NOTE_TAG_LABEL[n.tag]} · ${n.note}` : DAY_NOTE_TAG_LABEL[n.tag];
}

// ------------------------------------------------------ the trend strip --

/** Weekday of a trading day (YYYY-MM-DD), 0 = Monday. */
function weekdayOfYmd(ymd: string): number {
  return (new Date(`${ymd}T00:00:00.000Z`).getUTCDay() + 6) % 7;
}

export interface Sparkline {
  values: number[];
  /** What the line covers: "The 14 days before today". */
  caption: string;
}

/**
 * The small lines beside the trend strip: only stretches that are OVER and
 * that the till traded for in full. Today, this week and this month are
 * still going (at 1 pm today has a fraction of a day's sales), so drawn at
 * the end of the line they would read as a fall every day; days, weeks and
 * months before this till's first order would read as a rise. So:
 *  - today: the (up to) 14 days before today;
 *  - this week: the whole weeks, Monday to Sunday, before this one;
 *  - this month: the months before this one.
 */
export function trendSparklines(t: Pick<ReportTrends, 'recentDays' | 'months' | 'firstOrderAt'>): Partial<Record<ReportTrendPeriod, Sparkline>> {
  const out: Partial<Record<ReportTrendPeriod, Sparkline>> = {};
  const firstDay = t.firstOrderAt ? t.firstOrderAt.slice(0, 10) : null;
  const traded = (day: string) => firstDay !== null && day >= firstDay;
  const today = t.recentDays.at(-1);
  if (today) {
    const done = t.recentDays.slice(0, -1);
    const days = done.slice(-14).filter((d) => traded(d.day));
    if (days.length >= 2) out.today = { values: days.map((d) => d.netSalesCents), caption: `The ${days.length} days before today` };
    // This week began on the Monday `weekday` days before today; each whole week before it, Monday first.
    const weeks: number[] = [];
    for (let end = done.length - weekdayOfYmd(today.day); end - 7 >= 0; end -= 7) {
      const week = done.slice(end - 7, end);
      if (!traded(week[0]!.day)) break;
      weeks.unshift(week.reduce((sum, d) => sum + d.netSalesCents, 0));
    }
    if (weeks.length >= 2) out.week = { values: weeks, caption: `The ${weeks.length} weeks before this one` };
  }
  const months = t.months.slice(0, -1).filter((m) => m.hadData);
  if (months.length >= 2) out.month = { values: months.map((m) => m.netSalesCents), caption: `The ${months.length} months before this one` };
  return out;
}

/** How a month reads in the 12-month table and tooltip: "no data then", "so far", or nothing. */
export function monthNote(m: Pick<ReportMonthPoint, 'hadData' | 'orderCount'>, isThisMonth: boolean): string | null {
  if (!m.hadData && m.orderCount === 0) return 'no data then';
  if (isThisMonth) return 'so far';
  if (!m.hadData) return 'the till started part-way through';
  return null;
}
