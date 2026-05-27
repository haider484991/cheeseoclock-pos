import { useEffect } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { ipc, onFbrQueueChanged } from '../../ipc/client';
import { Card, Button, cn } from '@cheeseoclock/ui';
import { useToast } from '../../components/toast/ToastProvider';
import {
  Building2,
  CheckCircle2,
  AlertTriangle,
  PauseCircle,
  RefreshCw,
} from 'lucide-react';
import { Link } from 'react-router-dom';

export function FbrStatusCard() {
  const qc = useQueryClient();
  const { toast } = useToast();

  const statsQ = useQuery({
    queryKey: ['fbr', 'stats'],
    queryFn: () => ipc.fbr.getQueueStats(),
    refetchInterval: 15_000, // backup polling in case the broadcast is missed
  });

  // Real-time refresh on broadcast from the worker
  useEffect(
    () =>
      onFbrQueueChanged(() => {
        void qc.invalidateQueries({ queryKey: ['fbr'] });
      }),
    [qc],
  );

  const retryMut = useMutation({
    mutationFn: () => ipc.fbr.retryFailed(),
    onSuccess: (r) => {
      toast({ title: `Re-queued ${r.requeued} invoices`, variant: 'success' });
      void qc.invalidateQueries({ queryKey: ['fbr'] });
    },
    onError: (e) =>
      toast({
        title: 'Retry failed',
        description: e instanceof Error ? e.message : String(e),
        variant: 'error',
      }),
  });

  const s = statsQ.data;
  if (!s) {
    return (
      <Card>
        <div className="text-sm text-stone-500">Loading FBR status…</div>
      </Card>
    );
  }

  const live = s.mode !== 'noop';
  const hasIssues = s.failed > 0;
  const hasPending = s.pending > 0;

  return (
    <Card>
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Building2 className="h-5 w-5" />
          <h3 className="font-semibold">FBR Digital Invoicing</h3>
          <ModePill mode={s.mode} paused={s.paused} />
        </div>
        <Link to="/settings" className="text-xs text-amber-700 hover:underline dark:text-amber-300">
          Settings →
        </Link>
      </div>

      <div className="grid grid-cols-4 gap-3 text-center">
        <Stat label="Pending" value={s.pending} tone={hasPending ? 'warn' : 'neutral'} />
        <Stat label="Failed" value={s.failed} tone={hasIssues ? 'error' : 'neutral'} />
        <Stat label="Sent" value={s.sent} tone={s.sent > 0 ? 'success' : 'neutral'} />
        <Stat label="Skipped" value={s.skipped} tone="neutral" />
      </div>

      {!live && (
        <div className="mt-3 rounded-lg bg-stone-100 p-3 text-xs text-stone-600 dark:bg-stone-800 dark:text-stone-400">
          <strong>Noop mode:</strong> payloads dump to disk. Switch to sandbox/production in
          Settings when your PRAL credentials are ready.
        </div>
      )}
      {s.paused && (
        <div className="mt-3 flex items-center gap-2 rounded-lg bg-amber-50 p-3 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-200">
          <PauseCircle className="h-4 w-4" /> Worker paused — invoices are queueing but not
          submitting.
        </div>
      )}
      {hasIssues && (
        <div className="mt-3 flex items-center justify-between gap-2 rounded-lg bg-red-50 p-3 text-xs text-red-800 dark:bg-red-950 dark:text-red-200">
          <span className="inline-flex items-center gap-1">
            <AlertTriangle className="h-4 w-4" /> {s.failed} submission(s) failed permanently.
          </span>
          <Button
            variant="secondary"
            size="sm"
            disabled={retryMut.isPending}
            onClick={() => retryMut.mutate()}
          >
            <RefreshCw className="h-3 w-3" />
            Retry all
          </Button>
        </div>
      )}
    </Card>
  );
}

function ModePill({ mode, paused }: { mode: 'noop' | 'sandbox' | 'production'; paused: boolean }) {
  if (paused) {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-800 dark:bg-amber-950 dark:text-amber-200">
        Paused
      </span>
    );
  }
  const colors = {
    noop: 'bg-stone-200 text-stone-700 dark:bg-stone-700 dark:text-stone-200',
    sandbox: 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200',
    production:
      'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200',
  } as const;
  const icons = {
    noop: null,
    sandbox: null,
    production: <CheckCircle2 className="h-3 w-3" />,
  } as const;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider',
        colors[mode],
      )}
    >
      {icons[mode]}
      {mode}
    </span>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: 'neutral' | 'success' | 'warn' | 'error';
}) {
  const toneClass = {
    neutral: 'text-stone-700 dark:text-stone-200',
    success: 'text-emerald-700 dark:text-emerald-300',
    warn: 'text-amber-700 dark:text-amber-300',
    error: 'text-red-700 dark:text-red-300',
  }[tone];
  return (
    <div className="rounded-lg bg-stone-50 p-3 dark:bg-stone-800">
      <div className={cn('text-2xl font-bold', toneClass)}>{value}</div>
      <div className="text-[10px] uppercase tracking-wider text-stone-500">{label}</div>
    </div>
  );
}
