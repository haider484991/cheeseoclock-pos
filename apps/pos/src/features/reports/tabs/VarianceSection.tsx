/**
 * Reports → Food cost & stock, "Used vs should have used" (costing spec
 * Phase 8, §4.6): between two stock takes, what actually went against what
 * sales, batches and logged waste say should have gone, per ingredient in
 * rupees, with a good / look-at-it rating; batches shown with what they are
 * made from; typed fixes listed beside, not in the figures; and the real
 * food cost when both stock takes were full. Its own channel
 * (reports:variance), asked for when the period is "Between stock takes".
 */
import { cn } from '@cheeseoclock/ui';
import { formatCents, formatQty, staleLinkText } from '@cheeseoclock/pos-domain';
import type { ReportVariance } from '@cheeseoclock/shared-types';
import { Loader2, Scale } from 'lucide-react';
import { DataTable, Note, Panel, Section, useShowAll } from '../reportUi';
import { formatBps } from '../../costing/costingFormat';
import { fmtMoment } from '../dateRange';
import {
  VARIANCE_BAND_LABEL,
  actualCogsText,
  bandTone,
  lineVerdict,
  signedCents,
  signedQty,
  varianceHeadline,
  varianceWindowText,
} from '../varianceFormat';

/** What the page hands the section: the figures (when back), and whether they are coming or failed. */
export interface VarianceView {
  data: ReportVariance | undefined;
  loading: boolean;
  error: string | null;
}

const SUBTITLE =
  'What went between two stock takes, against what sales, batches and logged waste say should have gone. From every till’s stock.';

export function VarianceSection({ view }: { view: VarianceView | null }) {
  if (view === null) {
    return (
      <Section id="stock-used" icon={Scale} title="Used vs should have used" subtitle={SUBTITLE}>
        <Panel>
          <p className="py-2 text-sm text-stone-600 dark:text-stone-300">
            Pick <strong>Between stock takes</strong> in the period above to set what was used against what should have been.
            Stock takes are done under Inventory → Stock takes.
          </p>
        </Panel>
      </Section>
    );
  }
  const v = view.data;
  return (
    <Section id="stock-used" icon={Scale} title="Used vs should have used" subtitle={SUBTITLE}>
      {view.error ? (
        <Note tone="warn">{view.error}</Note>
      ) : !v ? (
        <Panel>
          <p className="flex items-center justify-center gap-2 py-4 text-sm text-stone-500">
            <Loader2 className="h-4 w-4 animate-spin" /> Working it out…
          </p>
        </Panel>
      ) : v.state !== 'ok' ? (
        <Panel>
          <p className="py-2 text-sm text-stone-600 dark:text-stone-300">{v.message}</p>
        </Panel>
      ) : (
        <VarianceBody v={v} />
      )}
    </Section>
  );
}

