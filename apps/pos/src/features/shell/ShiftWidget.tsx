import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Dialog from '@radix-ui/react-dialog';
import { Button, cn } from '@cheeseoclock/ui';
import { Banknote, BookOpenCheck, ChevronRight, Clock, X } from 'lucide-react';
import { formatCents } from '@cheeseoclock/pos-domain';
import { ipc } from '../../ipc/client';
import { useToast } from '../../components/toast/ToastProvider';
import { useSessionStore } from '../../stores/sessionStore';

/**
 * TopBar shift widget. Shows current shift status; lets manager open/close.
 *  - No shift open → grey pill "Open shift" → opens OpenShiftDialog.
 *  - Shift open → green pill with elapsed time + manager-only Close button.
 *  - Cashier-role: read-only; can see "Shift open" but can't open/close.
 */
export function ShiftWidget() {
  const can = useSessionStore((s) => s.can);
  const canManage = can('settings.manage');
  const [openDlg, setOpenDlg] = useState<'open' | 'close' | null>(null);

  const shiftQ = useQuery({
    queryKey: ['shifts', 'current'],
    queryFn: () => ipc.shifts.current(),
    refetchInterval: 30_000,
  });
  const shift = shiftQ.data;

  if (shiftQ.isLoading) {
    return (
      <span className="flex items-center gap-1.5 rounded-xl bg-stone-100 px-3 py-1.5 text-xs text-stone-500 dark:bg-stone-800">
        <Clock className="h-3.5 w-3.5" />
        …
      </span>
    );
  }

  if (!shift) {
    return (
      <>
        <button
          type="button"
          disabled={!canManage}
          onClick={() => setOpenDlg('open')}
          title={canManage ? 'Open a shift to start tracking cash' : 'Manager must open the shift'}
          className={cn(
            'flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-semibold transition-colors',
            'bg-stone-100 text-stone-600 hover:bg-amber-100 hover:text-amber-800 dark:bg-stone-800 dark:hover:bg-amber-950 dark:hover:text-amber-200',
            !canManage && 'cursor-not-allowed opacity-60 hover:bg-stone-100 hover:text-stone-600',
          )}
        >
          <Clock className="h-3.5 w-3.5" />
          Open shift
        </button>
        {openDlg === 'open' && <OpenShiftDialog onClose={() => setOpenDlg(null)} />}
      </>
    );
  }

  const elapsed = formatElapsed(shift.openedAt);

  return (
    <>
      <button
        type="button"
        disabled={!canManage}
        onClick={() => canManage && setOpenDlg('close')}
        title={canManage ? 'Close shift + count cash' : 'Manager must close the shift'}
        className={cn(
          'flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-semibold transition-colors',
          'bg-emerald-100 text-emerald-800 hover:bg-emerald-200 dark:bg-emerald-950/50 dark:text-emerald-200 dark:hover:bg-emerald-900/60',
          !canManage && 'cursor-default hover:bg-emerald-100 dark:hover:bg-emerald-950/50',
        )}
      >
        <span className="flex h-2 w-2 rounded-full bg-emerald-500" />
        Shift {elapsed}
        {canManage && <ChevronRight className="h-3 w-3" />}
      </button>
      {openDlg === 'close' && (
        <CloseShiftDialog shiftId={shift.id} onClose={() => setOpenDlg(null)} />
      )}
    </>
  );
}

function formatElapsed(openedAtIso: string): string {
  const ms = Date.now() - new Date(openedAtIso).getTime();
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  const rem = min - h * 60;
  return rem === 0 ? `${h}h` : `${h}h ${rem}m`;
}

// ---------------------------------------------------------------------------
// Open shift dialog
// ---------------------------------------------------------------------------

