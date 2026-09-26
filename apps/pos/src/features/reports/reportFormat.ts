/**
 * Plain-words labels and the small calculations the Reports page shows.
 * Pure (no React, no DOM) so they are unit-tested.
 */
import type { BusinessReport, ReportChannel, ReportPaymentGroup } from '@cheeseoclock/shared-types';
import { daysSoFar, fmtDay, fmtMonth, tradingDayNumber, weekdayIndex, WEEKDAYS, type ReportPeriod } from './dateRange';

export const CHANNEL_LABEL: Record<ReportChannel, string> = {
  takeaway: 'Takeaway (counter)',
  delivery: 'Delivery (phone)',
  foodpanda: 'Foodpanda',
  web_delivery: 'Website delivery',
  web_pickup: 'Website pick-up',
  dine_in: 'Dine-in (old orders)',
  online: 'Online (old orders)',
};

export const PAYMENT_LABEL: Record<ReportPaymentGroup, string> = {
  cash: 'Cash',
  card: 'Card',
  foodpanda: 'Foodpanda',
  transfer: 'Easypaisa / JazzCash / bank',
};

export const PAYMENT_ORDER: ReportPaymentGroup[] = ['cash', 'card', 'foodpanda', 'transfer'];

const METHOD_LABEL: Record<string, string> = {
  cash: 'Cash',
  card: 'Card',
  foodpanda: 'Foodpanda',
  easypaisa: 'Easypaisa',
  jazzcash: 'JazzCash',
  bank_transfer: 'Bank transfer',
};

export function methodLabel(method: string): string {
  return METHOD_LABEL[method] ?? method;
}

// ------------------------------------------------------------------ change --

export interface Change {
  /** "▲ 12%", "▼ 5%", "Same", "New", or "" when there is nothing to compare. */
  text: string;
  /** Up or down, ignoring whether that is good. */
  direction: 'up' | 'down' | 'flat' | 'none';
}

/** How a figure moved against the comparison period. */
export function changeOf(current: number, previous: number | null | undefined): Change {
  if (previous === null || previous === undefined) return { text: '', direction: 'none' };
  if (current === previous) return { text: 'Same', direction: 'flat' };
  if (previous === 0) return { text: 'New', direction: current > 0 ? 'up' : 'down' };
  const pct = Math.round(((current - previous) / Math.abs(previous)) * 100);
  if (pct === 0) return { text: current > previous ? '▲ <1%' : '▼ <1%', direction: current > previous ? 'up' : 'down' };
  return { text: `${pct > 0 ? '▲' : '▼'} ${Math.abs(pct)}%`, direction: pct > 0 ? 'up' : 'down' };
}

/** Whole-number share, "0%" when there is no whole. */
export function percentOf(part: number, whole: number): string {
  if (whole <= 0) return '0%';
  const p = (part / whole) * 100;
  if (p > 0 && p < 1) return '<1%';
  return `${Math.round(p)}%`;
}

// ------------------------------------------------------------------ hours --

