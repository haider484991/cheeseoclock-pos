import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import * as Dialog from '@radix-ui/react-dialog';
import { Button, cn } from '@cheeseoclock/ui';
import { formatCents } from '@cheeseoclock/pos-domain';
import { ipc } from '../../ipc/client';
import type { MenuItem } from '@cheeseoclock/shared-types';
import { groupDisplayName, isLeaveOutChoice } from '@cheeseoclock/shared-types';
import { X } from 'lucide-react';
import { ownsEnter } from './keys';

interface Props {
  item: MenuItem;
  onCancel: () => void;
  /**
   * `onlyOne`: when customising a line of several, the cashier chose to change
   * just one of them (it becomes its own line) instead of all of them.
   */
  onConfirm: (modifierIds: string[], notes: string | null, opts?: { onlyOne: boolean }) => void | Promise<void>;
  /** Editing a line already in the cart ("Customize"): its current choices and note. */
  initialModifierIds?: string[];
  initialNotes?: string | null;
  confirmLabel?: string;
  /** Customising a cart line: how many are on it (offers "just one of them"). */
  lineQuantity?: number;
}

/**
 * The item's choices — required ones (dip, veggies, deal pizzas), then the
 * optional ones: leave-outs, extras, dips on the side — plus an "allergy or
 * special request" note that prints on the kitchen ticket (owner 2026-09-26).
 *
 * Speed: an item whose only choice is one pick from one list (a dip) adds the
 * moment that pick is tapped. Enter confirms (Shift+Enter for a new line in
 * the note).
 */
