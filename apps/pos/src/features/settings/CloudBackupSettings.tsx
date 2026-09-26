import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@cheeseoclock/ui';
import { ArrowRight, Cloud } from 'lucide-react';
import { ipc } from '../../ipc/client';
import { useToast } from '../../components/toast/ToastProvider';
import type { OnlineFrequency } from './backupStatus';

const FREQUENCIES: Array<{ id: OnlineFrequency; label: string }> = [
  { id: 'daily', label: 'Every day (best)' },
  { id: 'weekly', label: 'Every week' },
  { id: 'monthly', label: 'Every month' },
  { id: 'off', label: 'Never' },
];

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Change how often a copy goes online. Online copies ride on the website
 * connection (Online orders tab); this touches only the schedule and keeps
 * the connection exactly as it is.
 */
export function useSetOnlineFrequency() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const cfgQ = useQuery({
    queryKey: ['webBridge', 'config'],
    queryFn: () => ipc.webBridge.getConfig(),
  });
  return useMutation({
    mutationFn: (next: OnlineFrequency) => {
      const cfg = cfgQ.data;
      if (!cfg) throw new Error('Settings are still loading');
      return ipc.webBridge.setConfig({
        enabled: cfg.enabled,
        ...(cfg.siteUrl ? { siteUrl: cfg.siteUrl } : {}),
        // The masked value; the main process keeps the stored secret when it
        // sees the mask, so nothing about the website connection changes here.
        ...(cfg.bridgeSecret ? { bridgeSecret: cfg.bridgeSecret } : {}),
        cloudBackupFrequency: next,
      });
    },
    onSuccess: (_r, next) => {
      toast({
        title: next === 'off' ? 'Online copies switched off' : 'Online copies switched on',
        variant: 'success',
      });
      void qc.invalidateQueries({ queryKey: ['webBridge'] });
      void qc.invalidateQueries({ queryKey: ['backup', 'health'] });
    },
    onError: (e) => {
      toast({ title: 'Could not save', description: errorMessage(e), variant: 'error' });
      void cfgQ.refetch();
    },
  });
}

/** Backups → Advanced: how often a copy is saved online. */
export function OnlineBackupSchedule({ onGoToOnline }: { onGoToOnline: () => void }) {
  const cfgQ = useQuery({
    queryKey: ['webBridge', 'config'],
    queryFn: () => ipc.webBridge.getConfig(),
  });
  const setFreq = useSetOnlineFrequency();
  const [freq, setLocalFreq] = useState<OnlineFrequency>('daily');
  const saved = cfgQ.data?.cloudBackupFrequency;
  useEffect(() => {
    if (saved) setLocalFreq(saved);
  }, [saved]);

  const cfg = cfgQ.data;
  const connected = !!cfg && cfg.ready.ok && !cfg.secretUnreadable;

  return (
    <section>
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        <Cloud className="h-4 w-4" />
        How often to save a copy online
      </h3>
      {cfg && !connected ? (
        <div className="mt-2 flex flex-wrap items-center gap-3 text-sm text-stone-600 dark:text-stone-300">
          <span>
            {cfg.secretUnreadable
              ? 'The website connection password was saved on another computer and has to be entered again.'
              : 'Online copies use the website connection, which is not set up yet.'}
          </span>
          <Button size="sm" variant="secondary" onClick={onGoToOnline}>
            Go to Online orders
            <ArrowRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      ) : (
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <select
            aria-label="How often to save a copy online"
            value={freq}
            disabled={setFreq.isPending || !cfg}
            onChange={(e) => {
              const next = e.target.value as OnlineFrequency;
              setLocalFreq(next);
              setFreq.mutate(next);
            }}
            className="rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm dark:border-stone-700 dark:bg-stone-800"
          >
            {FREQUENCIES.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </select>
          <span className="text-xs text-stone-500">
            Saved as soon as you change it. Only the changes since the last copy are sent, so it
            uses little internet.
          </span>
        </div>
      )}
    </section>
  );
}
