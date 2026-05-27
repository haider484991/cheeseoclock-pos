import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import * as Dialog from '@radix-ui/react-dialog';
import { Button, Card } from '@cheeseoclock/ui';
import { ipc, IpcError } from '../../ipc/client';
import { useToast } from '../../components/toast/ToastProvider';
import type { TaxCategory } from '@cheeseoclock/shared-types';
import { Plus, Edit, Trash2, X } from 'lucide-react';

export function TaxTab() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const q = useQuery({ queryKey: ['menu', 'taxCategories'], queryFn: () => ipc.menu.listTaxCategories() });
  const [editing, setEditing] = useState<TaxCategory | null | 'new'>(null);

  const deleteMut = useMutation({
    mutationFn: (id: string) => ipc.menu.deleteTaxCategory(id),
    onSuccess: () => {
      toast({ title: 'Tax category removed', variant: 'success' });
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
        <h2 className="font-semibold">Tax categories</h2>
        <Button variant="primary" size="sm" onClick={() => setEditing('new')}>
          <Plus className="h-4 w-4" /> Add tax
        </Button>
      </div>
      <table className="w-full text-sm">
        <thead className="text-left text-xs uppercase tracking-wider text-stone-500">
          <tr>
            <th className="pb-2">Name</th>
            <th className="pb-2 text-right">Rate</th>
            <th className="pb-2" />
          </tr>
        </thead>
        <tbody>
          {(q.data ?? []).map((t) => (
            <tr key={t.id} className="border-t border-stone-100 dark:border-stone-800">
              <td className="py-2 font-medium">{t.name}</td>
              <td className="py-2 text-right font-mono">{(t.rateBps / 100).toFixed(2)}%</td>
              <td className="py-2 text-right">
                <button onClick={() => setEditing(t)} className="rounded p-1 text-stone-500 hover:bg-stone-100 dark:hover:bg-stone-800" aria-label="Edit">
                  <Edit className="h-4 w-4" />
                </button>
                <button
                  onClick={() => {
                    if (confirm(`Delete tax category "${t.name}"?`)) deleteMut.mutate(t.id);
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
              <td colSpan={3} className="py-6 text-center text-stone-500">
                No tax categories yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {editing && (
        <TaxDialog
          key={editing === 'new' ? 'new' : editing.id}
          existing={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </Card>
  );
}

function TaxDialog({
  existing,
  onClose,
}: {
  existing: TaxCategory | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [name, setName] = useState(existing?.name ?? '');
  const [ratePercent, setRatePercent] = useState(((existing?.rateBps ?? 1600) / 100).toString());

  const mut = useMutation({
    mutationFn: () => {
      const bps = Math.round(parseFloat(ratePercent || '0') * 100);
      return existing
        ? ipc.menu.updateTaxCategory({ id: existing.id, name, rateBps: bps })
        : ipc.menu.createTaxCategory({ name, rateBps: bps });
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
            <Dialog.Title className="text-lg font-bold">{existing ? 'Edit tax' : 'Add tax'}</Dialog.Title>
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
                placeholder="Standard 16%"
                className="w-full rounded-lg border border-stone-300 px-3 py-2 dark:border-stone-700 dark:bg-stone-800"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs uppercase tracking-wider text-stone-500">Rate (%)</label>
              <input
                type="number"
                step="0.01"
                value={ratePercent}
                onChange={(e) => setRatePercent(e.target.value)}
                placeholder="16"
                className="w-full rounded-lg border border-stone-300 px-3 py-2 font-mono dark:border-stone-700 dark:bg-stone-800"
              />
              <div className="mt-1 text-xs text-stone-500">
                Stored as basis points internally (16% = 1600 bps).
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
