import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { KeyRound, ShieldAlert, X } from 'lucide-react';
import { ipc } from '../../ipc/client';
import { LICENCE_STATUS_QUERY } from '../settings/LicenceCard';

/** Show the trial countdown only in its last week; grace and stopped always. */
const TRIAL_REMINDER_DAYS = 7;

/**
 * One line at the top of every screen (the PIN screen too) when the licence
 * needs attention: the trial's last week, the grace period after a paid period,
 * or sales stopped. The stopped state cannot be dismissed. Rendered at the root
 * next to UpdateBanner; polls the status every minute.
 */
export function LicenceBanner() {
  const statusQ = useQuery({
    queryKey: LICENCE_STATUS_QUERY,
    queryFn: () => ipc.licence.status(),
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);

  const s = statusQ.data;
  if (!s) return null;
  const stopped = !s.salesAllowed;
  const needsWord =
    stopped || s.state === 'grace' || (s.state === 'trial' && s.daysLeft <= TRIAL_REMINDER_DAYS) || s.problem !== null;
  if (!needsWord) return null;
  const dismissKey = `${s.state}:${s.daysLeft}`;
  if (!stopped && dismissedFor === dismissKey) return null;

  const tone = stopped
    ? 'from-red-50 to-red-100/80 ring-red-200 text-red-900 dark:from-red-950 dark:to-red-900/60 dark:ring-red-800 dark:text-red-100'
    : 'from-amber-50 to-amber-100/80 ring-amber-200 text-amber-900 dark:from-amber-950 dark:to-amber-900/60 dark:ring-amber-800 dark:text-amber-100';

  return (
    <div className="fixed left-1/2 top-3 z-[114] w-[min(96vw,56rem)] -translate-x-1/2 animate-fade-in">
      <div className={`flex items-center gap-3 rounded-2xl bg-gradient-to-r px-4 py-2.5 shadow-soft-lg ring-1 backdrop-blur-md ${tone}`}>
        {stopped ? <ShieldAlert className="h-5 w-5 flex-shrink-0" /> : <KeyRound className="h-5 w-5 flex-shrink-0" />}
        <div className="flex-1 text-sm">
          <span className="font-semibold">{stopped ? 'Sales are stopped. ' : ''}</span>
          {s.message}
          {s.problem && <span className="ml-1 text-xs opacity-80">({s.problem})</span>}
          <span className="ml-1 text-xs opacity-80">Settings → About → Licence.</span>
        </div>
        {!stopped && (
          <button
            type="button"
            onClick={() => setDismissedFor(dismissKey)}
            className="rounded-lg p-1 opacity-70 hover:opacity-100"
            aria-label="Hide for now"
            title="Hide for now"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  );
}
