import { useQuery } from '@tanstack/react-query';
import * as Dialog from '@radix-ui/react-dialog';
import { Button, cn } from '@cheeseoclock/ui';
import type { Ingredient, PriceHistoryEntry } from '@cheeseoclock/shared-types';
import { Tag, X } from 'lucide-react';
import { ipc } from '../../ipc/client';
import { PriceLineChart } from '../reports/charts';
import { SOURCE_CHIP, historyPoints, packText, priceChange, priceText, whenText, type ChipTone } from './price-view';

const TONE: Record<ChipTone, string> = {
  stone: 'bg-stone-100 text-stone-700 dark:bg-stone-800 dark:text-stone-300',
  sky: 'bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-200',
  emerald: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200',
  violet: 'bg-violet-100 text-violet-800 dark:bg-violet-950 dark:text-violet-200',
  amber: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
};

/** Where a price came from, as a small chip (Bill, Typed, Sheet, Batch, Starting price…). */
export function SourceChip({ source }: { source: PriceHistoryEntry['source'] }) {
  const chip = SOURCE_CHIP[source];
  return (
    <span title={chip.hint} className={cn('whitespace-nowrap rounded px-1.5 py-0.5 font-sans text-[11px] font-medium', TONE[chip.tone])}>
      {chip.label}
    </span>
  );
}

/** ▲ dearer (red), ▼ cheaper (green), on the price before. */
export function ChangeMark({ prevUnitCostMc, unitCostMc, priceKind }: Pick<PriceHistoryEntry, 'prevUnitCostMc' | 'unitCostMc' | 'priceKind'>) {
  const c = priceChange(prevUnitCostMc, unitCostMc, priceKind);
  if (!c || c.tone === 'same') return null;
  return (
    <span
      className={cn(
        'whitespace-nowrap font-sans text-[11px] font-semibold',
        c.tone === 'up' ? 'text-red-700 dark:text-red-400' : 'text-emerald-700 dark:text-emerald-400',
      )}
      title="On the price before"
    >
      {c.text}
    </span>
  );
}

/**
 * One ingredient's price history, in a drawer: a small line of the price
 * over time, and every change — when, the price, where it came from, the
 * supplier and purchase order, who — newest first.
 */
export function PriceHistoryDrawer({
  ingredient,
  onClose,
  onSetPrice,
}: {
  ingredient: Ingredient;
  onClose: () => void;
  onSetPrice: (ingredient: Ingredient) => void;
}) {
  const q = useQuery({
    queryKey: ['inventory', 'priceHistory', ingredient.id],
    queryFn: () => ipc.inventory.priceHistory(ingredient.id),
  });
  const entries = q.data ?? [];
  const points = historyPoints(entries, ingredient.unit);

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/30 backdrop-blur-sm" />
        <Dialog.Content className="fixed right-0 top-0 z-50 flex h-full w-[600px] max-w-full flex-col bg-white shadow-soft-lg dark:bg-stone-900">
          <header className="flex items-start justify-between gap-3 border-b border-stone-200 px-5 py-4 dark:border-stone-700">
            <div className="min-w-0">
              <Dialog.Title className="text-xl font-bold">Price history: {ingredient.name}</Dialog.Title>
              <Dialog.Description className="mt-1 text-sm text-stone-600 dark:text-stone-400">
                Every price it has had, when it came in, where from and who set it. Reports price older sales at the price of their day.
              </Dialog.Description>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <Button variant="secondary" size="sm" className="whitespace-nowrap" onClick={() => onSetPrice(ingredient)}>
                <Tag className="h-4 w-4" /> Set price
              </Button>
              <Dialog.Close asChild>
                <button type="button" aria-label="Close" className="rounded-lg p-2 text-stone-400 hover:bg-stone-100 hover:text-stone-700 dark:hover:bg-stone-800">
                  <X className="h-5 w-5" />
                </button>
              </Dialog.Close>
            </div>
          </header>
          <div className="flex-1 space-y-4 overflow-auto px-5 py-4">
            {q.isLoading ? (
              <p className="text-sm text-stone-500">Loading…</p>
            ) : q.isError ? (
              <p className="text-sm text-red-700 dark:text-red-400">The price history could not be read.</p>
            ) : entries.length === 0 ? (
              <p className="text-sm text-stone-500">No prices recorded yet.</p>
            ) : (
              <>
                {points.length > 1 && (
                  <PriceLineChart points={points.map((p) => ({ at: p.at, value: p.unitCostMc, label: p.label }))} ariaLabel={`${ingredient.name}: price over time`} />
                )}
                <table className="w-full text-sm">
                  <thead className="text-left text-xs uppercase tracking-wider text-stone-500">
                    <tr>
                      <th className="pb-2">When</th>
                      <th className="pb-2 text-right">Price</th>
                      <th className="pb-2 pl-3">From</th>
                      <th className="pb-2 pl-3">Who</th>
                    </tr>
                  </thead>
                  <tbody>
                    {entries.map((e) => {
                      const pack = packText(e);
                      const when = whenText(e);
                      return (
                        <tr key={e.id} className="border-t border-stone-100 align-top dark:border-stone-800">
                          <td className="whitespace-nowrap py-2 pr-2 text-xs text-stone-600 dark:text-stone-400">
                            {when.main}
                            {when.sub && <div className="text-[11px] text-stone-500">{when.sub}</div>}
                          </td>
                          <td className="py-2 text-right">
                            <div className="whitespace-nowrap font-mono text-xs font-semibold">
                              {priceText(e)}
                              {e.priceKind === 'estimate' && <span className="ml-1 font-sans text-[11px] font-normal text-amber-700 dark:text-amber-300">guess</span>}
                            </div>
                            {pack && <div className="whitespace-nowrap text-[11px] text-stone-500">{pack}</div>}
                            {e.source !== 'convert' && <ChangeMark prevUnitCostMc={e.prevUnitCostMc} unitCostMc={e.unitCostMc} priceKind={e.priceKind} />}
                          </td>
                          <td className="py-2 pl-3">
                            <SourceChip source={e.source} />
                            {(e.supplierName || e.purchaseOrderRef) && (
                              <div className="mt-0.5 text-[11px] text-stone-500">
                                {[e.supplierName, e.purchaseOrderRef ? `PO ${e.purchaseOrderRef}` : null].filter(Boolean).join(' · ')}
                              </div>
                            )}
                            {e.notes && <div className="mt-0.5 text-[11px] text-stone-500">{e.notes}</div>}
                          </td>
                          <td className="py-2 pl-3 text-xs text-stone-600 dark:text-stone-400">{e.actorName ?? 'The till'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
