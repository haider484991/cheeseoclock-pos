import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import * as Dialog from '@radix-ui/react-dialog';
import { Button } from '@cheeseoclock/ui';
import { kitchenQty } from '@cheeseoclock/pos-domain';
import type { Ingredient } from '@cheeseoclock/shared-types';
import { Calculator, Soup, X } from 'lucide-react';
import { ipc } from '../../ipc/client';
import { SearchBox, compareText, matchesSearch } from '../../components/list';
import { BatchCalculatorDialog } from './BatchCalculator';

/**
 * "Batch calculator" (owner, 2026-09-27: "I want the batch calculator to
 * show"): one button, on Inventory → Recipes and in the recipe calculator,
 * that asks which sauce, dough or mix and opens the batch calculator for it
 * — no more hunting for the card's "Make / calculate". Picking one moves no
 * stock; only the calculator's Make button does.
 */
export function BatchCalculatorButton({
  variant = 'primary',
  size = 'sm',
  className,
}: {
  variant?: 'primary' | 'secondary';
  size?: 'sm' | 'md';
  className?: string;
}) {
  const [picking, setPicking] = useState(false);
  const [chosen, setChosen] = useState<Ingredient | null>(null);
  return (
    <>
      <Button variant={variant} size={size} className={className} onClick={() => setPicking(true)}>
        <Calculator className="h-4 w-4" /> Batch calculator
      </Button>
      {picking && (
        <BatchPickerDialog
          onClose={() => setPicking(false)}
          onPick={(i) => {
            setPicking(false);
            setChosen(i);
          }}
        />
      )}
      {chosen && <BatchCalculatorDialog key={chosen.id} ingredient={chosen} onClose={() => setChosen(null)} />}
    </>
  );
}

/** Which batch recipe: searchable, each with what one batch makes and the stock here. */
export function BatchPickerDialog({ onPick, onClose }: { onPick: (ingredient: Ingredient) => void; onClose: () => void }) {
  const ingredientsQ = useQuery({
    queryKey: ['inventory', 'ingredients', 'all'],
    queryFn: () => ipc.inventory.listIngredients(),
  });
  const [query, setQuery] = useState('');
  const batches = useMemo(
    () =>
      (ingredientsQ.data ?? [])
        .filter((i) => i.batchYield !== null)
        .sort((a, b) => compareText(a.name, b.name)),
    [ingredientsQ.data],
  );
  const shown = batches.filter((b) => matchesSearch(b.name, query));

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[85vh] w-[560px] max-w-[95vw] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl bg-white shadow-xl dark:bg-stone-900">
          <header className="flex items-start justify-between border-b border-stone-200 p-5 dark:border-stone-800">
            <div>
              <Dialog.Title className="text-lg font-bold">Batch calculator</Dialog.Title>
              <Dialog.Description className="text-sm text-stone-500">
                Which sauce, dough or mix? Then type any amount to see what it takes.
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button type="button" aria-label="Close" className="rounded p-2 text-stone-500 hover:bg-stone-100 dark:hover:bg-stone-800">
                <X className="h-5 w-5" />
              </button>
            </Dialog.Close>
          </header>
          <div className="border-b border-stone-200 p-3 dark:border-stone-800">
            <SearchBox value={query} onChange={setQuery} placeholder="Search batch recipes…" label="Search batch recipes" autoFocus hotkey={false} />
          </div>
          <ul className="flex-1 divide-y divide-stone-100 overflow-auto dark:divide-stone-800">
            {shown.map((b) => (
              <li key={b.id}>
                <button
                  type="button"
                  onClick={() => onPick(b)}
                  className="flex w-full items-center gap-3 px-5 py-3 text-left hover:bg-amber-50 dark:hover:bg-amber-950/30"
                >
                  <Soup className="h-5 w-5 flex-none text-amber-600" />
                  <span className="min-w-0 flex-1">
                    <span className="block font-semibold">{b.name}</span>
                    <span className="block text-xs text-stone-500">
                      One batch makes {b.batchYield ? kitchenQty(b.batchYield, b.unit) : '?'} · in stock here {kitchenQty(b.currentQty, b.unit)}
                    </span>
                  </span>
                </button>
              </li>
            ))}
            {shown.length === 0 && (
              <li className="px-5 py-8 text-center text-sm text-stone-500">
                {ingredientsQ.isLoading
                  ? 'Loading…'
                  : batches.length === 0
                    ? 'No batch recipes yet: add one in Inventory → Recipes → Batch recipes.'
                    : 'No batch recipe matches.'}
              </li>
            )}
          </ul>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
