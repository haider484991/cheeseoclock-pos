import type { Metadata } from 'next';
import Link from 'next/link';
import { AutoRefresh } from '@/components/dashboard/AutoRefresh';
import { ColumnChart } from '@/components/dashboard/charts';
import { IconAlert, IconGlobe, IconPrinter, IconStock, IconTill } from '@/components/dashboard/icons';
import { OrderList } from '@/components/dashboard/OrderList';
import { Shell } from '@/components/dashboard/Shell';
import { Card, Divider, Dot, Empty, Hero, PageHeader, Pill, Row, StatTile, cx } from '@/components/dashboard/ui';
import { ago, changePercent, clock, count, counted, fullDay, hourWord, money, moneyWhole } from '@/lib/dashboard/format';
import { addDays, todayOf } from '@/lib/dashboard/period';
import { seesReports } from '@/lib/dashboard/perms';
import { getFirstDay, getSalesByHour, getSalesSummary, getSalesUntil, getTills, listActiveOrders, listOrders } from '@/lib/dashboard/queries';
import { requireUser } from '@/lib/dashboard/session';
import { shopOpen, tillWord } from '@/lib/dashboard/till-status';
import { getStoreStatus } from '@/lib/store-status';

export const dynamic = 'force-dynamic';
// The layout's title template reaches child pages only, so this one names itself in full.
export const metadata: Metadata = { title: { absolute: 'Live · Dashboard' } };

/**
 * The hours to draw for today, in trading order (the day starts at 5 am):
 * from the first hour anything sold to the later of the last sale and now.
 */
function tradingHoursSpan(hoursWithSales: number[], nowHour: number): number[] {
  const order = Array.from({ length: 24 }, (_, i) => (i + 5) % 24);
  const pos = (h: number) => (h + 19) % 24;
  const used = hoursWithSales.map(pos);
  if (used.length === 0) return [];
  return order.slice(Math.min(...used), Math.max(...used, pos(nowHour)) + 1);
}

function greeting(now: Date): string {
  const h = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Karachi', hour: 'numeric', hourCycle: 'h23' }).format(now));
  if (h >= 5 && h < 12) return 'Good morning';
  if (h >= 12 && h < 17) return 'Good afternoon';
  return 'Good evening';
}

