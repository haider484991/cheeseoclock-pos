import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Dialog from '@radix-ui/react-dialog';
import { Button, cn } from '@cheeseoclock/ui';
import { Banknote, BookOpenCheck, ChevronRight, Clock, Wallet, X } from 'lucide-react';
import { formatCents } from '@cheeseoclock/pos-domain';
import { ipc } from '../../ipc/client';
import { useToast } from '../../components/toast/ToastProvider';
import { useSessionStore } from '../../stores/sessionStore';
import { CashMovementDialog } from './CashMovementDialog';

/**
 * TopBar shift widget. Shows current shift status; lets manager open/close.
 *  - No shift open → grey pill "Open shift" → opens OpenShiftDialog.
 *  - Shift open → green pill with elapsed time + manager-only Close button.
 *  - Cashier-role: read-only; can see "Shift open" but can't open/close.
 */
export function ShiftWidget() {
  const can = useSessionStore((s) => s.can);
  const canOpen = can('shift.open');
  const canClose = can('shift.close');
  const [openDlg, setOpenDlg] = useState<'open' | 'close' | 'cash' | null>(null);

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
          disabled={!canOpen}
          onClick={() => setOpenDlg('open')}
          title={canOpen ? 'Open a shift to start tracking cash' : 'Manager must open the shift'}
          className={cn(
            'flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-semibold transition-colors',
            'bg-stone-100 text-stone-600 hover:bg-amber-100 hover:text-amber-800 dark:bg-stone-800 dark:hover:bg-amber-950 dark:hover:text-amber-200',
            !canOpen && 'cursor-not-allowed opacity-60 hover:bg-stone-100 hover:text-stone-600',
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
        disabled={!canClose}
        onClick={() => canClose && setOpenDlg('close')}
        title={canClose ? 'Close shift + count cash' : 'Manager must close the shift'}
        className={cn(
          'flex items-center gap-1.5 rounded-xl px-3 py-1.5 text-xs font-semibold transition-colors',
          'bg-emerald-100 text-emerald-800 hover:bg-emerald-200 dark:bg-emerald-950/50 dark:text-emerald-200 dark:hover:bg-emerald-900/60',
          !canClose && 'cursor-default hover:bg-emerald-100 dark:hover:bg-emerald-950/50',
        )}
      >
        <span className="flex h-2 w-2 rounded-full bg-emerald-500" />
        Shift {elapsed}
        {canClose && <ChevronRight className="h-3 w-3" />}
      </button>
      <button
        type="button"
        onClick={() => setOpenDlg('cash')}
        title="Cash in / out of the drawer (not a sale)"
        aria-label="Drawer cash in or out"
        className="flex items-center rounded-xl bg-stone-100 px-2 py-1.5 text-stone-600 transition-colors hover:bg-amber-100 hover:text-amber-800 dark:bg-stone-800 dark:text-stone-300 dark:hover:bg-amber-950 dark:hover:text-amber-200"
      >
        <Wallet className="h-3.5 w-3.5" />
      </button>
      {openDlg === 'cash' && (
        <CashMovementDialog shiftId={shift.id} onClose={() => setOpenDlg(null)} />
      )}
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
  // The float starts from what the last shift on this till counted: the cash
  // that stayed in the drawer overnight. Typed in fresh every morning, it was
  // routinely left at 0 and the whole float showed up as "over" at close.
  const lastQ = useQuery({ queryKey: ['shifts', 'lastCount'], queryFn: () => ipc.shifts.lastCount() });
  const last = lastQ.data;
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (last && !touched) setOpening(String(last.countedCashCents / 100));
  }, [last, touched]);

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
              {last && (
                <span className="mb-1 block text-xs text-stone-500">
                  The last shift closed with {formatCents(last.countedCashCents)} in the drawer. Count
                  it again and change this if it is different.
                </span>
              )}
              <input
                inputMode="decimal"
                value={opening}
                onChange={(e) => {
                  setTouched(true);
                  setOpening(e.target.value);
                }}
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
  // A blind count: what the drawer should hold is shown only once the count
  // is in. Showing it first let a cashier type the expected figure and hide a
  // shortage (audit 2026-09-25).
  const [result, setResult] = useState<{ expected: number; counted: number; variance: number } | null>(null);
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
    onSuccess: (shift) => {
      toast({ title: 'Shift closed', description: 'Cash drawer reconciliation saved.' });
      void qc.invalidateQueries({ queryKey: ['shifts'] });
      setResult({
        expected: shift.expectedCashCents ?? 0,
        counted: shift.countedCashCents ?? 0,
        variance: shift.varianceCents ?? 0,
      });
    },
    onError: (e) =>
      toast({
        title: 'Could not close shift',
        description: e instanceof Error ? e.message : 'Unknown error',
        variant: 'error',
      }),
  });

  const variance = result?.variance ?? null;

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
                {result && (
                  <>
                    <Row k="Cash sales" v={formatCents(summary.cashSalesCents)} />
                    <Row k="Cash refunds" v={`− ${formatCents(summary.cashRefundsCents)}`} />
                    {summary.cashInCents > 0 && (
                      <Row k="Cash put in" v={`+ ${formatCents(summary.cashInCents)}`} />
                    )}
                    {summary.cashOutCents > 0 && (
                      <Row k="Cash taken out" v={`− ${formatCents(summary.cashOutCents)}`} />
                    )}
                    <div className="mt-1 flex justify-between border-t border-emerald-200 pt-1 font-bold dark:border-emerald-800">
                      <dt>Expected cash</dt>
                      <dd className="font-mono">{formatCents(result.expected)}</dd>
                    </div>
                    <Row k="Counted" v={formatCents(result.counted)} />
                  </>
                )}
              </dl>
            </div>
          )}

          <div className="space-y-3">
            {!result && (
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
            )}
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
            {!result && (
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
            )}
          </div>

          {result ? (
            <div className="mt-5 flex">
              <Button variant="primary" size="md" className="flex-1" onClick={onClose}>
                Done
              </Button>
            </div>
          ) : (
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
          )}
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
