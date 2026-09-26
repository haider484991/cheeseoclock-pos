import { useQuery } from '@tanstack/react-query';
import { DEFAULT_ALERT_SOUND_SETTINGS, type AlertSoundSettings } from '@cheeseoclock/shared-types';
import { ipc } from '../../ipc/client';

export const ALERT_SOUNDS_QUERY_KEY = ['alerts', 'sounds'] as const;

/**
 * This till's Settings → Sounds. Needs no login (the PIN screen rings too).
 * `settings` falls back to the defaults (everything on, 80%) while loading or
 * if loading fails, so an order still rings; `loaded` says whether they are
 * the saved ones; `settled` that loading is over either way (saved, or given
 * up after the retries) — nothing should ring on the defaults before then,
 * or a till set to "off" or "quiet" plays one loud chime after a restart.
 */
export function useAlertSoundSettings(): { settings: AlertSoundSettings; loaded: boolean; settled: boolean } {
  const q = useQuery({
    queryKey: ALERT_SOUNDS_QUERY_KEY,
    queryFn: () => ipc.alerts.getSounds(),
    staleTime: Infinity,
    retry: 2,
  });
  return {
    settings: q.data ?? DEFAULT_ALERT_SOUND_SETTINGS,
    loaded: q.data !== undefined,
    settled: q.data !== undefined || q.isError,
  };
}
