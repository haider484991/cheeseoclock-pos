import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Dialog from '@radix-ui/react-dialog';
import { Button, cn } from '@cheeseoclock/ui';
import { ArrowDownToLine, ArrowUpFromLine, Bike, Wallet, X } from 'lucide-react';
import { formatCents } from '@cheeseoclock/pos-domain';
import { COST_CAPABILITY, type CashMovementType } from '@cheeseoclock/shared-types';
import { ipc } from '../../ipc/client';
import { useToast } from '../../components/toast/ToastProvider';
import { useSessionStore } from '../../stores/sessionStore';
import { SecretInput } from '../../components/secret/SecretInput';
import { SecretHint } from '../../components/secret/SecretHint';
import { secretReady } from '../../components/secret/secretRules';
import { RecordPurchaseDialog, type PayoutToConvert } from '../inventory/RecordPurchaseDialog';
import { useOrderReasons } from '../settings/shop-rules/useShopSetting';
import { askConfirm } from '../../components/confirm/ConfirmHost';
import {
  CASH_IN_EXAMPLE,
  CASH_IN_HINT,
  NOTE_CHANGE_TEXT,
  NOTE_CHANGE_TITLE,
  noteChangeQuestion,
  showsNoteChangeNote,
} from './noteChangeWords';

const TYPES: Array<{ id: CashMovementType; label: string; hint: string; icon: typeof Wallet }> = [
  { id: 'payout', label: 'Cash out', hint: 'Supplier, gas, an expense', icon: ArrowUpFromLine },
  { id: 'payin', label: 'Cash in', hint: CASH_IN_HINT, icon: ArrowDownToLine },
  { id: 'tip_out', label: 'Rider tip', hint: 'Tip handed to a rider', icon: Bike },
];

/**
 * Cash into / out of the drawer that is not a sale. Without it every note
 * paid to a supplier from the till showed up as a shortage at close. A
 * cashier needs a manager's PIN; the list shows what this shift has recorded.
 */