function VarianceBody({ v }: { v: ReportVariance }) {
  const lines = useShowAll(v.lines, 12);
  const tone = bandTone(v.band);
  const stale = v.staleSync ? staleLinkText(v.link) : null;
  const warnings = v.pairs.filter((p) => p.warning !== null);
  return (
    <div className="space-y-3">
      <p className="text-sm text-stone-500">{varianceWindowText(v)}</p>
      {stale && <Note tone="warn">{stale}</Note>}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Panel>
          <div className="text-[11px] font-semibold uppercase tracking-widest text-stone-500">Not explained</div>
          <div className={cn('mt-1 text-2xl font-bold tabular-nums', v.totalCents > 0 && 'text-red-700 dark:text-red-400')}>
            {signedCents(v.totalCents)}
          </div>
          <div className="mt-1 text-xs text-stone-500">at the prices when the later stock take was finished</div>
        </Panel>
        <Panel>
          <div className="text-[11px] font-semibold uppercase tracking-widest text-stone-500">Of food sales</div>
          <div className="mt-1 flex items-center gap-2">
            <span className="text-2xl font-bold tabular-nums">{formatBps(v.varianceBps === null ? null : Math.abs(v.varianceBps))}</span>
            {v.band && (
              <span
                className={cn(
                  'rounded-full px-2 py-0.5 text-xs font-semibold',
                  tone === 'good' && 'bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200',
                  tone === 'warn' && 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
                  tone === 'bad' && 'bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-200',
                )}
              >
                {VARIANCE_BAND_LABEL[v.band]}
              </span>
            )}
          </div>
          <div className="mt-1 text-xs text-stone-500">Under 2% is good; over 5%, look at it now</div>
        </Panel>
        <Panel>
          <div className="text-[11px] font-semibold uppercase tracking-widest text-stone-500">Food sales</div>
          <div className="mt-1 text-2xl font-bold tabular-nums">{formatCents(v.foodSalesCents)}</div>
          <div className="mt-1 text-xs text-stone-500">between the two, before tax, after discounts</div>
        </Panel>
        <Panel>
          <div className="text-[11px] font-semibold uppercase tracking-widest text-stone-500">Compared</div>
          <div className="mt-1 text-2xl font-bold tabular-nums">{v.lines.length}</div>
          <div className="mt-1 text-xs text-stone-500">ingredients counted on both</div>
        </Panel>
      </div>
      <p className="text-sm font-semibold">{varianceHeadline(v)}</p>
      {warnings.map((p) => (
        <Note key={p.batchId} tone="warn">
          {p.warning}
        </Note>
      ))}
      <Panel
        title="By ingredient"
        note="Should have used: what sales took and batches used. Went: counted before, plus deliveries and batches made, less counted after. Waste is what was logged."
      >
        <DataTable
          columns={[
            { label: 'Ingredient' },
            { label: 'Should have used', right: true },
            { label: 'Went', right: true },
            { label: 'Waste logged', right: true },
            { label: 'Not explained', right: true },
            { label: 'Rs', right: true },
          ]}
          rows={lines.shown.map((l) => [
            <span key="n">
              <span className="font-medium">{l.name}</span>
              <span className="block text-xs text-stone-500">{lineVerdict(l)}</span>
            </span>,
            formatQty(l.shouldHaveUsed, l.unit),
            formatQty(l.used, l.unit),
            l.wasted === 0 ? '—' : formatQty(l.wasted, l.unit),
            <span key="v" className={cn(l.unexplained > 0 && 'font-semibold text-red-700 dark:text-red-400')}>
              {signedQty(l.unexplained, l.unit)}
            </span>,
            l.priced ? signedCents(l.unexplainedCents) : <span className="text-stone-500">no price</span>,
          ])}
          footer={['All', null, null, null, null, signedCents(v.totalCents)]}
          empty="Nothing was counted on both stock takes."
        />
        {lines.toggle}
      </Panel>
      {v.pairs.length > 0 && (
        <Panel title="Made here, and what goes into it" note="A batch's ingredients look short by any batch that was made but not logged.">
          <ul className="space-y-1 text-sm">
            {v.pairs.map((p) => (
              <li key={p.batchId}>
                <span className="font-medium">{p.batchName}</span>
                <span className="text-stone-500"> ← {p.inputs.map((i) => i.name).join(', ')}</span>
                {p.noBatchLogged && <span className="ml-2 text-xs font-semibold text-amber-700 dark:text-amber-300">no batch logged</span>}
              </li>
            ))}
          </ul>
        </Panel>
      )}
      {v.corrections.length > 0 && (
        <Panel title="Fixes typed in this time" note="Listed beside the figures, not counted in what went.">
          <DataTable
            columns={[{ label: 'When' }, { label: 'Ingredient' }, { label: 'Change', right: true }, { label: 'Note' }]}
            rows={v.corrections.map((c) => [
              fmtMoment(c.at),
              c.name,
              signedQty(c.qty, c.unit),
              c.notes ?? (c.kind === 'old_count' ? 'An older one-off count' : ''),
            ])}
            empty="None."
          />
        </Panel>
      )}
      {v.alreadyCounted.length > 0 && (
        <Panel
          title="Left out: cancelled orders a stock take had already counted"
          note="The food was not made, and a stock take had already seen it on the shelf, so it is not counted again."
        >
          <ul className="space-y-1 text-sm">
            {v.alreadyCounted.map((a, i) => (
              <li key={`${a.orderId}:${a.ingredientId}:${i}`}>
                Order {a.orderNumber ?? a.orderId.slice(0, 8)}: {formatQty(Math.abs(a.qty), a.unit)} {a.name}
              </li>
            ))}
          </ul>
        </Panel>
      )}
      {v.notOnBoth.length > 0 && (
        <p className="text-xs text-stone-500">
          Counted only on the later stock take (nothing to compare with): {v.notOnBoth.map((n) => n.name).join(', ')}.
        </p>
      )}
      <Panel title="Real food cost">
        {v.actualCogs ? (
          <div className="space-y-2 text-sm">
            <p className="font-semibold">{actualCogsText(v.actualCogs)}</p>
            <DataTable
              columns={[{ label: '' }, { label: 'Rs', right: true }]}
              rows={[
                ['Stock held at the first stock take', formatCents(v.actualCogs.openingCents)],
                ['+ bought in between', formatCents(v.actualCogs.purchasesCents)],
                ['− stock held at the second', formatCents(v.actualCogs.closingCents)],
              ]}
              footer={['= food used', formatCents(v.actualCogs.costCents)]}
              empty=""
            />
            <p className="text-xs text-stone-500">
              Includes price changes on stock you held. Only ingredients a recipe or a batch uses.
              {v.actualCogs.otherPurchasesCents > 0 &&
                ` Other things bought (${formatCents(v.actualCogs.otherPurchasesCents)}: ${v.actualCogs.otherPurchases
                  .slice(0, 4)
                  .map((p) => p.name)
                  .join(', ')}${v.actualCogs.otherPurchases.length > 4 ? '…' : ''}) are left out.`}
            </p>
          </div>
        ) : (
          <p className="text-sm text-stone-500">{v.actualCogsWhyNot}</p>
        )}
      </Panel>
    </div>
  );
}
