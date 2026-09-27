/**
 * Reports → Profit (costing spec Phase 9, profit.view): what the shop keeps.
 * The waterfall from sales before tax down to profit before overheads —
 * food cost, the sales whose cost is not known (set aside, never counted as
 * free), waste, food sent out and not paid, stock that went missing between
 * two full stock takes, foodpanda's commission and payment fees, the rider —
 * then what each order type earns, and each category's profit on its fully
 * costed sales. The main process refuses the tab to a login without
 * profit.view; the page does not show it to them. This till's orders.
 */
import { formatCents } from '@cheeseoclock/pos-domain';
import type { ReportChannelProfit, ReportProfitTab } from '@cheeseoclock/shared-types';
import { Coins, LayoutGrid, Store } from 'lucide-react';
import { Waterfall } from '../charts';
import { DataTable, Note, Panel, Section } from '../reportUi';
import { CHANNEL_LABEL, WASTE_REASON_LABEL, costingStartText, estimatedText, unpaidFoodText } from '../reportFormat';
import { formatBps } from '../../costing/costingFormat';
import { commissionText, profitHeadline, riderText, stepAmount, stepLabel, stockGainNote, unknownCostNote } from '../profitFormat';

export function ProfitTab({ data }: { data: ReportProfitTab }) {
  return (
    <div className="space-y-10">
      <WaterfallSection data={data} />
      <ChannelProfitSection channels={data.channels} />
      <CategoryProfitSection data={data} />
    </div>
  );
}