export function ModifierModal({
  item,
  onCancel,
  onConfirm,
  initialModifierIds,
  initialNotes,
  confirmLabel = 'Add to order',
  lineQuantity = 1,
}: Props) {
  const [notes, setNotes] = useState(initialNotes ?? '');
  const [onlyOne, setOnlyOne] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const confirmed = useRef(false);
  const groupsQ = useQuery({
    queryKey: ['menu', 'modifierGroupsForItem', item.id],
    queryFn: () => ipc.menu.listModifierGroupsForItem(item.id),
    staleTime: 5 * 60_000,
  });

  /** Map of groupId → selected modifier ids */
  const [selected, setSelected] = useState<Record<string, string[]>>({});

  // Seed once the groups load: the line's current choices when editing, the
  // defaults when adding.
  // Once only: the caller rebuilds initialModifierIds on every render, and
  // re-seeding would undo each tap.
  const seeded = useRef(false);
  useEffect(() => {
    if (!groupsQ.data || seeded.current) return;
    seeded.current = true;
    const next: Record<string, string[]> = {};
    for (const g of groupsQ.data) {
      next[g.id] = initialModifierIds
        ? g.modifiers.filter((m) => initialModifierIds.includes(m.id)).map((m) => m.id)
        : g.modifiers.filter((m) => m.isDefault).map((m) => m.id);
    }
    setSelected(next);
  }, [groupsQ.data, initialModifierIds]);

  const groups = groupsQ.data ?? [];
  const editing = initialModifierIds !== undefined;
  // One required pick from one list and nothing else to choose: the tap on
  // that pick is the confirmation.
  const onePickAdds =
    !editing && groups.length === 1 && groups[0]!.isRequired && groups[0]!.selectionType === 'single';

  function confirm(modifierIds: string[]) {
    // One confirmation per modal: a double tap or Enter + click must not add twice.
    if (confirmed.current) return;
    confirmed.current = true;
    void onConfirm(modifierIds, notes.trim() || null, { onlyOne: editing && lineQuantity > 1 && onlyOne });
  }

  function toggle(groupId: string, modId: string, selectionType: 'single' | 'multi', maxSelect: number) {
    if (onePickAdds && selectionType === 'single') {
      confirm([modId]);
      return;
    }
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

  // Validation: required groups need at least minSelect
  const errors = groups
    .filter((g) => g.isRequired && (selected[g.id]?.length ?? 0) < g.minSelect)
    .map((g) => `Pick ${g.minSelect - (selected[g.id]?.length ?? 0)} more for ${groupDisplayName(g.name)}`);
  const allValid = errors.length === 0 && !groupsQ.isLoading;

  // Compute running price
  const allMods = groups.flatMap((g) => g.modifiers);
  const selectedMods = Object.values(selected).flat();
  const deltaTotal = selectedMods.reduce((sum, id) => {
    const m = allMods.find((x) => x.id === id);
    return sum + (m?.priceDeltaCents ?? 0);
  }, 0);

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key !== 'Enter' || e.shiftKey) return;
    const target = e.target as HTMLElement;
    // A button reached with Tab does its own thing (a choice toggles, Cancel
    // cancels). One that was just tapped does not: Enter means "add it".
    if (target.tagName === 'BUTTON' && ownsEnter(target)) return;
    e.preventDefault();
    if (allValid) confirm(selectedMods);
  }

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onCancel()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content
          ref={contentRef}
          onKeyDown={onKeyDown}
          // Not the Close button (Radix's default): Enter there would cancel.
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            contentRef.current?.focus();
          }}
          {...(item.description ? {} : { 'aria-describedby': undefined })}
          className="fixed left-1/2 top-1/2 z-50 flex max-h-[calc(100dvh-24px)] w-[640px] max-w-[calc(100vw-24px)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl bg-white shadow-xl outline-none dark:bg-stone-900 dark:text-stone-100"
        >
          <header className="flex items-start justify-between border-b border-stone-200 p-5 dark:border-stone-800">
            <div>
              <Dialog.Title className="text-xl font-bold">{item.name}</Dialog.Title>
              {item.description && (
                <Dialog.Description className="mt-1 text-sm text-stone-500">
                  {item.description}
                </Dialog.Description>
              )}
              {onePickAdds && (
                <p className="mt-1 text-sm font-semibold text-amber-700 dark:text-amber-400">
                  Tap a choice to add it.
                </p>
              )}
            </div>
            <Dialog.Close asChild>
              <button
                type="button"
                aria-label="Close"
                className="grid h-10 w-10 shrink-0 place-items-center rounded-lg text-stone-500 hover:bg-stone-100 dark:hover:bg-stone-800"
              >
                <X className="h-5 w-5" />
              </button>
            </Dialog.Close>
          </header>

          <div className="flex-1 overflow-auto p-5">
            {editing && lineQuantity > 1 && (
              <div className="mb-5 grid grid-cols-2 gap-1 rounded-xl bg-stone-100 p-1 dark:bg-stone-800" role="group" aria-label="Which ones to change">
                {[false, true].map((one) => (
                  <button
                    key={String(one)}
                    type="button"
                    aria-pressed={onlyOne === one}
                    onClick={() => setOnlyOne(one)}
                    className={cn(
                      'min-h-[44px] rounded-lg text-sm font-semibold',
                      onlyOne === one
                        ? 'bg-white text-stone-900 shadow-sm dark:bg-stone-900 dark:text-stone-100'
                        : 'text-stone-500',
                    )}
                  >
                    {one ? `Just 1 of the ${lineQuantity}` : `All ${lineQuantity}`}
                  </button>
                ))}
              </div>
            )}
            {groups.map((g) => (
              <section key={g.id} className="mb-6">
                <div className="mb-2 flex items-baseline justify-between">
                  <h3 className="font-semibold">
                    {groupDisplayName(g.name)}
                    {g.isRequired && <span className="ml-1 text-red-500">*</span>}
                  </h3>
                  <span className="text-xs text-stone-500">
                    {g.selectionType === 'single'
                      ? 'Choose 1'
                      : `${
                          g.minSelect === g.maxSelect
                            ? `Choose ${g.minSelect}`
                            : g.minSelect === 0
                              ? `Up to ${g.maxSelect}`
                              : `Choose ${g.minSelect}-${g.maxSelect}`
                        } · ${selected[g.id]?.length ?? 0} chosen`}
                  </span>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {g.modifiers.map((m) => {
                    const sel = (selected[g.id] ?? []).includes(m.id);
                    return (
                      <button
                        key={m.id}
                        type="button"
                        aria-pressed={sel}
                        onClick={() => toggle(g.id, m.id, g.selectionType, g.maxSelect)}
                        className={cn(
                          'flex min-h-[52px] items-center justify-between rounded-lg border-2 p-3 text-left transition-colors',
                          sel && isLeaveOutChoice(m.name)
                            ? 'border-red-500 bg-red-50 text-red-800 dark:bg-red-950 dark:text-red-100'
                            : sel
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
            ))}
            <label className="block">
              <span className="mb-1 block font-semibold">Allergy or special request</span>
              <span className="mb-2 block text-xs text-stone-500">
                Prints on the kitchen ticket for this item. For an allergy, write it here (e.g. &ldquo;nut
                allergy&rdquo;).
              </span>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value.slice(0, 300))}
                rows={2}
                maxLength={300}
                placeholder="e.g. peanut allergy, well done, cut in 8"
                className="w-full rounded-lg border-2 border-stone-200 p-3 text-sm focus:border-amber-400 focus:outline-none dark:border-stone-700 dark:bg-stone-800"
              />
            </label>
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
              <Button variant="secondary" size="lg" onClick={onCancel}>
                Cancel
              </Button>
              <Button variant="primary" size="lg" disabled={!allValid} onClick={() => confirm(selectedMods)}>
                {confirmLabel}
              </Button>
            </div>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