function OpenShiftDialog({ onClose }: { onClose: () => void }) {
  const [opening, setOpening] = useState('0');
  const [notes, setNotes] = useState('');
  const { toast } = useToast();
  const qc = useQueryClient();

  const openMut = useMutation({
    mutationFn: () =>
      ipc.shifts.open({
        openingCashCents: Math.round((parseFloat(opening) || 0) * 100),
        notes: notes.trim() || null,
      }),
    onSuccess: () => {
      toast({ title: 'Shift opened', description: 'New orders will be linked to this shift.' });
      void qc.invalidateQueries({ queryKey: ['shifts'] });
      onClose();
    },
    onError: (e) =>
      toast({
        title: 'Could not open shift',
        description: e instanceof Error ? e.message : 'Unknown error',
        variant: 'error',
      }),
  });

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[420px] -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-white p-5 shadow-soft-lg dark:bg-stone-900">
          <header className="mb-4 flex items-start justify-between gap-3">
            <div className="flex items-start gap-2">
              <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-200">
                <BookOpenCheck className="h-4 w-4" />
              </span>
              <div>
                <Dialog.Title className="text-lg font-semibold">Open shift</Dialog.Title>
                <Dialog.Description className="mt-0.5 text-xs text-stone-500">
                  Count the cash in the drawer right now — this is the opening float.
                </Dialog.Description>
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded p-1 text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-800"
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </button>
          </header>

          <div className="space-y-3">
            <label className="block text-sm">
              <span className="mb-1 block font-medium text-stone-700 dark:text-stone-200">
                Opening cash (Rs)
              </span>
              <input
                inputMode="decimal"
                value={opening}
                onChange={(e) => setOpening(e.target.value)}
                autoFocus
                className="w-full rounded-lg border border-stone-200 px-3 py-2 text-right font-mono text-lg focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200 dark:border-stone-700 dark:bg-stone-800"
              />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block font-medium text-stone-700 dark:text-stone-200">
                Notes (optional)
              </span>
              <input
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Morning shift, Ali on register…"
                className="w-full rounded-lg border border-stone-200 px-3 py-2 text-sm focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200 dark:border-stone-700 dark:bg-stone-800"
              />
            </label>
          </div>

          <div className="mt-5 flex gap-2">
            <Button variant="ghost" size="md" className="flex-1" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="success"
              size="md"
              className="flex-1"
              onClick={() => openMut.mutate()}
              disabled={openMut.isPending}
            >
              {openMut.isPending ? 'Opening…' : 'Open shift'}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// ---------------------------------------------------------------------------
// Close shift dialog
// ---------------------------------------------------------------------------

function CloseShiftDialog({ shiftId, onClose }: { shiftId: string; onClose: () => void }) {
  const [counted, setCounted] = useState('');
  const [notes, setNotes] = useState('');
  const { toast } = useToast();
  const qc = useQueryClient();

  const summaryQ = useQuery({
    queryKey: ['shifts', 'summary', shiftId],
    queryFn: () => ipc.shifts.summary(shiftId),
  });
  const summary = summaryQ.data;

  const closeMut = useMutation({
    mutationFn: () =>
      ipc.shifts.close({
        shiftId,
        countedCashCents: Math.round((parseFloat(counted) || 0) * 100),
        notes: notes.trim() || null,
      }),
    onSuccess: () => {
      toast({ title: 'Shift closed', description: 'Cash drawer reconciliation saved.' });
      void qc.invalidateQueries({ queryKey: ['shifts'] });
      onClose();
    },
    onError: (e) =>
      toast({
        title: 'Could not close shift',
        description: e instanceof Error ? e.message : 'Unknown error',
        variant: 'error',
      }),
  });

  const countedCents =
    counted === '' ? null : Math.round((parseFloat(counted) || 0) * 100);
  const variance =
    countedCents !== null && summary ? countedCents - summary.expectedCashCents : null;

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[460px] -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-white p-5 shadow-soft-lg dark:bg-stone-900">
          <header className="mb-4 flex items-start justify-between gap-3">
            <div className="flex items-start gap-2">
              <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-200">
                <Banknote className="h-4 w-4" />
              </span>
              <div>
                <Dialog.Title className="text-lg font-semibold">Close shift</Dialog.Title>
                <Dialog.Description className="mt-0.5 text-xs text-stone-500">
                  Count cash in the drawer and enter the actual total below.
                </Dialog.Description>
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded p-1 text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-800"
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </button>
          </header>

          {summary && (
            <div className="mb-3 rounded-xl bg-emerald-50 p-3 text-sm dark:bg-emerald-950/30">
              <dl className="space-y-0.5 text-emerald-900 dark:text-emerald-100">
                <Row k="Paid orders" v={String(summary.paidOrderCount)} />
                <Row k="Refunds" v={String(summary.refundedOrderCount)} />
                <Row k="Cash sales" v={formatCents(summary.cashSalesCents)} />
                <Row k="Cash refunds" v={`− ${formatCents(summary.cashRefundsCents)}`} />
                <div className="mt-1 flex justify-between border-t border-emerald-200 pt-1 font-bold dark:border-emerald-800">
                  <dt>Expected cash</dt>
                  <dd className="font-mono">{formatCents(summary.expectedCashCents)}</dd>
                </div>
              </dl>
            </div>
          )}

          <div className="space-y-3">
            <label className="block text-sm">
              <span className="mb-1 block font-medium text-stone-700 dark:text-stone-200">
                Counted cash in drawer (Rs)
              </span>
              <input
                inputMode="decimal"
                value={counted}
                onChange={(e) => setCounted(e.target.value)}
                placeholder="0"
                autoFocus
                className="w-full rounded-lg border border-stone-200 px-3 py-2 text-right font-mono text-lg focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200 dark:border-stone-700 dark:bg-stone-800"
              />
            </label>
            {variance !== null && (
              <div
                className={cn(
                  'rounded-lg p-3 text-sm',
                  variance === 0
                    ? 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-100'
                    : variance > 0
                    ? 'bg-amber-50 text-amber-900 dark:bg-amber-950/40 dark:text-amber-100'
                    : 'bg-red-50 text-red-800 dark:bg-red-950/40 dark:text-red-100',
                )}
              >
                <div className="flex items-baseline justify-between">
                  <span className="font-semibold">Variance</span>
                  <span className="font-mono text-xl">
                    {variance > 0 ? '+' : ''}
                    {formatCents(variance)}
                  </span>
                </div>
                <div className="mt-0.5 text-xs">
                  {variance === 0
                    ? 'Matches expected'
                    : variance > 0
                    ? 'Over (more than expected)'
                    : 'Short (less than expected)'}
                </div>
              </div>
            )}
            <label className="block text-sm">
              <span className="mb-1 block font-medium text-stone-700 dark:text-stone-200">
                Notes (optional)
              </span>
              <input
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Variance reason, cashier handover, etc."
                className="w-full rounded-lg border border-stone-200 px-3 py-2 text-sm focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200 dark:border-stone-700 dark:bg-stone-800"
              />
            </label>
          </div>

          <div className="mt-5 flex gap-2">
            <Button variant="ghost" size="md" className="flex-1" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              size="md"
              className="flex-1"
              onClick={() => closeMut.mutate()}
              disabled={closeMut.isPending || counted === ''}
            >
              {closeMut.isPending ? 'Closing…' : 'Close shift'}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="flex justify-between text-xs">
      <dt>{k}</dt>
      <dd className="font-mono">{v}</dd>
    </div>
  );
}
