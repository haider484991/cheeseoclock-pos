import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, cn } from '@cheeseoclock/ui';
import { Lock, Waypoints } from 'lucide-react';
import { CAME_BY_CHOICES, CAME_BY_LABEL, isCameBy, type CameBy, type OrderSnapshot } from '@cheeseoclock/shared-types';
import { ipc, IpcError } from '../../ipc/client';
import { useToast } from '../../components/toast/ToastProvider';
import { SecretInput } from '../../components/secret/SecretInput';
import { approvalProblem, secretReady } from '../../components/secret/secretRules';

/** "Came in by WhatsApp", "Came in by: not asked" — a website or foodpanda order says so itself. */
export function cameByWords(cameBy: string | null | undefined): string {
  if (cameBy && cameBy in CAME_BY_LABEL) return `Came in by ${CAME_BY_LABEL[cameBy as keyof typeof CAME_BY_LABEL]}`;
  return 'How it came in: not asked';
}

/**
 * How a counter order came in, in the order drawer (Walk-in · Phone ·
 * WhatsApp). It was locked when the order was sent (the owner's automatic
 * offers depend on it): changing it now needs a manager's PIN or password,
 * the till keeps an audit row, and the bill does not change. A website or
 * foodpanda order says how it came in itself, so it has no row here.
 */
export function CameByRow({ snap }: { snap: OrderSnapshot }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const o = snap.order;
  const [editing, setEditing] = useState(false);
  const [pick, setPick] = useState<CameBy | null>(isCameBy(o.cameBy) ? o.cameBy : null);
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const change = useMutation({
    mutationFn: (v: { cameBy: CameBy; approverPin: string }) => ipc.orders.setCameBy({ orderId: o.id, ...v }),
    onSuccess: () => {
      setEditing(false);
      setPin('');
      toast({ title: 'Saved', description: 'How the order came in was changed. The bill stays as it was.', variant: 'success' });
      void qc.invalidateQueries({ queryKey: ['orders'] });
      void qc.invalidateQueries({ queryKey: ['reports'] });
    },
    onError: (e: unknown) => setError(e instanceof IpcError ? e.message : String(e)),
  });

  if (o.source !== 'pos' || o.mode === 'foodpanda' || o.status === 'open') return null;
  const same = pick === (isCameBy(o.cameBy) ? o.cameBy : null);

  function save() {
    if (!pick) {
      setError('Pick how the order came in.');
      return;
    }
    if (!secretReady(pin)) {
      setError(pin.trim() ? approvalProblem(pin) : "A manager's PIN or password is needed.");
      return;
    }
    setError(null);
    change.mutate({ cameBy: pick, approverPin: pin });
  }

  return (
    <section className="rounded-xl bg-stone-50 p-3 text-sm dark:bg-stone-800/60" aria-label="How the order came in">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-1.5">
          <Waypoints className="h-3.5 w-3.5 text-stone-400" aria-hidden="true" />
          {cameByWords(o.cameBy)}
        </span>
        {!editing && (
          <button type="button" className="text-xs font-medium text-stone-600 underline dark:text-stone-300" onClick={() => setEditing(true)}>
            Change (manager)
          </button>
        )}
      </div>
      {editing && (
        <div className="mt-2 space-y-2">
          <p className="text-xs text-stone-500">
            Locked when the order was sent. A manager’s PIN or password changes it; the till keeps a record, and the bill does not change.
          </p>
          <div className="grid grid-cols-3 gap-1.5" role="group" aria-label="How the order came in">
            {CAME_BY_CHOICES.map((c) => (
              <button
                key={c}
                type="button"
                aria-pressed={pick === c}
                onClick={() => setPick(c)}
                className={cn(
                  'h-9 rounded-lg border text-xs font-semibold',
                  pick === c ? 'border-amber-500 bg-amber-50 dark:bg-amber-950' : 'border-stone-200 dark:border-stone-700',
                )}
              >
                {CAME_BY_LABEL[c]}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-2">
            <Lock className="h-3.5 w-3.5 shrink-0 text-amber-700" aria-hidden="true" />
            <SecretInput value={pin} onChange={setPin} wrapperClassName="min-w-0 flex-1" className="h-9 min-w-0 flex-1 rounded-lg border border-stone-300 px-2 font-mono dark:border-stone-700 dark:bg-stone-900" />
          </label>
          {error && (
            <p role="alert" className="text-xs font-semibold text-red-600">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={() => { setEditing(false); setError(null); setPin(''); }}>
              Cancel
            </Button>
            <Button size="sm" disabled={same || change.isPending} onClick={save}>
              {change.isPending ? 'Saving…' : 'Save'}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
