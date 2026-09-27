import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, Card, cn } from '@cheeseoclock/ui';
import type { CostAlert } from '@cheeseoclock/shared-types';
import { BellRing, CheckCircle2, ChevronDown, ChevronRight, Eye, KeyRound, Soup, TrendingUp } from 'lucide-react';
import { ipc, IpcError } from '../../ipc/client';
import { useToast } from '../../components/toast/ToastProvider';
import { COSTING_KEY, useCostAlerts } from './costingQueries';
import { alertHeadline, alertMoves, alertSummary, moveText } from './alertWords';
import { openIngredientInInventory } from './deepLinks';

/**
 * Costing → Alerts (costing spec Phase 6): when a key ingredient's price
 * jumps, when a price change costs the menu real money each week, when a
 * batch made here kept an old price, and each Monday the dishes that price
 * changes moved across their target — in plain words, with what it costs
 * per week at this till's sales. Managers and the owner read them and mark
 * them seen; nothing here changes a price (that is Inventory).
 */
export function AlertsTab() {
  const q = useCostAlerts();
  const qc = useQueryClient();
  const { toast } = useToast();
  const seenMut = useMutation({
    mutationFn: (ids: string[]) => ipc.costing.markAlertsSeen(ids),
    onSuccess: (view) => {
      qc.setQueryData([...COSTING_KEY, 'alerts'], view);
    },
    onError: (e) => toast({ title: 'Could not mark it seen', description: e instanceof IpcError ? e.message : String(e), variant: 'error' }),
  });

  if (!q.data) {
    return <Card className="py-8 text-center text-stone-500">{q.isError ? 'Could not load the alerts.' : 'Loading…'}</Card>;
  }
  const unseen = q.data.alerts.filter((a) => a.seenAt === null);
  const seen = q.data.alerts.filter((a) => a.seenAt !== null);

  return (
    <div className="space-y-3">
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="max-w-2xl">
            <h2 className="font-semibold">Price alerts</h2>
            <p className="mt-0.5 text-sm text-stone-500">
              When a key ingredient&apos;s price jumps, or a price change costs your menu real money each week, it shows here:
              which dishes moved and what it costs per week at this till&apos;s sales. Every Monday, the dishes that price
              changes pushed over (or back under) their target. Change prices and thresholds in Inventory and Targets.
            </p>
          </div>
          {unseen.length > 1 && (
            <Button variant="secondary" size="sm" disabled={seenMut.isPending} onClick={() => seenMut.mutate(unseen.map((a) => a.id))}>
              <Eye className="h-4 w-4" /> Mark all {unseen.length} seen
            </Button>
          )}
        </div>
      </Card>

      {unseen.length === 0 && (
        <Card className="flex items-center gap-3 py-6">
          <CheckCircle2 className="h-6 w-6 text-emerald-600" />
          <div>
            <p className="font-semibold">Nothing new</p>
            <p className="text-sm text-stone-500">No price change since the last one you saw needs a look.</p>
          </div>
        </Card>
      )}

      {unseen.map((a) => (
        <AlertCard key={a.id} alert={a} onSeen={() => seenMut.mutate([a.id])} busy={seenMut.isPending} />
      ))}

      {seen.length > 0 && (
        <details className="rounded-xl border border-stone-200 p-3 dark:border-stone-800">
          <summary className="cursor-pointer text-sm font-medium text-stone-600 dark:text-stone-300">
            Seen ({seen.length})
          </summary>
          <div className="mt-3 space-y-3">
            {seen.map((a) => (
              <AlertCard key={a.id} alert={a} />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

const when = (iso: string) =>
  new Date(iso).toLocaleString('en-PK', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

function AlertIcon({ alert }: { alert: CostAlert }) {
  const d = alert.detail;
  const cls = 'h-5 w-5 flex-none';
  if (d?.kind === 'batch_unpriced_input') return <Soup className={cn(cls, 'text-amber-600')} />;
  if (d?.kind === 'weekly_digest') return <BellRing className={cn(cls, 'text-sky-600')} />;
  if (d?.kind === 'price_jump' && d.key) return <KeyRound className={cn(cls, 'text-red-600')} />;
  return <TrendingUp className={cn(cls, alert.impactWeekCents >= 0 ? 'text-red-600' : 'text-emerald-600')} />;
}

function AlertCard({ alert: a, onSeen, busy }: { alert: CostAlert; onSeen?: () => void; busy?: boolean }) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const moves = alertMoves(a);
  const d = a.detail;
  return (
    <Card className={cn(a.seenAt === null && 'border-l-4 border-l-amber-500')}>
      <div className="flex items-start gap-3">
        <AlertIcon alert={a} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="font-semibold">{alertHeadline(a)}</p>
            <span className="text-xs text-stone-500">
              {when(a.createdAt)}
              {a.seenAt && ` · seen${a.seenByName ? ` by ${a.seenByName}` : ''}`}
            </span>
          </div>
          <p className="mt-1 text-sm text-stone-600 dark:text-stone-300">{alertSummary(a)}</p>
          {open && moves.length > 0 && (
            <ul className="mt-2 space-y-1 border-l-2 border-stone-200 pl-3 text-sm dark:border-stone-700">
              {moves.map((m) => (
                <li key={m.menuItemId}>{moveText(m)}</li>
              ))}
              {d?.kind === 'price_jump' && d.itemsMoved > moves.length && (
                <li className="text-stone-500">…and {d.itemsMoved - moves.length} more</li>
              )}
            </ul>
          )}
          <div className="mt-2 flex flex-wrap gap-2">
            {moves.length > 0 && (
              <Button variant="secondary" size="sm" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
                {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />} {open ? 'Hide dishes' : 'Show dishes'}
              </Button>
            )}
            {d?.kind === 'batch_unpriced_input' &&
              d.unpricedInputs.map((i) => (
                <Button key={i.ingredientId} variant="secondary" size="sm" onClick={() => openIngredientInInventory(navigate, { id: i.ingredientId, name: i.name })}>
                  Set price: {i.name}
                </Button>
              ))}
            {d?.kind === 'price_jump' && (
              <Button variant="secondary" size="sm" onClick={() => openIngredientInInventory(navigate, { id: d.ingredientId, name: d.ingredientName })}>
                Check the price of {d.ingredientName}
              </Button>
            )}
            {onSeen && (
              <Button variant="primary" size="sm" disabled={busy} onClick={onSeen}>
                <Eye className="h-4 w-4" /> Seen
              </Button>
            )}
          </div>
        </div>
      </div>
    </Card>
  );
}
