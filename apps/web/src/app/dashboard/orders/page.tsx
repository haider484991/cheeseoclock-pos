import type { Metadata } from 'next';
import Link from 'next/link';
import { IconSearch } from '@/components/dashboard/icons';
import { OrderList } from '@/components/dashboard/OrderList';
import { PeriodBar } from '@/components/dashboard/PeriodBar';
import { Shell } from '@/components/dashboard/Shell';
import { Card, Chip, ChipRow, PageHeader, StatTile } from '@/components/dashboard/ui';
import { CHANNEL_WORDS, count, moneyWhole } from '@/lib/dashboard/format';
import { periodFrom, periodQuery, todayOf } from '@/lib/dashboard/period';
import { seesDrawerLog } from '@/lib/dashboard/perms';
import { ORDER_FILTERS, getSalesSummary, listOrders, type OrderFilter } from '@/lib/dashboard/queries';
import { requireUser } from '@/lib/dashboard/session';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Orders' };

const PAGE = 40;

const FILTER_WORDS: Record<OrderFilter, string> = {
  all: 'All',
  open: 'On the board',
  paid: 'Paid',
  unpaid: 'Not paid',
  cancelled: 'Cancelled',
  refunded: 'Refunded',
  deleted: 'Deleted test orders',
};

const CHANNELS = ['takeaway', 'delivery', 'web_delivery', 'web_pickup', 'foodpanda'] as const;

type Search = { p?: string; from?: string; to?: string; filter?: string; channel?: string; q?: string; before?: string };

export default async function OrdersPage({ searchParams }: { searchParams: Search }) {
  const user = await requireUser('/dashboard/orders');
  const now = new Date();
  const period = periodFrom(searchParams, now);
  // Deleted test orders are the owner's to look back on (the till's delete is owner-only).
  const filters = ORDER_FILTERS.filter((f) => f !== 'deleted' || seesDrawerLog(user));
  const filter: OrderFilter = (filters as readonly string[]).includes(searchParams.filter ?? '') ? (searchParams.filter as OrderFilter) : 'all';
  const channel = (CHANNELS as readonly string[]).includes(searchParams.channel ?? '') ? searchParams.channel! : null;
  const q = typeof searchParams.q === 'string' && searchParams.q.trim() ? searchParams.q.trim().slice(0, 40) : null;
  const [beforeAt, beforeId] = (searchParams.before ?? '').split('|');
  const before = beforeAt && beforeId && !Number.isNaN(Date.parse(beforeAt)) ? { at: beforeAt, id: beforeId } : null;

  const [summary, orders] = await Promise.all([
    getSalesSummary(period.from, period.to),
    listOrders({ from: period.from, to: period.to, filter, channel, q, before, limit: PAGE + 1 }),
  ]);
  const more = orders.length > PAGE;
  const shown = orders.slice(0, PAGE);
  const last = shown[shown.length - 1];

  const keep = (over: Partial<Record<'filter' | 'channel' | 'q', string | null>>) => {
    const parts = [periodQuery(period)];
    const f = over.filter !== undefined ? over.filter : filter === 'all' ? null : filter;
    const c = over.channel !== undefined ? over.channel : channel;
    const qq = over.q !== undefined ? over.q : q;
    if (f) parts.push(`filter=${f}`);
    if (c) parts.push(`channel=${c}`);
    if (qq) parts.push(`q=${encodeURIComponent(qq)}`);
    return parts.join('&');
  };
  const notPeriod = keep({}).split('&').slice(1).join('&');

  return (
    <Shell user={user}>
      <PageHeader title="Orders" sub={period.label === period.from ? period.label : `${period.label}${period.days > 1 ? ` · ${period.days} days` : ''}`} />
      <PeriodBar period={period} base="/dashboard/orders" keep={notPeriod} today={todayOf(now)} />

      <div className="mb-4 grid grid-cols-2 gap-2.5 sm:grid-cols-3">
        <div className="col-span-2 sm:col-span-1">
          <StatTile label="Sales" value={moneyWhole(summary.netCents)} />
        </div>
        <StatTile label="Orders" value={count(summary.orders)} />
        <StatTile label="Average" value={summary.orders > 0 ? moneyWhole(summary.avgCents) : '–'} />
      </div>

      <form action="/dashboard/orders" method="get" className="mb-3" role="search">
        <input type="hidden" name="p" value={period.key} />
        {period.key === 'custom' ? (
          <>
            <input type="hidden" name="from" value={period.from} />
            <input type="hidden" name="to" value={period.to} />
          </>
        ) : null}
        {filter !== 'all' ? <input type="hidden" name="filter" value={filter} /> : null}
        {channel ? <input type="hidden" name="channel" value={channel} /> : null}
        <label htmlFor="order-search" className="sr-only">
          Find an order by number, name or phone
        </label>
        <div className="relative">
          <IconSearch className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-dash-muted" />
          <input
            id="order-search"
            name="q"
            defaultValue={q ?? ''}
            placeholder="Order number, name or phone"
            autoComplete="off"
            className="block w-full rounded-xl border border-dash-line bg-dash-surface py-2.5 pl-10 pr-3 text-[15px] text-dash-ink placeholder:text-dash-muted focus:border-dash-ink focus:outline-none"
          />
        </div>
      </form>

      <ChipRow label="Which orders">
        {filters.map((f) => (
          <Chip key={f} href={`/dashboard/orders?${keep({ filter: f === 'all' ? null : f })}`} active={filter === f}>
            {FILTER_WORDS[f]}
          </Chip>
        ))}
      </ChipRow>
      <ChipRow label="How they came">
        <Chip href={`/dashboard/orders?${keep({ channel: null })}`} active={channel === null}>
          Every channel
        </Chip>
        {CHANNELS.map((c) => (
          <Chip key={c} href={`/dashboard/orders?${keep({ channel: c })}`} active={channel === c}>
            {CHANNEL_WORDS[c]}
          </Chip>
        ))}
      </ChipRow>

      <Card flush>
        <OrderList
          orders={shown}
          showDay={period.days > 1}
          empty={q ? `No order matches “${q}”.` : 'No orders here.'}
        />
        {more && last ? (
          <div className="border-t border-dash-line p-3 text-center">
            <Link
              href={`/dashboard/orders?${keep({})}&before=${encodeURIComponent(`${last.createdAt}|${last.id}`)}`}
              className="inline-block rounded-full border border-dash-line px-4 py-2 text-sm font-semibold text-dash-ink hover:border-dash-axis"
            >
              Older orders
            </Link>
          </div>
        ) : null}
      </Card>
      {before ? (
        <p className="mt-3 text-center text-sm">
          <Link href={`/dashboard/orders?${keep({})}`} className="font-medium text-dash-soft hover:text-dash-ink">
            Back to the newest
          </Link>
        </p>
      ) : null}
    </Shell>
  );
}
