import type { OrderRow } from '@/lib/dashboard/queries';
import { CHANNEL_WORDS, METHOD_WORDS, STATUS_WORDS, clock, dayClock, money, orderNo } from '@/lib/dashboard/format';
import { ListLink, Pill, type Tone } from './ui';

/**
 * Orders as a list (the phone's table): number and time, who and what, the
 * money and where the order stands. Each row opens the whole order.
 */

export function statusTone(o: Pick<OrderRow, 'status' | 'counted' | 'paidAt' | 'refundedCents' | 'deleted'>): { tone: Tone; word: string } {
  if (o.deleted === 'test') return { tone: 'neutral', word: 'Test order, deleted' };
  if (o.status === 'void') return { tone: 'bad', word: 'Cancelled' };
  if (o.status === 'refunded') return { tone: 'bad', word: 'Refunded' };
  const word = STATUS_WORDS[o.status] ?? o.status;
  if (!o.paidAt && o.status !== 'open') return { tone: 'warn', word: `${word} · not paid` };
  if (o.status === 'open') return { tone: 'neutral', word };
  if (o.refundedCents > 0) return { tone: 'warn', word: `${o.status === 'paid' ? 'Done' : word} · part refunded` };
  if (o.status === 'paid') return { tone: 'good', word: 'Done' };
  return { tone: 'info', word: `${word} · paid` };
}

export function OrderList({ orders, showDay = false, empty }: { orders: OrderRow[]; showDay?: boolean; empty?: string }) {
  if (orders.length === 0) return <p className="px-4 py-6 text-sm text-dash-muted">{empty ?? 'No orders.'}</p>;
  return (
    <ul className="divide-y divide-dash-line">
      {orders.map((o) => {
        const st = statusTone(o);
        return (
          <li key={o.id}>
            <ListLink href={`/dashboard/orders/${encodeURIComponent(o.id)}`}>
              <div className="flex items-baseline justify-between gap-3">
                <p className="min-w-0 truncate font-semibold text-dash-ink">
                  {orderNo(o.number)}
                  <span className="ml-2 text-sm font-normal text-dash-muted">{showDay ? dayClock(o.createdAt) : clock(o.createdAt)}</span>
                </p>
                <p className="tnum shrink-0 font-semibold text-dash-ink">
                  {o.refundedCents > 0 && o.status !== 'refunded' ? (
                    <>
                      <span className="mr-1.5 text-sm font-normal text-dash-muted line-through">{money(o.totalCents)}</span>
                      {money(o.netCents)}
                    </>
                  ) : (
                    money(o.totalCents)
                  )}
                </p>
              </div>
              <p className="mt-0.5 truncate text-sm text-dash-soft">{o.summary || 'No items'}</p>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-dash-muted">
                <Pill tone={st.tone}>{st.word}</Pill>
                <span>{CHANNEL_WORDS[o.channel] ?? o.channel}</span>
                {o.customerName ? <span className="truncate">· {o.customerName}</span> : null}
                {o.area ? <span className="truncate">· {o.area}</span> : null}
                {o.methods.length > 0 ? <span>· {o.methods.map((m) => METHOD_WORDS[m] ?? m).join(' + ')}</span> : null}
              </div>
            </ListLink>
          </li>
        );
      })}
    </ul>
  );
}
