import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Button, cn } from '@cheeseoclock/ui';
import { AlertTriangle, Clock } from 'lucide-react';
import { ipc } from '../../ipc/client';
import { useSessionStore } from '../../stores/sessionStore';
import { useWebOrdersPause } from '../notifications/useAlertWatch';
import { OpenShiftDialog } from './ShiftWidget';
import { showWebOrdersPaused, WEB_PAUSED_BANNER_TEXT } from './webOrdersPause';

/** The banner's words (Checkout and Live Orders). */
export const NO_SHIFT_TEXT = 'No shift is open — open the shift (count the float) before taking payment';

/**
 * "No shift is open" on Checkout and Live Orders (audit 2026-09-27). Orders
 * still go to the kitchen with no shift open — that is not blocked — but the
 * till refuses to take the money until a shift is open on this till
 * (order-repo shiftForPayment), so the cashier found out only at "Pay".
 *
 * Shown only once the till has said there is no shift (not while it is still
 * asking, and not when it could not answer). "Open shift" opens the same
 * float count as the top bar's pill, for a login that may open a shift.
 * When closing the last shift paused website orders on this till, a second
 * line says so: the same "Open shift" starts them again.
 */
export function NoShiftBanner({ className }: { className?: string }) {
  const canOpen = useSessionStore((s) => s.can('shift.open'));
  const [opening, setOpening] = useState(false);
  // The same query as the top bar's shift pill: one answer for both.
  const shiftQ = useQuery({
    queryKey: ['shifts', 'current'],
    queryFn: () => ipc.shifts.current(),
    refetchInterval: 30_000,
  });
  const pause = useWebOrdersPause();
  if (shiftQ.data !== null) return null;

  return (
    <div
      role="alert"
      className={cn(
        'flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl bg-amber-50 px-3 py-2 text-sm text-amber-900 ring-1 ring-amber-300 dark:bg-amber-950/50 dark:text-amber-100 dark:ring-amber-800',
        className,
      )}
    >
      <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-300" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="font-semibold">{NO_SHIFT_TEXT}</p>
        {showWebOrdersPaused(pause) && <p className="mt-0.5">{WEB_PAUSED_BANNER_TEXT}</p>}
      </div>
      {canOpen && (
        <Button variant="primary" size="sm" onClick={() => setOpening(true)}>
          <Clock className="h-4 w-4" aria-hidden="true" />
          Open shift
        </Button>
      )}
      {opening && <OpenShiftDialog onClose={() => setOpening(false)} />}
    </div>
  );
}
