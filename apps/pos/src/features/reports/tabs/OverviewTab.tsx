/**
 * Reports → Overview (costing spec Phase 3): the headline figures against
 * the comparison period, how customers paid, how the sales add up, and
 * website vs till. Summary moved here unchanged from ReportsPage.tsx; the
 * tab loads only these figures (reports:overview). Phase 7 adds the trend
 * strip, the 12-month chart and the weekly sheet here.
 */
import { formatCents } from '@cheeseoclock/pos-domain';
import type { ReportOverviewTab } from '@cheeseoclock/shared-types';
import { changeOf, PAYMENT_LABEL, PAYMENT_ORDER, percentOf, websiteVsTill } from '../reportFormat';
import { DataTable, Kpi, Note, Panel } from '../reportUi';
import { ShareBar } from '../charts';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** While the first figures load, the tiles show as loading (data undefined). */
export function OverviewTab({ data }: { data: ReportOverviewTab | undefined }) {
  return (
    <div className="space-y-4">
      <Summary report={data} />
      {data && data.kpis.orderCount > 0 && <WebsiteVsTill data={data} />}
    </div>
  );
}

/** Website orders against everything rung up at the till, from the order types. */
function WebsiteVsTill({ data }: { data: ReportOverviewTab }) {
  const split = websiteVsTill(data.channels);
  const net = data.kpis.netSalesCents;
  const rows = [
    { label: 'Website (pick-up and delivery)', ...split.website },
    { label: 'Till (counter, phone, Foodpanda)', ...split.till },
  ];
  return (
    <Panel title="Website vs till" note="Every order type is on Channels & delivery.">
      <DataTable
        columns={[{ label: 'Taken on' }, { label: 'Orders', right: true }, { label: 'Sales', right: true }, { label: 'Share', right: true }, { label: '', className: 'hidden w-1/4 md:table-cell' }]}
        rows={rows.map((r) => [
          <span key="l" className="font-medium">{r.label}</span>,
          r.orderCount,
          formatCents(r.netSalesCents),
          percentOf(r.netSalesCents, net),
          <ShareBar key="b" value={r.netSalesCents} total={net} tone="sky" />,
        ])}
        empty="No sales in this period yet."
      />
    </Panel>
  );
}

// ----------------------------------------------------------------- summary --

