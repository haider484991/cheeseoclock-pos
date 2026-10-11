/**
 * What if on one dish (0.7.46; the owner, 12 Oct 2026: "the recipe calculator
 * should be really comprehensive — I wanted to know the cost of Regular Fries
 * if I only decrease or increase the fries grams, I couldn't do it"). The
 * recipe as saved beside the amounts being tried — and another price before
 * tax, if typed — with what each line costs, what the plate costs, its food
 * cost against the target and, for the owner, what the price leaves after
 * it (costing:recipeWhatIf: the plate the recipe editor's footer and the cost
 * sheet work out). Nothing changes until Save these amounts, which saves the
 * amounts (never the price: that is Menu → Items).
 */
import { useEffect, useMemo, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, cn } from '@cheeseoclock/ui';
import { formatCents } from '@cheeseoclock/pos-domain';
import type { MenuItem, RecipeWhatIfSide } from '@cheeseoclock/shared-types';
import { Minus, Plus, RotateCcw, X } from 'lucide-react';
import { ipc } from '../../ipc/client';
import { useToast } from '../../components/toast/ToastProvider';
import { useDebouncedValue } from '../../components/list';
import { COSTING_KEY } from './costingQueries';
import { FoodCostChip } from './CostChip';
import { formatBps } from './costingFormat';
import { amountsChanged, bpsDiff, linesToSave, moneyDiff, priceCentsOf, stepAmount } from './whatIfAmounts';

type TryLine = { ingredientId: string; qtyPerUnit: number; modifierId: string | null };

