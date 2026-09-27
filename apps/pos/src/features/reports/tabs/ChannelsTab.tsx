/**
 * Reports → Channels & delivery (costing spec Phase 3): where orders come
 * from, and own-rider deliveries by rider and by area. Both sections moved
 * here unchanged from ReportSections.tsx; the tab loads only these figures
 * (reports:channels).
 *
 * Phase 9 adds, for profit.view, what each order type earns after its food,
 * foodpanda's commission, fees and the rider; and delivery areas (costing
 * spec 4.11) in place of the plain "By area" list: each area recognised as a
 * delivery zone, its orders, sales, charges collected, time on the road, the
 * customers who came back, and — profit.view — the rider's cost and what an
 * order earns. Deliveries with no area and no delivery charge are listed.
 *
 * Settings → foodpanda adds the foodpanda block (the deal, what foodpanda
 * keeps, what the shop keeps, the orders to check). Its "foodpanda kept" is
 * the foodpanda row's "foodpanda keeps" in the table above it and its price
 * uplift that row's: one per-order rule serves both, so one screen never
 * shows two foodpanda figures for the same thing.
 */
import { cn } from '@cheeseoclock/ui';
import { formatCents } from '@cheeseoclock/pos-domain';
import type { ReportChannelsTab } from '@cheeseoclock/shared-types';
import { Bike, MapPin, Store } from 'lucide-react';
import { ShareBar } from '../charts';
import { DataTable, Note, Panel, Section, useShowAll } from '../reportUi';
import { CHANNEL_LABEL, fmtMinutes, fmtWhen, percentOf } from '../reportFormat';
import { formatBps } from '../../costing/costingFormat';
import { commissionText, riderText } from '../profitFormat';
import { ChannelProfitSection } from './ProfitTab';
import { FoodpandaSection } from './FoodpandaSection';

export function ChannelsTab({ data }: { data: ReportChannelsTab }) {
  return (
    <div className="space-y-10">
      <ChannelsSection report={data} />
      {data.profit && (
        <div className="space-y-2">
          <ChannelProfitSection channels={data.profit.channels} />
          <p className="text-xs text-stone-500">
            {commissionText(data.profit.fees)} {riderText(data.profit.riderCost)}
          </p>
        </div>
      )}
      {/* The same foodpanda figures as the table above (one rule, pos-domain foodpandaOrderMoney), in more detail. */}
      <FoodpandaSection foodpanda={data.foodpanda} />
      <DeliveriesSection report={data} />
    </div>
  );
}

export function ChannelsSection({ report }: { report: Pick<ReportChannelsTab, 'kpis' | 'channels'> }) {
  const net = report.kpis.netSalesCents;
  return (
    <Section id="types" icon={Store} title="Where orders come from">
      <Panel>
        <DataTable
          columns={[{ label: 'Order type' }, { label: 'Orders', right: true }, { label: 'Sales', right: true }, { label: 'Average order', right: true }, { label: 'Share', right: true }, { label: '', className: 'hidden w-1/4 md:table-cell' }]}
          rows={report.channels.map((c) => [
            <span key="l" className="font-medium">{CHANNEL_LABEL[c.channel]}</span>,
            c.orderCount,
            formatCents(c.netSalesCents),
            formatCents(c.orderCount > 0 ? Math.round(c.netSalesCents / c.orderCount) : 0),
            percentOf(c.netSalesCents, net),
            <ShareBar key="b" value={c.netSalesCents} total={net} tone="sky" />,
          ])}
          footer={
            report.channels.length > 0
              ? ['All orders', report.kpis.orderCount, formatCents(net), formatCents(report.kpis.avgOrderCents), '100%', '']
              : undefined
          }
          empty="No sales in this period yet."
        />
      </Panel>
    </Section>
  );
}