export function Summary({ report }: { report: Pick<ReportOverviewTab, 'kpis' | 'previous'> | undefined }) {
  const k = report?.kpis;
  const p = report?.previous ?? null;
  const dash = '—';
  const refunds = k ? k.partialRefundCents + k.fullRefundCents : 0;
  const prevRefunds = p ? p.partialRefundCents + p.fullRefundCents : null;

  return (
    <section className="space-y-4" aria-label="Summary">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <div className="col-span-2 md:col-span-1">
          <Kpi
            big
            label="Sales"
            value={k ? formatCents(k.netSalesCents) : dash}
            loading={!k}
            change={k ? changeOf(k.netSalesCents, p?.netSalesCents) : undefined}
            goodWhen="up"
            was={p ? formatCents(p.netSalesCents) : undefined}
            sub="After discounts and refunds. Tax included."
          />
        </div>
        <Kpi
          label="Orders"
          value={k ? String(k.orderCount) : dash}
          loading={!k}
          change={k ? changeOf(k.orderCount, p?.orderCount) : undefined}
          goodWhen="up"
          was={p ? String(p.orderCount) : undefined}
          sub={k ? `${plural(k.itemCount, 'item')} sold` : undefined}
        />
        <Kpi
          label="Average order"
          value={k ? formatCents(k.avgOrderCents) : dash}
          loading={!k}
          change={k ? changeOf(k.avgOrderCents, p?.avgOrderCents) : undefined}
          goodWhen="up"
          was={p ? formatCents(p.avgOrderCents) : undefined}
        />
        <Kpi
          label="Discounts given"
          value={k ? formatCents(k.discountCents) : dash}
          loading={!k}
          change={k ? changeOf(k.discountCents, p?.discountCents) : undefined}
          goodWhen="down"
          was={p ? formatCents(p.discountCents) : undefined}
          sub={k ? `on ${plural(k.discountedOrderCount, 'order')}` : undefined}
        />
        <Kpi
          label="Refunds"
          value={k ? formatCents(refunds) : dash}
          loading={!k}
          change={k ? changeOf(refunds, prevRefunds) : undefined}
          goodWhen="down"
          was={prevRefunds !== null ? formatCents(prevRefunds) : undefined}
          sub={
            k
              ? k.voidCount > 0
                ? `Also ${plural(k.voidCount, 'order')} cancelled before paying`
                : 'No cancelled orders'
              : undefined
          }
        />
        <Kpi
          label="Tax collected"
          value={k ? formatCents(k.taxCents) : dash}
          loading={!k}
          change={k ? changeOf(k.taxCents, p?.taxCents) : undefined}
          goodWhen="neutral"
          was={p ? formatCents(p.taxCents) : undefined}
          sub="Included in sales"
        />
      </div>

      {k && (
        <>
          {k.unpaidCount > 0 && (
            <Note>
              {plural(k.unpaidCount, 'order')} worth {formatCents(k.unpaidCents)} {k.unpaidCount === 1 ? 'is' : 'are'} not paid yet
              (still on the Orders board). {k.unpaidCount === 1 ? 'It counts' : 'They count'} once paid.
            </Note>
          )}
          {k.unrecordedPaymentCents !== 0 && (
            <Note tone="warn">
              {formatCents(k.unrecordedPaymentCents)} of these sales has no payment method on record (older orders). It is shown
              as “No method recorded” below.
            </Note>
          )}

          <div className="grid gap-4 lg:grid-cols-2">
            <Panel title="How customers paid" note="Refunds are taken off the method the money went back on.">
              <ul className="space-y-3">
                {PAYMENT_ORDER.map((g) => (
                  <li key={g}>
                    <div className="mb-1 flex items-baseline justify-between gap-2 text-sm">
                      <span className="font-medium">{PAYMENT_LABEL[g]}</span>
                      <span className="tabular-nums">
                        <span className="font-semibold">{formatCents(k.payments[g])}</span>{' '}
                        <span className="text-xs text-stone-500">{percentOf(k.payments[g], k.netSalesCents)}</span>
                      </span>
                    </div>
                    <ShareBar value={k.payments[g]} total={k.netSalesCents} tone="emerald" />
                  </li>
                ))}
                {k.unrecordedPaymentCents !== 0 && (
                  <li className="flex justify-between text-sm text-stone-500">
                    <span>No method recorded</span>
                    <span className="tabular-nums">{formatCents(k.unrecordedPaymentCents)}</span>
                  </li>
                )}
              </ul>
            </Panel>

            <Panel
              title="How the sales add up"
              note={
                k.fullRefundCount > 0 || k.voidCount > 0
                  ? `Not in these figures: ${[
                      k.fullRefundCount > 0 ? `${plural(k.fullRefundCount, 'order')} refunded in full (${formatCents(k.fullRefundCents)})` : null,
                      k.voidCount > 0 ? `${plural(k.voidCount, 'cancelled order')} (${formatCents(k.voidCents)})` : null,
                    ]
                      .filter(Boolean)
                      .join(' and ')}.`
                  : undefined
              }
            >
              <dl className="space-y-1.5 text-sm">
                <Line label="Items at menu price" value={formatCents(k.menuSalesCents)} />
                <Line label="− Discounts" value={formatCents(k.discountCents)} />
                <Line label="+ Tax" value={formatCents(k.taxCents)} />
                {k.partialRefundCents > 0 && <Line label="− Part refunds on these orders" value={formatCents(k.partialRefundCents)} />}
                <div className="flex justify-between border-t border-stone-200 pt-1.5 text-base font-bold dark:border-stone-700">
                  <dt>= Sales</dt>
                  <dd className="tabular-nums">{formatCents(k.netSalesCents)}</dd>
                </div>              </dl>
            </Panel>
          </div>
        </>
      )}
    </section>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <dt>{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );
}
