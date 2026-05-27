import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import * as Dialog from '@radix-ui/react-dialog';
import { Button, Card, cn } from '@cheeseoclock/ui';
import { ipc, IpcError } from '../../ipc/client';
import { useToast } from '../../components/toast/ToastProvider';
import type { Category } from '@cheeseoclock/shared-types';
import { Plus, Edit, Trash2, X } from 'lucide-react';

const PALETTE = [
  '#dc2626', '#f59e0b', '#16a34a', '#2563eb',
  '#db2777', '#7c3aed', '#0891b2', '#65a30d',
];

export function CategoriesTab() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const q = useQuery({ queryKey: ['menu', 'categories', 'all'], queryFn: () => ipc.menu.listCategories() });

  const [editing, setEditing] = useState<Category | null | 'new'>(null);

  const deleteMut = useMutation({
    mutationFn: (id: string) => ipc.menu.deleteCategory(id),
    onSuccess: () => {
      toast({ title: 'Category removed', variant: 'success' });
      void qc.invalidateQueries({ queryKey: ['menu'] });
    },
    onError: (e: unknown) =>
      toast({
        title: 'Cannot delete',
        description: e instanceof IpcError ? e.message : String(e),
        variant: 'error',
      }),
  });

  return (
    <Card>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="font-semibold">Categories</h2>
        <Button variant="primary" size="sm" onClick={() => setEditing('new')}>
          <Plus className="h-4 w-4" /> Add category
        </Button>
      </div>

      <table className="w-full text-sm">
        <thead className="text-left text-xs uppercase tracking-wider text-stone-500">
          <tr>
            <th className="pb-2">Color</th>
            <th className="pb-2">Name</th>
            <th className="pb-2 text-right">Order</th>
            <th className="pb-2">Status</th>
            <th className="pb-2" />
          </tr>
        </thead>
        <tbody>
          {(q.data ?? []).map((c) => (
            <tr key={c.id} className="border-t border-stone-100 dark:border-stone-800">
              <td className="py-2">
                <span className="inline-block h-5 w-8 rounded" style={{ background: c.colorHex }} />
              </td>
              <td className="py-2 font-medium">{c.name}</td>
              <td className="py-2 text-right font-mono">{c.displayOrder}</td>
              <td className="py-2">
                {c.isActive ? (
                  <span className="rounded bg-emerald-100 px-2 py-0.5 text-xs text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
                    Active
                  </span>
                ) : (
                  <span className="rounded bg-stone-200 px-2 py-0.5 text-xs text-stone-600 dark:bg-stone-700 dark:text-stone-300">
                    Inactive
                  </span>
                )}
              </td>
              <td className="py-2 text-right">
                <button
                  type="button"
                  onClick={() => setEditing(c)}
                  className="rounded p-1 text-stone-500 hover:bg-stone-100 dark:hover:bg-stone-800"
                  aria-label="Edit"
                >
                  <Edit className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (confirm(`Delete category "${c.name}"?`)) deleteMut.mutate(c.id);
                  }}
                  className="rounded p-1 text-red-500 hover:bg-red-50 dark:hover:bg-red-950"
                  aria-label="Delete"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </td>
            </tr>
          ))}
          {(!q.data || q.data.length === 0) && (
            <tr>
              <td colSpan={5} className="py-6 text-center text-stone-500">
                No categories yet. Click "Add category" to get started.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {editing && (
        <CategoryDialog
          key={editing === 'new' ? 'new' : editing.id}
          existing={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </Card>
  );
}

function CategoryDialog({
  existing,
  onClose,
}: {
  existing: Category | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [name, setName] = useState(existing?.name ?? '');
  const [displayOrder, setDisplayOrder] = useState(existing?.displayOrder ?? 0);
  const [colorHex, setColorHex] = useState(existing?.colorHex ?? PALETTE[1]!);
  const [isActive, setIsActive] = useState(existing?.isActive ?? true);

  const mut = useMutation({
    mutationFn: () =>
      existing
        ? ipc.menu.updateCategory({ id: existing.id, name, displayOrder, colorHex, isActive })
        : ipc.menu.createCategory({ name, displayOrder, colorHex }),
    onSuccess: () => {
      toast({ title: existing ? 'Category updated' : 'Category created', variant: 'success' });
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
              {existing ? `Edit ${existing.name}` : 'Add category'}
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
                onChange={(e) => setName(e.target.value)}
                autoFocus
                className="w-full rounded-lg border border-stone-300 px-3 py-2 dark:border-stone-700 dark:bg-stone-800"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="mb-1 block text-xs uppercase tracking-wider text-stone-500">Display order</label>
                <input
                  type="number"
                  value={displayOrder}
                  onChange={(e) => setDisplayOrder(parseInt(e.target.value, 10) || 0)}
                  className="w-full rounded-lg border border-stone-300 px-3 py-2 dark:border-stone-700 dark:bg-stone-800"
                />
              </div>
              {existing && (
                <div>
                  <label className="mb-1 block text-xs uppercase tracking-wider text-stone-500">Status</label>
                  <label className="flex h-[42px] items-center gap-2">
                    <input
                      type="checkbox"
                      checked={isActive}
                      onChange={(e) => setIsActive(e.target.checked)}
                    />
                    {isActive ? 'Active' : 'Inactive'}
                  </label>
                </div>
              )}
            </div>
            <div>
              <label className="mb-1 block text-xs uppercase tracking-wider text-stone-500">Color</label>
              <div className="flex flex-wrap gap-2">
                {PALETTE.map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setColorHex(p)}
                    className={cn(
                      'h-9 w-9 rounded-lg border-2',
                      colorHex === p ? 'border-stone-900 dark:border-white' : 'border-transparent',
                    )}
                    style={{ background: p }}
                    aria-label={p}
                  />
                ))}
              </div>
            </div>
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
