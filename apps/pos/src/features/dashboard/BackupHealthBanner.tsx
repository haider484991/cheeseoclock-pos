import { Link } from 'react-router-dom';
import { cn } from '@cheeseoclock/ui';
import { useBackupSummary } from '../settings/useBackupSummary';
import { ToneIcon } from '../settings/BackupSettings';

/**
 * Shown to the owner when the backups have stopped: a failed daily copy, one
 * that is days old, or an online copy that is overdue. Nothing when all is
 * well, and nothing for a choice the owner made (online copies not set up):
 * Settings → Backups says that one. Same words as Settings → Backups.
 */
export function BackupHealthBanner() {
  const { summary } = useBackupSummary(10 * 60_000);
  if (!summary) return null;
  const lines = [summary.local, summary.online].filter((l) => l.tone !== 'good' && l.alert);
  if (lines.length === 0) return null;
  const bad = summary.tone === 'bad';
  return (
    <div
      role="alert"
      className={cn(
        'flex items-start gap-3 rounded-xl border p-4 text-sm',
        bad
          ? 'border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950/40 dark:text-red-100'
          : 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100',
      )}
    >
      <ToneIcon tone={bad ? 'bad' : 'warn'} className="mt-0.5 h-5 w-5" />
      <div className="min-w-0 flex-1">
        <div className="font-semibold">{summary.headline}</div>
        <ul className="mt-1 space-y-0.5">
          {lines.map((l) => (
            <li key={l.text}>{l.text}</li>
          ))}
        </ul>
        <Link to="/settings?tab=backups" className="mt-2 inline-block font-semibold underline">
          Open Backups
        </Link>
      </div>
    </div>
  );
}
