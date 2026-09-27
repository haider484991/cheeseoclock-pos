import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Button, cn } from '@cheeseoclock/ui';
import { FileSpreadsheet, Printer, X } from 'lucide-react';
import type { DrawerLogGroup, DrawerLogPage, ReportDrawerLogLine, ReportShiftLine } from '@cheeseoclock/shared-types';
import { ipc } from '../../../ipc/client';
import { useToast } from '../../../components/toast/ToastProvider';
import { DataTable, Panel } from '../reportUi';
import { fmtWhen } from '../reportFormat';
import { downloadText } from '../exporters';
import {
  DRAWER_LOG_GROUPS,
  DRAWER_LOG_SUBTITLE,
  drawerCash,
  drawerLogChips,
  drawerLogCsv,
  drawerLogSinceText,
  drawerLogTitle,
  drawerResult,
  drawerResultIsProblem,
  drawerTill,
  drawerWhy,
} from '../drawerLogFormat';

/** Rows per "Show 50 more". */
export const DRAWER_LOG_PAGE = 50;

/** A shift's log is all of it: its rows are found by the shift, whatever the dates. */
const ANY_TIME = { sinceIso: '2000-01-01T00:00:00.000Z', untilIso: '2100-01-01T00:00:00.000Z' } as const;

/** One period's (or one shift's) log, a page at a time, newest first. */
function useDrawerLog(q: { sinceIso: string; untilIso: string; shiftId?: string; group: DrawerLogGroup }) {
  return useInfiniteQuery({
    queryKey: ['reports', 'drawerLog', q.sinceIso, q.untilIso, q.shiftId ?? null, q.group],
    queryFn: ({ pageParam }) =>
      ipc.reports.drawerLog({
        sinceIso: q.sinceIso,
        untilIso: q.untilIso,
        group: q.group,
        limit: DRAWER_LOG_PAGE,
        ...(q.shiftId ? { shiftId: q.shiftId } : {}),
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last: DrawerLogPage) => last.nextCursor,
    enabled: q.untilIso > q.sinceIso,
    staleTime: 15_000,
  });
}

function DrawerLogTable({ rows, nowMs }: { rows: ReportDrawerLogLine[]; nowMs: number }) {
  return (
    <DataTable
      columns={[
        { label: 'When' },
        { label: 'Till' },
        { label: 'Why' },
        { label: 'Cash', right: true },
        { label: 'By' },
        { label: 'Approved by' },
        { label: 'Result' },
      ]}
      rows={rows.map((d) => [
        <div key="w">
          <div>{fmtWhen(d.createdAt)}</div>
          {d.outsideShift && <div className="text-xs text-amber-700 dark:text-amber-400">No shift open</div>}
        </div>,
        drawerTill(d.till),
        drawerWhy(d),
        drawerCash(d.amountCents) || '—',
        d.openedBy,
        d.approvedBy ?? '—',
        <div key="r">
          <div className={cn(drawerResultIsProblem(d.outcome) && 'font-semibold text-red-700 dark:text-red-400')}>{drawerResult(d, nowMs)}</div>
          {d.outcomeNote && drawerResultIsProblem(d.outcome) && <div className="text-xs text-stone-500">{d.outcomeNote}</div>}
        </div>,
      ])}
      empty="The drawer was not opened in this period."
    />
  );
}

function Chips({ page }: { page: DrawerLogPage | undefined }) {
  if (!page) return null;
  const chips = drawerLogChips(page.counts).filter((c) => c.n > 0);
  if (chips.length === 0) return null;
  return (
    <div className="mb-3 flex flex-wrap gap-1.5" aria-label="Counts">
      {chips.map((c) => (
        <span
          key={c.label}
          className={cn(
            'rounded-full px-2.5 py-1 text-xs font-semibold',
            c.problem ? 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200' : 'bg-stone-100 text-stone-700 dark:bg-stone-800 dark:text-stone-200',
          )}
        >
          {c.label} {c.n}
        </span>
      ))}
    </div>
  );
}

/**
 * Reports → Team & leakage: "Cash drawer log — used N times" (the owner).
 * Every time the till opened the drawer, newest first, 50 at a time; opens
 * on 'All'. Replaces "Cash drawer opened by hand".
 */
export function DrawerLogPanel({ sinceIso, untilIso }: { sinceIso: string; untilIso: string }) {
  const [group, setGroup] = useState<DrawerLogGroup>('all');
  const q = useDrawerLog({ sinceIso, untilIso, group });
  const first = q.data?.pages[0];
  const rows = q.data?.pages.flatMap((p) => p.rows) ?? [];
  const nowMs = Date.now();
  return (
    <Panel title={drawerLogTitle(first?.counts.total ?? 0)} note={drawerLogSinceText(first?.logSince ?? null)} className="xl:col-span-2">
      <p className="-mt-2 mb-3 text-xs text-stone-500 dark:text-stone-400">{DRAWER_LOG_SUBTITLE}</p>
      <Chips page={first} />
      <div className="mb-3 flex flex-wrap gap-1.5" role="group" aria-label="Show">
        {DRAWER_LOG_GROUPS.map((g) => (
          <button
            key={g.key}
            type="button"
            aria-pressed={group === g.key}
            onClick={() => setGroup(g.key)}
            className={cn(
              'rounded-lg px-3 py-1.5 text-xs font-semibold ring-1 transition-colors',
              group === g.key
                ? 'bg-amber-100 text-amber-900 ring-amber-300 dark:bg-amber-950 dark:text-amber-100 dark:ring-amber-700'
                : 'bg-white text-stone-600 ring-stone-200 hover:bg-stone-50 dark:bg-stone-900 dark:text-stone-300 dark:ring-stone-700',
            )}
          >
            {g.label}
          </button>
        ))}
      </div>
      {q.isLoading ? (
        <p className="py-4 text-center text-sm text-stone-500">Loading…</p>
      ) : q.error ? (
        <p className="py-4 text-center text-sm text-red-700 dark:text-red-400">
          {q.error instanceof Error ? q.error.message : 'The drawer log could not be read.'}
        </p>
      ) : (
        <DrawerLogTable rows={rows} nowMs={nowMs} />
      )}
      {q.hasNextPage && (
        <Button variant="secondary" size="sm" className="mt-3" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
          {q.isFetchingNextPage ? 'Loading…' : `Show ${DRAWER_LOG_PAGE} more`}
        </Button>
      )}
    </Panel>
  );
}

/** The note when a shift's whole log could not be read for Print / Download CSV. */
export const DRAWER_LOG_READ_FAILED = 'Could not read the drawer log';

/**
 * Read one shift's whole log, then hand it on (Print, Download CSV). A failed
 * read (the session timed out, the till is busy) is told through `onError` —
 * never swallowed, so the owner is not left thinking the shift had no opens
 * or the button is broken. Never throws.
 */
export async function withWholeShiftLog(
  shiftId: string,
  then: (all: ReportDrawerLogLine[]) => void,
  onError: (message: string) => void,
  read: (shiftId: string) => Promise<ReportDrawerLogLine[]> = wholeShiftLog,
): Promise<void> {
  let all: ReportDrawerLogLine[];
  try {
    all = await read(shiftId);
  } catch (e) {
    onError(e instanceof Error ? e.message : String(e));
    return;
  }
  then(all);
}

/** Every row of one shift's log (for its Print and Download CSV). */
async function wholeShiftLog(shiftId: string): Promise<ReportDrawerLogLine[]> {
  const out: ReportDrawerLogLine[] = [];
  let cursor: string | null = null;
  // At most 5,000 opens: far more than any shift has.
  for (let i = 0; i < 25; i += 1) {
    const page: DrawerLogPage = await ipc.reports.drawerLog({ ...ANY_TIME, shiftId, limit: 200, ...(cursor ? { cursor } : {}) });
    out.push(...page.rows);
    cursor = page.nextCursor;
    if (!cursor) break;
  }
  return out;
}

/** The HTML of one shift's log on paper (the report print CSS applies). */
export function shiftDrawerLogPrint(shift: Pick<ReportShiftLine, 'openedAt' | 'closedAt'>, rows: readonly ReportDrawerLogLine[], nowMs: number): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const head = ['When', 'Till', 'Why', 'Cash', 'By', 'Approved by', 'Result'];
  const body = rows
    .map(
      (d) =>
        `<tr>${[fmtWhen(d.createdAt), drawerTill(d.till), drawerWhy(d), drawerCash(d.amountCents) || '—', d.openedBy, d.approvedBy ?? '—', drawerResult(d, nowMs)]
          .map((c) => `<td>${esc(c)}</td>`)
          .join('')}</tr>`,
    )
    .join('');
  return (
    `<header><h1>Cash drawer log — shift ${esc(fmtWhen(shift.openedAt))}${shift.closedAt ? ` to ${esc(fmtWhen(shift.closedAt))}` : ' (still open)'}</h1></header>` +
    `<section><table><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${body}</tbody></table></section>`
  );
}

