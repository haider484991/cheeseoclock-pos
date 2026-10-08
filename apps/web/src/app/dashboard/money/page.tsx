import type { Metadata } from 'next';
import { CASH_MOVE_WORDS, DRAWER_KIND_WORDS, VariancePill } from '@/components/dashboard/money-bits';
import { PeriodBar } from '@/components/dashboard/PeriodBar';
import { Shell } from '@/components/dashboard/Shell';
import { Card, ListLink, Note, PageHeader, Row, StatTile, TD, TD_NUM, TH, TableWrap } from '@/components/dashboard/ui';
import { clock, count, dayClock, money, moneyWhole } from '@/lib/dashboard/format';
import { periodFrom, todayOf } from '@/lib/dashboard/period';
import { seesDrawerLog, seesReports } from '@/lib/dashboard/perms';
import { getTills, listCashMoves, listDrawerOpens, listShifts } from '@/lib/dashboard/queries';
import { requireUser } from '@/lib/dashboard/session';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Shifts & cash' };

export default async function MoneyPage({ searchParams }: { searchParams: { p?: string; from?: string; to?: string } }) {
  const user = await requireUser('/dashboard/money');
  const now = new Date();
  // The shift history defaults to this week; the drawer open now is always shown.
  const period = periodFrom({ p: searchParams.p ?? 'this_week', from: searchParams.from, to: searchParams.to }, now);
  const reports = seesReports(user);
  const [tills, shifts, moves, opens] = await Promise.all([
    getTills(),
    reports ? listShifts(period.from, period.to) : Promise.resolve([]),
    reports ? listCashMoves({ from: period.from, to: period.to }) : Promise.resolve([]),
    seesDrawerLog(user) ? listDrawerOpens({ from: period.from, to: period.to }) : Promise.resolve([]),
  ]);
  const tillName = (id: string) => tills.find((t) => t.deviceId === id)?.name ?? 'Till';
  const openTills = tills.filter((t) => t.live?.shift);
  const closed = shifts.filter((s) => s.closedAt);
  const short = closed.filter((s) => s.varianceCents !== null && s.varianceCents <= -100).reduce((t, s) => t + (s.varianceCents ?? 0), 0);
  const over = closed.filter((s) => s.varianceCents !== null && s.varianceCents >= 100).reduce((t, s) => t + (s.varianceCents ?? 0), 0);
  const cashIn = moves.filter((m) => m.type === 'payin').reduce((t, m) => t + m.amountCents, 0);
  const cashOut = moves.filter((m) => m.type !== 'payin').reduce((t, m) => t + m.amountCents, 0);

  return (
    <Shell user={user}>
      <PageHeader title="Shifts & cash" sub="The drawer now, past shifts, and cash in and out." />

      <h2 className="mb-2 mt-1 text-sm font-semibold text-dash-muted">Open now</h2>
      {openTills.length === 0 ? (
        <Card className="mb-6">
          <p className="py-1 text-sm text-dash-muted">No shift is open on any till.</p>
        </Card>
      ) : (
        <div className="mb-6 grid grid-cols-1 gap-4 md:grid-cols-2">
          {openTills.map((t) => {
            const s = t.live!.shift!;
            return (
              <Card key={t.deviceId} title={t.name} sub={`Opened ${dayClock(s.openedAt)}${s.openedBy ? ` by ${s.openedBy}` : ''}`}>
                <p className="text-xs font-medium text-dash-muted">Should be in the drawer</p>
                <p className="text-3xl font-semibold tracking-tight text-dash-ink">{money(s.expectedCashCents)}</p>
                <div className="mt-2 text-sm">
                  <Row label="Opening float" value={money(s.openingCashCents)} />
                  <Row label="Cash sales" value={`+ ${money(s.cashSalesCents)}`} />
                  <Row label="Cash refunds" value={`− ${money(s.cashRefundsCents)}`} />
                  <Row label="Cash in" value={`+ ${money(s.cashInCents)}`} />
                  <Row label="Cash out" value={`− ${money(s.cashOutCents)}`} />
                </div>
                <Note>As the till worked it out {clock(t.lastPushAt)}. The count at the close says what is really there.</Note>
              </Card>
            );
          })}
        </div>
      )}

      {!reports ? (
        <Card>
          <p className="text-sm text-dash-muted">Past shifts and cash in and out are the owner’s. The owner can let you see them from the till.</p>
        </Card>
      ) : (
        <>
          <PeriodBar period={period} base="/dashboard/money" today={todayOf(now)} />
          <div className="mb-4 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
            <StatTile label="Shifts closed" value={count(closed.length)} />
            <StatTile label="Short" value={moneyWhole(-short)} tone={short < 0 ? 'bad' : undefined} />
            <StatTile label="Over" value={moneyWhole(over)} tone={over > 0 ? 'warn' : undefined} />
            <StatTile label="Cash out − in" value={moneyWhole(cashOut - cashIn)} sub={`${moneyWhole(cashOut)} out · ${moneyWhole(cashIn)} in`} />
          </div>

          <Card title="Shifts" sub={period.label} flush className="mb-4">
            {shifts.length === 0 ? (
              <p className="px-4 pb-4 text-sm text-dash-muted">No shifts in this period.</p>
            ) : (
              <ul className="divide-y divide-dash-line">
                {shifts.map((s) => (
                  <li key={s.id}>
                    <ListLink href={`/dashboard/money/${encodeURIComponent(s.id)}`}>
                      <div className="flex items-baseline justify-between gap-3">
                        <p className="font-semibold text-dash-ink">{dayClock(s.openedAt)}</p>
                        <VariancePill varianceCents={s.closedAt ? s.varianceCents : null} />
                      </div>
                      <p className="mt-0.5 text-sm text-dash-soft">
                        {tills.length > 1 ? `${tillName(s.deviceId)} · ` : ''}
                        {s.openedBy ?? 'Someone'} opened{s.closedAt ? ` · ${s.closedBy ?? 'someone'} closed ${clock(s.closedAt)}` : ' · still open'}
                      </p>
                      {s.closedAt ? (
                        <p className="tnum mt-0.5 text-xs text-dash-muted">
                          Expected {money(s.expectedCashCents ?? 0)} · counted {money(s.countedCashCents ?? 0)}
                        </p>
                      ) : null}
                    </ListLink>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="Cash in and out" sub={period.label} flush className="mb-4">
            {moves.length === 0 ? (
              <p className="px-4 pb-4 text-sm text-dash-muted">No cash in or out in this period.</p>
            ) : (
              <TableWrap caption="Cash in and out">
                <thead className="border-y border-dash-line bg-dash-sunk">
                  <tr>
                    <th className={TH}>When</th>
                    <th className={TH}>What</th>
                    <th className={TH}>Who</th>
                    <th className={`${TH} text-right`}>Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {moves.map((m) => (
                    <tr key={m.id} className="border-b border-dash-line last:border-0">
                      <td className={`${TD} whitespace-nowrap text-dash-soft`}>{dayClock(m.createdAt)}</td>
                      <td className={TD}>
                        <span className="font-medium text-dash-ink">{CASH_MOVE_WORDS[m.type] ?? m.type}</span>
                        <span className="block text-dash-soft">
                          {m.reason}
                          {m.purchase ? ' · stock bought' : ''}
                        </span>
                      </td>
                      <td className={`${TD} text-dash-soft`}>
                        {m.by ?? '–'}
                        {m.approvedBy && m.approvedBy !== m.by ? <span className="block text-xs text-dash-muted">OK’d by {m.approvedBy}</span> : null}
                      </td>
                      <td className={`${TD_NUM} font-medium ${m.type === 'payin' ? 'text-dash-good-text' : 'text-dash-ink'}`}>
                        {m.type === 'payin' ? '+' : '−'} {money(m.amountCents)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </TableWrap>
            )}
          </Card>

          {seesDrawerLog(user) ? (
            <Card title="Drawer log" sub={`Every time the cash drawer opened · ${period.label}`} flush>
              {opens.length === 0 ? (
                <p className="px-4 pb-4 text-sm text-dash-muted">Nothing logged in this period.</p>
              ) : (
                <TableWrap caption="Drawer log">
                  <thead className="border-y border-dash-line bg-dash-sunk">
                    <tr>
                      <th className={TH}>When</th>
                      <th className={TH}>Why</th>
                      <th className={TH}>Who</th>
                      <th className={`${TH} text-right`}>Money</th>
                    </tr>
                  </thead>
                  <tbody>
                    {opens.map((o) => (
                      <tr key={o.id} className="border-b border-dash-line last:border-0">
                        <td className={`${TD} whitespace-nowrap text-dash-soft`}>{dayClock(o.createdAt)}</td>
                        <td className={TD}>
                          <span className="font-medium text-dash-ink">{DRAWER_KIND_WORDS[o.kind] ?? o.kind}</span>
                          {o.reason ? <span className="block text-dash-soft">{o.reason}</span> : null}
                          {o.outcome && o.outcome !== 'opened' ? <span className="block text-xs text-dash-warn-text">{o.outcome.replace(/_/g, ' ')}</span> : null}
                        </td>
                        <td className={`${TD} text-dash-soft`}>
                          {o.by ?? '–'}
                          {o.approvedBy && o.approvedBy !== o.by ? <span className="block text-xs text-dash-muted">OK’d by {o.approvedBy}</span> : null}
                        </td>
                        <td className={TD_NUM}>{o.amountCents === null ? '–' : `${o.amountCents < 0 ? '−' : '+'} ${money(Math.abs(o.amountCents))}`}</td>
                      </tr>
                    ))}
                  </tbody>
                </TableWrap>
              )}
            </Card>
          ) : null}
        </>
      )}
    </Shell>
  );
}
