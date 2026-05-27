import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import * as Dialog from '@radix-ui/react-dialog';
import { Button, Card } from '@cheeseoclock/ui';
import { formatCents } from '@cheeseoclock/pos-domain';
import { ipc, IpcError } from '../../ipc/client';
import { useToast } from '../../components/toast/ToastProvider';
import type { Modifier, ModifierGroup, ModifierSelectionType } from '@cheeseoclock/shared-types';
import { Plus, Edit, Trash2, X, ChevronDown, ChevronRight } from 'lucide-react';

type GroupWithMods = ModifierGroup & { modifiers: Modifier[] };

export function ModifiersTab() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const q = useQuery({
    queryKey: ['menu', 'modifierGroups'],
    queryFn: () => ipc.menu.listModifierGroups(),
  });
  const [expandedGroupId, setExpandedGroupId] = useState<string | null>(null);
  const [editingGroup, setEditingGroup] = useState<ModifierGroup | null | 'new'>(null);
  const [editingMod, setEditingMod] = useState<{ groupId: string; mod: Modifier | null } | null>(null);

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
      toast({ title: 'Modifier removed', variant: 'success' });
      void qc.invalidateQueries({ queryKey: ['menu'] });
    },
    onError: (e) =>
      toast({
        title: 'Cannot delete',
        description: e instanceof IpcError ? e.message : String(e),
        variant: 'error',
      }),
  });

  return (
    <Card>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-semibold">Modifier groups</h2>
        <Button variant="primary" size="sm" onClick={() => setEditingGroup('new')}>
          <Plus className="h-4 w-4" /> Add group
        </Button>
      </div>

      <div className="space-y-2">
        {(q.data ?? []).map((g) => {
          const expanded = expandedGroupId === g.id;
          return (
            <div key={g.id} className="rounded-lg border border-stone-200 dark:border-stone-800">
              <div
                className="flex cursor-pointer items-center gap-3 p-3 hover:bg-stone-50 dark:hover:bg-stone-800"
                onClick={() => setExpandedGroupId(expanded ? null : g.id)}
              >
                {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                <div className="flex-1">
                  <div className="font-medium">
                    {g.name}
                    {g.isRequired && <span className="ml-1 text-red-500">*</span>}
                  </div>
                  <div className="text-xs text-stone-500">
                    {g.selectionType === 'single' ? 'Choose 1' : `Choose ${g.minSelect}-${g.maxSelect}`}
                    {' · '}
                    {g.modifiers.length} options
                  </div>
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setEditingGroup(g);
                  }}
                  className="rounded p-1 text-stone-500 hover:bg-stone-200 dark:hover:bg-stone-700"
                  aria-label="Edit group"
                >
                  <Edit className="h-4 w-4" />
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    if (confirm(`Delete group "${g.name}"?`)) deleteGroupMut.mutate(g.id);
                  }}
                  className="rounded p-1 text-red-500 hover:bg-red-50 dark:hover:bg-red-950"
                  aria-label="Delete group"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>

              {expanded && (
                <div className="border-t border-stone-200 p-3 dark:border-stone-800">
                  <div className="mb-2 flex items-center justify-between">
                    <div className="text-xs uppercase tracking-wider text-stone-500">Options</div>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => setEditingMod({ groupId: g.id, mod: null })}
                    >
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
                                  default
                                </span>
                              )}
                            </td>
                            <td className="py-2 text-right font-mono text-sm">
                              {m.priceDeltaCents > 0 ? '+' : ''}
                              {formatCents(m.priceDeltaCents)}
                            </td>
                            <td className="py-2 text-right">
                              <button
                                onClick={() => setEditingMod({ groupId: g.id, mod: m })}
                                className="rounded p-1 text-stone-500 hover:bg-stone-100 dark:hover:bg-stone-800"
                                aria-label="Edit option"
                              >
                                <Edit className="h-3.5 w-3.5" />
                              </button>
                              <button
                                onClick={() => {
                                  if (confirm(`Delete option "${m.name}"?`)) deleteModMut.mutate(m.id);
                                }}
                                className="rounded p-1 text-red-500 hover:bg-red-50 dark:hover:bg-red-950"
                                aria-label="Delete option"
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
          );
        })}
        {(!q.data || q.data.length === 0) && (
          <div className="py-6 text-center text-stone-500">No modifier groups yet.</div>
        )}
      </div>

      {editingGroup && (
        <GroupDialog
          key={editingGroup === 'new' ? 'new' : editingGroup.id}
          existing={editingGroup === 'new' ? null : editingGroup}
          onClose={() => setEditingGroup(null)}
        />
      )}
      {editingMod && (
        <ModDialog
          key={editingMod.mod ? editingMod.mod.id : `new-${editingMod.groupId}`}
          groupId={editingMod.groupId}
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

  const mut = useMutation({
    mutationFn: () =>
      existing
        ? ipc.menu.updateModifierGroup({ id: existing.id, name, selectionType, minSelect, maxSelect, isRequired })
        : ipc.menu.createModifierGroup({ name, selectionType, minSelect, maxSelect, isRequired }),
    onSuccess: () => {
      toast({ title: existing ? 'Updated' : 'Created', variant: 'success' });
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
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[440px] -translate-x-1/2 -translate-y-1/2 rounded-xl bg-white p-5 shadow-xl dark:bg-stone-900">
          <header className="mb-4 flex items-center justify-between">
            <Dialog.Title className="text-lg font-bold">
              {existing ? 'Edit modifier group' : 'Add modifier group'}
            </Dialog.Title>
            <Dialog.Close asChild>
              <button type="button" className="rounded p-2 text-stone-500 hover:bg-stone-100 dark:hover:bg-stone-800">
                <X className="h-5 w-5" />
              </button>
            </Dialog.Close>
          </header>
          <div className="space-y-3">
            <div>
              <label className="mb-1 block text-xs uppercase tracking-wider text-stone-500">Name</label>
              <input
                type="text"
                value={name}
                autoFocus
                onChange={(e) => setName(e.target.value)}
                placeholder="Size, Crust, Toppings…"
                className="w-full rounded-lg border border-stone-300 px-3 py-2 dark:border-stone-700 dark:bg-stone-800"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs uppercase tracking-wider text-stone-500">Selection type</label>
              <div className="grid grid-cols-2 gap-2">
                {(['single', 'multi'] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => {
                      setSelectionType(t);
                      if (t === 'single') {
                        setMinSelect(1);
                        setMaxSelect(1);
                      }
                    }}
                    className={
                      selectionType === t
                        ? 'rounded-lg border-2 border-amber-500 bg-amber-50 px-3 py-2 font-semibold dark:bg-amber-950'
                        : 'rounded-lg border-2 border-stone-200 px-3 py-2 hover:border-stone-300 dark:border-stone-700'
                    }
                  >
                    {t === 'single' ? 'Single (radio)' : 'Multi (checkboxes)'}
                  </button>
                ))}
              </div>
            </div>
            {selectionType === 'multi' && (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="mb-1 block text-xs uppercase tracking-wider text-stone-500">Min select</label>
                  <input
                    type="number"
                    value={minSelect}
                    onChange={(e) => setMinSelect(parseInt(e.target.value, 10) || 0)}
                    className="w-full rounded-lg border border-stone-300 px-3 py-2 dark:border-stone-700 dark:bg-stone-800"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-xs uppercase tracking-wider text-stone-500">Max select</label>
                  <input
                    type="number"
                    value={maxSelect}
                    onChange={(e) => setMaxSelect(parseInt(e.target.value, 10) || 0)}
                    className="w-full rounded-lg border border-stone-300 px-3 py-2 dark:border-stone-700 dark:bg-stone-800"
                  />
                </div>
              </div>
            )}
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={isRequired} onChange={(e) => setIsRequired(e.target.checked)} />
              Required to choose at order time
            </label>
          </div>
          <footer className="mt-5 flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            <Button variant="primary" disabled={mut.isPending || !name.trim()} onClick={() => mut.mutate()}>
              {mut.isPending ? 'Saving…' : 'Save'}
            </Button>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function ModDialog({
  groupId,
  existing,
  onClose,
}: {
  groupId: string;
  existing: Modifier | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [name, setName] = useState(existing?.name ?? '');
  const [priceRupees, setPriceRupees] = useState(((existing?.priceDeltaCents ?? 0) / 100).toString());
  const [isDefault, setIsDefault] = useState(existing?.isDefault ?? false);
  const [sortOrder, setSortOrder] = useState(existing?.sortOrder ?? 0);

  const mut = useMutation({
    mutationFn: () => {
      const priceDeltaCents = Math.round(parseFloat(priceRupees || '0') * 100);
      return existing
        ? ipc.menu.updateModifier({ id: existing.id, name, priceDeltaCents, isDefault, sortOrder })
        : ipc.menu.createModifier({
            modifierGroupId: groupId,
            name,
            priceDeltaCents,
            isDefault,
            sortOrder,
          });
    },
    onSuccess: () => {
      toast({ title: existing ? 'Updated' : 'Created', variant: 'success' });
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
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[400px] -translate-x-1/2 -translate-y-1/2 rounded-xl bg-white p-5 shadow-xl dark:bg-stone-900">
          <header className="mb-4 flex items-center justify-between">
            <Dialog.Title className="text-lg font-bold">{existing ? 'Edit option' : 'Add option'}</Dialog.Title>
            <Dialog.Close asChild>
              <button type="button" className="rounded p-2 text-stone-500 hover:bg-stone-100 dark:hover:bg-stone-800">
                <X className="h-5 w-5" />
              </button>
            </Dialog.Close>
          </header>
          <div className="space-y-3">
            <div>
              <label className="mb-1 block text-xs uppercase tracking-wider text-stone-500">Name</label>
              <input
                type="text"
                value={name}
                autoFocus
                onChange={(e) => setName(e.target.value)}
                placeholder="Large (15&quot;)"
                className="w-full rounded-lg border border-stone-300 px-3 py-2 dark:border-stone-700 dark:bg-stone-800"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-xs uppercase tracking-wider text-stone-500">Price delta (PKR)</label>
                <input
                  type="number"
                  step="0.01"
                  value={priceRupees}
                  onChange={(e) => setPriceRupees(e.target.value)}
                  className="w-full rounded-lg border border-stone-300 px-3 py-2 font-mono dark:border-stone-700 dark:bg-stone-800"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs uppercase tracking-wider text-stone-500">Sort order</label>
                <input
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
            <Button variant="primary" disabled={mut.isPending || !name.trim()} onClick={() => mut.mutate()}>
              {mut.isPending ? 'Saving…' : 'Save'}
            </Button>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
