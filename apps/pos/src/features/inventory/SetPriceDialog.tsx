import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import * as Dialog from '@radix-ui/react-dialog';
import { Button, cn } from '@cheeseoclock/ui';
import type { Ingredient } from '@cheeseoclock/shared-types';
import { ChefHat, X } from 'lucide-react';
import { effectivePack, thousandWord, unitCostMc } from '@cheeseoclock/pos-domain';
import { ipc, IpcError } from '../../ipc/client';
import { useToast } from '../../components/toast/ToastProvider';
import { COSTING_KEY } from '../costing/costingQueries';
import { formatUnitPrice } from '../costing/costingFormat';
import {
  initialPriceEntry,
  perChoices,
  perLabel,
  priceChange,
  priceText,
  readPriceEntry,
  type PriceEntry,
  type PricePer,
} from './price-view';

/**
 * The price boxes, shared by "Set price" and "Add ingredient" (costing spec
 * Phase 4): Rs X per kg (or litre), for a pack of N, or per piece — as it
 * is bought, kept exactly — plus "free" and "a guess". What it works out to
 * is shown under the boxes as they are typed.
 */
export function PriceFields({
  unit,
  entry,
  onChange,
  idPrefix,
  optional = false,
}: {
  unit: string;
  entry: PriceEntry;
  onChange: (next: PriceEntry) => void;
  idPrefix: string;
  /** "Add ingredient": no price typed is allowed (it is added as "no price yet"). */
  optional?: boolean;
}) {
  const reading = readPriceEntry(entry, unit);
  const choices = perChoices(unit);
  const set = (p: Partial<PriceEntry>) => onChange({ ...entry, ...p });
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2" role="group" aria-label="How it is bought">
        {choices.map((per: PricePer) => (
          <button
            key={per}
            type="button"
            aria-pressed={entry.per === per}
            disabled={entry.free}
            onClick={() => set({ per })}
            className={cn(
              'rounded-full border-2 px-3 py-1.5 text-xs font-semibold transition-colors disabled:opacity-50',
              entry.per === per ? 'border-amber-500 bg-amber-50 dark:bg-amber-950' : 'border-stone-200 hover:border-stone-300 dark:border-stone-700',
            )}
          >
            {per === 'pack' ? 'Per pack' : per === 'piece' ? 'Per piece' : `Per ${thousandWord(unit) ?? 'kg'}`}
          </button>
        ))}
      </div>
      <div className={cn('grid gap-3', entry.per === 'pack' ? 'grid-cols-2' : 'grid-cols-1')}>
        {entry.per === 'pack' && (
          <div>
            <label htmlFor={`${idPrefix}-pack`} className="mb-1 block text-xs uppercase tracking-wider text-stone-500">
              One pack holds ({unit})
            </label>
            <input
              id={`${idPrefix}-pack`}
              type="text"
              inputMode="numeric"
              value={entry.packSize}
              placeholder="e.g. 6000"
              disabled={entry.free}
              onChange={(e) => set({ packSize: e.target.value })}
              className="w-full rounded-lg border border-stone-300 px-3 py-2 font-mono disabled:opacity-50 dark:border-stone-700 dark:bg-stone-800"
            />
          </div>
        )}
        <div>
          <label htmlFor={`${idPrefix}-rupees`} className="mb-1 block text-xs uppercase tracking-wider text-stone-500">
            Price (Rs) {perLabel(entry.per, unit)}
          </label>
          <input
            id={`${idPrefix}-rupees`}
            type="text"
            inputMode="decimal"
            value={entry.free ? '0' : entry.rupees}
            placeholder={entry.per === 'pack' ? 'e.g. 2250' : 'e.g. 375'}
            disabled={entry.free}
            onChange={(e) => set({ rupees: e.target.value })}
            className="w-full rounded-lg border border-stone-300 px-3 py-2 font-mono text-lg disabled:opacity-50 dark:border-stone-700 dark:bg-stone-800"
          />
        </div>
      </div>
      <div className="flex flex-wrap gap-x-5 gap-y-1 text-sm">
        <label className="inline-flex items-center gap-2">
          <input type="checkbox" checked={entry.free} onChange={(e) => set({ free: e.target.checked, guess: e.target.checked ? false : entry.guess })} />
          Free (costs nothing)
        </label>
        <label className={cn('inline-flex items-center gap-2', entry.free && 'opacity-50')}>
          <input type="checkbox" checked={entry.guess} disabled={entry.free} onChange={(e) => set({ guess: e.target.checked })} />
          This price is a guess
        </label>
      </div>
      <p className={cn('text-xs', !reading.ok && !(reading.empty && optional) ? 'text-red-700 dark:text-red-400' : 'text-stone-500')} aria-live="polite">
        {reading.ok
          ? reading.free
            ? 'Counted as Rs 0 in every dish that uses it.'
            : `= ${formatUnitPrice(reading.unitCostMc, unit)}${reading.priceKind === 'estimate' ? ' (a guess: it stays on Costing → Missing costs until the real price is in)' : ''}`
          : reading.empty && optional
            ? 'No price yet: dishes that use it show "can\'t cost yet" on the Costing page until it has one.'
            : reading.problem}
      </p>
    </div>
  );
}

