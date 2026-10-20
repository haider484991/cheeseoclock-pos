import { useState } from 'react';
import { shopTakes } from '@cheeseoclock/shared-types';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import * as Dialog from '@radix-ui/react-dialog';
import { Button, Card } from '@cheeseoclock/ui';
import { ipc, IpcError } from '../../ipc/client';
import { useToast } from '../../components/toast/ToastProvider';
import type { TaxCategory } from '@cheeseoclock/shared-types';
import { RATED_METHOD_LABEL, RATED_PAYMENT_METHODS, STARTING_TAX_RATE_BPS, taxRatePercentText } from '@cheeseoclock/shared-types';
import { rateBpsOf, taxRateFieldStart, taxRatesText, wayRateFieldsStart, wayRatesOf, type WayRateFields } from './taxForm';
import { Plus, Edit, Trash2, X } from 'lucide-react';
import { askConfirm } from '../../components/confirm/ConfirmHost';

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
              {/* "15% · card 8%" when the category charges less by card / wallet / bank (0052); each way's own (0.7.45). */}
              <td className="py-2 text-right font-mono">{taxRatesText(t)}</td>
              <td className="py-2 text-right">
                <button onClick={() => setEditing(t)} className="rounded p-1 text-stone-500 hover:bg-stone-100 dark:hover:bg-stone-800" aria-label="Edit">
                  <Edit className="h-4 w-4" />
                </button>
                <button
                  onClick={() => {
                    void askConfirm(`Delete tax category "${t.name}"?`).then((ok) => {
                      if (ok) deleteMut.mutate(t.id);
                    });
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

/**
 * Add or edit a tax category: its name, its rate (cash), and its rate by how
 * the customer pays (0052 one card rate; 0.7.45 one for each way: card,
 * EasyPaisa, JazzCash, bank transfer — the owner, 12 Oct 2026: "add settings
 * to set percentage tax on jazz cash or any payment method"). Also opened
 * from Settings → Money & discounts → Tax by how the customer pays.
 */
export function TaxDialog({
  existing,
  onClose,
}: {
  existing: TaxCategory | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [name, setName] = useState(existing?.name ?? '');
  // Editing: the category's own rate, as it is. A new one starts at the till's starting rate.
  const [ratePercent, setRatePercent] = useState(taxRateFieldStart(existing));
  // The rate by each way of paying but cash; an empty box = the cash rate.
  const [ways, setWays] = useState<WayRateFields>(wayRateFieldsStart(existing));

  const mut = useMutation({
    mutationFn: () => {
      const bps = rateBpsOf(ratePercent) ?? 0;
      const { digitalRateBps, methodRatesBps } = wayRatesOf(bps, ways);
      return existing
        ? ipc.menu.updateTaxCategory({ id: existing.id, name, rateBps: bps, digitalRateBps, methodRatesBps })
        : ipc.menu.createTaxCategory({ name, rateBps: bps, digitalRateBps, methodRatesBps });
    },
    onSuccess: () => {
      toast({ title: existing ? 'Updated' : 'Created', variant: 'success' });
      void qc.invalidateQueries({ queryKey: ['menu'] });
      void qc.invalidateQueries({ queryKey: ['settings'] });
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
                placeholder={`Sales tax ${taxRatePercentText(STARTING_TAX_RATE_BPS)}`}
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
                placeholder={String(STARTING_TAX_RATE_BPS / 100)}
                className="w-full rounded-lg border border-stone-300 px-3 py-2 font-mono dark:border-stone-700 dark:bg-stone-800"
              />
              <div className="mt-1 text-xs text-stone-500">
                Stored as basis points internally ({taxRatePercentText(STARTING_TAX_RATE_BPS)} = {STARTING_TAX_RATE_BPS} bps).
              </div>
            </div>
            <div>
              <span className="mb-1 block text-xs uppercase tracking-wider text-stone-500">Rate by how the customer pays (%)</span>
              <div className="grid grid-cols-2 gap-2">
                {RATED_PAYMENT_METHODS.filter((m) => shopTakes(m)).map((m) => (
                  <label key={m} className="flex items-center gap-2 text-sm">
                    <span className="w-24 shrink-0 text-stone-600 dark:text-stone-300">{RATED_METHOD_LABEL[m]}</span>
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      max="100"
                      value={ways[m]}
                      onChange={(e) => setWays((w) => ({ ...w, [m]: e.target.value }))}
                      placeholder={ratePercent || 'Cash rate'}
                      aria-label={`Rate when paid by ${RATED_METHOD_LABEL[m]} (%)`}
                      className="w-full min-w-0 rounded-lg border border-stone-300 px-2 py-1.5 font-mono dark:border-stone-700 dark:bg-stone-800"
                    />
                  </label>
                ))}
              </div>
              <div className="mt-1 text-xs text-stone-500">
                Sindh charges a restaurant&rsquo;s bill a lower rate when it is paid by card, wallet or bank transfer. Set
                each way&rsquo;s rate; leave a box empty to charge the cash rate (the Rate above) that way. Pay works out a
                bill paid part one way, part in cash: each part at its own rate.
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