export default async function LivePage() {
  const user = await requireUser('/dashboard');
  const now = new Date();
  const today = todayOf(now);
  const reports = seesReports(user);
  const weekAgo = new Date(now.getTime() - 7 * 86_400_000);
  const [tills, summary, active, recent, store, lastWeek, hourly, first] = await Promise.all([
    getTills(),
    getSalesSummary(today, today),
    listActiveOrders(12),
    listOrders({ from: today, to: today, filter: 'all', channel: null, q: null, before: null, limit: 6 }),
    getStoreStatus(),
    reports ? getSalesUntil(addDays(today, -7), weekAgo.toISOString()) : Promise.resolve(null),
    reports ? getSalesByHour(today, today) : Promise.resolve(null),
    getFirstDay(),
  ]);
  // Last week's same day is only a fair compare once the tills' records reach back to it.
  const lastWeekKnown = first !== null && first <= addDays(today, -7);
  const firstName = user.displayName.split(/\s+/)[0] ?? user.displayName;
  const open = shopOpen(tills);
  const openTills = tills.filter((t) => t.live?.shift);
  const board = tills.reduce(
    (b, t) => {
      const x = t.live?.board;
      if (!x) return b;
      return { kitchen: b.kitchen + x.kitchen, ready: b.ready + x.ready, out: b.out + x.out, unpaid: b.unpaid + x.unpaidHandedOver };
    },
    { kitchen: 0, ready: 0, out: 0, unpaid: 0 },
  );
  const lowStock = Math.max(0, ...tills.map((t) => t.live?.lowStock ?? 0));
  const notPrinted = tills.reduce((s, t) => s + (t.live?.notPrinted ?? 0), 0);
  const words = { clock: (i: string) => clock(i), ago: (i: string) => ago(i, now) };
  const quiet = tills.filter((t) => tillWord(t, words, now.getTime()).tone === 'warn');
  const webPaused = tills.some((t) => t.live?.web.pausedByShift && t.live.web.ordersOn);
  const nowHour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Karachi', hour: 'numeric', hourCycle: 'h23' }).format(now));

  return (
    <Shell user={user}>
      <PageHeader title={`${greeting(now)}, ${firstName}`} sub={fullDay(now)} right={<AutoRefresh renderedAt={now.toISOString()} />} />

      {tills.length === 0 ? (
        <Empty title="No till has sent anything yet">
          The figures appear here once a till runs the update that sends them (version 0.7.40 or newer) with the website link
          switched on. Nothing to do on this phone.
        </Empty>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          {/* Right now */}
          <Card title="Right now" className="lg:col-span-1">
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-2 text-sm text-dash-soft">
                  <IconTill className="h-4 w-4" /> Shop
                </span>
                <Pill tone={open ? 'good' : 'neutral'}>
                  <Dot tone={open ? 'good' : 'neutral'} />
                  {open ? 'Open' : 'Closed'}
                </Pill>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-2 text-sm text-dash-soft">
                  <IconGlobe className="h-4 w-4" /> Website orders
                </span>
                <Pill tone={store.acceptingOrders ? 'good' : webPaused ? 'warn' : 'neutral'}>
                  <Dot tone={store.acceptingOrders ? 'good' : webPaused ? 'warn' : 'neutral'} />
                  {store.acceptingOrders ? 'Taking orders' : webPaused ? 'Paused · no shift open' : 'Not taking orders'}
                </Pill>
              </div>
              <Divider />
              <ul className="space-y-2.5">
                {tills.map((t) => {
                  const w = tillWord(t, words, now.getTime());
                  return (
                    <li key={t.deviceId} className="text-sm">
                      <p className="flex min-w-0 items-center gap-2 font-medium text-dash-ink">
                        <Dot tone={w.tone} />
                        <span className="truncate">{t.name}</span>
                      </p>
                      <p className="ml-4 mt-0.5 text-dash-soft">
                        {w.title}
                        {t.live?.shift?.openedBy ? ` · ${t.live.shift.openedBy}` : ''}
                      </p>
                      <p className={cx('ml-4 text-xs', w.tone === 'warn' ? 'text-dash-warn-text' : 'text-dash-muted')}>{w.detail}</p>
                    </li>
                  );
                })}
              </ul>
            </div>
          </Card>

          {/* Today's sales */}
          <Card className="lg:col-span-2">
            <Hero
              label="Sales today"
              value={moneyWhole(summary.netCents)}
              sub={`${counted(summary.orders, 'order')}${summary.orders > 0 ? ` · ${moneyWhole(summary.avgCents)} on average · ${counted(summary.items, 'item')}` : ''}`}
              delta={lastWeek ? { pct: lastWeekKnown ? changePercent(summary.netCents, lastWeek.netCents) : null, vs: 'vs the same time last week', none: 'nothing from last week to compare yet' } : undefined}
            />
            <div className="mt-4 grid grid-cols-2 gap-2.5">
              <StatTile
                label="Not paid yet"
                value={moneyWhole(summary.unpaidCents)}
                sub={counted(summary.unpaid, 'order')}
                tone={summary.unpaid > 0 ? 'warn' : undefined}
                href="/dashboard/orders?filter=unpaid"
              />
              <StatTile
                label="Cancelled or refunded"
                value={count(summary.cancels + summary.fullRefunds + summary.partRefundOrders)}
                sub={moneyWhole(summary.cancelCents + summary.fullRefundCents + summary.partRefundCents)}
                href="/dashboard/orders?filter=cancelled"
              />
            </div>
            {hourly && hourly.length > 0 ? (
              <div className="mt-5">
                <p className="mb-2 text-xs font-medium text-dash-muted">Sales by hour today</p>
                <ColumnChart
                  caption="Sales by hour today"
                  highlightKey={String(nowHour)}
                  height={120}
                  points={tradingHoursSpan(
                    hourly.map((x) => x.hour),
                    nowHour,
                  ).map((h) => {
                      const x = hourly.find((p) => p.hour === h);
                      return { key: String(h), axis: hourWord(h).replace(' ', ''), title: hourWord(h), value: x?.netCents ?? 0, extra: counted(x?.orders ?? 0, 'order') };
                    })}
                />
              </div>
            ) : null}
          </Card>

          {/* The board */}
          <Card
            title="On the board now"
            sub="Orders sent to the kitchen and not yet handed over, as the tills last sent them."
            className="lg:col-span-2"
            flush
            action={
              <Link href="/dashboard/orders?filter=open" className="font-medium text-dash-soft hover:text-dash-ink">
                See all
              </Link>
            }
          >
            <div className="grid grid-cols-4 gap-px border-y border-dash-line bg-dash-line">
              {[
                ['In the kitchen', board.kitchen],
                ['Ready', board.ready],
                ['Out', board.out],
                ['Unpaid, handed over', board.unpaid],
              ].map(([label, n]) => (
                <div key={label as string} className="bg-dash-surface px-3 py-3 text-center">
                  <p className="text-xl font-semibold text-dash-ink">{n as number}</p>
                  <p className="text-[11px] leading-tight text-dash-muted">{label as string}</p>
                </div>
              ))}
            </div>
            <OrderList orders={active} empty="Nothing on the board right now." />
          </Card>

          {/* Cash */}
          <Card title="Cash in the drawer" sub={openTills.length > 0 ? 'What should be in the drawer now, as the till works it out.' : undefined} className="lg:col-span-1">
            {openTills.length === 0 ? (
              <p className="py-2 text-sm text-dash-muted">No shift is open.</p>
            ) : (
              <div className="space-y-4">
                {openTills.map((t) => {
                  const s = t.live!.shift!;
                  return (
                    <div key={t.deviceId}>
                      {openTills.length > 1 ? <p className="text-xs font-semibold text-dash-muted">{t.name}</p> : null}
                      <p className="mt-0.5 text-3xl font-semibold tracking-tight text-dash-ink">{money(s.expectedCashCents)}</p>
                      <div className="mt-2 text-sm">
                        <Row label="Opening float" value={money(s.openingCashCents)} />
                        <Row label="Cash sales" value={`+ ${money(s.cashSalesCents)}`} />
                        {s.cashRefundsCents > 0 ? <Row label="Cash refunds" value={`− ${money(s.cashRefundsCents)}`} /> : null}
                        {s.cashInCents > 0 ? <Row label="Cash in" value={`+ ${money(s.cashInCents)}`} /> : null}
                        {s.cashOutCents > 0 ? <Row label="Cash out" value={`− ${money(s.cashOutCents)}`} /> : null}
                      </div>
                    </div>
                  );
                })}
                <Link href="/dashboard/money" className="inline-block text-sm font-medium text-dash-soft hover:text-dash-ink">
                  Shift details →
                </Link>
              </div>
            )}
          </Card>

          {/* Things to look at */}
          {lowStock > 0 || notPrinted > 0 || quiet.length > 0 ? (
            <Card title="Worth a look" className="lg:col-span-1">
              <ul className="divide-y divide-dash-line text-sm">
                {quiet.map((t) => (
                  <li key={t.deviceId} className="flex items-start gap-2 py-2.5 text-dash-warn-text">
                    <IconAlert className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>
                      {t.name} has a shift open but has sent nothing since {clock(t.lastPushAt)}. Is it on and online?
                    </span>
                  </li>
                ))}
                {lowStock > 0 ? (
                  <li className="py-2.5">
                    <Link href="/dashboard/stock?show=low" className="flex items-start gap-2 text-dash-ink hover:underline">
                      <IconStock className="mt-0.5 h-4 w-4 shrink-0 text-dash-warn-text" />
                      <span>
                        {lowStock} ingredient{lowStock === 1 ? ' is' : 's are'} at or under the low mark
                      </span>
                    </Link>
                  </li>
                ) : null}
                {notPrinted > 0 ? (
                  <li className="flex items-start gap-2 py-2.5 text-dash-ink">
                    <IconPrinter className="mt-0.5 h-4 w-4 shrink-0 text-dash-warn-text" />
                    <span>
                      {notPrinted} kitchen ticket{notPrinted === 1 ? '' : 's'} or bill{notPrinted === 1 ? '' : 's'} did not print
                    </span>
                  </li>
                ) : null}
              </ul>
            </Card>
          ) : null}

          {/* Latest */}
          <Card
            title="Latest orders"
            className={lowStock > 0 || notPrinted > 0 || quiet.length > 0 ? 'lg:col-span-2' : 'lg:col-span-3'}
            flush
            action={
              <Link href="/dashboard/orders" className="font-medium text-dash-soft hover:text-dash-ink">
                All of today
              </Link>
            }
          >
            <OrderList orders={recent} empty="No orders yet today." />
          </Card>
        </div>
      )}
    </Shell>
  );
}