/** A Pakistan clock hour as people say it: 0 → "12 am", 13 → "1 pm". */
export function hourLabel(h: number): string {
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12} ${h < 12 ? 'am' : 'pm'}`;
}

/** Hours in trading-day order: 5 am … 11 pm, then midnight … 4 am. */
export const TRADING_HOURS: number[] = [...Array.from({ length: 19 }, (_, i) => i + 5), 0, 1, 2, 3, 4];

/**
 * One bar per hour from the first hour with a sale to the last (in trading
 * order, so midnight and 1 am follow 11 pm), with empty hours between kept
 * so the gaps show.
 */
export function hourSeries(byHour: BusinessReport['byHour']): Array<{ hour: number; orderCount: number; netSalesCents: number }> {
  const at = new Map(byHour.map((h) => [h.hour, h]));
  const positions = TRADING_HOURS.map((h, i) => (at.has(h) ? i : -1)).filter((i) => i >= 0);
  if (positions.length === 0) return [];
  const from = Math.min(...positions);
  const to = Math.max(...positions);
  return TRADING_HOURS.slice(from, to + 1).map((hour) => ({
    hour,
    orderCount: at.get(hour)?.orderCount ?? 0,
    netSalesCents: at.get(hour)?.netSalesCents ?? 0,
  }));
}

// ------------------------------------------------------------------- days --

export interface DayBar {
  key: string;
  /** Short label under the bar. */
  label: string;
  /** Full label for the tooltip / table. */
  title: string;
  orderCount: number;
  netSalesCents: number;
}

/**
 * Sales over the period: a bar a day (empty days included, future days
 * left out) up to two months, a bar a month beyond that.
 */
export function daySeries(
  byDay: BusinessReport['byDay'],
  period: Pick<ReportPeriod, 'firstDay' | 'lastDay'>,
  now: Date = new Date(),
): { unit: 'day' | 'month'; bars: DayBar[] } {
  const days = daysSoFar(period, now);
  const at = new Map(byDay.map((d) => [d.day, d]));
  if (days.length <= 62) {
    return {
      unit: 'day',
      bars: days.map((day) => ({
        key: day,
        label: String(Number(day.slice(8, 10))),
        title: fmtDay(day),
        orderCount: at.get(day)?.orderCount ?? 0,
        netSalesCents: at.get(day)?.netSalesCents ?? 0,
      })),
    };
  }
  const months = new Map<string, DayBar>();
  for (const day of days) {
    const key = day.slice(0, 7);
    const bar = months.get(key) ?? {
      key,
      label: fmtMonth(day).slice(0, 3),
      title: fmtMonth(day),
      orderCount: 0,
      netSalesCents: 0,
    };
    bar.orderCount += at.get(day)?.orderCount ?? 0;
    bar.netSalesCents += at.get(day)?.netSalesCents ?? 0;
    months.set(key, bar);
  }
  return { unit: 'month', bars: [...months.values()] };
}

/**
 * The average trading day for each weekday in the period (so far): total
 * sales on Mondays ÷ number of Mondays, and so on. Days with no sales count
 * as zero — a shut Monday pulls Mondays down, which is the truth.
 */
export function weekdayAverages(
  byDay: BusinessReport['byDay'],
  period: Pick<ReportPeriod, 'firstDay' | 'lastDay'>,
  now: Date = new Date(),
): Array<{ weekday: string; days: number; avgSalesCents: number; avgOrders: number }> {
  const at = new Map(byDay.map((d) => [d.day, d]));
  const acc = WEEKDAYS.map((weekday) => ({ weekday, days: 0, sales: 0, orders: 0 }));
  for (const day of daysSoFar(period, now)) {
    const n = tradingDayNumber(day);
    if (n === null) continue;
    const slot = acc[weekdayIndex(n)]!;
    slot.days += 1;
    slot.sales += at.get(day)?.netSalesCents ?? 0;
    slot.orders += at.get(day)?.orderCount ?? 0;
  }
  return acc.map((a) => ({
    weekday: a.weekday,
    days: a.days,
    avgSalesCents: a.days > 0 ? Math.round(a.sales / a.days) : 0,
    avgOrders: a.days > 0 ? Math.round((a.orders / a.days) * 10) / 10 : 0,
  }));
}

// ------------------------------------------------------------------ times --

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** An instant on the Pakistan clock: "26 Sep, 8:30 pm". Fixed UTC+5, whatever the PC's zone. */
export function fmtWhen(iso: string | null): string {
  if (!iso) return '—';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '—';
  const d = new Date(ms + 5 * 3_600_000);
  const h = d.getUTCHours();
  const m = String(d.getUTCMinutes()).padStart(2, '0');
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}, ${h % 12 === 0 ? 12 : h % 12}:${m} ${h < 12 ? 'am' : 'pm'}`;
}

/** "45 min", "1 h 10 min". */
export function fmtMinutes(min: number | null): string {
  if (min === null) return '—';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/** A quantity in an ingredient's unit, with thousands separators: "12,500 g". */
export function fmtQty(qty: number, unit: string): string {
  return `${new Intl.NumberFormat('en-PK').format(qty)} ${unit}`;
}
