import { useCallback, useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import * as Dialog from '@radix-ui/react-dialog';
import { Button, Card, cn } from '@cheeseoclock/ui';
import { formatCents } from '@cheeseoclock/pos-domain';
import { ipc, IpcError } from '../../ipc/client';
import { useToast } from '../../components/toast/ToastProvider';
import type { Modifier, ModifierGroup, ModifierSelectionType } from '@cheeseoclock/shared-types';
import { Plus, Edit, Trash2, X, ChevronDown, ChevronRight } from 'lucide-react';
import { askConfirm } from '../../components/confirm/ConfirmHost';
import {
  FilterChips,
  Pagination,
  SearchBox,
  compareText,
  countBy,
  useListQuery,
  useSessionState,
  type ChipOption,
  type ChipTone,
} from '../../components/list';
import {
  GROUP_KIND_LABEL,
  groupItemName,
  modifierGroupKind,
  modifierGroupSearchText,
  type GroupKind,
} from './menuLists';

type GroupWithOptions = ModifierGroup & { modifiers: Modifier[] };
type KindFilter = 'all' | GroupKind;

const KIND_ORDER: Record<GroupKind, number> = { required: 0, extras: 1, 'leave-out': 2 };
const KIND_TONE: Record<GroupKind, ChipTone> = { required: 'amber', extras: 'blue', 'leave-out': 'red' };
const KIND_HELP: Record<GroupKind, string> = {
  required: 'The till asks for these before the item goes on the order (a dip, a deal’s pizzas).',
  extras: 'Optional add-ons the customer can ask for, usually with a price.',
  'leave-out': '“No onion”-style choices, one group per item. Picked under Customize on the order line.',
};

/** "Choose 1", "Up to 3", "Pick exactly 5", "1 to 3". */
function selectionText(g: ModifierGroup): string {
  if (g.selectionType === 'single') return g.isRequired || g.minSelect > 0 ? 'Pick 1' : 'Pick 1 (optional)';
  if (g.minSelect === 0) return `Up to ${g.maxSelect}`;
  if (g.minSelect === g.maxSelect) return `Pick exactly ${g.minSelect}`;
  return `${g.minSelect} to ${g.maxSelect}`;
}

export function ModifiersTab() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const q = useQuery({
    queryKey: ['menu', 'modifierGroups'],
    queryFn: () => ipc.menu.listModifierGroups(),
  });
  const [kind, setKind] = useSessionState<KindFilter>('menu.groups.kind', 'all');
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [editingGroup, setEditingGroup] = useState<ModifierGroup | null | 'new'>(null);
  const [editingMod, setEditingMod] = useState<{ group: GroupWithOptions; mod: Modifier | null } | null>(null);

  const deleteGroupMut = useMutation({
    mutationFn: (id: string) => ipc.menu.deleteModifierGroup(id),
    onSuccess: () => {
      toast({ title: 'Group removed', variant: 'success' });
      void qc.invalidateQueries({ queryKey: ['menu'] });
    },
    onError: (e) =>
      toast({
        title: 'Cannot delete',
        description: e instanceof IpcError ? e.message : String(e),
        variant: 'error',
      }),
  });

  const deleteModMut = useMutation({
    mutationFn: (id: string) => ipc.menu.deleteModifier(id),
    onSuccess: () => {
      toast({ title: 'Option removed', variant: 'success' });
      void qc.invalidateQueries({ queryKey: ['menu'] });
    },
    onError: (e) =>
      toast({
        title: 'Cannot delete',
        description: e instanceof IpcError ? e.message : String(e),
        variant: 'error',
      }),
  });

  const filter = useCallback((g: GroupWithOptions) => kind === 'all' || modifierGroupKind(g) === kind, [kind]);
  // Grouped by kind, then by the item a per-item group is for, then by name.
  const sort = useCallback(
    (a: GroupWithOptions, b: GroupWithOptions) =>
      KIND_ORDER[modifierGroupKind(a)] - KIND_ORDER[modifierGroupKind(b)] ||
      compareText(groupItemName(a.name) ?? a.name, groupItemName(b.name) ?? b.name),
    [],
  );
  const list = useListQuery({
    items: q.data,
    searchText: modifierGroupSearchText,
    filter,
    sort,
    persistKey: 'menu.groups',
    resetPageOn: kind,
  });

  const counts = useMemo(() => countBy(list.searched, (g) => modifierGroupKind(g)), [list.searched]);
  const kindOptions: ChipOption<KindFilter>[] = [
    { id: 'all', label: 'All', count: list.searched.length },
    ...(['required', 'extras', 'leave-out'] as const).map((k) => ({
      id: k,
      label: GROUP_KIND_LABEL[k],
      count: counts[k] ?? 0,
      tone: KIND_TONE[k],
    })),
  ];

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <Card>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-semibold">Choice groups</h2>
          <p className="text-xs text-stone-500">
            Dips, extras and leave-outs that attach to items. Attach a group to an item from the item’s Edit screen.
          </p>
        </div>
        <Button variant="primary" size="sm" onClick={() => setEditingGroup('new')}>
          <Plus className="h-4 w-4" /> Add group
        </Button>
      </div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <SearchBox
          value={list.query}
          onChange={list.setQuery}
          placeholder="Search a group, item or option (e.g. fajita, onion)…"
          label="Search choice groups"
        />
        <FilterChips label="Kind of group" options={kindOptions} value={kind} onChange={setKind} />
      </div>
      {kind !== 'all' && <p className="mb-2 text-xs text-stone-500">{KIND_HELP[kind]}</p>}

      <div className="space-y-2">
        {list.items.map((g, idx) => {
          const k = modifierGroupKind(g);
          const prev = list.items[idx - 1];
          const heading = !prev || modifierGroupKind(prev) !== k;
          const forItem = groupItemName(g.name);
          const open = expanded.has(g.id);
          return (
            <div key={g.id}>
              {heading && (
                <h3 className="mb-1 mt-3 text-xs font-semibold uppercase tracking-wider text-stone-500 first:mt-0">
                  {GROUP_KIND_LABEL[k]}
                </h3>
              )}
              <div className="rounded-lg border border-stone-200 dark:border-stone-800">
                <div className="flex items-center gap-3 p-3 hover:bg-stone-50 dark:hover:bg-stone-800">
                  <button
                    type="button"
                    onClick={() => toggle(g.id)}
                    aria-expanded={open}
                    className="flex min-w-0 flex-1 items-center gap-3 text-left"
                  >
                    {open ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium">
                        {forItem ? (
                          <>
                            <span className="text-stone-500">{g.name.slice(0, g.name.indexOf(' · '))} · </span>
                            {forItem}
                          </>
                        ) : (
                          g.name
                        )}
                        {(g.isRequired || g.minSelect > 0) && (
                          <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-900 dark:bg-amber-950 dark:text-amber-200">
                            required
                          </span>
                        )}
                      </span>
                      <span className="block truncate text-xs text-stone-500">
                        {selectionText(g)} · {g.modifiers.length} option{g.modifiers.length === 1 ? '' : 's'}
                        {!open && g.modifiers.length > 0 && (
                          <>
                            {' — '}
                            {g.modifiers.slice(0, 4).map((m) => m.name).join(', ')}
                            {g.modifiers.length > 4 ? '…' : ''}
                          </>
                        )}
                      </span>
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditingGroup(g)}
                    className="rounded p-1 text-stone-500 hover:bg-stone-200 dark:hover:bg-stone-700"
                    aria-label={`Edit group ${g.name}`}
                    title="Edit group"
                  >
                    <Edit className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      void askConfirm(
                        `Delete group "${g.name}"? Items using it lose these choices. Past orders keep theirs.`,
                      ).then((ok) => {
                        if (ok) deleteGroupMut.mutate(g.id);
                      });
                    }}
                    className="rounded p-1 text-red-500 hover:bg-red-50 dark:hover:bg-red-950"
                    aria-label={`Delete group ${g.name}`}
                    title="Delete group"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>

                {open && (
                  <div className="border-t border-stone-200 p-3 dark:border-stone-800">
                    <div className="mb-2 flex items-center justify-between">
                      <div className="text-xs uppercase tracking-wider text-stone-500">Options</div>
                      <Button variant="secondary" size="sm" onClick={() => setEditingMod({ group: g, mod: null })}>
                        <Plus className="h-3 w-3" /> Add option
                      </Button>
                    </div>
                    {g.modifiers.length === 0 ? (
                      <div className="text-sm text-stone-500">No options yet.</div>
                    ) : (
                      <table className="w-full text-sm">
                        <tbody>
                          {g.modifiers.map((m) => (
                            <tr key={m.id} className="border-t border-stone-100 dark:border-stone-700">
                              <td className="py-2">{m.name}</td>
                              <td className="py-2 text-stone-500">
                                {m.isDefault && (
                                  <span className="rounded bg-blue-100 px-2 py-0.5 text-xs text-blue-800 dark:bg-blue-950 dark:text-blue-200">
                                    pre-selected
                                  </span>
                                )}
                                {m.removesIngredientId && (
                                  <span className="ml-1 rounded bg-stone-100 px-2 py-0.5 text-xs text-stone-600 dark:bg-stone-800 dark:text-stone-300">
                                    takes it off stock use
                                  </span>
                                )}
                              </td>
                              <td className="py-2 text-right font-mono text-sm">
                                {m.priceDeltaCents === 0 ? (
                                  <span className="text-stone-400">free</span>
                                ) : (
                                  <>
                                    {m.priceDeltaCents > 0 ? '+' : ''}
                                    {formatCents(m.priceDeltaCents)}
                                  </>
                                )}
                              </td>
                              <td className="py-2 text-right">
                                <button
                                  type="button"
                                  onClick={() => setEditingMod({ group: g, mod: m })}
                                  className="rounded p-1 text-stone-500 hover:bg-stone-100 dark:hover:bg-stone-800"
                                  aria-label={`Edit option ${m.name}`}
                                  title="Edit option"
                                >
                                  <Edit className="h-3.5 w-3.5" />
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    void askConfirm(`Delete option "${m.name}"?`).then((ok) => {
                                      if (ok) deleteModMut.mutate(m.id);
                                    });
                                  }}
                                  className="rounded p-1 text-red-500 hover:bg-red-50 dark:hover:bg-red-950"
                                  aria-label={`Delete option ${m.name}`}
                                  title="Delete option"
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })}
        {list.items.length === 0 && (
          <div className="py-6 text-center text-stone-500">
            {q.isLoading ? 'Loading…' : (q.data?.length ?? 0) === 0 ? 'No choice groups yet.' : 'No groups match.'}
          </div>
        )}
      </div>
      <Pagination
        page={list.page}
        pageCount={list.pageCount}
        total={list.total}
        from={list.from}
        to={list.to}
        onPage={list.setPage}
        pageSize={list.pageSize}
        onPageSize={list.setPageSize}
        noun="groups"
      />

      {editingGroup && (
        <GroupDialog
          key={editingGroup === 'new' ? 'new' : editingGroup.id}
          existing={editingGroup === 'new' ? null : editingGroup}
          onClose={() => setEditingGroup(null)}
        />
      )}
      {editingMod && (
        <ModDialog
          key={editingMod.mod ? editingMod.mod.id : `new-${editingMod.group.id}`}
          group={editingMod.group}
          existing={editingMod.mod}
          onClose={() => setEditingMod(null)}
        />
      )}
    </Card>
  );
}

function GroupDialog({
  existing,
  onClose,
}: {
  existing: ModifierGroup | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [name, setName] = useState(existing?.name ?? '');
  const [selectionType, setSelectionType] = useState<ModifierSelectionType>(existing?.selectionType ?? 'single');
  const [minSelect, setMinSelect] = useState(existing?.minSelect ?? 0);
  const [maxSelect, setMaxSelect] = useState(existing?.maxSelect ?? 1);
  const [isRequired, setIsRequired] = useState(existing?.isRequired ?? false);

  // "Pick one" is 0–1 when optional and exactly 1 when required. It used to
  // force 1–1 whenever "single" was clicked, which quietly made the group
  // required: every item using it opened the choices box on the till.
  const min = selectionType === 'single' ? (isRequired ? 1 : 0) : isRequired ? Math.max(1, minSelect) : minSelect;
  const max = selectionType === 'single' ? 1 : maxSelect;
  const rangeError =
    selectionType === 'multi' && (max < 1 ? 'Allow at least 1.' : min > max ? 'The minimum is more than the maximum.' : null);

  const mut = useMutation({
    mutationFn: () => {
      const body = { name: name.trim(), selectionType, minSelect: min, maxSelect: max, isRequired };
      return existing ? ipc.menu.updateModifierGroup({ id: existing.id, ...body }) : ipc.menu.createModifierGroup(body);
    },
    onSuccess: () => {
      toast({ title: existing ? 'Group updated' : 'Group created', variant: 'success' });
      void qc.invalidateQueries({ queryKey: ['menu'] });
      onClose();
    },
    onError: (e) =>
      toast({
        title: 'Save failed',
        description: e instanceof Error ? e.message : String(e),
        variant: 'error',
      }),
  });

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[460px] max-w-[94vw] -translate-x-1/2 -translate-y-1/2 rounded-xl bg-white p-5 shadow-xl dark:bg-stone-900">
          <header className="mb-4 flex items-center justify-between">
            <Dialog.Title className="text-lg font-bold">
              {existing ? 'Edit choice group' : 'Add choice group'}
            </Dialog.Title>
            <Dialog.Description className="sr-only">Name and how many options can be picked.</Dialog.Description>
            <Dialog.Close asChild>
              <button type="button" aria-label="Close" className="rounded p-2 text-stone-500 hover:bg-stone-100 dark:hover:bg-stone-800">
                <X className="h-5 w-5" />
              </button>
            </Dialog.Close>
          </header>
          <div className="space-y-3">
            <div>
              <label htmlFor="group-name" className="mb-1 block text-xs uppercase tracking-wider text-stone-500">Name</label>
              <input
                id="group-name"
                type="text"
                value={name}
                autoFocus
                onChange={(e) => setName(e.target.value)}
                placeholder="Choose your dip, Extra toppings, Leave out · Fajita Pizza…"
                className="w-full rounded-lg border border-stone-300 px-3 py-2 dark:border-stone-700 dark:bg-stone-800"
              />
            </div>
            <div>
              <div className="mb-1 block text-xs uppercase tracking-wider text-stone-500">How many can be picked</div>
              <div className="grid grid-cols-2 gap-2">
                {(['single', 'multi'] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    aria-pressed={selectionType === t}
                    onClick={() => setSelectionType(t)}
                    className={
                      selectionType === t
                        ? 'rounded-lg border-2 border-amber-500 bg-amber-50 px-3 py-2 font-semibold dark:bg-amber-950'
                        : 'rounded-lg border-2 border-stone-200 px-3 py-2 hover:border-stone-300 dark:border-stone-700'
                    }
                  >
                    {t === 'single' ? 'One only' : 'Several'}
                  </button>
                ))}
              </div>
            </div>
            {selectionType === 'multi' && (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="group-min" className="mb-1 block text-xs uppercase tracking-wider text-stone-500">At least</label>
                  <input
                    id="group-min"
                    type="number"
                    min={0}
                    value={minSelect}
                    onChange={(e) => setMinSelect(Math.max(0, parseInt(e.target.value, 10) || 0))}
                    className="w-full rounded-lg border border-stone-300 px-3 py-2 dark:border-stone-700 dark:bg-stone-800"
                  />
                </div>
                <div>
                  <label htmlFor="group-max" className="mb-1 block text-xs uppercase tracking-wider text-stone-500">At most</label>
                  <input
                    id="group-max"
                    type="number"
                    min={1}
                    value={maxSelect}
                    onChange={(e) => setMaxSelect(Math.max(0, parseInt(e.target.value, 10) || 0))}
                    className="w-full rounded-lg border border-stone-300 px-3 py-2 dark:border-stone-700 dark:bg-stone-800"
                  />
                </div>
              </div>
            )}
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={isRequired} onChange={(e) => setIsRequired(e.target.checked)} />
              Must be chosen before the item goes on the order
            </label>
            <p className="text-xs text-stone-500">
              {selectionType === 'single'
                ? isRequired
                  ? 'The cashier must pick exactly one.'
                  : 'The cashier may pick one, or none.'
                : `The cashier picks ${min === 0 ? `up to ${max}` : min === max ? `exactly ${min}` : `${min} to ${max}`}.`}
            </p>
            {rangeError && <p className="text-xs text-red-600">{rangeError}</p>}
          </div>
          <footer className="mt-5 flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            <Button variant="primary" disabled={mut.isPending || !name.trim() || !!rangeError} onClick={() => mut.mutate()}>
              {mut.isPending ? 'Saving…' : 'Save'}
            </Button>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function ModDialog({
  group,
  existing,
  onClose,
}: {
  group: GroupWithOptions;
  existing: Modifier | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const leaveOut = modifierGroupKind(group) === 'leave-out';
  const [name, setName] = useState(existing?.name ?? '');
  const [priceRupees, setPriceRupees] = useState(((existing?.priceDeltaCents ?? 0) / 100).toString());
  const [isDefault, setIsDefault] = useState(existing?.isDefault ?? false);
  // New options go to the end of the list by default.
  const [sortOrder, setSortOrder] = useState(
    existing?.sortOrder ?? group.modifiers.reduce((n, m) => Math.max(n, m.sortOrder + 1), 0),
  );
  const price = Number(priceRupees);
  const priceValid = priceRupees.trim() !== '' && Number.isFinite(price);

  const mut = useMutation({
    mutationFn: () => {
      const priceDeltaCents = Math.round(price * 100);
      return existing
        ? ipc.menu.updateModifier({ id: existing.id, name: name.trim(), priceDeltaCents, isDefault, sortOrder })
        : ipc.menu.createModifier({
            modifierGroupId: group.id,
            name: name.trim(),
            priceDeltaCents,
            isDefault,
            sortOrder,
          });
    },
    onSuccess: () => {
      toast({ title: existing ? 'Option updated' : 'Option added', variant: 'success' });
      void qc.invalidateQueries({ queryKey: ['menu'] });
      onClose();
    },
    onError: (e) =>
      toast({
        title: 'Save failed',
        description: e instanceof Error ? e.message : String(e),
        variant: 'error',
      }),
  });

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[420px] max-w-[94vw] -translate-x-1/2 -translate-y-1/2 rounded-xl bg-white p-5 shadow-xl dark:bg-stone-900">
          <header className="mb-4 flex items-center justify-between">
            <div className="min-w-0">
              <Dialog.Title className="text-lg font-bold">{existing ? 'Edit option' : 'Add option'}</Dialog.Title>
              <Dialog.Description className="truncate text-xs text-stone-500">in {group.name}</Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button type="button" aria-label="Close" className="rounded p-2 text-stone-500 hover:bg-stone-100 dark:hover:bg-stone-800">
                <X className="h-5 w-5" />
              </button>
            </Dialog.Close>
          </header>
          <div className="space-y-3">
            <div>
              <label htmlFor="mod-name" className="mb-1 block text-xs uppercase tracking-wider text-stone-500">Name</label>
              <input
                id="mod-name"
                type="text"
                value={name}
                autoFocus
                onChange={(e) => setName(e.target.value)}
                placeholder={leaveOut ? 'No onion' : 'Extra cheese'}
                className="w-full rounded-lg border border-stone-300 px-3 py-2 dark:border-stone-700 dark:bg-stone-800"
              />
              {leaveOut && name.trim() !== '' && !/^no\s/i.test(name.trim()) && (
                <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">
                  Leave-outs start with “No ” so the kitchen ticket prints them as NO ONION.
                </p>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="mod-price" className="mb-1 block text-xs uppercase tracking-wider text-stone-500">Extra charge (Rs)</label>
                <input
                  id="mod-price"
                  type="number"
                  step="any"
                  inputMode="decimal"
                  value={priceRupees}
                  onChange={(e) => setPriceRupees(e.target.value)}
                  className={cn(
                    'w-full rounded-lg border px-3 py-2 font-mono dark:bg-stone-800',
                    priceValid ? 'border-stone-300 dark:border-stone-700' : 'border-red-400',
                  )}
                />
              </div>
              <div>
                <label htmlFor="mod-sort" className="mb-1 block text-xs uppercase tracking-wider text-stone-500">Position</label>
                <input
                  id="mod-sort"
                  type="number"
                  value={sortOrder}
                  onChange={(e) => setSortOrder(parseInt(e.target.value, 10) || 0)}
                  className="w-full rounded-lg border border-stone-300 px-3 py-2 dark:border-stone-700 dark:bg-stone-800"
                />
              </div>
            </div>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} />
              Pre-selected by default
            </label>
          </div>
          <footer className="mt-5 flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            <Button variant="primary" disabled={mut.isPending || !name.trim() || !priceValid} onClick={() => mut.mutate()}>
              {mut.isPending ? 'Saving…' : 'Save'}
            </Button>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