/**
 * The Shifts table's "Drawer log": that shift's opens with their counts, and
 * Print / Download CSV. The owner (Reports).
 */
export function ShiftDrawerLogDialog({
  shift,
  onClose,
  onPrint,
}: {
  shift: ReportShiftLine;
  onClose: () => void;
  /** Prints an HTML body with the Reports print sheet (no Print button without it). */
  onPrint?: (html: string) => void;
}) {
  const q = useDrawerLog({ ...ANY_TIME, shiftId: shift.id, group: 'all' });
  const first = q.data?.pages[0];
  const rows = q.data?.pages.flatMap((p) => p.rows) ?? [];
  const nowMs = Date.now();
  const [busy, setBusy] = useState(false);
  const { toast } = useToast();
  const fileName = `drawer-log-shift-${shift.openedAt.slice(0, 10)}.csv`;

  const withAll = async (then: (all: ReportDrawerLogLine[]) => void) => {
    setBusy(true);
    try {
      await withWholeShiftLog(shift.id, then, (message) =>
        toast({ title: DRAWER_LOG_READ_FAILED, description: message, variant: 'error' }),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[90vh] w-[960px] max-w-[95vw] -translate-x-1/2 -translate-y-1/2 flex-col rounded-2xl bg-white p-5 shadow-soft-lg dark:bg-stone-900">
          <div className="mb-3 flex items-start justify-between gap-3">
            <div>
              <Dialog.Title className="text-lg font-semibold">{drawerLogTitle(first?.counts.total ?? 0)}</Dialog.Title>
              <Dialog.Description className="mt-0.5 text-xs text-stone-500">
                Shift {fmtWhen(shift.openedAt)}
                {shift.closedAt ? ` to ${fmtWhen(shift.closedAt)}` : ' (still open)'} · opened by {shift.openedBy}
              </Dialog.Description>
            </div>
            <div className="flex items-center gap-2">
              {onPrint && (
                <Button variant="secondary" size="sm" disabled={busy} onClick={() => void withAll((all) => onPrint(shiftDrawerLogPrint(shift, all, Date.now())))}>
                  <Printer className="h-4 w-4" />
                  Print
                </Button>
              )}
              <Button variant="secondary" size="sm" disabled={busy} onClick={() => void withAll((all) => downloadText(fileName, drawerLogCsv(all)))}>
                <FileSpreadsheet className="h-4 w-4" />
                Download CSV
              </Button>
              <button type="button" onClick={onClose} aria-label="Close" className="rounded p-1 text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-800">
                <X className="h-4 w-4" />
              </button>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <Chips page={first} />
            {q.isLoading ? (
              <p className="py-4 text-center text-sm text-stone-500">Loading…</p>
            ) : q.error ? (
              <p className="py-4 text-center text-sm text-red-700 dark:text-red-400">
                {q.error instanceof Error ? q.error.message : 'The drawer log could not be read.'}
              </p>
            ) : (
              <DrawerLogTable rows={rows} nowMs={nowMs} />
            )}
            {q.hasNextPage && (
              <Button variant="secondary" size="sm" className="mt-3" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
                {q.isFetchingNextPage ? 'Loading…' : `Show ${DRAWER_LOG_PAGE} more`}
              </Button>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