function WaterfallSection({ data }: { data: ReportProfitTab }) {
  const unknown = unknownCostNote(data);
  const gain = stockGainNote(data);
  const sales = data.steps.find((s) => s.key === 'sales')?.cents ?? 0;
  const noSales = sales === 0 && data.channels.length === 0;
  return (
    <Section
      id="waterfall"
      icon={Coins}
      title="What you keep"
      subtitle="From sales before tax down to profit before overheads (rent, salaries and bills are not on the till). This till's orders."
    >
      {noSales ? (
        <Panel>
          <p className="py-4 text-center text-sm text-stone-500">No sales in this period yet.</p>
        </Panel>
      ) : (
        <div className="grid gap-4 xl:grid-cols-3">
          <Panel className="xl:col-span-2">
            <p className="mb-3 text-lg font-semibold">{profitHeadline(data)}</p>
            <Waterfall
              ariaLabel="From sales to profit before overheads"
              steps={data.steps.map((s) => ({
                key: s.key,
                label: stepLabel(s.key, s.cents),
                cents: s.cents,
                amount: stepAmount(s.key, s.cents),
                hatched: s.key === 'unknown_cost',
              }))}
              result={{
                label: 'Profit before overheads',
                cents: data.profitCents,
                amount: `${data.profitCents < 0 ? '−' : ''}${formatCents(Math.abs(data.profitCents))}`,
              }}
            />
          </Panel>
          <div className="space-y-3">
            {unknown && <Note tone="warn">{unknown}</Note>}
            {gain && <Note tone="warn">{gain}</Note>}
            {data.stockLoss.state !== 'counted' && data.stockLoss.message && <Note>{data.stockLoss.message}</Note>}
            <Panel title="Waste by reason">
              {data.wasteByReason.length === 0 ? (
                <p className="text-sm text-stone-500">Nothing thrown away.</p>
              ) : (
                <ul className="space-y-1 text-sm">
                  {data.wasteByReason.map((w) => (
                    <li key={w.reason} className="flex justify-between gap-2">
                      <span>
                        {WASTE_REASON_LABEL[w.reason]} <span className="text-xs text-stone-500">· {w.times}×</span>
                      </span>
                      <span className="tabular-nums">{formatCents(w.cents)}</span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-2 text-xs text-stone-500">Food sent out, not paid: {unpaidFoodText(data.sentNotPaid)}</p>
            </Panel>
            <p className="text-xs text-stone-500">{commissionText(data.fees)}</p>
            <p className="text-xs text-stone-500">{riderText(data.riderCost)}</p>
            {data.noRateCount > 0 && (
              <p className="text-xs text-amber-800 dark:text-amber-300">
                {data.noRateCount} {data.noRateCount === 1 ? 'delivery has' : 'deliveries have'} no area and no delivery charge, so no rider cost is on{' '}
                {data.noRateCount === 1 ? 'it' : 'them'} (listed on Channels &amp; delivery).
              </p>
            )}
            <p className="text-xs text-stone-500">
              {estimatedText(data)} {costingStartText(data.costingStartedAt)}
            </p>
          </div>
        </div>
      )}
    </Section>
  );
}

/**
 * A channel's earnings, in the owner's words: before waste, unpaid food and
 * stock loss. Its sales are BEFORE tax (delivery charges included) — the
 * "Where orders come from" table above it is with tax — and say so.
 */
export function ChannelProfitSection({ channels }: { channels: ReportChannelProfit[] }) {
  // foodpanda's dearer menu (estimated) only when the owner said it is dearer.
  const uplift = channels.some((c) => c.upliftCents > 0);
  const partly = channels.some((c) => c.unknownSalesCents > 0);
  return (
    <Section
      id="channel-profit"
      icon={Store}
      title="What each order type earns"
      subtitle="Sales before tax, less the food whose cost is known, foodpanda's commission, card fees and the rider. Waste and missing stock are on the whole shop, above."
    >
      <Panel>
        <DataTable
          columns={[
            { label: 'Order type' },
            { label: 'Orders', right: true },
            { label: 'Sales before tax', right: true },
            { label: 'Food cost', right: true },
            { label: 'Unknown cost', right: true },
            { label: 'Commission', right: true },
            ...(uplift ? [{ label: 'Price uplift', right: true }] : []),
            { label: 'Card fees', right: true },
            { label: 'Rider', right: true },
            { label: 'Earns', right: true },
            { label: 'Per order', right: true },
          ]}
          rows={channels.map((c) => [
            <span key="c" className="font-medium">{CHANNEL_LABEL[c.channel]}</span>,
            c.orderCount,
            formatCents(c.salesCents),
            formatCents(c.foodCostCents),
            c.unknownSalesCents > 0 ? formatCents(c.unknownSalesCents) : '—',
            c.commissionCents > 0 ? formatCents(c.commissionCents) : '—',
            ...(uplift ? [c.upliftCents > 0 ? `+${formatCents(c.upliftCents)}` : '—'] : []),
            c.paymentFeeCents > 0 ? formatCents(c.paymentFeeCents) : '—',
            c.riderCents > 0 ? formatCents(c.riderCents) : '—',
            <b key="e">{formatCents(c.contributionCents)}</b>,
            c.contributionPerOrderCents === null ? '—' : formatCents(c.contributionPerOrderCents),
          ])}
          empty="No sales in this period."
        />
        {uplift && (
          <p className="mt-2 text-xs text-stone-500">Price uplift (estimated): what foodpanda&apos;s dearer menu brings in over the till&apos;s prices.</p>
        )}
        {partly && (
          <p className="mt-2 text-xs text-stone-500">
            Earns and per order are on the sales whose food cost is known. An order with food of unknown cost counts only in the share that is known,
            with the same share of its commission, delivery charge, rider and card fees; the rest is left out with that food.
          </p>
        )}
      </Panel>
    </Section>
  );
}

function CategoryProfitSection({ data }: { data: ReportProfitTab }) {
  return (
    <Section
      id="category-profit"
      icon={LayoutGrid}
      title="Profit by category"
      subtitle="Food only, on the sales whose cost is fully known, before channel costs (commission, rider). Each dish counts in the category it is in now."
    >
      <Panel note={costingStartText(data.costingStartedAt)}>
        <DataTable
          columns={[
            { label: 'Category' },
            { label: 'Sold', right: true },
            { label: 'Sales', right: true },
            { label: 'Costs known', right: true },
            { label: 'Food cost', right: true },
            { label: 'Profit', right: true },
            { label: 'Per sale', right: true },
          ]}
          rows={data.categories.map((c) => [
            <span key="n" className="font-medium">{c.name}</span>,
            c.units,
            formatCents(c.salesCents),
            formatBps(c.coverageBps),
            formatBps(c.foodCostBps),
            c.profitCents === null ? '—' : formatCents(c.profitCents),
            c.profitPerSaleCents === null ? '—' : formatCents(c.profitPerSaleCents),
          ])}
          empty="No food sold in this period."
        />
      </Panel>
    </Section>
  );
}