export function RecipeWhatIfDialog({ item, onClose }: { item: MenuItem; onClose: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const recipeQ = useQuery({ queryKey: ['inventory', 'recipe', item.id], queryFn: () => ipc.inventory.getRecipe(item.id) });
  const saved = useMemo<TryLine[]>(
    () => (recipeQ.data ?? []).map((l) => ({ ingredientId: l.ingredientId, qtyPerUnit: l.qtyPerUnit, modifierId: l.modifierId })),
    [recipeQ.data],
  );
  const labels = useMemo(
    () =>
      new Map(
        (recipeQ.data ?? []).map((l) => [`${l.ingredientId}|${l.modifierId ?? ''}`, { name: l.ingredientName, unit: l.unit, choice: l.modifierName }]),
      ),
    [recipeQ.data],
  );
  const [tried, setTried] = useState<TryLine[]>([]);
  const [priceText, setPriceText] = useState(String(item.basePriceCents / 100));
  useEffect(() => setTried(saved), [saved]);

  const priceCents = priceCentsOf(priceText);
  // Asked again a moment after the last tap, the amounts as text so the same amounts are the same question.
  const asked = useDebouncedValue(JSON.stringify({ lines: tried, priceCents }), 250);
  const whatIfQ = useQuery({
    queryKey: [...COSTING_KEY, 'recipeWhatIf', item.id, asked],
    queryFn: () => ipc.costing.recipeWhatIf({ menuItemId: item.id, ...(JSON.parse(asked) as { lines: TryLine[]; priceCents: number | null }) }),
    enabled: recipeQ.isSuccess,
    placeholderData: keepPreviousData,
    staleTime: 0,
  });
  const w = whatIfQ.data;
  const changed = amountsChanged(saved, tried);

  const saveMut = useMutation({
    mutationFn: () => ipc.inventory.setRecipe({ menuItemId: item.id, lines: linesToSave(tried) }),
    onSuccess: () => {
      toast({ title: `${item.name}: new amounts saved`, variant: 'success' });
      void qc.invalidateQueries({ queryKey: ['inventory', 'recipe', item.id] });
      void qc.invalidateQueries({ queryKey: ['inventory', 'recipeLineCounts'] });
      void qc.invalidateQueries({ queryKey: COSTING_KEY });
      onClose();
    },
    onError: (e) => toast({ title: 'Not saved', description: e instanceof Error ? e.message : String(e), variant: 'error' }),
  });

  const setQty = (i: number, qty: number) => setTried((prev) => prev.map((l, j) => (j === i ? { ...l, qtyPerUnit: Math.max(0, Math.round(qty)) } : l)));
  // Each side's lines by ingredient and choice: the main process lists the saved recipe in its own order.
  const lineOf = (side: RecipeWhatIfSide | undefined, l: TryLine) =>
    side?.lines.find((x) => x.ingredientId === l.ingredientId && (x.modifierId ?? null) === (l.modifierId ?? null)) ?? null;

  return (
    <Dialog.Root open onOpenChange={(o) => !o && !saveMut.isPending && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[90vh] w-[820px] max-w-[96vw] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl bg-white shadow-xl dark:bg-stone-900">
          <header className="flex items-start justify-between gap-3 border-b border-stone-200 p-5 dark:border-stone-800">
            <div>
              <Dialog.Title className="text-lg font-bold">What if · {item.name}</Dialog.Title>
              <Dialog.Description className="mt-0.5 text-xs text-stone-500">
                Change an amount or the price and see what it costs to make, at today&rsquo;s prices. Nothing changes until you
                press Save these amounts.
              </Dialog.Description>
            </div>
            <button type="button" onClick={onClose} aria-label="Close" className="rounded p-2 text-stone-500 hover:bg-stone-100 dark:hover:bg-stone-800">
              <X className="h-5 w-5" />
            </button>
          </header>

          <div className="flex-1 overflow-auto p-5">
            {recipeQ.isLoading ? (
              <p className="py-6 text-center text-sm text-stone-500">Loading the recipe…</p>
            ) : saved.length === 0 ? (
              <p className="py-6 text-center text-sm text-stone-500">This item has no recipe yet: add one first.</p>
            ) : (
              <table className="w-full text-sm" data-testid="what-if-lines">
                <thead className="text-left text-xs uppercase tracking-wider text-stone-500">
                  <tr>
                    <th className="pb-2">Ingredient</th>
                    <th className="pb-2 text-right">Now</th>
                    <th className="pb-2 text-center">Try</th>
                    <th className="pb-2 text-right">Cost now</th>
                    <th className="pb-2 text-right">Cost tried</th>
                  </tr>
                </thead>
                <tbody>
                  {tried.map((l, i) => {
                    const lab = labels.get(`${l.ingredientId}|${l.modifierId ?? ''}`);
                    const unit = lab?.unit ?? '';
                    const was = saved[i]?.qtyPerUnit ?? 0;
                    const moved = l.qtyPerUnit !== was;
                    return (
                      <tr key={`${l.ingredientId}|${l.modifierId ?? ''}`} className={cn('border-t border-stone-100 dark:border-stone-800', moved && 'bg-amber-50 dark:bg-amber-950/30')}>
                        <td className="py-2 pr-2">
                          <div className="font-medium">{lab?.name ?? 'An ingredient'}</div>
                          <div className="text-xs text-stone-500">{lab?.choice ? `Only with: ${lab.choice}` : 'Every sale'}</div>
                        </td>
                        <td className="py-2 text-right font-mono text-stone-500">
                          {was} {unit}
                        </td>
                        <td className="py-2">
                          <div className="flex items-center justify-center gap-1">
                            <button
                              type="button"
                              onClick={() => setQty(i, stepAmount(l.qtyPerUnit, unit, -1))}
                              aria-label={`Less ${lab?.name ?? ''}`}
                              className="rounded-md border border-stone-300 p-1.5 hover:bg-stone-100 dark:border-stone-700 dark:hover:bg-stone-800"
                            >
                              <Minus className="h-3.5 w-3.5" />
                            </button>
                            <input
                              type="number"
                              min={0}
                              step={1}
                              inputMode="numeric"
                              value={l.qtyPerUnit}
                              onChange={(e) => setQty(i, parseInt(e.target.value, 10) || 0)}
                              aria-label={`Try an amount of ${lab?.name ?? 'this ingredient'}`}
                              className="w-20 rounded-lg border border-stone-300 px-2 py-1.5 text-right font-mono dark:border-stone-700 dark:bg-stone-800"
                            />
                            <button
                              type="button"
                              onClick={() => setQty(i, stepAmount(l.qtyPerUnit, unit, 1))}
                              aria-label={`More ${lab?.name ?? ''}`}
                              className="rounded-md border border-stone-300 p-1.5 hover:bg-stone-100 dark:border-stone-700 dark:hover:bg-stone-800"
                            >
                              <Plus className="h-3.5 w-3.5" />
                            </button>
                            <span className="w-8 text-xs text-stone-500">{unit}</span>
                          </div>
                        </td>
                        <td className="py-2 text-right font-mono text-stone-500">{lineCostText(lineOf(w?.saved, saved[i] ?? l), w !== undefined)}</td>
                        <td className={cn('py-2 text-right font-mono', moved && 'font-semibold')}>{lineCostText(lineOf(w?.tried, l), w !== undefined, l.qtyPerUnit === 0)}</td>
                      </tr>
                    );
                  })}
                  <tr className="border-t-2 border-stone-200 dark:border-stone-700">
                    <td className="py-2 pr-2 font-medium">Price before tax</td>
                    <td className="py-2 text-right font-mono text-stone-500">{formatCents(item.basePriceCents)}</td>
                    <td className="py-2">
                      <div className="flex items-center justify-center gap-1">
                        <span className="text-xs text-stone-500">Rs</span>
                        <input
                          inputMode="decimal"
                          value={priceText}
                          onChange={(e) => setPriceText(e.target.value)}
                          aria-label="Try a price before tax (Rs)"
                          className="w-28 rounded-lg border border-stone-300 px-2 py-1.5 text-right font-mono dark:border-stone-700 dark:bg-stone-800"
                        />
                      </div>
                    </td>
                    <td colSpan={2} className="py-2 text-right text-xs text-stone-500">
                      Trying only: the price changes in Menu → Items.
                    </td>
                  </tr>
                </tbody>
              </table>
            )}

            {w && saved.length > 0 && (
              <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-3" data-testid="what-if-summary">
                <Figure label="Cost to make" now={formatCents(w.saved.costCents)} tried={formatCents(w.tried.costCents)} diff={moneyDiff(w.saved.costCents, w.tried.costCents)} />
                <div className="rounded-lg border border-stone-200 p-3 dark:border-stone-700">
                  <div className="text-xs uppercase tracking-wider text-stone-500">Food cost (target {formatBps(w.targetBps)})</div>
                  <div className="mt-1 flex items-center gap-2 font-mono text-sm">
                    <span className="text-stone-500">{formatBps(w.saved.foodCostBps)}</span>
                    <span aria-hidden="true">→</span>
                    <FoodCostChip flag={w.tried.flag} bps={w.tried.foodCostBps} targetBps={w.targetBps} />
                  </div>
                  <div className="mt-0.5 text-xs text-stone-500">{bpsDiff(w.saved.foodCostBps, w.tried.foodCostBps) ?? '—'}</div>
                </div>
                {w.tried.leftCents !== null && w.saved.leftCents !== null ? (
                  <Figure
                    label="Left after the food cost"
                    now={formatCents(w.saved.leftCents)}
                    tried={formatCents(w.tried.leftCents)}
                    diff={moneyDiff(w.saved.leftCents, w.tried.leftCents)}
                  />
                ) : (
                  <Figure label="Price with the usual picks" now={formatCents(w.saved.priceCents)} tried={formatCents(w.tried.priceCents)} diff={moneyDiff(w.saved.priceCents, w.tried.priceCents)} />
                )}
              </div>
            )}
            {w && (w.tried.missingLines > 0 || w.tried.estimateLines > 0) && (
              <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">
                {w.tried.missingLines > 0
                  ? 'An ingredient here has no price yet: the cost is at least this much.'
                  : 'Includes a guessed price.'}
              </p>
            )}
            {w && saved.some((l) => l.modifierId) && (
              <p className="mt-2 text-xs text-stone-500">
                Lines used only with a choice count as often as customers pick it (the last 4 weeks), as on the cost sheet.
              </p>
            )}
          </div>

          <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-stone-200 p-5 dark:border-stone-800">
            <Button
              variant="ghost"
              className="mr-auto"
              disabled={!changed && priceCents === item.basePriceCents}
              onClick={() => {
                setTried(saved);
                setPriceText(String(item.basePriceCents / 100));
              }}
            >
              <RotateCcw className="h-4 w-4" /> Put back
            </Button>
            <Button variant="secondary" onClick={onClose} disabled={saveMut.isPending}>
              Close
            </Button>
            <Button variant="primary" disabled={!changed || saveMut.isPending || linesToSave(tried).length === 0} onClick={() => saveMut.mutate()}>
              {saveMut.isPending ? 'Saving…' : 'Save these amounts'}
            </Button>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** A line's cost in the table: "Rs 135", "no price", "free"; "taken off" for a line tried at 0; "…" while it is worked out. */
function lineCostText(line: { costCents: number; kind: string } | null, answered: boolean, takenOff = false): string {
  if (takenOff) return 'taken off';
  if (!line) return answered ? '—' : '…';
  if (line.kind === 'missing') return 'no price';
  if (line.kind === 'free') return 'free';
  return formatCents(line.costCents);
}

function Figure({ label, now, tried, diff }: { label: string; now: string; tried: string; diff: string }) {
  return (
    <div className="rounded-lg border border-stone-200 p-3 dark:border-stone-700">
      <div className="text-xs uppercase tracking-wider text-stone-500">{label}</div>
      <div className="mt-1 font-mono text-sm">
        <span className="text-stone-500">{now}</span> <span aria-hidden="true">→</span> <b>{tried}</b>
      </div>
      <div className="mt-0.5 text-xs text-stone-500">{diff}</div>
    </div>
  );
}
