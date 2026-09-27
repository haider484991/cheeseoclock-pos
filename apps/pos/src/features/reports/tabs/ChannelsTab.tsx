/**
 * Reports → Channels & delivery (costing spec Phase 3): where orders come
 * from, and own-rider deliveries by rider and by area. Both sections moved
 * here unchanged from ReportSections.tsx; the tab loads only these figures
 * (reports:channels). Phase 9 adds contribution, commission and delivery
 * areas here.
 */
import { cn } from '@cheeseoclock/ui';
import { formatCents } from '@cheeseoclock/pos-domain';
import type { ReportChannelsTab } from '@cheeseoclock/shared-types';
import { Bike, Store } from 'lucide-react';
import { ShareBar } from '../charts';
import { DataTable, Panel, Section, useShowAll } from '../reportUi';
import { CHANNEL_LABEL, fmtMinutes, percentOf } from '../reportFormat';

export function ChannelsTab({ data }: { data: ReportChannelsTab }) {
  return (
    <div className="space-y-10">
      <ChannelsSection report={data} />
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

export function DeliveriesSection({ report }: { report: Pick<ReportChannelsTab, 'deliveries'> }) {
  const riders = report.deliveries.byRider;
  const areas = useShowAll(report.deliveries.byArea, 10);
  return (
    <Section id="deliveries" icon={Bike} title="Deliveries" subtitle="Your own riders — phone and website deliveries. Foodpanda brings its own.">
      {riders.length === 0 ? (
        <Panel>
          <p className="py-4 text-center text-sm text-stone-500">No deliveries in this period.</p>
        </Panel>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
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
          <Panel title="By area">
            <DataTable
              columns={[{ label: 'Area' }, { label: 'Orders', right: true }, { label: 'Sales', right: true }]}
              rows={areas.shown.map((a) => [a.area, a.orderCount, formatCents(a.netSalesCents)])}
              empty="None."
            />
            {areas.toggle}
          </Panel>
        </div>
      )}
    </Section>
  );
}
