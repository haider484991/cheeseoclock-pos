import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { AlertWatch, WebOrdersPauseView } from '@cheeseoclock/shared-types';
import { ipc, onAlertWatchChanged } from '../../ipc/client';

/**
 * What every screen may show between logins (alerts:getWatch, no login): one
 * cache entry, whichever screen reads a part of it. Opening or closing a
 * shift on this till invalidates it too.
 */
export const ALERT_WATCH_KEY = ['alerts', 'watch'] as const;

/**
 * Asked again this often, by OrderAlerts (useAlertWatch: mounted once at the
 * root, the one poller); 'alerts:watch-changed' asks sooner.
 */
export const WATCH_EVERY_MS = 30_000;

const watchQuery = {
  queryKey: ALERT_WATCH_KEY,
  queryFn: () => ipc.alerts.getWatch(),
  retry: 1,
};

/** Read the watch again when the main process says part of it changed. */
function useAlertWatchLive(): void {
  const qc = useQueryClient();
  useEffect(() => onAlertWatchChanged(() => void qc.invalidateQueries({ queryKey: ALERT_WATCH_KEY })), [qc]);
}

/** The whole watch, polled: the PIN screen's reminders (OrderAlerts only). */
export function useAlertWatch() {
  useAlertWatchLive();
  return useQuery({ ...watchQuery, refetchInterval: WATCH_EVERY_MS });
}

const selectWebOrders = (w: AlertWatch): WebOrdersPauseView => w.webOrders;

/**
 * Whether website orders are paused on this till because no shift is open:
 * the PIN screen, the no-shift banner and the shift pill. The same entry as
 * useAlertWatch, which keeps it fresh, so no second poll. Nothing
 * (undefined) before the till has answered and when it could not answer: a
 * pause is only ever shown on a yes.
 */
export function useWebOrdersPause(): WebOrdersPauseView | undefined {
  useAlertWatchLive();
  const q = useQuery({ ...watchQuery, select: selectWebOrders });
  return q.isError ? undefined : q.data;
}
