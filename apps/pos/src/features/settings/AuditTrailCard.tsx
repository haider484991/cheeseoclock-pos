import { useQuery } from '@tanstack/react-query';
import { Button } from '@cheeseoclock/ui';
import { ShieldCheck, ShieldAlert, RefreshCw } from 'lucide-react';
import { ipc } from '../../ipc/client';

/** The history-log check, shared by the Backups status and the Advanced section. */
export function useAuditChain() {
  return useQuery({
    queryKey: ['audit', 'chain'],
    queryFn: () => ipc.audit.verifyChain(),
    staleTime: 60_000,
  });
}

/**
 * Backups → Advanced → History log check. Shows whether the hash-chained
 * history still holds together and whether the newest online copy's recorded
 * chain head is still part of it — the two checks that make silent rewriting
 * visible. The same result raises the red alarm on the Backups status.
 */
export function AuditTrailCard() {
  const q = useAuditChain();
  const s = q.data;
  const anchorMissing = !!s?.anchor && !s.anchor.present;

  return (
    <section>
      <div className="flex flex-wrap items-center gap-2">
        {s && (!s.ok || anchorMissing) ? (
          <ShieldAlert className="h-4 w-4 text-red-600" />
        ) : (
          <ShieldCheck className="h-4 w-4" />
        )}
        <h3 className="text-sm font-semibold">History log check</h3>
        {s && (
          <span
            data-testid="audit-chain-chip"
            className={
              s.ok && !anchorMissing
                ? 'inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-700 ring-1 ring-emerald-200 dark:bg-emerald-950 dark:text-emerald-200 dark:ring-emerald-800'
                : 'inline-flex items-center rounded-full bg-red-50 px-2 py-0.5 text-xs font-semibold text-red-700 ring-1 ring-red-200 dark:bg-red-950 dark:text-red-200 dark:ring-red-800'
            }
          >
            {s.ok && !anchorMissing ? 'Nothing changed' : 'History was changed'}
          </span>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="ml-auto"
          onClick={() => void q.refetch()}
          disabled={q.isFetching}
        >
          <RefreshCw className={q.isFetching ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />
          {q.isFetching ? 'Checking…' : 'Check again'}
        </Button>
      </div>
      <p className="mt-1 text-sm text-stone-500">
        The till keeps a sealed log of every sale, refund, void and change. Each entry is locked to
        the one before it, so deleting or editing an old entry shows up here. Each online copy
        also records where the log had got to, so a log rewritten later shows up too.
      </p>

      {q.isLoading && <p className="mt-2 text-xs text-stone-400">Checking…</p>}
      {q.isError && (
        <p className="mt-2 text-xs text-red-600">
          Could not check the history log: {q.error instanceof Error ? q.error.message : String(q.error)}
        </p>
      )}

      {s && (
        <dl className="mt-3 grid grid-cols-2 gap-x-8 gap-y-1 text-xs sm:grid-cols-3">
          <div>
            <dt className="text-stone-500">Entries checked</dt>
            <dd className="font-mono">{s.checkedRows.toLocaleString()}</dd>
          </div>
          <div>
            <dt className="text-stone-500">Older entries (before the seal existed)</dt>
            <dd className="font-mono">{s.legacyRows.toLocaleString()}</dd>
          </div>
          <div>
            <dt className="text-stone-500">Newest online copy</dt>
            <dd>
              {s.anchor
                ? `${new Date(s.anchor.uploadedAt).toLocaleDateString()} · ${
                    s.anchor.present ? 'matches this log' : 'NOT in this log'
                  }`
                : 'none yet'}
            </dd>
          </div>
        </dl>
      )}

      {s && !s.ok && s.brokenAt && (
        <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-200">
          The log was changed at entry #{s.brokenAt.rowid} (
          {new Date(s.brokenAt.createdAt).toLocaleString()}): {s.brokenAt.reason}. Do not restore
          anything over this computer. Leave it as it is and compare it with an online copy made
          before that date.
        </p>
      )}
      {anchorMissing && (
        <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200">
          The newest online copy recorded a point in the log that no longer exists here. Something
          rewrote the log after that copy was made.
        </p>
      )}
    </section>
  );
}
