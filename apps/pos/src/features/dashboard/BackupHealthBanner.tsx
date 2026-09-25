import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { AlertTriangle } from 'lucide-react';
import { ipc } from '../../ipc/client';

/**
 * Shown to the owner when the backups have stopped: a failed daily copy, one
 * that is days old, or a cloud copy that is overdue. Nothing when all is well.
 */
export function BackupHealthBanner() {
  const q = useQuery({
    queryKey: ['backup', 'health'],
    queryFn: () => ipc.backup.health(),
    refetchInterval: 10 * 60_000,
  });
  const warnings = q.data?.warnings ?? [];
  if (warnings.length === 0) return null;
  return (
    <div
      role="alert"
      className="flex items-start gap-3 rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100"
    >
      <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="font-semibold">Backups need attention</div>
        <ul className="mt-1 list-disc space-y-0.5 pl-5">
          {warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
        <Link to="/settings" className="mt-2 inline-block font-semibold underline">
          Open Settings → Backups
        </Link>
      </div>
    </div>
  );
}
