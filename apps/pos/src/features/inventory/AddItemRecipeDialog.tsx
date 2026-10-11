/**
 * The recipe editor's "Add another item's recipe" (0.7.46; the owner, 12 Oct
 * 2026: "if the manager or anyone want to create new deals it should be able
 * to group the already listed products so the inventory ingredients and
 * recipes should be able to add easily … I don't have time to add [recipes]
 * one by one again"). Two ways:
 *  - One item: its recipe × how many (two Zinger Burgers), on every sale or
 *    under one of this item's choices, with any of its own choices' lines
 *    ticked (a pizza's "Size: Large");
 *  - A choice group, item by item: each choice of a deal's slot ("Deal: Large
 *    pizza: Fajita") takes its item's recipe under that choice; each box
 *    starts at the item of the same name (recipeFromItems itemForChoice).
 * The lines are COPIED into the recipe being edited and merged with what it
 * has; nothing is saved until the editor's Save recipe.
 */
import { useMemo, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useQueries, useQuery } from '@tanstack/react-query';
import { Button, cn } from '@cheeseoclock/ui';
import type { Ingredient, MenuItem } from '@cheeseoclock/shared-types';
import { X } from 'lucide-react';
import { ipc } from '../../ipc/client';
import { itemForChoice, linesFromItem, MAX_TIMES, type DraftLine } from './recipeFromItems';

interface ChoiceGroup {
  id: string;
  name: string;
  modifiers: ReadonlyArray<{ id: string; name: string }>;
}

type Mode = 'one' | 'group';

const selectClass = 'w-full rounded-lg border border-stone-300 px-2 py-2 text-sm dark:border-stone-700 dark:bg-stone-800';
const labelClass = 'mb-1 block text-xs font-semibold uppercase tracking-wider text-stone-500';

