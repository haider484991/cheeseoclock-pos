import type { Metadata } from 'next';
import Link from 'next/link';
import type { ShiftReport } from '@cheeseoclock/shared-types';
import { IconChevronLeft } from '@/components/dashboard/icons';
import { CASH_MOVE_WORDS, DRAWER_KIND_WORDS, VariancePill } from '@/components/dashboard/money-bits';
import { OrderList } from '@/components/dashboard/OrderList';
import { Shell } from '@/components/dashboard/Shell';
import { Card, Divider, Empty, Note, PageHeader, Row } from '@/components/dashboard/ui';
import { CHANNEL_WORDS, METHOD_WORDS, count, dayClock, money } from '@/lib/dashboard/format';
import { seesDrawerLog, seesReports } from '@/lib/dashboard/perms';
import { getShift, getTills, listCashMoves, listDrawerOpens, listShiftOrders } from '@/lib/dashboard/queries';
import { requireUser } from '@/lib/dashboard/session';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Shift' };

/** The close report as saved (shared-types ShiftReport v1), or null for anything else. */
function reportOf(raw: unknown): ShiftReport | null {
  const r = raw as Partial<ShiftReport> | null;
  return r && typeof r === 'object' && r.v === 1 && r.drawer && r.sales ? (r as ShiftReport) : null;
}

interface NoteCount {
  faceCents: number;
  count: number;
}

function notesOf(raw: unknown): { notes: NoteCount[]; otherCents: number } | null {
  const r = raw as { notes?: unknown; otherCents?: unknown } | null;
  if (!r || !Array.isArray(r.notes)) return null;
  const notes = r.notes.filter((n): n is NoteCount => typeof (n as NoteCount)?.faceCents === 'number' && typeof (n as NoteCount)?.count === 'number');
  return { notes, otherCents: typeof r.otherCents === 'number' ? r.otherCents : 0 };
}