export function DeliveriesSection({ report }: { report: Pick<ReportChannelsTab, 'deliveries' | 'areas' | 'noRateDeliveries' | 'noRateCount'> }) {
  const riders = report.deliveries.byRider;
  return (
    <Section id="deliveries" icon={Bike} title="Deliveries" subtitle="Your own riders — phone and website deliveries. Foodpanda brings its own.">
      {riders.length === 0 ? (
        <Panel>
          <p className="py-4 text-center text-sm text-stone-500">No deliveries in this period.</p>
        </Panel>
      ) : (
        <div className="space-y-4">
          <Panel title="By rider" note="Time on the road = from “out for delivery” to “delivered”, when both were marked.">
            <DataTable
              columns={[{ label: 'Rider' }, { label: 'Deliveries', right: true }, { label: 'Sales', right: true }, { label: 'Avg time', right: true }]}
              rows={riders.map((r) => [
                <span key="n" className={cn('font-medium', r.riderId === null && 'text-stone-500')}>{r.name}</span>,
                r.deliveries,
                formatCents(r.netSalesCents),
                fmtMinutes(r.avgMinutesOut),
              ])}
              empty="None."
            />
          </Panel>
          <AreasPanel report={report} />
        </div>
      )}
    </Section>
  );
}

function AreasPanel({ report }: { report: Pick<ReportChannelsTab, 'areas' | 'noRateDeliveries' | 'noRateCount'> }) {
  const areas = useShowAll(report.areas, 12);
  const withProfit = report.areas.some((a) => a.riderCents !== null);
  return (
    <Panel
      title="By area"
      note={`The area on each order's address, matched to your delivery zones. Sales and average with tax; delivery charges before tax. Came back: its customers (by account or phone) with 2 or more orders of any kind in the 90 days up to the end of the period.${
        withProfit
          ? ' Earns per order: its food less the food cost, plus the delivery charge, less the rider and card fees, on the orders whose food cost is known.'
          : ''
      }`}
    >
      <DataTable
        columns={[
          { label: 'Area' },
          { label: 'Orders', right: true },
          { label: 'Sales', right: true },
          { label: 'Average', right: true },
          { label: 'Charges before tax', right: true },
          { label: 'Avg time', right: true },
          { label: 'Came back', right: true },
          ...(withProfit ? [{ label: 'Rider', right: true }, { label: 'Earns / order', right: true }] : []),
        ]}
        rows={areas.shown.map((a) => [
          <span key="a" className={cn('font-medium', a.zoneId === null && 'text-stone-600 dark:text-stone-300')}>
            <MapPin className="mr-1 inline h-3.5 w-3.5 text-stone-400" />
            {a.area}
          </span>,
          a.orderCount,
          formatCents(a.netSalesCents),
          formatCents(a.avgOrderCents),
          formatCents(a.feesCollectedCents),
          fmtMinutes(a.avgMinutesOut),
          a.customers > 0 ? `${a.repeatCustomers} of ${a.customers} (${formatBps(a.repeatRateBps)})` : '—',
          ...(withProfit
            ? [a.riderCents === null ? '—' : formatCents(a.riderCents), a.contributionPerOrderCents === null ? '—' : formatCents(a.contributionPerOrderCents)]
            : []),
        ])}
        empty="None."
      />
      {areas.toggle}
      {report.noRateCount > 0 && (
        <div className="mt-3">
          <Note tone="warn">
            {report.noRateCount} {report.noRateCount === 1 ? 'delivery has' : 'deliveries have'} no area recognised and no delivery charge on the bill:
            no rider cost could be put on {report.noRateCount === 1 ? 'it' : 'them'}, and the customer may not have paid for delivery.
          </Note>
          <ul className="mt-2 space-y-0.5 text-xs text-stone-600 dark:text-stone-300">
            {report.noRateDeliveries.slice(0, 20).map((d) => (
              <li key={d.orderId}>
                Order {d.orderNumber} · {fmtWhen(d.createdAt)} · {d.area ? `“${d.area}”` : 'no area'}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Panel>
  );
}
