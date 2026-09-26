import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Dialog from '@radix-ui/react-dialog';
import { Button, cn } from '@cheeseoclock/ui';
import { ArrowDownToLine, ArrowUpFromLine, Bike, Wallet, X } from 'lucide-react';
import { formatCents } from '@cheeseoclock/pos-domain';
import type { CashMovementType } from '@cheeseoclock/shared-types';
import { ipc } from '../../ipc/client';
import { useToast } from '../../components/toast/ToastProvider';
import { useSessionStore } from '../../stores/sessionStore';
import { SecretInput } from '../../components/secret/SecretInput';
import { SecretHint } from '../../components/secret/SecretHint';
import { secretReady } from '../../components/secret/secretRules';

const TYPES: Array<{ id: CashMovementType; label: string; hint: string; icon: typeof Wallet }> = [
  { id: 'payout', label: 'Cash out', hint: 'Supplier, gas, an expense', icon: ArrowUpFromLine },
  { id: 'payin', label: 'Cash in', hint: 'Change from the bank', icon: ArrowDownToLine },
  { id: 'tip_out', label: 'Rider tip', hint: 'Tip handed to a rider', icon: Bike },
];

/**
 * Cash into / out of the drawer that is not a sale. Without it every note
 * paid to a supplier from the till showed up as a shortage at close. A
 * cashier needs a manager's PIN; the list shows what this shift has recorded.
 */
export function CashMovementDialog({ shiftId, onClose }: { shiftId: string; onClose: () => void }) {
  const canDirect = useSessionStore((s) => s.can('cash.movement'));
  const [type, setType] = useState<CashMovementType>('payout');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [pin, setPin] = useState('');
  const { toast } = useToast();
  const qc = useQueryClient();

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
            <label className="block text-sm">
              <span className="mb-1 block font-medium text-stone-700 dark:text-stone-200">
                What was it for?
              </span>
              <input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder={
                  type === 'payin' ? 'Change from the bank' : type === 'tip_out' ? 'Tip for Ali' : 'Gas cylinder'
                }
                className="w-full rounded-lg border border-stone-200 px-3 py-2 text-sm focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200 dark:border-stone-700 dark:bg-stone-800"
              />
            </label>
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
              onClick={() => saveMut.mutate()}
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
                    <span
                      className={cn(
                        'shrink-0 font-mono',
                        m.type === 'payin'
                          ? 'text-emerald-700 dark:text-emerald-300'
                          : 'text-red-700 dark:text-red-300',
                      )}
                    >
                      {m.type === 'payin' ? '+' : '−'} {formatCents(m.amountCents)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