/**
 * In place of the price boxes for a batch made here whose inputs all have a
 * price (costing spec D4): its price is worked out from its batch recipe,
 * so it changes through what goes into it, or the recipe.
 */
export function WorkedOutFromRecipe({ name }: { name: string }) {
  return (
    <div className="flex gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
      <ChefHat className="mt-0.5 h-4 w-4 shrink-0" />
      <p>
        <strong>{name}</strong> is made here, so its price is worked out from its batch recipe, and it changes by itself when a
        price of what goes into it changes. To change it, set the price of what goes into it, or change its recipe (Inventory →
        Recipes → Batch recipes).
      </p>
    </div>
  );
}

/**
 * "Set price" for one ingredient: as it is bought, kept exactly, with a line
 * in its price history. Anything made from it here takes the new price at
 * once. Managers and the owner only (the till refuses anyone else).
 */
export function SetPriceDialog({ ingredient, onClose }: { ingredient: Ingredient; onClose: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [entry, setEntry] = useState<PriceEntry>(() => initialPriceEntry(ingredient));
  const reading = readPriceEntry(entry, ingredient.unit);
  const current = ingredient.latestPrice ?? null;
  const madeHere = ingredient.batchYield !== null;
  // Every input priced: its price is its batch recipe's (the till refuses a typed one too).
  const fromRecipe = ingredient.priceFromRecipe === true;

  const mut = useMutation({
    mutationFn: () => {
      if (!reading.ok) throw new Error(reading.problem);
      if (reading.free) {
        return ipc.inventory.setPrice({ ingredientId: ingredient.id, per: entry.per, priceCents: 0, priceKind: 'free' });
      }
      return ipc.inventory.setPrice({
        ingredientId: ingredient.id,
        per: entry.per,
        priceCents: reading.pack.priceCents,
        packSize: entry.per === 'pack' ? reading.pack.size : null,
        priceKind: reading.priceKind,
      });
    },
    onSuccess: (i) => {
      toast({ title: `${i.name}: price saved`, variant: 'success' });
      void qc.invalidateQueries({ queryKey: ['inventory'] });
      void qc.invalidateQueries({ queryKey: COSTING_KEY });
      onClose();
    },
    onError: (e) => toast({ title: 'Price not saved', description: e instanceof IpcError ? e.message : String(e), variant: 'error' }),
  });

  const change =
    reading.ok && !reading.free && current && current.unit === ingredient.unit
      ? priceChange(current.priceKind === 'unset' ? null : current.unitCostMc, reading.unitCostMc, reading.priceKind)
      : null;

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 max-h-[90vh] w-[460px] max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-xl bg-white p-5 shadow-xl dark:bg-stone-900">
          <header className="mb-3 flex items-center justify-between">
            <Dialog.Title className="text-lg font-bold">Set price: {ingredient.name}</Dialog.Title>
            <Dialog.Close asChild>
              <button type="button" aria-label="Close" className="rounded p-2 text-stone-500 hover:bg-stone-100 dark:hover:bg-stone-800">
                <X className="h-5 w-5" />
              </button>
            </Dialog.Close>
          </header>
          <Dialog.Description className="mb-4 rounded-lg bg-stone-100 p-3 text-sm dark:bg-stone-800">
            Now:{' '}
            <strong>
              {current
                ? priceText(current)
                : priceText({ unitCostMc: unitCostMc(effectivePack(ingredient)), unit: ingredient.unit, priceKind: ingredient.priceKind })}
            </strong>
            . Type it as you buy it — the till keeps it exactly (Rs 2,250 for 6 kg stays Rs 375 a kilo).
          </Dialog.Description>
          {fromRecipe ? (
            <>
              <WorkedOutFromRecipe name={ingredient.name} />
              <footer className="mt-5 flex justify-end gap-2">
                <Button variant="secondary" onClick={onClose}>
                  Close
                </Button>
              </footer>
            </>
          ) : (
            <>
              {madeHere && (
                <p className="mb-3 flex gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
                  <ChefHat className="mt-0.5 h-4 w-4 shrink-0" />
                  Made here, but something that goes into it has no price yet, so its cost can&apos;t be worked out from its batch
                  recipe. The price typed here is used until everything in it has one.
                </p>
              )}
              <PriceFields unit={ingredient.unit} entry={entry} onChange={setEntry} idPrefix="set-price" />
              {change && (
                <p className={cn('mt-2 text-sm font-semibold', change.tone === 'up' ? 'text-red-700 dark:text-red-400' : change.tone === 'down' ? 'text-emerald-700 dark:text-emerald-400' : 'text-stone-500')}>
                  {change.text} on the price now
                </p>
              )}
              <p className="mt-2 text-xs text-stone-500">Anything made here from it (a sauce, a mix) is re-priced at once.</p>
              <footer className="mt-5 flex justify-end gap-2">
                <Button variant="secondary" onClick={onClose}>
                  Cancel
                </Button>
                <Button variant="primary" disabled={mut.isPending || !reading.ok} onClick={() => mut.mutate()}>
                  {mut.isPending ? 'Saving…' : 'Save price'}
                </Button>
              </footer>
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
