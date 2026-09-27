/**
 * Reports → Team & leakage (costing spec Phase 3): who took the orders,
 * shifts and the cash drawer, discounts, refunds and cancelled orders. The
 * sections moved here unchanged from ReportSections.tsx; the tab loads only
 * these figures (reports:team). Phase 10 adds rates, flags and the
 * Exceptions list here.
 */
import { useState } from 'react';
import { cn } from '@cheeseoclock/ui';
import { formatCents } from '@cheeseoclock/pos-domain';
import type { ReportOrderStock, ReportShiftLine, ReportTeamTab } from '@cheeseoclock/shared-types';
import { Percent, Receipt, Trash2, UsersRound } from 'lucide-react';
import { DataTable, Panel, Section, useShowAll } from '../reportUi';
import { fmtWhen, methodLabel, percentOf, stockCellText } from '../reportFormat';
import { shiftDrawerUseNote, shiftTestDeletedNote } from '../drawerLogFormat';
import { DrawerLogPanel, ShiftDrawerLogDialog } from './DrawerLog';
import { DeletedTestOrdersPanel, deletedTestsTitle, useDeletedTests } from '../../orders/DeletedTestOrdersPanel';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** `onPrint`: prints an HTML body with the Reports print sheet (a shift's drawer log). */
export function TeamLeakageTab({ data, onPrint }: { data: ReportTeamTab; onPrint?: (html: string) => void }) {
  return (
    <div className="space-y-10">
      <StaffSection report={data} {...(onPrint ? { onPrint } : {})} />
      <DiscountsSection report={data} />
      <RefundsSection report={data} />
      <DeletedTestsSection sinceIso={data.sinceIso} untilIso={data.untilIso} />
    </div>
  );
}

/** " · cash in/out 3× · drawer used 9× (1 no sale)" — what opened the drawer on a shift. */
function shiftDrawerNote(s: ReportShiftLine): string {
  let note = '';
  if (s.cashMovementCount > 0) note += ` · cash in/out ${s.cashMovementCount}×`;
  return note + shiftDrawerUseNote(s);
}

export function StaffSection({
  report,
  onPrint,
}: {
  report: Pick<ReportTeamTab, 'kpis' | 'staff' | 'shifts' | 'sinceIso' | 'untilIso'>;
  onPrint?: (html: string) => void;
}) {
  const net = report.kpis.netSalesCents;
  const [logShift, setLogShift] = useState<ReportShiftLine | null>(null);
  const closed = report.shifts.filter((s) => s.closedAt !== null && s.varianceCents !== null);
  const drawer = closed.reduce((sum, s) => sum + (s.varianceCents ?? 0), 0);
  return (
    <Section id="staff" icon={UsersRound} title="Staff and cash drawer">
      <div className="grid gap-4 xl:grid-cols-2">
        <Panel
          title="Orders taken"
          note="Website orders come in by themselves, so they have their own line. Reprints: a bill or receipt printed again with a print button after one had already gone out. A table's first bill printed with the button says DUPLICATE too, but is not counted here."
        >
          <DataTable
            columns={[{ label: 'Taken by' }, { label: 'Orders', right: true }, { label: 'Sales', right: true }, { label: 'Discounts', right: true }, { label: 'Cancelled', right: true }, { label: 'No-sale opens', right: true }, { label: 'Drawer opens', right: true }, { label: 'Reprints', right: true }]}
            rows={report.staff.map((s) => [
              <span key="n" className={cn('font-medium', s.isWebsite && 'text-sky-700 dark:text-sky-300')}>{s.name}</span>,
              s.orderCount,
              <span key="s">
                {formatCents(s.netSalesCents)} <span className="text-xs text-stone-500">{percentOf(s.netSalesCents, net)}</span>
              </span>,
              s.discountCents > 0 ? formatCents(s.discountCents) : '—',
              s.voidCount > 0 ? <span key="v" className="font-semibold text-amber-700 dark:text-amber-400">{s.voidCount}</span> : '—',
              s.noSaleOpens > 0 ? <span key="d" className="font-semibold text-amber-700 dark:text-amber-400">{s.noSaleOpens}</span> : '—',
              // Every time the till opened the drawer for them: cash sales, refunds, cash in / out, float… (0040).
              (s.drawerOpens ?? 0) > 0 ? s.drawerOpens : '—',
              // Receipts / bills printed AGAIN by hand, after one had gone out (print-log-sql.ts).
              (s.reprints ?? 0) > 0 ? <span key="r" className="font-semibold text-amber-700 dark:text-amber-400">{s.reprints}</span> : '—',
            ])}
            empty="No orders in this period yet."
          />
        </Panel>

        <Panel
          title="Shifts — cash in the drawer"
          note="Expected = float + cash sales − cash refunds + cash put in − cash taken out. Figures are the ones saved when the shift was closed."
        >
          {closed.length > 0 && (
            <div
              className={cn(
                'mb-3 rounded-lg px-3 py-2 text-sm font-semibold',
                drawer === 0
                  ? 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300'
                  : drawer > 0
                    ? 'bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-300'
                    : 'bg-red-50 text-red-800 dark:bg-red-950/40 dark:text-red-300',
              )}
            >
              {drawer === 0
                ? `Every closed drawer matched (${plural(closed.length, 'shift')}).`
                : `${drawer > 0 ? 'Over' : 'Short'} ${formatCents(Math.abs(drawer))} in all, over ${plural(closed.length, 'closed shift')}.`}
            </div>
          )}
          <DataTable
            columns={[{ label: 'Shift' }, { label: 'Float', right: true }, { label: 'Taken out', right: true }, { label: 'Expected', right: true }, { label: 'Counted', right: true }, { label: 'Result', right: true }]}
            rows={report.shifts.map((s) => [
              <div key="w">
                <div className="font-medium">{fmtWhen(s.openedAt)}</div>
                <div className="text-xs text-stone-500">
                  {s.closedAt ? `to ${fmtWhen(s.closedAt)} · closed by ${s.closedBy ?? 'unknown'}` : `still open · opened by ${s.openedBy}`}
                  {shiftDrawerNote(s)}
                </div>
                {shiftTestDeletedNote(s) && (
                  <div className="text-xs font-medium text-amber-700 dark:text-amber-400">{shiftTestDeletedNote(s)}</div>
                )}
                <button
                  type="button"
                  onClick={() => setLogShift(s)}
                  className="mt-0.5 text-xs font-semibold text-amber-700 underline-offset-2 hover:underline dark:text-amber-400"
                >
                  Drawer log
                </button>
              </div>,
              formatCents(s.openingCashCents),
              s.cashOutCents > 0 ? formatCents(s.cashOutCents) : '—',
              s.expectedCashCents === null ? '—' : formatCents(s.expectedCashCents),
              s.countedCashCents === null ? '—' : formatCents(s.countedCashCents),
              s.varianceCents === null ? (
                '—'
              ) : s.varianceCents === 0 ? (
                <span key="r" className="font-semibold text-emerald-700 dark:text-emerald-400">Matched</span>
              ) : (
                <span key="r" className={cn('font-semibold', s.varianceCents > 0 ? 'text-amber-700 dark:text-amber-400' : 'text-red-700 dark:text-red-400')}>
                  {s.varianceCents > 0 ? 'Over' : 'Short'} {formatCents(Math.abs(s.varianceCents))}
                </span>
              ),
            ])}
            empty="No shifts were opened in this period."
          />
        </Panel>

        <DrawerLogPanel sinceIso={report.sinceIso} untilIso={report.untilIso} />
      </div>
      {logShift && <ShiftDrawerLogDialog shift={logShift} onClose={() => setLogShift(null)} {...(onPrint ? { onPrint } : {})} />}
    </Section>
  );
}

/**
 * The owner's deleted test orders taken in the period (0041): "Test orders
 * deleted — N (Rs X)". Read-only; they are in no other figure of Reports.
 */
function DeletedTestsSection({ sinceIso, untilIso }: { sinceIso: string; untilIso: string }) {
  const q = useDeletedTests(sinceIso, untilIso);
  return (
    <Section
      id="deleted-tests"
      icon={Trash2}
      title={deletedTestsTitle(q.data)}
      subtitle="Orders made to test the till that the owner deleted. They are not in sales, the shifts' cash or any other figure here."
    >
      <Panel>
        <DeletedTestOrdersPanel sinceIso={sinceIso} untilIso={untilIso} />
      </Panel>
    </Section>
  );
}

export function DiscountsSection({ report }: { report: Pick<ReportTeamTab, 'kpis' | 'discounts'> }) {
  const d = report.discounts;
  const { shown, toggle } = useShowAll(d.recent, 8);
  return (
    <Section
      id="discounts"
      icon={Percent}
      title="Discounts given"
      subtitle={
        d.totalCount > 0
          ? `${formatCents(d.totalCents)} off ${plural(d.totalCount, 'order')} — ${percentOf(d.totalCents, report.kpis.menuSalesCents)} of menu-price sales.`
          : undefined
      }
    >
      {d.totalCount === 0 ? (
        <Panel>
          <p className="py-4 text-center text-sm text-stone-500">No discounts in this period.</p>
        </Panel>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          <Panel title="Why">
            <DataTable
              columns={[{ label: 'Reason' }, { label: 'Times', right: true }, { label: 'Amount', right: true }]}
              rows={d.byReason.map((r) => [r.reason, r.count, formatCents(r.amountCents)])}
              empty="None."
            />
          </Panel>
          <Panel title="Who gave them" note="“Manager OK” = a manager's PIN or password approved it.">
            <DataTable
              columns={[{ label: 'Given by' }, { label: 'Times', right: true }, { label: 'Amount', right: true }, { label: 'Manager OK', right: true }]}
              rows={d.byPerson.map((p) => [p.name, p.count, formatCents(p.amountCents), p.approvedCount || '—'])}
              empty="None."
            />
          </Panel>
          <Panel title="Each discount" className="xl:col-span-2">
            <DataTable
              columns={[{ label: 'When' }, { label: 'Order' }, { label: 'Discount', right: true }, { label: 'Reason' }, { label: 'Given by' }, { label: 'Approved by' }]}
              rows={shown.map((x) => [
                fmtWhen(x.createdAt),
                <span key="o" className="font-mono text-xs">{x.orderNumber}</span>,
                <span key="a">
                  {formatCents(x.amountCents)}
                  {x.entered && <span className="ml-1 text-xs text-stone-500">({x.entered})</span>}
                </span>,
                x.reason,
                x.givenBy,
                x.approvedBy ?? '—',
              ])}
              empty="None."
            />
            {toggle}
            {d.recent.length < d.totalCount && (
              <p className="mt-2 text-xs text-stone-500">
                Showing the latest {d.recent.length} of {d.totalCount}. The totals above include all of them.
              </p>
            )}
          </Panel>
        </div>
      )}
    </Section>
  );
}

export function RefundsSection({ report }: { report: Pick<ReportTeamTab, 'kpis' | 'refunds' | 'voids' | 'foodCost'> }) {
  const k = report.kpis;
  const refunds = useShowAll(report.refunds, 8);
  const voids = useShowAll(report.voids, 8);
  return (
    <Section
      id="refunds"
      icon={Receipt}
      title="Refunds and cancelled orders"
      subtitle="Refunds are money handed back. Cancelled orders were never paid, so no money moved."
    >
      <div className="grid gap-4 xl:grid-cols-2">
        <Panel
          title={`Refunds — ${formatCents(k.partialRefundCents + k.fullRefundCents)}`}
          note="Listed against the day the order was taken, whenever the money went back."
        >
          <DataTable
            columns={[{ label: 'When' }, { label: 'Amount', right: true }, { label: 'Reason' }, { label: 'Stock' }, { label: 'Approved by' }]}
            rows={refunds.shown.map((x) => [
              <div key="w">
                <div>{fmtWhen(x.refundedAt)}</div>
                <div className="font-mono text-xs text-stone-500">{x.orderNumber}</div>
              </div>,
              <div key="a">
                <div>{formatCents(x.amountCents)}</div>
                <div className="text-xs text-stone-500">
                  {methodLabel(x.method)} · {x.full ? 'whole order' : 'part'}
                </div>
              </div>,
              x.reason,
              <StockCell key="s" stock={x.stock} hasCosts={report.foodCost?.hasCosts ?? false} />,
              x.approvedBy,
            ])}
            empty="No refunds in this period."
          />
          {refunds.toggle}
        </Panel>
        <Panel title={`Cancelled before payment — ${plural(k.voidCount, 'order')}`} note={k.voidCount > 0 ? `Worth ${formatCents(k.voidCents)} at the time. Not in the sales.` : undefined}>
          <DataTable
            columns={[{ label: 'When' }, { label: 'Value', right: true }, { label: 'Reason' }, { label: 'Stock' }, { label: 'Approved by' }, { label: 'Taken by' }]}
            rows={voids.shown.map((v) => [
              <div key="w">
                <div>{fmtWhen(v.voidedAt ?? v.createdAt)}</div>
                {v.billPrinted && <div className="text-[10px] font-semibold uppercase text-red-700 dark:text-red-400">Bill was printed</div>}
                <div className="font-mono text-xs text-stone-500">{v.orderNumber}</div>
              </div>,
              formatCents(v.amountCents),
              v.reason,
              <StockCell key="s" stock={v.stock} hasCosts={report.foodCost?.hasCosts ?? false} />,
              v.approvedBy,
              v.takenBy,
            ])}
            empty="No cancelled orders in this period."
          />
          {voids.toggle}
        </Panel>
      </div>
    </Section>
  );
}

/**
 * What a cancel / whole-order refund did to stock: "Put back", "Wasted · Rs
 * 180", or "—". Amber when it deserves a look: put back although cooking had
 * been marked, or the answer went against what the till hinted.
 */
function StockCell({ stock, hasCosts }: { stock: ReportOrderStock | null; hasCosts: boolean }) {
  const text = stockCellText(stock, hasCosts);
  if (!stock) return <span className="text-stone-400">{text}</span>;
  return (
    <span
      className={cn(
        'whitespace-nowrap text-xs',
        stock.flagged ? 'rounded bg-amber-100 px-1.5 py-0.5 font-semibold text-amber-900 dark:bg-amber-950 dark:text-amber-100' : '',
      )}
      title={stock.flagged ? 'Worth a look: put back after cooking was marked, or against the hint the till showed' : undefined}
    >
      {text}
    </span>
  );
}
