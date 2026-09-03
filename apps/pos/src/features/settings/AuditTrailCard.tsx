import { useQuery } from '@tanstack/react-query';
import { Button, Card } from '@cheeseoclock/ui';
import { ShieldCheck, ShieldAlert, RefreshCw } from 'lucide-react';
import { ipc } from '../../ipc/client';

/**
 * Backups → Audit trail. Shows whether the hash-chained history still holds
 * together and whether the newest cloud copy's recorded chain head is still
 * part of it — the two checks that make silent rewriting visible.
 */
export function AuditTrailCard() {
  const q = useQuery({
    queryKey: ['audit', 'chain'],
    queryFn: () => ipc.audit.verifyChain(),
    staleTime: 60_000,
  });
  const s = q.data;

  return (
    <Card>
      <div className="mb-2 flex items-center gap-2">
        {s && !s.ok ? (
          <ShieldAlert className="h-5 w-5 text-red-600" />
        ) : (
          <ShieldCheck className="h-5 w-5" />
        )}
        <h2 className="text-lg font-semibold">Audit trail</h2>
        {s && (
          <span
            data-testid="audit-chain-chip"
            className={
              s.ok
                ? 'ml-auto inline-flex items-center rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-700 ring-1 ring-emerald-200 dark:bg-emerald-950 dark:text-emerald-200 dark:ring-emerald-800'
                : 'ml-auto inline-flex items-center rounded-full bg-red-50 px-2 py-0.5 text-xs font-semibold text-red-700 ring-1 ring-red-200 dark:bg-red-950 dark:text-red-200 dark:ring-red-800'
            }
          >
            {s.ok ? 'Intact' : 'History altered'}
          </span>
        )}
      </div>
      <p className="mb-4 text-sm text-stone-500">
        Every change is written to a tamper-evident log: each entry carries the
        fingerprint of the one before it, so deleting or editing history breaks
        the chain. The fingerprint of the newest entry travels with every cloud
        copy, so the cloud record shows whether this PC&rsquo;s history was
        rewritten after that copy was made.
      </p>

      {q.isLoading && <p className="text-xs text-stone-400">Checking…</p>}
      {q.isError && (
        <p className="text-xs text-red-600">Could not check the audit trail: {String(q.error)}</p>
      )}

      {s && (
        <dl className="grid grid-cols-2 gap-x-8 gap-y-1 text-xs sm:grid-cols-3">
          <div>
            <dt className="text-stone-500">Entries checked</dt>
            <dd className="font-mono">{s.checkedRows.toLocaleString()}</dd>
          </div>
          <div>
            <dt className="text-stone-500">Before this feature (not covered)</dt>
            <dd className="font-mono">{s.legacyRows.toLocaleString()}</dd>
          </div>
          <div>
            <dt className="text-stone-500">Newest cloud copy</dt>
            <dd>
              {s.anchor
                ? `${new Date(s.anchor.uploadedAt).toLocaleDateString()} · ${
                    s.anchor.present ? 'matches this history' : 'NOT in this history'
                  }`
                : 'none yet'}
            </dd>
          </div>
        </dl>
      )}

      {s && !s.ok && s.brokenAt && (
        <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-200">
          History was altered at entry #{s.brokenAt.rowid} (
          {new Date(s.brokenAt.createdAt).toLocaleString()}): {s.brokenAt.reason}. Do not
          restore over this PC; keep it as it is and compare with a cloud copy made before
          that date.
        </p>
      )}
      {s?.anchor && !s.anchor.present && (
        <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:bg-amber-950 dark:text-amber-200">
          The newest cloud copy recorded a chain head that no longer exists in this
          history. Something rewrote the audit trail after that copy was made.
        </p>
      )}

      <div className="mt-4">
        <Button size="sm" variant="secondary" onClick={() => void q.refetch()} disabled={q.isFetching}>
          <RefreshCw className="h-3.5 w-3.5" />
          {q.isFetching ? 'Checking…' : 'Check again'}
        </Button>
      </div>
    </Card>
  );
}