export default async function ShiftPage({ params }: { params: { id: string } }) {
  const id = decodeURIComponent(params.id);
  const user = await requireUser(`/dashboard/money/${encodeURIComponent(id)}`);
  const [shift, tills] = await Promise.all([getShift(id), getTills()]);
  const back = (
    <Link href="/dashboard/money" className="mb-3 inline-flex items-center gap-1 text-sm font-medium text-dash-soft hover:text-dash-ink">
      <IconChevronLeft className="h-4 w-4" /> Shifts & cash
    </Link>
  );
  const openNow = tills.some((t) => t.live?.shift?.id === id);
  // A manager sees the shift open now (they run it); past shifts are report.view, the owner's.
  if (!shift || (!seesReports(user) && !openNow)) {
    return (
      <Shell user={user}>
        {back}
        <Empty title={shift ? 'Past shifts are the owner’s' : 'This shift is not on the dashboard'}>
          {shift ? 'The owner can let you see them from the till.' : 'It may be on a till that has not sent its shifts yet.'}
        </Empty>
      </Shell>
    );
  }
  const [moves, opens, orders] = await Promise.all([
    listCashMoves({ shiftId: id }),
    seesDrawerLog(user) ? listDrawerOpens({ shiftId: id }) : Promise.resolve([]),
    listShiftOrders(id),
  ]);
  const report = reportOf(shift.closeReport);
  const notes = notesOf(shift.countedNotes) ?? (report?.drawer.countedNotes ? notesOf(report.drawer.countedNotes) : null);
  const till = tills.find((t) => t.deviceId === shift.deviceId);
  const live = tills.find((t) => t.live?.shift?.id === id)?.live?.shift ?? null;

  return (
    <Shell user={user}>
      {back}
      <PageHeader
        title={`Shift · ${dayClock(shift.openedAt).split(',')[0]}`}
        sub={`${till?.name ?? 'Till'} · ${dayClock(shift.openedAt)}${shift.closedAt ? ` → ${dayClock(shift.closedAt)}` : ' · still open'}`}
        right={<VariancePill varianceCents={shift.closedAt ? shift.varianceCents : null} />}
      />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card title="The drawer">
            <div className="text-sm">
              <Row label="Opened by" value={shift.openedBy ?? '–'} />
              {shift.closedAt ? <Row label="Closed by" value={shift.closedBy ?? '–'} /> : null}
              <Divider />
              <Row label="Opening float" value={money(shift.openingCashCents)} />
              {report ? (
                <>
                  <Row label="Cash sales" value={`+ ${money(report.drawer.cashSalesCents)}`} />
                  {report.drawer.cashRefundsCents > 0 ? <Row label="Cash refunds" value={`− ${money(report.drawer.cashRefundsCents)}`} /> : null}
                  {report.drawer.cashIn?.cents > 0 ? <Row label={`Cash in (${report.drawer.cashIn.count})`} value={`+ ${money(report.drawer.cashIn.cents)}`} /> : null}
                  {report.drawer.cashOut?.cents > 0 ? <Row label={`Cash out (${report.drawer.cashOut.count})`} value={`− ${money(report.drawer.cashOut.cents)}`} /> : null}
                  {report.drawer.riderKept?.cents > 0 ? <Row label={`Paid to outside riders (${report.drawer.riderKept.count})`} value={`− ${money(report.drawer.riderKept.cents)}`} /> : null}
                </>
              ) : live ? (
                <>
                  <Row label="Cash sales" value={`+ ${money(live.cashSalesCents)}`} />
                  <Row label="Cash refunds" value={`− ${money(live.cashRefundsCents)}`} />
                  <Row label="Cash in" value={`+ ${money(live.cashInCents)}`} />
                  <Row label="Cash out" value={`− ${money(live.cashOutCents)}`} />
                </>
              ) : null}
              <Row label="Should be in the drawer" value={money(shift.expectedCashCents ?? live?.expectedCashCents ?? 0)} strong />
              {shift.closedAt ? (
                <>
                  <Row label="Counted" value={money(shift.countedCashCents ?? 0)} strong />
                  <Row label="Difference" value={<VariancePill varianceCents={shift.varianceCents} />} />
                </>
              ) : null}
            </div>
            {/* The owner changed how a payment was paid after the close (till v0.7.42): the drawer was put right,
                the rows above are still the shift report as printed. */}
            {report && shift.closedAt && shift.expectedCashCents !== null && report.drawer.expectedCents !== shift.expectedCashCents ? (
              <Note>
                Put right after the close: the owner changed how a payment was paid, on the till. The rows above are the
                shift report as printed; at the close it said {money(report.drawer.expectedCents)} should be in the drawer.
              </Note>
            ) : null}
            {notes && notes.notes.length > 0 ? (
              <details className="mt-3 rounded-xl bg-dash-sunk px-3 py-2 text-sm">
                <summary className="cursor-pointer font-medium text-dash-soft">The count by note</summary>
                <div className="mt-1">
                  {notes.notes
                    .filter((n) => n.count > 0)
                    .map((n) => (
                      <Row key={n.faceCents} label={`${money(n.faceCents)} × ${n.count}`} value={money(n.faceCents * n.count)} />
                    ))}
                  {notes.otherCents > 0 ? <Row label="Coins and the rest" value={money(notes.otherCents)} /> : null}
                </div>
              </details>
            ) : null}
            {shift.openNote || shift.closeNote || shift.carryOverReason ? (
              <div className="mt-3 space-y-1 text-sm">
                {shift.openNote ? <p className="text-dash-soft">Opening note: {shift.openNote}</p> : null}
                {shift.closeNote ? <p className="text-dash-soft">Closing note: {shift.closeNote}</p> : null}
                {shift.carriedUnpaidCount > 0 ? (
                  <p className="text-dash-warn-text">
                    {shift.carriedUnpaidCount} unpaid order{shift.carriedUnpaidCount === 1 ? '' : 's'} carried over
                    {shift.carryOverReason ? `: ${shift.carryOverReason}` : ''}
                  </p>
                ) : null}
              </div>
            ) : null}
          </Card>

          <Card title="Orders" sub="Started or paid in this shift." flush>
            <OrderList orders={orders} empty="No orders in this shift." />
          </Card>
        </div>

        <div className="space-y-4">
          {report ? (
            <Card title="Sales" sub="As printed on the shift report at the close.">
              <div className="text-sm">
                <Row label="Orders paid" value={count(report.sales.orderCount)} />
                <Row label="Food" value={money(report.sales.foodCents)} />
                {report.sales.delivery?.cents > 0 ? <Row label={`Delivery charges (${report.sales.delivery.orderCount})`} value={money(report.sales.delivery.cents)} /> : null}
                {(report.sales.discounts ?? []).map((d) => (
                  <Row key={d.kind} label={`Discounts · ${d.kind} (${d.orderCount})`} value={`− ${money(d.cents)}`} />
                ))}
                <Row label="Tax" value={money(report.sales.taxCents)} />
                <Row label="Billed" value={money(report.sales.billedCents)} />
                {report.sales.refunds?.cents > 0 ? <Row label={`Refunds (${report.sales.refunds.orderCount})`} value={`− ${money(report.sales.refunds.cents)}`} /> : null}
                <Row label="Net sales" value={money(report.sales.netCents)} strong />
              </div>
              {report.payments?.length ? (
                <>
                  <Divider />
                  <p className="mb-1 text-xs font-semibold text-dash-muted">Money taken</p>
                  <div className="text-sm">
                    {report.payments.map((p) => (
                      <Row key={p.method} label={`${METHOD_WORDS[p.method] ?? p.method} (${p.orderCount})`} value={money(p.cents)} />
                    ))}
                  </div>
                </>
              ) : null}
              {report.channels?.length ? (
                <>
                  <Divider />
                  <p className="mb-1 text-xs font-semibold text-dash-muted">By channel</p>
                  <div className="text-sm">
                    {report.channels.map((c) => (
                      <Row key={c.channel} label={`${CHANNEL_WORDS[c.channel] ?? c.channel} (${c.orderCount})`} value={money(c.billedCents)} />
                    ))}
                  </div>
                </>
              ) : null}
            </Card>
          ) : null}

          <Card title="Cash in and out" flush>
            {moves.length === 0 ? (
              <p className="px-4 pb-4 text-sm text-dash-muted">None in this shift.</p>
            ) : (
              <ul className="divide-y divide-dash-line">
                {moves.map((m) => (
                  <li key={m.id} className="flex items-baseline justify-between gap-3 px-4 py-2.5 text-sm">
                    <span className="min-w-0">
                      <span className="font-medium text-dash-ink">{CASH_MOVE_WORDS[m.type] ?? m.type}</span>
                      <span className="block text-dash-soft">{m.reason}</span>
                      <span className="block text-xs text-dash-muted">
                        {dayClock(m.createdAt)}
                        {m.by ? ` · ${m.by}` : ''}
                      </span>
                    </span>
                    <span className="tnum shrink-0 font-medium">
                      {m.type === 'payin' ? '+' : '−'} {money(m.amountCents)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {seesDrawerLog(user) ? (
            <Card title="Drawer log" flush>
              {opens.length === 0 ? (
                <p className="px-4 pb-4 text-sm text-dash-muted">Nothing logged.</p>
              ) : (
                <ul className="divide-y divide-dash-line">
                  {opens.map((o) => (
                    <li key={o.id} className="px-4 py-2.5 text-sm">
                      <p className="font-medium text-dash-ink">{DRAWER_KIND_WORDS[o.kind] ?? o.kind}</p>
                      {o.reason ? <p className="text-dash-soft">{o.reason}</p> : null}
                      <p className="text-xs text-dash-muted">
                        {dayClock(o.createdAt)}
                        {o.by ? ` · ${o.by}` : ''}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          ) : null}
        </div>
      </div>
    </Shell>
  );
}
