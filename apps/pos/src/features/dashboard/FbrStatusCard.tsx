import { useEffect } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { ipc, onFbrQueueChanged } from '../../ipc/client';
import { Card, Button, cn } from '@cheeseoclock/ui';
import { useToast } from '../../components/toast/ToastProvider';
import { Building2, CheckCircle2, AlertTriangle, PauseCircle, RefreshCw } from 'lucide-react';
import { Link } from 'react-router-dom';

/**
 * FBR invoices waiting, sent and failed. Shown only while FBR sending is on
 * (Test or Live); with it off the status tiles above already say "Off".
 */
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
        void qc.invalidateQueries({ queryKey: ['fbr', 'stats'] });
      }),
    [qc],
  );

  const retryMut = useMutation({
    mutationFn: () => ipc.fbr.retryFailed(),
    onSuccess: (r) => {
      toast({
        title: `Sending ${r.requeued} invoice${r.requeued === 1 ? '' : 's'} again`,
        variant: 'success',
      });
      void qc.invalidateQueries({ queryKey: ['fbr', 'stats'] });
    },
    onError: (e) =>
      toast({
        title: 'Could not send again',
        description: e instanceof Error ? e.message : String(e),
        variant: 'error',
      }),
  });

  const s = statsQ.data;
  if (!s || s.mode === 'noop') return null;

  const hasIssues = s.failed > 0;
  const hasPending = s.pending > 0;

  return (
    <Card>
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Building2 className="h-5 w-5" />
          <h3 className="font-semibold">FBR invoices</h3>
          <ModePill mode={s.mode} paused={s.paused} />
        </div>
        <Link to="/settings?tab=fbr" className="text-xs text-amber-700 hover:underline dark:text-amber-300">
          Settings →
        </Link>
      </div>

      <div className="grid grid-cols-3 gap-3 text-center">
        <Stat label="Waiting to send" value={s.pending} tone={hasPending ? 'warn' : 'neutral'} />
        <Stat label="Sent" value={s.sent} tone={s.sent > 0 ? 'success' : 'neutral'} />
        <Stat label="Failed" value={s.failed} tone={hasIssues ? 'error' : 'neutral'} />
      </div>
      {hasPending && s.oldestPendingIso && (
        <p className="mt-2 text-xs text-stone-500">
          Oldest waiting since {new Date(s.oldestPendingIso).toLocaleString()}
        </p>
      )}

      {s.paused && (
        <div className="mt-3 flex items-center gap-2 rounded-lg bg-amber-50 p-3 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-200">
          <PauseCircle className="h-4 w-4" /> Sending is paused: invoices wait here and go out when you
          turn it back on (Settings → FBR invoicing).
        </div>
      )}
      {hasIssues && (
        <div className="mt-3 flex items-center justify-between gap-2 rounded-lg bg-red-50 p-3 text-xs text-red-800 dark:bg-red-950 dark:text-red-200">
          <span className="inline-flex items-center gap-1">
            <AlertTriangle className="h-4 w-4" /> {s.failed} invoice{s.failed === 1 ? '' : 's'} could
            not be sent to FBR.
          </span>
          <Button
            variant="secondary"
            size="sm"
            disabled={retryMut.isPending}
            onClick={() => retryMut.mutate()}
          >
            <RefreshCw className="h-3 w-3" />
            Send again
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
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider',
        mode === 'production'
          ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200'
          : 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200',
      )}
    >
      {mode === 'production' && <CheckCircle2 className="h-3 w-3" />}
      {mode === 'production' ? 'Live' : 'Test'}
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
