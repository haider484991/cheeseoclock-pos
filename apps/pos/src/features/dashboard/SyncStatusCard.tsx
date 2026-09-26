import { useEffect } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { ipc, onSyncStatusChanged } from '../../ipc/client';
import { Card, Button, cn } from '@cheeseoclock/ui';
import { useToast } from '../../components/toast/ToastProvider';
import { askConfirm } from '../../components/confirm/ConfirmHost';
import { MonitorSmartphone, RefreshCw, AlertTriangle, PauseCircle, CheckCircle2 } from 'lucide-react';
import { Link } from 'react-router-dom';

/**
 * The link between this till and a second till (multi-device sync). Nothing
 * is shown for a one-till shop: with the link off there is nothing to watch,
 * and a "Cloud sync" card next to the backups only confused the owner.
 */
export function SyncStatusCard() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const statusQ = useQuery({
    queryKey: ['sync', 'status'],
    queryFn: () => ipc.sync.getStatus(),
    // Nothing to watch while the second-till link is off (the card is hidden then).
    refetchInterval: (q) => (q.state.data?.mode === 'off' ? false : 20_000),
  });

  useEffect(
    () =>
      onSyncStatusChanged(() => {
        void qc.invalidateQueries({ queryKey: ['sync'] });
      }),
    [qc],
  );

  const triggerMut = useMutation({
    mutationFn: () => ipc.sync.triggerNow(),
    onSuccess: () => toast({ title: 'Syncing now', variant: 'success' }),
    onError: (e) =>
      toast({
        title: 'Could not sync',
        description: e instanceof Error ? e.message : String(e),
        variant: 'error',
      }),
  });

  const clearMut = useMutation({
    mutationFn: () => ipc.sync.clearNotSaved(),
    onSuccess: () => {
      toast({ title: 'Cleared', variant: 'success' });
      void qc.invalidateQueries({ queryKey: ['sync'] });
    },
    onError: (e) =>
      toast({
        title: 'Could not clear',
        description: e instanceof Error ? e.message : String(e),
        variant: 'error',
      }),
  });

  const askClear = async () => {
    const yes = await askConfirm(
      'Only do this after pressing Send everything again on the other till. Changes still waiting here are tried again. Clear the count?',
    );
    if (yes) clearMut.mutate();
  };

  const s = statusQ.data;
  if (!s || s.mode === 'off') return null;

  const isFailing = s.consecutiveFails > 0;

  return (
    <Card>
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <MonitorSmartphone className="h-5 w-5" />
          <h3 className="font-semibold">Second till link</h3>
          <ModePill mode={s.mode} paused={s.paused} />
        </div>
        <Link to="/settings?tab=advanced" className="text-xs text-amber-700 hover:underline dark:text-amber-300">
          Settings →
        </Link>
      </div>

      <div className="grid grid-cols-3 gap-3 text-center">
        <Stat label="Waiting to send" value={s.pending} tone={s.pending > 0 ? 'warn' : 'neutral'} />
        <Stat label="Sent" value={s.eventsPushed} tone="success" />
        <Stat label="Received" value={s.eventsPulled} tone="success" />
      </div>

      <p className="mt-3 text-xs text-stone-500">Last sent {fmt(s.pushedAt)} · last received {fmt(s.pulledAt)}</p>

      {s.paused && (
        <div className="mt-3 flex items-center gap-2 rounded-lg bg-amber-50 p-3 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-200">
          <PauseCircle className="h-4 w-4" /> Paused: changes wait here and go out when you turn it back on.
        </div>
      )}

      {s.sendingEverything && (
        <div className="mt-3 flex items-center gap-2 rounded-lg bg-stone-50 p-3 text-xs text-stone-700 dark:bg-stone-800 dark:text-stone-200">
          <RefreshCw className="h-4 w-4 flex-shrink-0" />
          {s.paused
            ? 'Everything on this till will be sent to the other till once, when you turn the link back on.'
            : isFailing
              ? 'Everything on this till will be sent to the other till once, when it can be reached.'
              : 'Sending everything to the other till once. "Waiting to send" goes up first, then down. The till keeps working.'}
        </div>
      )}

      {s.notSaved > 0 && (
        <div className="mt-3 flex items-start justify-between gap-2 rounded-lg bg-amber-50 p-3 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-200">
          <span className="inline-flex items-start gap-1">
            <AlertTriangle className="h-4 w-4 flex-shrink-0" />
            <span>
              {s.notSaved} {s.notSaved === 1 ? 'change' : 'changes'} from the other till could not be saved
              on this till. To fix: on the other till, open Settings → Second till and press Send everything
              again. Then press Clear here.
            </span>
          </span>
          <Button variant="secondary" size="sm" disabled={clearMut.isPending} onClick={() => void askClear()}>
            Clear
          </Button>
        </div>
      )}

      {isFailing && s.lastError && (
        <div className="mt-3 flex items-start justify-between gap-2 rounded-lg bg-red-50 p-3 text-xs text-red-800 dark:bg-red-950 dark:text-red-200">
          <span className="inline-flex items-center gap-1">
            <AlertTriangle className="h-4 w-4 flex-shrink-0" />
            <span>
              Not reaching the other till ({s.consecutiveFails} tr{s.consecutiveFails === 1 ? 'y' : 'ies'}):{' '}
              {s.lastError}
            </span>
          </span>
          <Button
            variant="secondary"
            size="sm"
            disabled={triggerMut.isPending}
            onClick={() => triggerMut.mutate()}
          >
            <RefreshCw className="h-3 w-3" />
            Try again
          </Button>
        </div>
      )}
    </Card>
  );
}

function fmt(iso: string | null): string {
  if (!iso) return 'never';
  const d = new Date(iso);
  const diffMs = Date.now() - d.getTime();
  if (diffMs < 60_000) return 'just now';
  if (diffMs < 3_600_000) return `${Math.round(diffMs / 60_000)} min ago`;
  if (diffMs < 86_400_000) return `${Math.round(diffMs / 3_600_000)} h ago`;
  return d.toLocaleString();
}

function ModePill({ mode, paused }: { mode: 'off' | 'mock' | 'http'; paused: boolean }) {
  if (paused) {
    return (
      <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-800 dark:bg-amber-950 dark:text-amber-200">
        Paused
      </span>
    );
  }
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider',
        mode === 'http'
          ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200'
          : 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200',
      )}
    >
      {mode === 'http' && <CheckCircle2 className="h-3 w-3" />}
      {mode === 'http' ? 'On' : 'Developer test'}
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
