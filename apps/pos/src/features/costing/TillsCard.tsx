/**
 * Costing → Targets & fees: how many tills take orders at the shop (costing
 * spec Phase 8, owner question 3). Stock takes compare what was used with
 * what was sold; with two tills selling and the link between them off, the
 * other till's sales never reach this one, so "used vs should have used"
 * and the real food cost are switched off (costing spec D14). Managers see
 * it; only the owner (settings.manage) changes it — the main process
 * refuses anyone else.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Card, cn } from '@cheeseoclock/ui';
import { OTHER_TILL_MISSING, otherTillMissing, staleLinkText } from '@cheeseoclock/pos-domain';
import { Lock, MonitorSmartphone } from 'lucide-react';
import { ipc, IpcError } from '../../ipc/client';
import { useToast } from '../../components/toast/ToastProvider';
import { COSTING_KEY } from './costingQueries';

const TILLS_KEY = [...COSTING_KEY, 'tills'] as const;

export function TillsCard({ canEdit }: { canEdit: boolean }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const q = useQuery({ queryKey: TILLS_KEY, queryFn: () => ipc.costing.getTills(), staleTime: 0 });
  const mut = useMutation({
    mutationFn: (sellingTills: 1 | 2) => ipc.costing.setTills({ sellingTills }),
    onSuccess: () => {
      toast({ title: 'Saved', description: 'On both tills.', variant: 'success' });
      void qc.invalidateQueries({ queryKey: COSTING_KEY });
      void qc.invalidateQueries({ queryKey: ['reports'] });
    },
    onError: (e) => toast({ title: 'Could not save', description: e instanceof IpcError ? e.message : String(e), variant: 'error' }),
  });
  if (!q.data) {
    return <Card className="py-6 text-center text-stone-500">{q.isError ? 'Could not load the tills.' : 'Loading…'}</Card>;
  }
  const v = q.data;
  const off = otherTillMissing(v.sellingTills, v.link);
  const stale = staleLinkText(v.link);
  return (
    <Card>
      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-2xl">
          <h2 className="flex items-center gap-2 font-semibold">
            <MonitorSmartphone className="h-4 w-4" /> Tills that take orders
          </h2>
          <p className="mt-0.5 text-sm text-stone-500">
            Stock takes set what was used against what was sold. If two tills take orders, both tills&apos; sales must be on
            this one for that to add up.
          </p>
        </div>
        {!canEdit && (
          <p className="inline-flex items-center gap-1.5 rounded-lg bg-stone-100 px-3 py-2 text-sm text-stone-600 dark:bg-stone-800 dark:text-stone-300">
            <Lock className="h-4 w-4" /> Only the owner can change this.
          </p>
        )}
      </div>
      <div className="flex flex-wrap gap-2" role="group" aria-label="Tills that take orders">
        {([1, 2] as const).map((n) => (
          <Button
            key={n}
            variant={v.sellingTills === n ? 'primary' : 'secondary'}
            aria-pressed={v.sellingTills === n}
            disabled={!canEdit || mut.isPending}
            onClick={() => v.sellingTills !== n && mut.mutate(n)}
          >
            {n === 1 ? 'One till' : 'Two tills'}
          </Button>
        ))}
      </div>
      <p className={cn('mt-3 text-sm', off ? 'text-amber-800 dark:text-amber-300' : 'text-stone-500')}>
        {off
          ? `${OTHER_TILL_MISSING}: the link between the tills is off, so "used vs should have used" and the real food cost are switched off. Switch the link on under Settings → Sync.`
          : v.link.on
            ? 'The link between the tills is on: every till’s sales and stock count.'
            : v.isDefault
              ? 'One till, until you say otherwise. The link between the tills is off.'
              : 'The link between the tills is off.'}
      </p>
      {stale && <p className="mt-2 text-sm text-amber-800 dark:text-amber-300">{stale}</p>}
    </Card>
  );
}