export function CashMovementDialog({ shiftId, onClose }: { shiftId: string; onClose: () => void }) {
  const canDirect = useSessionStore((s) => s.can('cash.movement'));
  // "Turn this payout into a purchase" (costing Phase 5): managers and the
  // owner only (the main process refuses the rest). Nothing changes for a cashier.
  const canPurchase = useSessionStore((s) => s.can(COST_CAPABILITY));
  const [converting, setConverting] = useState<PayoutToConvert | null>(null);
  const [type, setType] = useState<CashMovementType>('payout');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [pin, setPin] = useState('');
  const { toast } = useToast();
  const qc = useQueryClient();
  // The owner's "Cash out" buttons (Settings → Staff & kitchen): they fill the
  // box, and anything else can still be typed. None by default.
  const cashOutReasons = useOrderReasons().cashOut;

  const listQ = useQuery({
    queryKey: ['shifts', 'cashMovements', shiftId],
    queryFn: () => ipc.shifts.listCashMovements(shiftId),
  });

  const amountCents = Math.round((parseFloat(amount) || 0) * 100);
  const ready = amountCents > 0 && reason.trim() !== '' && (canDirect || secretReady(pin));

  const saveMut = useMutation({
    mutationFn: () =>
      ipc.shifts.recordCashMovement({
        type,
        amountCents,
        reason: reason.trim(),
        ...(canDirect ? {} : { approverPin: pin }),
      }),
    onSuccess: (m) => {
      toast({
        title: `${TYPES.find((t) => t.id === m.type)?.label ?? 'Cash'} recorded`,
        description: `${formatCents(m.amountCents)} — ${m.reason}`,
      });
      setAmount('');
      setReason('');
      setPin('');
      void qc.invalidateQueries({ queryKey: ['shifts'] });
    },
    onError: (e) =>
      toast({
        title: 'Could not record the cash',
        description: e instanceof Error ? e.message : 'Unknown error',
        variant: 'error',
      }),
  });

  const moves = listQ.data ?? [];

  // Breaking a note is not money in or out (noteChangeWords.ts): a reason about change asks first, in Roman Urdu.
  const record = async () => {
    const q = noteChangeQuestion(type, reason);
    if (q && !(await askConfirm(q.message, { yesLabel: q.yesLabel, noLabel: q.noLabel, safeDefault: true }))) return;
    saveMut.mutate();
  };

  return (
    <Dialog.Root open onOpenChange={(o) => !o && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[480px] -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-white p-5 shadow-soft-lg dark:bg-stone-900">
          <header className="mb-4 flex items-start justify-between gap-3">
            <div className="flex items-start gap-2">
              <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-200">
                <Wallet className="h-4 w-4" />
              </span>
              <div>
                <Dialog.Title className="text-lg font-semibold">Drawer cash in / out</Dialog.Title>
                <Dialog.Description className="mt-0.5 text-xs text-stone-500">
                  Money in or out of the drawer that is not a sale. It counts towards the
                  cash the drawer should hold at close.
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

          <div className="mb-3 grid grid-cols-3 gap-2">
            {TYPES.map((t) => {
              const Icon = t.icon;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setType(t.id)}
                  className={cn(
                    'flex flex-col items-center gap-0.5 rounded-lg border-2 p-2 text-center transition-colors',
                    type === t.id
                      ? 'border-amber-500 bg-amber-50 dark:bg-amber-950'
                      : 'border-stone-200 hover:border-stone-300 dark:border-stone-700',
                  )}
                >
                  <Icon className="h-4 w-4" />
                  <span className="text-sm font-semibold">{t.label}</span>
                  <span className="text-[10px] text-stone-500">{t.hint}</span>
                </button>
              );
            })}
          </div>

          <div className="space-y-3">
            <label className="block text-sm">
              <span className="mb-1 block font-medium text-stone-700 dark:text-stone-200">
                Amount (Rs)
              </span>
              <input
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))}
                autoFocus
                className="w-full rounded-lg border border-stone-200 px-3 py-2 text-right font-mono text-lg focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200 dark:border-stone-700 dark:bg-stone-800"
              />
            </label>
            <div className="block text-sm">
              <label htmlFor="cash-reason" className="mb-1 block font-medium text-stone-700 dark:text-stone-200">
                What was it for?
              </label>
              {type === 'payout' && cashOutReasons.length > 0 && (
                <div className="mb-1.5 flex flex-wrap gap-1.5">
                  {cashOutReasons.map((r) => (
                    <button
                      key={r}
                      type="button"
                      onClick={() => setReason(r)}
                      aria-pressed={reason === r}
                      className={cn(
                        'rounded-full px-2.5 py-1 text-xs font-medium ring-1 transition-colors',
                        reason === r
                          ? 'bg-amber-100 text-amber-900 ring-amber-300 dark:bg-amber-950 dark:text-amber-100 dark:ring-amber-700'
                          : 'bg-stone-50 text-stone-700 ring-stone-200 hover:bg-stone-100 dark:bg-stone-800 dark:text-stone-200 dark:ring-stone-700',
                      )}
                    >
                      {r}
                    </button>
                  ))}
                </div>
              )}
              <input
                id="cash-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder={
                  type === 'payin' ? CASH_IN_EXAMPLE : type === 'tip_out' ? 'Tip for Ali' : 'Gas cylinder'
                }
                className="w-full rounded-lg border border-stone-200 px-3 py-2 text-sm focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200 dark:border-stone-700 dark:bg-stone-800"
              />
            </div>
            {showsNoteChangeNote(type, reason) && (
              <div
                role="note"
                lang="ur-Latn"
                className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-700 dark:bg-amber-950"
              >
                <p className="font-semibold text-amber-900 dark:text-amber-100">{NOTE_CHANGE_TITLE}</p>
                <p className="mt-1 text-amber-900 dark:text-amber-100">{NOTE_CHANGE_TEXT}</p>
              </div>
            )}
            {!canDirect && (
              <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-700 dark:bg-amber-950">
                <div className="mb-2 text-sm font-semibold text-amber-900 dark:text-amber-100">
                  Manager approval required
                </div>
                <SecretInput
                  value={pin}
                  onChange={setPin}
                  aria-label="Manager PIN or password"
                  placeholder="Manager PIN or password"
                  className="min-w-0 flex-1 rounded-lg border border-amber-300 bg-white px-3 py-2 font-mono tracking-widest dark:border-amber-700 dark:bg-stone-900"
                />
                <SecretHint value={pin} className="mt-1" />
              </div>
            )}
          </div>

          <div className="mt-4 flex gap-2">
            <Button variant="ghost" size="md" className="flex-1" onClick={onClose}>
              Close
            </Button>
            <Button
              variant="primary"
              size="md"
              className="flex-1"
              disabled={!ready || saveMut.isPending}
              onClick={() => void record()}
            >
              {saveMut.isPending ? 'Saving…' : 'Record'}
            </Button>
          </div>

          {moves.length > 0 && (
            <div className="mt-4 border-t border-stone-200 pt-3 dark:border-stone-700">
              <div className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-stone-500">
                This shift
              </div>
              <ul className="max-h-40 space-y-1 overflow-y-auto text-sm">
                {moves.map((m) => (
                  <li key={m.id} className="flex items-baseline justify-between gap-2">
                    <span className="truncate">
                      <span className="text-stone-500">
                        {new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>{' '}
                      {m.reason}
                      {m.userName ? <span className="text-stone-400"> · {m.userName}</span> : null}
                    </span>
                    <span className="flex shrink-0 items-baseline gap-2">
                      {/* A payout to an outside rider for an order (his delivery charge or a
                          wasted trip, v0.7.34) bought nothing: the till refuses to make it a purchase. */}
                      {canPurchase && m.type === 'payout' && !m.orderId && (
                        m.refPurchaseOrderId ? (
                          <span className="text-[11px] font-semibold text-emerald-700 dark:text-emerald-300">a purchase</span>
                        ) : (
                          <button
                            type="button"
                            onClick={() =>
                              setConverting({ id: m.id, amountCents: m.amountCents, reason: m.reason, createdAt: m.createdAt, userName: m.userName })
                            }
                            className="text-[11px] font-semibold text-amber-700 underline hover:text-amber-900 dark:text-amber-300"
                          >
                            Turn into a purchase
                          </button>
                        )
                      )}
                      <span
                        className={cn(
                          'font-mono',
                          m.type === 'payin'
                            ? 'text-emerald-700 dark:text-emerald-300'
                            : 'text-red-700 dark:text-red-300',
                        )}
                      >
                        {m.type === 'payin' ? '+' : '−'} {formatCents(m.amountCents)}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {converting && <RecordPurchaseDialog payout={converting} onClose={() => setConverting(null)} />}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
