/**
 * Settings → Vouchers (v0.7.50; the owner, 12 Oct 2026: "its for large
 * regular pizza all shuould be change abele in settings so we can add more
 * vouchers and add other companies"). Each company's vouchers and what they
 * are for (the menu categories, the size, the whole item or up to an
 * amount), with Add company vouchers (a CSV of the printed list), Change and
 * Delete (while none is used). Each voucher's own log stays on the Vouchers
 * page. The same batches and the same main-process checks as that page.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Ticket, Trash2 } from 'lucide-react';
import { Button, Card } from '@cheeseoclock/ui';
import type { VoucherBatchSummary } from '@cheeseoclock/shared-types';
import { ipc } from '../../ipc/client';
import { useToast } from '../../components/toast/ToastProvider';
import { askConfirm } from '../../components/confirm/ConfirmHost';
import { VoucherBatchDialog } from '../vouchers/VoucherBatchDialog';
import { batchCountWords, batchNumbersWords, batchTermsWords } from '../vouchers/voucherPageWords';

export function VoucherSettings() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<VoucherBatchSummary | null>(null);
  const batchesQ = useQuery({ queryKey: ['vouchers', 'batches'], queryFn: () => ipc.vouchers.listBatches() });
  const batches = batchesQ.data ?? [];

  const remove = useMutation({
    mutationFn: (id: string) => ipc.vouchers.removeBatch(id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['vouchers'] });
      toast({ title: 'Vouchers deleted', variant: 'success' });
    },
    onError: (e: unknown) =>
      toast({ title: 'Could not delete the vouchers', description: e instanceof Error ? e.message : 'Unknown error', variant: 'error' }),
  });

  async function confirmRemove(b: VoucherBatchSummary) {
    const yes = await askConfirm(`Delete the ${b.count} vouchers for ${b.name}? They can't be used at the till after this.`, {
      yesLabel: 'Delete them',
      noLabel: 'Keep them',
    });
    if (yes) remove.mutate(b.id);
  }

  return (
    <Card>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300">
            <Ticket className="h-5 w-5" />
          </span>
          <div>
            <h2 className="text-lg font-bold">Company vouchers</h2>
            <p className="text-sm text-stone-500">
              Vouchers a company bought to hand out, and what each one is for. The till lets a voucher come off only that item, once.
            </p>
          </div>
        </div>
        <Button onClick={() => setAdding(true)}>
          <Plus className="h-4 w-4" />
          Add company vouchers
        </Button>
      </div>

      {batchesQ.isLoading ? (
        <p className="py-6 text-center text-sm text-stone-400">Loading…</p>
      ) : batchesQ.isError ? (
        <p className="py-6 text-center text-sm text-red-600">Could not load the vouchers.</p>
      ) : batches.length === 0 ? (
        <p className="py-6 text-center text-sm text-stone-500">No company vouchers yet. Add them with the CSV of the printed list.</p>
      ) : (
        <ul className="divide-y divide-stone-100 rounded-xl border border-stone-200 dark:divide-stone-800 dark:border-stone-700">
          {batches.map((b) => (
            <li key={b.id} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <p className="font-semibold">
                  {b.name}
                  <span className="ml-2 text-xs font-normal text-stone-500">{batchNumbersWords(b)}</span>
                </p>
                <p className="text-sm text-stone-600 dark:text-stone-300">{b.gives}</p>
                <p className="text-sm font-medium">For: {batchTermsWords(b)}</p>
                <p className="text-xs text-stone-500">{batchCountWords(b)}</p>
              </div>
              <div className="flex gap-1">
                <Button variant="ghost" size="sm" onClick={() => setEditing(b)}>
                  <Pencil className="h-4 w-4" />
                  Change
                </Button>
                {b.used + b.onOrder === 0 && (
                  <Button variant="ghost" size="sm" className="text-red-700 dark:text-red-400" onClick={() => void confirmRemove(b)}>
                    <Trash2 className="h-4 w-4" />
                    Delete
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-3 text-sm text-stone-500">
        Which voucher was used, when and on which order:{' '}
        <Link to="/vouchers" className="font-semibold text-amber-700 hover:underline dark:text-amber-300">
          the Vouchers page
        </Link>
        .
      </p>

      {adding && <VoucherBatchDialog onClose={() => setAdding(false)} onSaved={() => setAdding(false)} />}
      {editing && <VoucherBatchDialog batch={editing} onClose={() => setEditing(null)} onSaved={() => setEditing(null)} />}
    </Card>
  );
}
