import { useMemo, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Dialog from '@radix-ui/react-dialog';
import { Button, cn } from '@cheeseoclock/ui';
import { batchesText, formatCents, maxBatchAmount, scaleBatch } from '@cheeseoclock/pos-domain';
import type { BatchCalc, BatchRecipe, Ingredient } from '@cheeseoclock/shared-types';
import { AlertTriangle, ChefHat, X } from 'lucide-react';
import { ipc, IpcError } from '../../ipc/client';
import { useDebouncedValue } from '../../components/list';
import { useToast } from '../../components/toast/ToastProvider';
import { BatchBreakdown } from '../costing/BatchBreakdown';
import { COSTING_KEY, useCanSeeCosts } from '../costing/costingQueries';
import { amountProblem, batchMakeReady, formatMc, formatQtyUnit, readAmount, thousandUnit } from '../costing/costingFormat';

const qty = (n: number) => new Intl.NumberFormat('en-PK').format(n);

/**
 * The batch calculator (owner, 2026-09-27: "if a user wants to see a 200 g
 * batch it should show; I want to see full costing"). Type ANY amount of the
 * batch item — 200 g, or 1.5 in kg — and see every input scaled: the exact
 * amount, the whole grams stock will move, its price, its cost and its share
 * of the batch; the total, per g and per kg. "Make this amount" then takes
 * exactly those whole-unit amounts out of stock and puts the amount made in
 * (the same pos-domain scaleBatch decides both).
 */
export function BatchCalculatorDialog({
  ingredient,
  onClose,
  initialAmount,
}: {
  ingredient: Ingredient;
  onClose: () => void;
  /**
   * The amount it opens at (the recipe calculator's "Make / calculate 800 g"),
   * in the base unit; one batch when not given. Opening it never moves
   * stock: only its Make button does. Key the dialog by id + amount.
   */
  initialAmount?: number;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const canCost = useCanSeeCosts();
  const recipeQ = useQuery({
    queryKey: ['inventory', 'batch', ingredient.id],
    queryFn: () => ipc.inventory.getBatchRecipe(ingredient.id),
  });
  const r = recipeQ.data;
  const batchYield = r?.batchYield ?? ingredient.batchYield ?? 0;
  const big = thousandUnit(ingredient.unit);
  const [inBig, setInBig] = useState(false);
  const [text, setText] = useState(() =>
    initialAmount !== undefined && initialAmount > 0 ? String(initialAmount) : batchYield > 0 ? String(batchYield) : '',
  );

  // "200", "200 g", "1.5 kg" (a unit typed after the number wins over the switch).
  const reading = readAmount(text, inBig, ingredient.unit);
  const amount = reading.ok ? reading.amount : null;
  const max = batchYield > 0 ? maxBatchAmount(batchYield) : 0;
  const tooMuch = amount !== null && max > 0 && amount > max;
  const usable = amount !== null && !tooMuch && batchYield > 0;
  const asked = useDebouncedValue(usable ? amount : null, 250);

  const calcQ = useQuery({
    queryKey: [...COSTING_KEY, 'batchCalc', ingredient.id, asked],
    queryFn: () => ipc.costing.batchCalc({ ingredientId: ingredient.id, amount: asked! }),
    enabled: canCost && asked !== null,
    staleTime: 0,
    placeholderData: keepPreviousData,
  });
  // While a new amount is worked out, the last figures stay up, dimmed —
  // and "Make" waits: what it moves must be what the screen shows.
  const calc = usable ? (calcQ.data ?? null) : null;
  const fresh = calc !== null && calc.amount === amount;
  // If the costing cannot be worked out, fall back to the amounts alone (worked out here), as for a cashier.
  const costed = canCost && !(calcQ.isError && !calcQ.isFetching);

  const mut = useMutation({
    mutationFn: (made: number) => ipc.inventory.makeBatch({ ingredientId: ingredient.id, amount: made }),
    onSuccess: (res) => {
      toast({
        title: `Made ${qty(res.made)} ${ingredient.unit} of ${ingredient.name}`,
        description: `In stock now: ${qty(res.resultingQty)} ${ingredient.unit}`,
        variant: 'success',
      });
      void qc.invalidateQueries({ queryKey: ['inventory'] });
      void qc.invalidateQueries({ queryKey: COSTING_KEY });
      onClose();
    },
    onError: (e) => toast({ title: 'Could not record the batch', description: e instanceof IpcError ? e.message : String(e), variant: 'error' }),
  });
  const ready = batchMakeReady({
    amount,
    usable,
    hasLines: !!r && r.lines.length > 0,
    pending: mut.isPending,
    seesCosts: costed,
    shownAmount: calc?.amount ?? null,
  });

  /** Quick sizes, always typed in the base unit. */
  const quick = batchYield > 0 ? [
    { label: '¼ batch', n: Math.round(batchYield / 4) },
    { label: '½ batch', n: Math.round(batchYield / 2) },
    { label: '1 batch', n: batchYield },
    { label: '2 batches', n: batchYield * 2 },
  ].filter((x) => x.n > 0) : [];

  const switchUnit = (toBig: boolean) => {
    if (toBig === inBig) return;
    // Keep the same amount when switching g ↔ kg.
    if (amount !== null) setText(toBig ? String(amount / 1000) : String(amount));
    setInBig(toBig);
  };

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[90vh] w-[760px] max-w-[95vw] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl bg-white shadow-xl dark:bg-stone-900">
          <header className="flex items-start justify-between border-b border-stone-200 p-5 dark:border-stone-800">
            <div>
              <Dialog.Title className="text-lg font-bold">Make or cost: {ingredient.name}</Dialog.Title>
              <Dialog.Description className="text-sm text-stone-500">
                One batch makes {batchYield > 0 ? formatQtyUnit(batchYield, ingredient.unit) : '?'}. Type any amount to see
                what it takes{canCost ? ' and what it costs' : ''}.
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button type="button" aria-label="Close" className="rounded p-2 text-stone-500 hover:bg-stone-100 dark:hover:bg-stone-800">
                <X className="h-5 w-5" />
              </button>
            </Dialog.Close>
          </header>

          <div className="flex-1 space-y-4 overflow-auto p-5">
            <div className="flex flex-wrap items-end gap-3">
              <label className="text-sm">
                <span className="mb-1 block text-xs uppercase tracking-wider text-stone-500">How much</span>
                <input
                  type="text"
                  inputMode="decimal"
                  autoFocus
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  aria-invalid={text.trim() !== '' && (amount === null || tooMuch)}
                  placeholder={`e.g. 200 ${ingredient.unit}`}
                  className={cn(
                    'w-40 rounded-lg border px-3 py-2 text-right font-mono text-lg dark:bg-stone-800',
                    text.trim() !== '' && (amount === null || tooMuch) ? 'border-red-500' : 'border-stone-300 dark:border-stone-700',
                  )}
                />
              </label>
              {big ? (
                <div className="flex overflow-hidden rounded-lg ring-1 ring-stone-300 dark:ring-stone-700" role="group" aria-label="Unit">
                  {[false, true].map((b) => (
                    <button
                      key={String(b)}
                      type="button"
                      aria-pressed={inBig === b}
                      onClick={() => switchUnit(b)}
                      className={cn(
                        'px-3 py-2 text-sm font-semibold',
                        inBig === b ? 'bg-stone-900 text-white dark:bg-amber-500 dark:text-stone-900' : 'bg-white text-stone-600 dark:bg-stone-800 dark:text-stone-300',
                      )}
                    >
                      {b ? big : ingredient.unit}
                    </button>
                  ))}
                </div>
              ) : (
                <span className="pb-2 text-sm text-stone-500">{ingredient.unit}</span>
              )}
              <div className="flex flex-wrap gap-1.5 pb-1">
                {quick.map((x) => (
                  <button
                    key={x.label}
                    type="button"
                    onClick={() => {
                      setInBig(false);
                      setText(String(x.n));
                    }}
                    className="h-8 rounded-full bg-stone-100 px-3 text-xs font-medium text-stone-700 hover:bg-stone-200 dark:bg-stone-800 dark:text-stone-200 dark:hover:bg-stone-700"
                  >
                    {x.label}
                  </button>
                ))}
              </div>
            </div>
            <p className="-mt-2 text-sm text-stone-500">
              {amount === null
                ? amountProblem(reading, ingredient.unit, inBig && !!big)
                : tooMuch
                  ? `At most ${qty(max)} ${ingredient.unit} (100 batches) at once.`
                  : batchYield > 0
                    ? `${qty(amount)} ${ingredient.unit} = ${batchesText(amount, batchYield)}.`
                    : null}
            </p>

            {costed ? (
              calc ? (
                <div className={cn('transition-opacity', !fresh && 'opacity-50')} aria-busy={!fresh}>
                  <CostedBreakdown calc={calc} />
                </div>
              ) : (
                <div className="py-6 text-center text-sm text-stone-500">{usable ? 'Working it out…' : ' '}</div>
              )
            ) : (
              r && usable && <AmountsOnly recipe={r} amount={amount} />
            )}
          </div>

          <footer className="flex flex-wrap items-center gap-2 border-t border-stone-200 p-5 dark:border-stone-800">
            <span className="mr-auto text-sm text-stone-500">
              In stock now: {qty(ingredient.currentQty)} {ingredient.unit}
              {usable && (
                <>
                  {' '}
                  → after making it: <b className="text-stone-800 dark:text-stone-100">{qty(ingredient.currentQty + amount)} {ingredient.unit}</b>
                </>
              )}
            </span>
            <Button variant="secondary" onClick={onClose}>
              Close
            </Button>
            <Button
              variant="primary"
              disabled={!ready}
              title={usable && !ready && costed && !fresh ? 'Working out this amount first…' : undefined}
              onClick={() => ready && amount !== null && mut.mutate(amount)}
            >
              <ChefHat className="h-4 w-4" /> {mut.isPending ? 'Recording…' : usable ? `Make ${qty(amount)} ${ingredient.unit}` : 'Make this amount'}
            </Button>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Total, per unit and per kg; warnings; then every input. */
function CostedBreakdown({ calc }: { calc: BatchCalc }) {
  const rounded = calc.lines.some((l) => l.stockQty * 100 !== l.scaledHundredths);
  const perBig = thousandUnit(calc.unit);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 rounded-lg bg-amber-50 px-4 py-3 dark:bg-amber-950/40">
        <div>
          <div className="text-xs uppercase tracking-wider text-stone-500">
            {qty(calc.amount)} {calc.unit} costs
          </div>
          <div className="font-mono text-2xl font-bold">{formatCents(calc.totalCostCents)}</div>
        </div>
        <div className="text-sm text-stone-600 dark:text-stone-300">
          {formatMc(calc.perUnitMc)} per {calc.unit}
          {/* A base unit's price in millicents is the thousand's in paisa: per g → per kg. */}
          {perBig && (
            <>
              {' · '}
              <b>{formatCents(calc.perUnitMc)}</b> per {perBig}
            </>
          )}
        </div>
      </div>
      {!calc.complete && (
        <p className="flex items-start gap-1.5 text-sm text-red-700 dark:text-red-400">
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-none" />
          No price yet for {calc.unpricedInputs.join(', ')}: the total leaves {calc.unpricedInputs.length === 1 ? 'it' : 'them'} out.
        </p>
      )}
      {calc.estimateInputs.length > 0 && (
        <p className="text-sm text-amber-800 dark:text-amber-300">Guessed price: {calc.estimateInputs.join(', ')}.</p>
      )}
      <BatchBreakdown calc={calc} showStock />
      {(rounded || calc.roundedAway.length > 0) && (
        <p className="text-xs text-stone-500">
          Stock is counted in whole units, so &quot;From stock&quot; is each amount rounded (amber where it differs); the cost is
          of the exact amount.
          {calc.roundedAway.length > 0 && <> Too little to take from stock at this size: {calc.roundedAway.join(', ')}.</>}
        </p>
      )}
    </div>
  );
}

/** Without cost access: only what stock will move (the same scaleBatch as the till). */
function AmountsOnly({ recipe, amount }: { recipe: BatchRecipe; amount: number }) {
  const scaled = useMemo(
    () =>
      recipe.batchYield
        ? scaleBatch(
            recipe.batchYield,
            recipe.lines.map((l) => ({ inputId: l.inputIngredientId, qty: l.qty, pack: null, kind: 'missing' as const })),
            amount,
          )
        : null,
    [recipe, amount],
  );
  if (!scaled) return null;
  return (
    <ul className="space-y-0.5 rounded bg-stone-50 p-2 text-sm dark:bg-stone-800/50">
      {scaled.lines.map((l, i) => {
        const line = recipe.lines[i]!;
        return (
          <li key={l.inputId} className="flex justify-between">
            <span>{line.name}</span>
            <span className="font-mono">
              −{qty(l.stockQty)} {line.unit}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
