import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import * as Dialog from '@radix-ui/react-dialog';
import { Button, cn } from '@cheeseoclock/ui';
import { formatCents } from '@cheeseoclock/pos-domain';
import { ipc } from '../../ipc/client';
import type { MenuItem } from '@cheeseoclock/shared-types';
import { X } from 'lucide-react';

interface Props {
  item: MenuItem;
  onCancel: () => void;
  onConfirm: (modifierIds: string[]) => void | Promise<void>;
}

export function ModifierModal({ item, onCancel, onConfirm }: Props) {
  const groupsQ = useQuery({
    queryKey: ['menu', 'modifierGroupsForItem', item.id],
    queryFn: () => ipc.menu.listModifierGroupsForItem(item.id),
  });

  /** Map of groupId → selected modifier ids */
  const [selected, setSelected] = useState<Record<string, string[]>>({});

  // Seed defaults once the groups load
  useEffect(() => {
    if (!groupsQ.data) return;
    const next: Record<string, string[]> = {};
    for (const g of groupsQ.data) {
      next[g.id] = g.modifiers.filter((m) => m.isDefault).map((m) => m.id);
    }
    setSelected(next);
  }, [groupsQ.data]);

  function toggle(groupId: string, modId: string, selectionType: 'single' | 'multi', maxSelect: number) {
    setSelected((prev) => {
      const current = prev[groupId] ?? [];
      const isSelected = current.includes(modId);
      let next: string[];
      if (selectionType === 'single') {
        next = isSelected ? [] : [modId];
      } else {
        if (isSelected) next = current.filter((id) => id !== modId);
        else if (current.length < maxSelect) next = [...current, modId];
        else next = current;
      }
      return { ...prev, [groupId]: next };
    });
  }

  const groups = groupsQ.data ?? [];

  // Validation: required groups need at least minSelect
  const errors = groups
    .filter((g) => g.isRequired && (selected[g.id]?.length ?? 0) < g.minSelect)
    .map((g) => `Choose ${g.minSelect}+ for ${g.name}`);
  const allValid = errors.length === 0;

  // Compute running price
  const allMods = groups.flatMap((g) => g.modifiers);
  const selectedMods = Object.values(selected).flat();
  const deltaTotal = selectedMods.reduce((sum, id) => {
    const m = allMods.find((x) => x.id === id);
    return sum + (m?.priceDeltaCents ?? 0);
  }, 0);

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onCancel()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 flex max-h-[80vh] w-[640px] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl bg-white shadow-xl dark:bg-stone-900">
          <header className="flex items-start justify-between border-b border-stone-200 p-5 dark:border-stone-800">
            <div>
              <Dialog.Title className="text-xl font-bold">{item.name}</Dialog.Title>
              {item.description && (
                <Dialog.Description className="mt-1 text-sm text-stone-500">
                  {item.description}
                </Dialog.Description>
              )}
            </div>
            <Dialog.Close asChild>
              <button
                type="button"
                className="rounded p-2 text-stone-500 hover:bg-stone-100 dark:hover:bg-stone-800"
              >
                <X className="h-5 w-5" />
              </button>
            </Dialog.Close>
          </header>

          <div className="flex-1 overflow-auto p-5">
            {groups.length === 0 ? (
              <div className="text-stone-500">No modifiers to choose.</div>
            ) : (
              groups.map((g) => (
                <section key={g.id} className="mb-6">
                  <div className="mb-2 flex items-baseline justify-between">
                    <h3 className="font-semibold">
                      {g.name}
                      {g.isRequired && <span className="ml-1 text-red-500">*</span>}
                    </h3>
                    <span className="text-xs text-stone-500">
                      {g.selectionType === 'single'
                        ? 'Choose 1'
                        : `Choose ${g.minSelect}-${g.maxSelect}`}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {g.modifiers.map((m) => {
                      const sel = (selected[g.id] ?? []).includes(m.id);
                      return (
                        <button
                          key={m.id}
                          type="button"
                          onClick={() =>
                            toggle(g.id, m.id, g.selectionType, g.maxSelect)
                          }
                          className={cn(
                            'flex items-center justify-between rounded-lg border-2 p-3 text-left transition-colors',
                            sel
                              ? 'border-amber-500 bg-amber-50 dark:bg-amber-950'
                              : 'border-stone-200 bg-white hover:border-stone-300 dark:border-stone-700 dark:bg-stone-800',
                          )}
                        >
                          <span className="font-medium">{m.name}</span>
                          {m.priceDeltaCents !== 0 && (
                            <span className="font-mono text-sm text-stone-500">
                              {m.priceDeltaCents > 0 ? '+' : ''}
                              {formatCents(m.priceDeltaCents, { showSymbol: false })}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                </section>
              ))
            )}
          </div>

          <footer className="flex items-center justify-between border-t border-stone-200 p-5 dark:border-stone-800">
            <div>
              <div className="text-xs text-stone-500">Item total</div>
              <div className="font-mono text-xl font-bold">
                {formatCents(item.basePriceCents + deltaTotal)}
              </div>
              {errors.length > 0 && (
                <div className="mt-1 text-xs text-red-500">{errors[0]}</div>
              )}
            </div>
            <div className="flex gap-2">
              <Button variant="secondary" onClick={onCancel}>
                Cancel
              </Button>
              <Button
                variant="primary"
                disabled={!allValid}
                onClick={() => void onConfirm(selectedMods)}
              >
                Add to order
              </Button>
            </div>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