export function AddItemRecipeDialog({
  forItem,
  choices,
  groups,
  ingredients,
  onAdd,
  onClose,
}: {
  /** The item whose recipe is being edited (never offered as its own source). */
  forItem: MenuItem;
  /** This item's choices, for "Use it": "Deal: Large pizza: Fajita". */
  choices: ReadonlyArray<{ id: string; label: string }>;
  /** This item's choice groups, for "A choice group, item by item". */
  groups: ReadonlyArray<ChoiceGroup>;
  ingredients: ReadonlyArray<Ingredient> | undefined;
  /** The lines to add to the editor, and a few words for its toast. */
  onAdd: (lines: DraftLine[], summary: string) => void;
  onClose: () => void;
}) {
  const itemsQ = useQuery({ queryKey: ['menu', 'items', 'all'], queryFn: () => ipc.menu.listItems() });
  const countsQ = useQuery({ queryKey: ['inventory', 'recipeLineCounts'], queryFn: () => ipc.inventory.listRecipeLineCounts() });
  const lineCount = useMemo(() => new Map((countsQ.data ?? []).map((c) => [c.menuItemId, c.lineCount])), [countsQ.data]);
  // Every other item with a recipe to copy, A to Z.
  const sources = useMemo(
    () =>
      (itemsQ.data ?? [])
        .filter((i) => i.id !== forItem.id && (lineCount.get(i.id) ?? 0) > 0)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [itemsQ.data, lineCount, forItem.id],
  );
  const [mode, setMode] = useState<Mode>('one');
  const [times, setTimes] = useState(1);
  // One item.
  const [sourceId, setSourceId] = useState('');
  const [target, setTarget] = useState<string>('');
  const [withChoices, setWithChoices] = useState<Set<string>>(new Set());
  // A choice group, item by item: each choice's item ('' = none), started from the names.
  const [groupId, setGroupId] = useState(groups[0]?.id ?? '');
  const [picked, setPicked] = useState<Record<string, string>>({});
  const group = groups.find((g) => g.id === groupId) ?? null;
  const itemOfChoice = (choiceId: string, choiceName: string) => picked[choiceId] ?? itemForChoice(choiceName, sources) ?? '';

  // The recipes the dialog needs: the one item's, or every item a choice is matched to.
  const neededIds = mode === 'one' ? (sourceId ? [sourceId] : []) : [...new Set((group?.modifiers ?? []).map((m) => itemOfChoice(m.id, m.name)).filter(Boolean))];
  const recipeQs = useQueries({
    queries: neededIds.map((id) => ({ queryKey: ['inventory', 'recipe', id], queryFn: () => ipc.inventory.getRecipe(id) })),
  });
  const recipeOf = (id: string) => {
    const i = neededIds.indexOf(id);
    return i >= 0 ? (recipeQs[i]?.data ?? null) : null;
  };
  const loading = recipeQs.some((q) => q.isLoading);

  const ingName = (id: string) => ingredients?.find((x) => x.id === id)?.name ?? 'An ingredient';
  const ingUnit = (id: string) => ingredients?.find((x) => x.id === id)?.unit ?? '';
  const itemName = (id: string) => sources.find((i) => i.id === id)?.name ?? '';

  const sourceRecipe = sourceId ? recipeOf(sourceId) : null;
  // The source's own choices with lines ("Size: Large"), each once.
  const sourceChoices = useMemo(() => {
    const seen = new Map<string, string>();
    for (const l of sourceRecipe ?? []) if (l.modifierId && !seen.has(l.modifierId)) seen.set(l.modifierId, l.modifierName ?? 'A choice');
    return [...seen.entries()].map(([id, name]) => ({ id, name }));
  }, [sourceRecipe]);

  const toDraft = (rows: ReadonlyArray<{ ingredientId: string; qtyPerUnit: number; modifierId: string | null }>): DraftLine[] =>
    rows.map((l) => ({ ingredientId: l.ingredientId, qtyPerUnit: l.qtyPerUnit, modifierId: l.modifierId }));

  // What Add puts in, worked out as the boxes change (a few lines: no need to keep it between renders).
  const plan = ((): { lines: DraftLine[]; summary: string; parts: Array<{ label: string; lines: DraftLine[] }> } => {
    if (mode === 'one') {
      if (!sourceRecipe) return { lines: [], summary: '', parts: [] };
      const lines = linesFromItem(toDraft(sourceRecipe), { times, withChoices, target: target || null });
      const when = target ? ` with ${choices.find((c) => c.id === target)?.label ?? 'a choice'}` : '';
      return { lines, summary: `${itemName(sourceId)} × ${times}${when}`, parts: [{ label: `${itemName(sourceId)} × ${times}`, lines }] };
    }
    const parts: Array<{ label: string; lines: DraftLine[] }> = [];
    for (const m of group?.modifiers ?? []) {
      const id = itemOfChoice(m.id, m.name);
      const r = id ? recipeOf(id) : null;
      if (!r) continue;
      parts.push({ label: `${m.name} ← ${itemName(id)}${times > 1 ? ` × ${times}` : ''}`, lines: linesFromItem(toDraft(r), { times, target: m.id }) });
    }
    return { lines: parts.flatMap((p) => p.lines), summary: `${parts.length} choices of ${group?.name ?? 'the group'}`, parts };
  })();

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-black/40 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-[60] flex max-h-[88vh] w-[640px] max-w-[95vw] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl bg-white shadow-xl dark:bg-stone-900">
          <header className="flex items-start justify-between gap-3 border-b border-stone-200 p-5 dark:border-stone-800">
            <div>
              <Dialog.Title className="text-lg font-bold">Add another item&rsquo;s recipe</Dialog.Title>
              <Dialog.Description className="mt-0.5 text-xs text-stone-500">
                Its ingredients are copied into {forItem.name}&rsquo;s recipe — check them, then Save recipe. Changing that
                item&rsquo;s recipe later does not change this one.
              </Dialog.Description>
            </div>
            <button type="button" onClick={onClose} aria-label="Close" className="rounded p-2 text-stone-500 hover:bg-stone-100 dark:hover:bg-stone-800">
              <X className="h-5 w-5" />
            </button>
          </header>

          <div className="flex-1 space-y-4 overflow-auto p-5">
            {groups.length > 0 && (
              <div className="flex flex-wrap gap-2" role="group" aria-label="How to add">
                {(
                  [
                    ['one', 'One item'],
                    ['group', 'A choice group, item by item'],
                  ] as const
                ).map(([m, label]) => (
                  <button
                    key={m}
                    type="button"
                    aria-pressed={mode === m}
                    onClick={() => setMode(m)}
                    className={cn(
                      'rounded-lg border-2 px-3 py-1.5 text-sm font-semibold',
                      mode === m ? 'border-amber-500 bg-amber-50 dark:bg-amber-950' : 'border-stone-200 dark:border-stone-700',
                    )}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}

            {mode === 'one' ? (
              <>
                <div className="grid grid-cols-1 gap-3 md:grid-cols-[1fr_7rem]">
                  <label className="block">
                    <span className={labelClass}>Which item</span>
                    <select
                      value={sourceId}
                      onChange={(e) => {
                        setSourceId(e.target.value);
                        setWithChoices(new Set());
                      }}
                      aria-label="Which item's recipe"
                      className={selectClass}
                    >
                      <option value="">Pick an item with a recipe…</option>
                      {sources.map((i) => (
                        <option key={i.id} value={i.id}>
                          {i.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="block">
                    <span className={labelClass}>How many</span>
                    <input
                      type="number"
                      min={1}
                      max={MAX_TIMES}
                      value={times}
                      onChange={(e) => setTimes(Math.max(1, Math.min(MAX_TIMES, parseInt(e.target.value, 10) || 1)))}
                      aria-label="How many of it"
                      className={cn(selectClass, 'text-right font-mono')}
                    />
                  </label>
                </div>
                <label className="block">
                  <span className={labelClass}>Use it</span>
                  <select value={target} onChange={(e) => setTarget(e.target.value)} aria-label="When it is used" className={selectClass}>
                    <option value="">On every sale</option>
                    {choices.map((c) => (
                      <option key={c.id} value={c.id}>
                        Only if {c.label}
                      </option>
                    ))}
                  </select>
                </label>
                {sourceChoices.length > 0 && (
                  <div>
                    <span className={labelClass}>Also its lines for</span>
                    <div className="flex flex-wrap gap-2">
                      {sourceChoices.map((c) => (
                        <label key={c.id} className="flex items-center gap-1.5 rounded-lg border border-stone-200 px-2 py-1 text-sm dark:border-stone-700">
                          <input
                            type="checkbox"
                            checked={withChoices.has(c.id)}
                            onChange={() =>
                              setWithChoices((prev) => {
                                const next = new Set(prev);
                                if (next.has(c.id)) next.delete(c.id);
                                else next.add(c.id);
                                return next;
                              })
                            }
                          />
                          {c.name}
                        </label>
                      ))}
                    </div>
                    <p className="mt-1 text-xs text-stone-500">Tick a size or an extra that is always part of this one.</p>
                  </div>
                )}
              </>
            ) : (
              <>
                <div className="grid grid-cols-1 gap-3 md:grid-cols-[1fr_7rem]">
                  <label className="block">
                    <span className={labelClass}>Choice group</span>
                    <select value={groupId} onChange={(e) => setGroupId(e.target.value)} aria-label="Which choice group" className={selectClass}>
                      {groups.map((g) => (
                        <option key={g.id} value={g.id}>
                          {g.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="block">
                    <span className={labelClass}>How many each</span>
                    <input
                      type="number"
                      min={1}
                      max={MAX_TIMES}
                      value={times}
                      onChange={(e) => setTimes(Math.max(1, Math.min(MAX_TIMES, parseInt(e.target.value, 10) || 1)))}
                      aria-label="How many of each choice's item"
                      className={cn(selectClass, 'text-right font-mono')}
                    />
                  </label>
                </div>
                <div className="space-y-2" data-testid="choice-items">
                  {(group?.modifiers ?? []).map((m) => (
                    <label key={m.id} className="grid grid-cols-[10rem_1fr] items-center gap-2 text-sm">
                      <span className="truncate font-medium" title={m.name}>
                        {m.name}
                      </span>
                      <select
                        value={itemOfChoice(m.id, m.name)}
                        onChange={(e) => setPicked((p) => ({ ...p, [m.id]: e.target.value }))}
                        aria-label={`The item for ${m.name}`}
                        className={selectClass}
                      >
                        <option value="">Nothing for this choice</option>
                        {sources.map((i) => (
                          <option key={i.id} value={i.id}>
                            {i.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  ))}
                </div>
                <p className="text-xs text-stone-500">Each choice gets its item&rsquo;s recipe, used only when that choice is picked at the till.</p>
              </>
            )}

            {plan.parts.length > 0 && (
              <div className="rounded-lg bg-stone-50 p-3 text-sm dark:bg-stone-800/60" data-testid="add-preview">
                <div className="mb-1 text-xs font-semibold uppercase tracking-wider text-stone-500">What it adds</div>
                {plan.parts.map((p) => (
                  <div key={p.label} className="mb-2 last:mb-0">
                    <div className="font-medium">{p.label}</div>
                    <ul className="text-xs text-stone-600 dark:text-stone-300">
                      {p.lines.map((l) => (
                        <li key={`${l.ingredientId}|${l.modifierId ?? ''}`}>
                          {l.qtyPerUnit} {ingUnit(l.ingredientId)} {ingName(l.ingredientId)}
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            )}
            {sources.length === 0 && itemsQ.isSuccess && (
              <p className="text-sm text-stone-500">No other item has a recipe yet: add those first, then build the deal from them.</p>
            )}
          </div>

          <footer className="flex justify-end gap-2 border-t border-stone-200 p-5 dark:border-stone-800">
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" disabled={loading || plan.lines.length === 0} onClick={() => onAdd(plan.lines, plan.summary)}>
              Add to the recipe
            </Button>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
