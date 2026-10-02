import { formatCents } from '@cheeseoclock/pos-domain';
import type { DrawerLogCounts, DrawerLogGroup, ReportDrawerLogLine, ReportShiftLine } from '@cheeseoclock/shared-types';
import { fmtWhen } from './reportFormat';

/**
 * The cash drawer log's words (migration 0042; Reports → Team & leakage, a
 * shift's "Drawer log", and the Excel / paper copies). Pure, so they are
 * tested on their own; every figure comes from reports:drawerLog.
 */

export const DRAWER_LOG_SUBTITLE =
  'Every time the till opened the cash drawer: cash sales, refunds, cash in and out, the float, counting, no sale and tests. Opening it with the key is not recorded.';

/** "Cash drawer log — used 12 times" */
export function drawerLogTitle(total: number): string {
  return `Cash drawer log — used ${total} ${total === 1 ? 'time' : 'times'}`;
}

/** The footer: when the log started, and what was kept before it. */
export function drawerLogSinceText(logSince: string | null): string {
  if (!logSince) return 'Before the drawer log only Open drawer, count and test were recorded.';
  return `Drawer log started ${fmtWhen(logSince)}. Before that only Open drawer, count and test were recorded.`;
}

/** The filter pills, in order ('All' first: the list opens on it). */
export const DRAWER_LOG_GROUPS: ReadonlyArray<{ key: DrawerLogGroup; label: string }> = [
  { key: 'all', label: 'All' },
  { key: 'sales', label: 'Sales & refunds' },
  { key: 'cash', label: 'Cash in & out, float' },
  { key: 'nosale', label: 'No sale, count & test' },
  { key: 'problems', label: 'Problems' },
];

/** The count chips: each kind, then the two problem results. Zero ones are left out on screen. */
export function drawerLogChips(counts: DrawerLogCounts): Array<{ label: string; n: number; problem?: boolean }> {
  const k = (kind: string) => counts.byKind[kind] ?? 0;
  return [
    { label: 'Cash sales', n: k('sale') },
    { label: 'Refunds', n: k('refund') },
    { label: 'Cash in', n: k('payin') },
    { label: 'Cash out', n: k('payout') },
    { label: 'Rider tips', n: k('tip_out') },
    { label: 'Float', n: k('float') },
    { label: 'Count', n: k('count') },
    { label: 'No sale', n: k('no_sale') },
    { label: 'Test', n: k('test') },
    { label: 'Did not open', n: counts.byOutcome['not_opened'] ?? 0, problem: true },
    { label: 'May not have opened', n: counts.byOutcome['unsure'] ?? 0, problem: true },
  ];
}

/** "#0042" from "20260926-0042". */
function shortNumber(orderNumber: string): string {
  return `#${orderNumber.split('-').pop() ?? orderNumber}`;
}

/** "rider kept Rs 200 delivery charge" from "Rider kept Rs 200 delivery charge": the end of a sentence. */
function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

/**
 * Why the drawer opened, in the owner's words ("Cash sale — Order #0042").
 * Outside riders (v0.7.34): the cash an outside rider hands in is a sale
 * whose reason says what he kept ("Cash sale — Order #0042 — rider kept
 * Rs 200 delivery charge"); a payout to him for an order (his charge on a
 * prepaid order, or a wasted trip) shows its stored reason, which names the
 * order ("Cash out — Delivery charge kept by the outside rider — Order
 * #0042").
 */
export function drawerWhy(line: Pick<ReportDrawerLogLine, 'kind' | 'orderNumber' | 'orderDeletedAsTest' | 'reason'>): string {
  const deleted = line.orderDeletedAsTest ? ' (deleted test order)' : '';
  const order = line.orderNumber ? ` — Order ${shortNumber(line.orderNumber)}${deleted}` : '';
  const why = (label: string) => (line.reason ? `${label} — ${line.reason}` : label);
  switch (line.kind) {
    case 'sale':
      return `Cash sale${order}${line.reason ? ` — ${lowerFirst(line.reason)}` : ''}`;
    case 'refund':
      return `Refund${order}`;
    case 'payin':
      return why('Cash in');
    case 'payout':
      // Linked to an order: its reason already names it; with none, the order does.
      if (line.orderNumber) return line.reason ? `Cash out — ${line.reason}${deleted}` : `Cash out${order}`;
      return why('Cash out');
    case 'tip_out':
      return why('Rider tip');
    case 'float':
      return 'Float at shift open';
    case 'count':
      return 'Opened to count';
    case 'no_sale':
      return why('No sale');
    case 'test':
      return 'Test (Settings)';
    default:
      // A kind a newer till wrote: never passed off as "No sale".
      return why('Other');
  }
}

