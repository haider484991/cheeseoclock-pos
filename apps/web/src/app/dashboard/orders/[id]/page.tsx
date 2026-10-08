import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { IconChevronLeft, IconPhone, IconPin } from '@/components/dashboard/icons';
import { statusTone } from '@/components/dashboard/OrderList';
import { Shell } from '@/components/dashboard/Shell';
import { Card, Divider, Empty, PageHeader, Pill, Row } from '@/components/dashboard/ui';
import { CAME_BY_WORDS, CHANNEL_WORDS, METHOD_WORDS, dayClock, money, orderNo, percent } from '@/lib/dashboard/format';
import { seesCosts } from '@/lib/dashboard/perms';
import { getOrder, getTills, rowOfDoc } from '@/lib/dashboard/queries';
import { requireUser } from '@/lib/dashboard/session';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Order' };

/** Words with any web address in them made into a link (the website's map pin note, for one). */
function withLinks(text: string): ReactNode[] {
  return text.split(/(https?:\/\/[^\s)]+)/g).map((part, i) =>
    /^https?:\/\//.test(part) ? (
      <a key={i} href={part} target="_blank" rel="noopener noreferrer nofollow" className="break-all font-medium text-dash-info-text underline">
        {part.includes('maps.google') ? 'Open the map pin' : part}
      </a>
    ) : (
      <span key={i}>{part}</span>
    ),
  );
}

