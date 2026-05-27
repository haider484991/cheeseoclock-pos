import { useEffect } from 'react';
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query';
import { ipc, onSyncStatusChanged } from '../../ipc/client';
import { Card, Button, cn } from '@cheeseoclock/ui';
import { useToast } from '../../components/toast/ToastProvider';
import { Cloud, RefreshCw, AlertTriangle, PauseCircle, CheckCircle2 } from 'lucide-react';
import { Link } from 'react-router-dom';

export function SyncStatusCard() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const statusQ = useQuery({
    queryKey: ['sync', 'status'],
    queryFn: () => ipc.sync.getStatus(),
    refetchInterval: 20_000,
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
    onSuccess: () => toast({ title: 'Sync kicked', variant: 'success' }),
    onError: (e) =>
      toast({
        title: 'Failed',
        description: e instanceof Error ? e.message : String(e),
        variant: 'error',
      }),
  });

  const s = statusQ.data;
  if (!s) {
    return (
      <Card>
        <div className="text-sm text-stone-500">Loading sync status…</div>
      </Card>
    );
  }

  const isFailing = s.consecutiveFails > 0;
  const live = s.mode !== 'off';

  return (
    <Card>
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Cloud className="h-5 w-5" />
          <h3 className="font-semibold">Cloud sync</h3>
          <ModePill mode={s.mode} paused={s.paused} />
        </div>
        <Link to="/settings" className="text-xs text-amber-700 hover:underline dark:text-amber-300">
          Settings →
        </Link>
      </div>

      <div className="grid grid-cols-4 gap-3 text-center">
        <Stat label="Pending" value={s.pending} tone={s.pending > 0 ? 'warn' : 'neutral'} />
        <Stat label="Pushed" value={s.eventsPushed} tone="success" />
        <Stat label="Pulled" value={s.eventsPulled} tone="success" />
        <Stat label="Failures" value={s.consecutiveFails} tone={isFailing ? 'error' : 'neutral'} />
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-x-3 text-xs text-stone-500">
        <dt>Last pushed</dt>
        <dd className="text-right font-mono">{fmt(s.pushedAt)}</dd>
        <dt>Last pulled</dt>
        <dd className="text-right font-mono">{fmt(s.pulledAt)}</dd>
        <dt>Last attempt</dt>
        <dd className="text-right font-mono">{fmt(s.lastAttempt)}</dd>
      </dl>

      {!live && (
        <div className="mt-3 rounded-lg bg-stone-100 p-3 text-xs text-stone-600 dark:bg-stone-800 dark:text-stone-400">
          Sync is off — all data stays on this device.
        </div>
      )}

      {s.paused && (
        <div className="mt-3 flex items-center gap-2 rounded-lg bg-amber-50 p-3 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-200">
          <PauseCircle className="h-4 w-4" /> Paused — events queueing but not transmitting.
        </div>
      )}

      {isFailing && s.lastError && (
        <div className="mt-3 flex items-start justify-between gap-2 rounded-lg bg-red-50 p-3 text-xs text-red-800 dark:bg-red-950 dark:text-red-200">
          <span className="inline-flex items-center gap-1">
            <AlertTriangle className="h-4 w-4 flex-shrink-0" />
            <span>
              {s.consecutiveFails} consecutive failure
              {s.consecutiveFails === 1 ? '' : 's'}: {s.lastError}
            </span>
          </span>
          <Button
            variant="secondary"
            size="sm"
            disabled={triggerMut.isPending}
            onClick={() => triggerMut.mutate()}
          >
            <RefreshCw className="h-3 w-3" />
            Retry
          </Button>
        </div>
      )}
    </Card>
  );
}

function fmt(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  const diffMs = Date.now() - d.getTime();
  if (diffMs < 60_000) return 'just now';
  if (diffMs < 3_600_000) return `${Math.round(diffMs / 60_000)} min ago`;
  if (diffMs < 86_400_000) return `${Math.round(diffMs / 3_600_000)}h ago`;
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
  const colors = {
    off: 'bg-stone-200 text-stone-700 dark:bg-stone-700 dark:text-stone-200',
    mock: 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200',
    http: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200',
  } as const;
  const icons = {
    off: null,
    mock: null,
    http: <CheckCircle2 className="h-3 w-3" />,
  } as const;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider',
        colors[mode],
      )}
    >
      {icons[mode]}
      {mode === 'http' ? 'Cloud' : mode === 'mock' ? 'Mock' : 'Off'}
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