/** How long a pulse with no result yet is "Waiting…" rather than unknown. */
export const DRAWER_WAITING_MS = 2 * 60_000;

/** Whether the drawer opened, in words ("—" for a row from before the log). */
export function drawerResult(line: Pick<ReportDrawerLogLine, 'outcome' | 'createdAt'>, nowMs: number = Date.now()): string {
  switch (line.outcome) {
    case 'opened':
      return 'Opened';
    case 'already_open':
      return 'Already open';
    case 'not_opened':
      return 'Did not open — key used?';
    case 'unsure':
      return 'May not have opened';
    case 'no_printer':
      return 'No printer set up';
    default: {
      const age = nowMs - Date.parse(line.createdAt);
      return Number.isFinite(age) && age >= 0 && age < DRAWER_WAITING_MS ? 'Waiting…' : '—';
    }
  }
}

/** A result that deserves a look (red on screen). */
export function drawerResultIsProblem(outcome: string | null): boolean {
  return outcome === 'not_opened' || outcome === 'unsure';
}

/** "+Rs 1,250" into the drawer, "−Rs 500" out; "" for no sale / count / test. */
export function drawerCash(amountCents: number | null): string {
  if (amountCents === null) return '';
  if (amountCents === 0) return formatCents(0);
  return `${amountCents > 0 ? '+' : '−'}${formatCents(Math.abs(amountCents))}`;
}

/** "This till" / "Other till" */
export function drawerTill(till: ReportDrawerLogLine['till']): string {
  return till === 'this' ? 'This till' : 'Other till';
}

/** A shift's note on the Shifts table: " · drawer used 9× (1 no sale)". */
export function shiftDrawerUseNote(s: Pick<ReportShiftLine, 'drawerOpenCount' | 'noSaleOpens'>): string {
  const n = s.drawerOpenCount ?? 0;
  if (n > 0) return ` · drawer used ${n}× (${s.noSaleOpens} no sale)`;
  return s.noSaleOpens > 0 ? ` · drawer opened ${s.noSaleOpens}× with no sale` : '';
}

/**
 * A closed shift with test orders deleted after it closed (0043): its saved
 * figures stay. testDeletedCashCents is signed — cash taken for those tests
 * minus cash handed back for them on this shift — so the note says which way
 * the saved expected cash is off: a test REFUND paid out of this drawer made
 * it lower, not higher.
 */
export function shiftTestDeletedNote(s: Pick<ReportShiftLine, 'testDeletedCashCents'>): string | null {
  const c = s.testDeletedCashCents ?? 0;
  if (c === 0) return null;
  if (c > 0) return `Includes ${formatCents(c)} of test orders deleted after this shift closed.`;
  return `Its expected cash was ${formatCents(-c)} lower because of a test-order refund deleted after this shift closed.`;
}

/** The log as rows for a file: the same columns everywhere (Excel, CSV, a shift's download). */
export const DRAWER_LOG_COLUMNS = ['When', 'Till', 'Why', 'Order', 'Cash Rs', 'By', 'Approved by', 'Result', 'Note'] as const;

export function drawerLogRow(
  l: ReportDrawerLogLine,
  nowMs: number = Date.now(),
): [string, string, string, string | null, number | null, string, string | null, string, string | null] {
  return [
    fmtWhen(l.createdAt),
    drawerTill(l.till),
    drawerWhy(l),
    l.orderNumber,
    l.amountCents === null ? null : l.amountCents / 100,
    l.openedBy,
    l.approvedBy,
    drawerResult(l, nowMs),
    l.outcomeNote,
  ];
}

/** One shift's log as a CSV file (the Shifts table's "Drawer log" → Download CSV). */
export function drawerLogCsv(lines: readonly ReportDrawerLogLine[], nowMs: number = Date.now()): string {
  const cell = (v: string | number | null): string => {
    if (v === null) return '';
    if (typeof v === 'number') return v.toFixed(2);
    const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
    return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  const rows = [DRAWER_LOG_COLUMNS.map(cell).join(','), ...lines.map((l) => drawerLogRow(l, nowMs).map(cell).join(','))];
  return String.fromCharCode(0xfeff) + rows.join('\r\n') + '\r\n';
}