export default async function OrderPage({ params }: { params: { id: string } }) {
  const id = decodeURIComponent(params.id);
  const user = await requireUser(`/dashboard/orders/${encodeURIComponent(id)}`);
  const [order, tills] = await Promise.all([getOrder(id), getTills()]);
  const back = (
    <Link href="/dashboard/orders" className="mb-3 inline-flex items-center gap-1 text-sm font-medium text-dash-soft hover:text-dash-ink">
      <IconChevronLeft className="h-4 w-4" /> Orders
    </Link>
  );
  if (!order) {
    return (
      <Shell user={user}>
        {back}
        <Empty title="This order is not on the dashboard">It may be on a till that has not sent its orders yet.</Empty>
      </Shell>
    );
  }
  const st = statusTone(rowOfDoc(order));
  const till = tills.find((t) => t.deviceId === order.deviceId);
  const food = order.lines.filter((l) => !l.isFee);
  const fees = order.lines.filter((l) => l.isFee);
  const costs = seesCosts(user) ? food.map((l) => l.costCents) : [];
  const costKnown = costs.length > 0 && costs.every((c) => c !== null);
  const costTotal = costs.reduce<number>((s, c) => s + (c ?? 0), 0);
  const foodSales = food.reduce((s, l) => s + l.lineTotalCents, 0);
  // A full refund is stamped where a cancel is (voided_at, voided_by, void_reason): say which it was.
  const endWord = order.status === 'refunded' ? 'Refunded' : 'Cancelled';
  const timeline: Array<[string, string | null]> = [
    ['Started', order.createdAt],
    ['Sent to the kitchen', order.sentAt],
    ['Paid', order.paidAt],
    ['Left with the rider', order.dispatchedAt],
    ['Delivered', order.deliveredAt],
    [endWord, order.voidedAt],
  ];

  return (
    <Shell user={user}>
      {back}
      <PageHeader
        title={`Order ${orderNo(order.number)}`}
        sub={`${dayClock(order.createdAt)}${till && tills.length > 1 ? ` · ${till.name}` : ''} · ${order.number}`}
        right={<Pill tone={st.tone}>{st.word}</Pill>}
      />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          <Card title="What was ordered" sub={`${CHANNEL_WORDS[order.channel] ?? order.channel}${order.cameBy ? ` · came by ${CAME_BY_WORDS[order.cameBy] ?? order.cameBy}` : ''}`}>
            <ul className="divide-y divide-dash-line">
              {food.map((l) => (
                <li key={l.id} className="flex items-start justify-between gap-3 py-2.5">
                  <div className="min-w-0">
                    <p className="font-medium text-dash-ink">
                      <span className="tnum mr-1.5 text-dash-muted">{l.qty}×</span>
                      {l.name}
                    </p>
                    {l.choices.length > 0 ? (
                      <ul className="mt-0.5 space-y-0.5 text-sm text-dash-soft">
                        {l.choices.map((c, i) => (
                          <li key={i}>
                            {c.name}
                            {c.priceDeltaCents !== 0 ? <span className="text-dash-muted"> ({c.priceDeltaCents > 0 ? '+' : '−'}{money(Math.abs(c.priceDeltaCents))})</span> : null}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    {l.note ? <p className="mt-0.5 text-sm font-medium text-dash-warn-text">Note: {l.note}</p> : null}
                  </div>
                  <span className="tnum shrink-0 text-dash-ink">{money(l.lineTotalCents)}</span>
                </li>
              ))}
              {fees.map((l) => (
                <li key={l.id} className="flex items-baseline justify-between gap-3 py-2 text-sm">
                  <span className="text-dash-soft">{l.name}</span>
                  <span className="tnum text-dash-ink">{money(l.lineTotalCents)}</span>
                </li>
              ))}
            </ul>
            <Divider />
            <div className="text-sm">
              <Row label="Items" value={money(order.subtotalCents)} />
              {order.discountCents > 0 ? (
                <Row
                  label="Discount"
                  sub={order.discounts.map((d) => [d.reason, d.approvedBy ? `approved by ${d.approvedBy}` : null].filter(Boolean).join(' · ')).join('; ') || undefined}
                  value={`− ${money(order.discountCents)}`}
                />
              ) : null}
              <Row label="Tax" value={money(order.taxCents)} />
              <Row label="Total" value={money(order.totalCents)} strong />
              {order.digitalTotalCents !== null && order.digitalTotalCents !== order.totalCents ? (
                <Row label="By card it would have been" value={money(order.digitalTotalCents)} muted />
              ) : null}
              {order.refundedCents > 0 ? (
                <>
                  <Row label="Refunded" value={`− ${money(order.refundedCents)}`} />
                  <Row label="Kept" value={money(order.netCents)} strong />
                </>
              ) : null}
              {order.riderKeepsCents !== null ? <Row label="Outside rider kept" value={money(order.riderKeepsCents)} muted /> : null}
            </div>
          </Card>

          <Card title="Payments">
            {order.payments.length === 0 ? (
              <p className="py-1 text-sm text-dash-muted">{order.paidAt ? 'Nothing to pay (a free order).' : 'Not paid yet.'}</p>
            ) : (
              <ul className="divide-y divide-dash-line text-sm">
                {order.payments.map((p) => (
                  <li key={p.id} className="flex items-baseline justify-between gap-3 py-2">
                    <span className="min-w-0">
                      <span className="font-medium text-dash-ink">{p.amountCents < 0 ? `Refund · ${METHOD_WORDS[p.method] ?? p.method}` : (METHOD_WORDS[p.method] ?? p.method)}</span>
                      <span className="block text-xs text-dash-muted">
                        {dayClock(p.at)}
                        {p.by ? ` · ${p.by}` : ''}
                        {p.tenderedCents !== null && p.tenderedCents > p.amountCents ? ` · given ${money(p.tenderedCents)}, change ${money(p.tenderedCents - p.amountCents)}` : ''}
                      </span>
                    </span>
                    <span className="tnum shrink-0 font-medium text-dash-ink">{p.amountCents < 0 ? `− ${money(-p.amountCents)}` : money(p.amountCents)}</span>
                  </li>
                ))}
              </ul>
            )}
            {order.foodpanda ? (
              <div className="mt-2 border-t border-dash-line pt-2 text-sm">
                {order.foodpanda.dealLabel ? <Row label="foodpanda deal" value={order.foodpanda.dealLabel} /> : null}
                {order.foodpanda.commissionCents !== null ? <Row label="foodpanda commission" value={money(order.foodpanda.commissionCents)} /> : null}
                {order.foodpanda.expectedPayoutCents !== null ? <Row label="foodpanda should pay" value={money(order.foodpanda.expectedPayoutCents)} strong /> : null}
              </div>
            ) : null}
          </Card>
        </div>

        <div className="space-y-4">
          {order.customer ? (
            <Card title="Customer">
              <div className="space-y-2 text-sm">
                {order.customer.name ? <p className="font-medium text-dash-ink">{order.customer.name}</p> : null}
                {order.customer.phone ? (
                  <a href={`tel:${order.customer.phone}`} className="flex items-center gap-2 font-medium text-dash-info-text">
                    <IconPhone className="h-4 w-4" />
                    {order.customer.phone}
                  </a>
                ) : null}
                {order.customer.address || order.customer.area ? (
                  <p className="flex items-start gap-2 text-dash-soft">
                    <IconPin className="mt-0.5 h-4 w-4 shrink-0" />
                    <span>{[order.customer.address, order.customer.area].filter(Boolean).join(', ')}</span>
                  </p>
                ) : null}
              </div>
            </Card>
          ) : null}

          {order.notes ? (
            <Card title="Notes">
              <p className="whitespace-pre-wrap break-words text-sm text-dash-ink">{withLinks(order.notes)}</p>
            </Card>
          ) : null}

          <Card title="What happened">
            <ol className="space-y-2 text-sm">
              {timeline
                .filter(([, at]) => at)
                .map(([what, at]) => (
                  <li key={what} className="flex items-baseline justify-between gap-3">
                    <span className="text-dash-soft">{what}</span>
                    <span className="tnum text-dash-ink">{dayClock(at)}</span>
                  </li>
                ))}
            </ol>
            <Divider />
            <div className="text-sm">
              {order.cashier ? <Row label="Taken by" value={order.cashier} /> : order.source === 'web' ? <Row label="Taken by" value="The website" /> : null}
              {order.rider ? <Row label="Rider" value={order.rider} /> : null}
              {order.voidedBy || order.voidReason ? <Row label={endWord} sub={order.voidReason ?? undefined} value={order.voidedBy ?? ''} /> : null}
              {order.deleted === 'test' ? <Row label="Deleted as a test order" sub={order.deleteReason ?? undefined} value={order.deletedBy ?? ''} /> : null}
            </div>
          </Card>

          {seesCosts(user) && food.length > 0 ? (
            <Card title="Food cost" sub="The cost of its ingredients when it was made.">
              {costKnown ? (
                <div className="text-sm">
                  <Row label="Food cost" value={money(costTotal)} strong />
                  <Row label="Of the food at menu price" value={percent(costTotal, foodSales)} muted />
                </div>
              ) : (
                <p className="text-sm text-dash-muted">Not known for every item (an older order, or an item with no recipe).</p>
              )}
            </Card>
          ) : null}
        </div>
      </div>
    </Shell>
  );
}
