import type { Metadata } from 'next';
import { PeriodBar } from '@/components/dashboard/PeriodBar';
import { Shell } from '@/components/dashboard/Shell';
import { Card, Empty, Note, PageHeader, StatTile, TD, TD_NUM, TH, TableWrap } from '@/components/dashboard/ui';
import { count, counted, dayClock, money, percent } from '@/lib/dashboard/format';
import { periodFrom, todayOf } from '@/lib/dashboard/period';
import { seesReports } from '@/lib/dashboard/perms';
import { requireUser } from '@/lib/dashboard/session';
import {
  FREE_SERVICE_MESSAGES,
  ORDER_WINDOW_DAYS,
  getBotMessagesThisMonth,
  getWhatsappByAd,
  getWhatsappChats,
  getWhatsappSummary,
} from '@/lib/dashboard/whatsapp';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'WhatsApp' };

/**
 * WhatsApp (26 Oct 2026, lib/dashboard/whatsapp): who wrote to the shop's WhatsApp in the period, which ads brought
 * them, the bot's replies with their order link, and what they bought afterwards at the till. Reports' people only.
 */
export default async function WhatsappPage({ searchParams }: { searchParams: { p?: string; from?: string; to?: string } }) {
  const user = await requireUser('/dashboard/whatsapp');
  if (!seesReports(user)) {
    return (
      <Shell user={user}>
        <PageHeader title="WhatsApp" />
        <Empty title="This is the owner’s">The owner can let you see reports from the till: Settings → Online orders → Phone dashboard.</Empty>
      </Shell>
    );
  }
  const now = new Date();
  const period = periodFrom(searchParams, now);
  const [summary, byAd, chats, botThisMonth] = await Promise.all([
    getWhatsappSummary(period.from, period.to),
    getWhatsappByAd(period.from, period.to),
    getWhatsappChats(period.from, period.to),
    getBotMessagesThisMonth(now),
  ]);
  const freeLeft = Math.max(0, FREE_SERVICE_MESSAGES - botThisMonth);
  return (
    <Shell user={user}>
      <PageHeader title="WhatsApp" sub={`Chats, the ads behind them, and what they bought · ${period.label}`} />
      <PeriodBar period={period} base="/dashboard/whatsapp" today={todayOf(now)} />
      <div className="mb-3">
        <StatTile
          label="Bot messages this month (Meta’s free 1,000)"
          value={`${count(botThisMonth)} / ${count(FREE_SERVICE_MESSAGES)}`}
          sub={
            freeLeft === 0
              ? 'Free messages used up: the bot cannot reply until the 1st unless a payment method is added'
              : `${count(freeLeft)} free left · about ${count(Math.floor(freeLeft / 16))} more WhatsApp orders`
          }
          tone={botThisMonth >= FREE_SERVICE_MESSAGES ? 'bad' : botThisMonth >= FREE_SERVICE_MESSAGES * 0.8 ? 'warn' : undefined}
        />
      </div>
      {summary.customers === 0 ? (
        <Empty title="No WhatsApp chats in this period">
          Every message to the shop’s WhatsApp shows here once Meta sends it to the website. The words are never kept,
          only who wrote, when, and the ad that brought them.
        </Empty>
      ) : (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StatTile label="Customers who wrote" value={count(summary.customers)} sub={`${count(summary.firstTime)} for the first time`} />
            <StatTile label="From an ad" value={count(summary.fromAds)} sub={`${percent(summary.fromAds, summary.customers)} of them`} />
            <StatTile
              label="Bought afterwards"
              value={count(summary.buyers)}
              sub={`${counted(summary.orders, 'order')} · ${money(summary.salesCents)}`}
              tone={summary.buyers > 0 ? 'good' : undefined}
            />
            <StatTile label="Through the bot’s link" value={counted(summary.linkOrders, 'order')} sub={money(summary.linkSalesCents)} />
          </div>
          <Card title="By ad" sub={`Customers who wrote, and their till orders within ${ORDER_WINDOW_DAYS} days`} flush>
            <TableWrap caption="WhatsApp customers and sales by ad">
              <thead>
                <tr className="border-b border-dash-line">
                  <th className={TH}>Ad</th>
                  <th className={`${TH} text-right`}>Customers</th>
                  <th className={`${TH} text-right`}>Orders</th>
                  <th className={`${TH} text-right`}>Sales</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-dash-line">
                {byAd.map((r) => (
                  <tr key={r.adId ?? 'none'}>
                    <td className={TD}>
                      {r.adId ? (
                        <>
                          <span className="block text-dash-ink">{r.headline ?? 'An ad'}</span>
                          <span className="block text-xs text-dash-muted">Ad {r.adId}</span>
                        </>
                      ) : (
                        <span className="text-dash-soft">No ad (wrote by themselves)</span>
                      )}
                    </td>
                    <td className={TD_NUM}>{count(r.customers)}</td>
                    <td className={TD_NUM}>{count(r.orders)}</td>
                    <td className={TD_NUM}>{money(r.salesCents)}</td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
          </Card>
          <Card title="Latest chats" sub={`${counted(summary.messagesIn, 'message')} in · bot replied ${count(summary.botReplies)} · staff sent ${count(summary.staffReplies)}`} flush>
            <TableWrap caption="Latest WhatsApp chats">
              <thead>
                <tr className="border-b border-dash-line">
                  <th className={TH}>Customer</th>
                  <th className={TH}>Last wrote</th>
                  <th className={TH}>Ad</th>
                  <th className={TH}>Answered</th>
                  <th className={`${TH} text-right`}>Orders</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-dash-line">
                {chats.map((c) => (
                  <tr key={c.waId}>
                    <td className={TD}>
                      <span className="block text-dash-ink">{c.name ?? 'No name'}</span>
                      <a href={`https://wa.me/${c.waId}`} target="_blank" rel="noopener noreferrer" className="block text-xs text-dash-muted underline">
                        {c.phone}
                      </a>
                    </td>
                    <td className={TD}>
                      {dayClock(c.lastAt)}
                      <span className="block text-xs text-dash-muted">{counted(c.messages, 'message')}</span>
                    </td>
                    <td className={TD}>{c.adHeadline ?? <span className="text-dash-muted">–</span>}</td>
                    <td className={TD}>{[c.botReplied ? 'Bot' : null, c.staffReplied ? 'Staff' : null].filter(Boolean).join(' + ') || '–'}</td>
                    <td className={TD_NUM}>{count(c.orders)}</td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
          </Card>
          <Note>
            Orders are matched by the customer’s number: any till order to it within {ORDER_WINDOW_DAYS} days after they
            wrote, whether staff typed it or the customer used the bot’s link. Message words are never kept.
          </Note>
        </div>
      )}
    </Shell>
  );
}
