import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Copy, Pencil, Plus, Ticket, Trash2 } from 'lucide-react';
import { Button, Card, cn } from '@cheeseoclock/ui';
import { formatCents, voucherNumberText } from '@cheeseoclock/pos-domain';
import type { VoucherBatchSummary, VoucherRow, VoucherState } from '@cheeseoclock/shared-types';
import { ipc } from '../../ipc/client';
import { useToast } from '../../components/toast/ToastProvider';
import { askConfirm } from '../../components/confirm/ConfirmHost';
import { FilterChips, SearchBox, type ChipOption } from '../../components/list';
import { fmtWhen } from '../reports/reportFormat';
import { VoucherBatchDialog } from './VoucherBatchDialog';
import {
  batchCountWords,
  batchNumbersWords,
  batchTermsWords,
  VOUCHER_STATE_WORDS,
  voucherListText,
  voucherMatches,
} from './voucherPageWords';

type StateFilter = 'all' | VoucherState;

const PILL: Record<VoucherState, string> = {
  not_used: 'bg-stone-100 text-stone-600 ring-stone-200 dark:bg-stone-800 dark:text-stone-300 dark:ring-stone-700',
  on_order: 'bg-amber-50 text-amber-800 ring-amber-200 dark:bg-amber-950 dark:text-amber-200 dark:ring-amber-800',
  used: 'bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-950 dark:text-emerald-300 dark:ring-emerald-900',
};

const shortNo = (orderNumber: string) => `#${orderNumber.split('-').pop()}`;

/**
 * Vouchers (v0.7.48; the owner, 12 Oct 2026: "we are giving these vouchers
 * to abhi company … add it to pos system so we can track it"). Each client's
 * vouchers, and for each one what the paper log at the counter used to say:
 * used or not, when, on which order, on what, and who put it on. Read from
 * the orders themselves, so cancelling an order frees its voucher here too.
 * The owner's and the managers'.
 */
export function VouchersPage() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [picked, setPicked] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<VoucherBatchSummary | null>(null);
  const [query, setQuery] = useState('');
  const [state, setState] = useState<StateFilter>('all');

  const batchesQ = useQuery({ queryKey: ['vouchers', 'batches'], queryFn: () => ipc.vouchers.listBatches() });
  const batches = batchesQ.data ?? [];
  const batchId = picked && batches.some((b) => b.id === picked) ? picked : (batches[0]?.id ?? null);
  const detailQ = useQuery({
    queryKey: ['vouchers', 'batch', batchId],
    queryFn: () => ipc.vouchers.getBatch(batchId!),
    enabled: batchId !== null,
  });
  const detail = detailQ.data && detailQ.data.batch.id === batchId ? detailQ.data : null;

  const remove = useMutation({
    mutationFn: (id: string) => ipc.vouchers.removeBatch(id),
    onSuccess: () => {
      setPicked(null);
      void qc.invalidateQueries({ queryKey: ['vouchers'] });
      toast({ title: 'Vouchers deleted', variant: 'success' });
    },
    onError: (e: unknown) =>
      toast({ title: 'Could not delete the vouchers', description: e instanceof Error ? e.message : 'Unknown error', variant: 'error' }),
  });

  const searched = useMemo(() => (detail?.vouchers ?? []).filter((v) => voucherMatches(v, query)), [detail, query]);
  const shown = state === 'all' ? searched : searched.filter((v) => v.state === state);
  const chips: ChipOption<StateFilter>[] = [
    { id: 'all', label: 'All', count: searched.length },
    { id: 'not_used', label: 'Not used', count: searched.filter((v) => v.state === 'not_used').length },
    { id: 'on_order', label: 'On an order', count: searched.filter((v) => v.state === 'on_order').length, tone: 'amber' },
    { id: 'used', label: 'Used', count: searched.filter((v) => v.state === 'used').length, tone: 'green' },
  ];
  const twice = (detail?.vouchers ?? []).filter((v) => v.alsoOn.length > 0);

  async function copyList(rows: readonly VoucherRow[]) {
    try {
      await navigator.clipboard.writeText(voucherListText(rows));
      toast({ title: `${rows.length} vouchers copied`, description: 'One a line: number then code.', variant: 'success' });
    } catch {
      toast({ title: 'Could not copy the list', variant: 'error' });
    }
  }

  async function confirmRemove(b: VoucherBatchSummary) {
    const yes = await askConfirm(`Delete the ${b.count} vouchers for ${b.name}? They can't be used at the till after this.`, {
      yesLabel: 'Delete them',
      noLabel: 'Keep them',
    });
    if (yes) remove.mutate(b.id);
  }

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Vouchers</h1>
          <p className="mt-1 text-sm text-stone-500">
            Vouchers a client bought to hand out. Each is used once at the till (Use a voucher), and shows here with its order.
          </p>
        </div>
        <Button onClick={() => setAdding(true)}>
          <Plus className="h-4 w-4" />
          Add vouchers
        </Button>
      </header>

      {batchesQ.isLoading ? (
        <Card>
          <div className="py-10 text-center text-sm text-stone-400">Loading…</div>
        </Card>
      ) : batchesQ.isError ? (
        <Card>
          <div className="py-10 text-center text-sm text-red-600">Could not load the vouchers.</div>
        </Card>
      ) : batches.length === 0 ? (
        <Card>
          <div className="py-10 text-center">
            <Ticket className="mx-auto mb-3 h-10 w-10 text-stone-300" />
            <p className="text-sm text-stone-500">No vouchers yet.</p>
            <p className="mt-1 text-xs text-stone-400">Add a client’s vouchers: paste the printed list, or let the till make the codes.</p>
          </div>
        </Card>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {batches.map((b) => (
              <button
                key={b.id}
                type="button"
                onClick={() => setPicked(b.id)}
                aria-pressed={b.id === batchId}
                className={cn(
                  'rounded-2xl border bg-white p-4 text-left shadow-soft transition dark:bg-stone-900',
                  b.id === batchId ? 'border-amber-500 ring-2 ring-amber-200 dark:ring-amber-800' : 'border-stone-200 hover:border-stone-400 dark:border-stone-700',
                )}
              >
                <div className="flex items-center gap-2">
                  <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300">
                    <Ticket className="h-4 w-4" />
                  </span>
                  <span className="text-lg font-bold">{b.name}</span>
                  <span className="ml-auto text-xs text-stone-500">{batchNumbersWords(b)}</span>
                </div>
                <p className="mt-1 text-sm text-stone-600 dark:text-stone-300">{b.gives}</p>
                <div className="mt-3 h-2 overflow-hidden rounded-full bg-stone-100 dark:bg-stone-800" aria-hidden="true">
                  <div className="h-full bg-emerald-500" style={{ width: `${b.count > 0 ? (b.used / b.count) * 100 : 0}%` }} />
                </div>
                <p className="mt-2 text-sm font-semibold">{batchCountWords(b)}</p>
                <p className="mt-0.5 text-xs text-stone-500">{batchTermsWords(b)}</p>
              </button>
            ))}
          </div>

          {detail && (
            <Card>
              <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-xl font-bold">
                    {detail.batch.name} · {batchNumbersWords(detail.batch)}
                  </h2>
                  <p className="text-sm text-stone-500">
                    {detail.batch.gives} · {batchTermsWords(detail.batch)}
                    {detail.batch.createdByName && ` · added by ${detail.batch.createdByName} on ${fmtWhen(detail.batch.createdAt)}`}
                  </p>
                </div>
                <div className="flex gap-1">
                  <Button variant="ghost" size="sm" onClick={() => void copyList(detail.vouchers)} title="Copy the list: number then code, one a line">
                    <Copy className="h-4 w-4" />
                    Copy list
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setEditing(detail.batch)}>
                    <Pencil className="h-4 w-4" />
                    Change
                  </Button>
                  {detail.batch.used + detail.batch.onOrder === 0 && (
                    <Button variant="ghost" size="sm" className="text-red-700 dark:text-red-400" onClick={() => void confirmRemove(detail.batch)}>
                      <Trash2 className="h-4 w-4" />
                      Delete
                    </Button>
                  )}
                </div>
              </div>

              {twice.length > 0 && (
                <p className="mb-3 flex items-start gap-2 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-900 ring-1 ring-red-200 dark:bg-red-950 dark:text-red-100 dark:ring-red-800">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                  {twice.length === 1 ? 'One voucher was' : `${twice.length} vouchers were`} used on two orders (the two tills both took it while
                  the link between them was down): No. {twice.map((v) => voucherNumberText(v.number)).join(', ')}. Check those orders.
                </p>
              )}

              <div className="mb-3 flex flex-wrap items-center gap-2">
                <SearchBox value={query} onChange={setQuery} placeholder="Number, code or order…" label="Search vouchers" />
                <FilterChips label="Voucher status" options={chips} value={state} onChange={setState} />
              </div>

              <div className="overflow-x-auto rounded-xl border border-stone-200 dark:border-stone-700">
                <table className="w-full text-sm">
                  <thead className="bg-stone-50 text-left text-xs uppercase tracking-wider text-stone-500 dark:bg-stone-800">
                    <tr>
                      <th className="px-4 py-2 font-semibold">No.</th>
                      <th className="px-4 py-2 font-semibold">Code</th>
                      <th className="px-4 py-2 font-semibold">Status</th>
                      <th className="px-4 py-2 font-semibold">Date</th>
                      <th className="px-4 py-2 font-semibold">Order</th>
                      <th className="px-4 py-2 font-semibold">Item</th>
                      <th className="px-4 py-2 font-semibold">Customer</th>
                      <th className="px-4 py-2 font-semibold">Staff</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-stone-100 dark:divide-stone-700">
                    {shown.map((v) => (
                      <tr key={v.id} className={cn(v.alsoOn.length > 0 && 'bg-red-50/60 dark:bg-red-950/40')}>
                        <td className="px-4 py-2 font-mono font-bold">{voucherNumberText(v.number)}</td>
                        <td className="px-4 py-2 font-mono font-semibold tracking-wider">{v.code}</td>
                        <td className="px-4 py-2">
                          <span className={cn('inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ring-1', PILL[v.state])}>
                            {VOUCHER_STATE_WORDS[v.state]}
                            {v.use?.refunded ? ' · refunded' : ''}
                          </span>
                        </td>
                        <td className="px-4 py-2 text-stone-600 dark:text-stone-300">{v.use ? fmtWhen(v.use.paidAt ?? v.use.at) : '—'}</td>
                        <td className="px-4 py-2 font-mono">
                          {v.use ? shortNo(v.use.orderNumber) : '—'}
                          {v.alsoOn.map((u) => (
                            <span key={u.orderId} className="ml-1 text-red-700 dark:text-red-300">
                              + {shortNo(u.orderNumber)}
                            </span>
                          ))}
                        </td>
                        <td className="px-4 py-2">
                          {v.use?.item ?? '—'}
                          {v.use && <span className="ml-1 text-xs text-stone-500">(−{formatCents(v.use.amountCents)})</span>}
                        </td>
                        <td className="px-4 py-2 text-stone-600 dark:text-stone-300">
                          {v.use ? [v.use.customerName, v.use.customerPhone].filter(Boolean).join(' · ') || '—' : '—'}
                        </td>
                        <td className="px-4 py-2 text-stone-600 dark:text-stone-300">{v.use?.staffName ?? '—'}</td>
                      </tr>
                    ))}
                    {shown.length === 0 && (
                      <tr>
                        <td colSpan={8} className="px-4 py-6 text-center text-sm text-stone-500">
                          No vouchers match.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </>
      )}

      {adding && (
        <VoucherBatchDialog
          onClose={() => setAdding(false)}
          onSaved={(b) => {
            setAdding(false);
            setPicked(b.id);
          }}
        />
      )}
      {editing && <VoucherBatchDialog batch={editing} onClose={() => setEditing(null)} onSaved={() => setEditing(null)} />}
    </div>
  );
}
