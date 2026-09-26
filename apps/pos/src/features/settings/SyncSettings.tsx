import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ipc } from '../../ipc/client';
import { Button, Card, cn } from '@cheeseoclock/ui';
import { useToast } from '../../components/toast/ToastProvider';
import { Cloud, AlertTriangle, CheckCircle2, Info, PauseCircle } from 'lucide-react';

type Mode = 'off' | 'mock' | 'http';

const MODES: Array<{ id: Mode; label: string; description: string; devOnly?: boolean }> = [
  { id: 'off', label: 'Off (one till)', description: 'Everything stays on this computer. Right for most shops.' },
  {
    id: 'mock',
    label: 'Developer test',
    description: 'Writes sync payloads to userData/sync-mock/ instead of a server.',
    devOnly: true,
  },
  {
    id: 'http',
    label: 'On (two or more tills)',
    description: 'Orders, menu and stock are shared with the other tills through a sync server.',
  },
];

export function SyncSettings() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const cfgQ = useQuery({ queryKey: ['sync', 'config'], queryFn: () => ipc.sync.getConfig() });
  const versionQ = useQuery({
    queryKey: ['system', 'version'],
    queryFn: () => ipc.system.getVersion(),
    staleTime: Infinity,
  });

  const [mode, setMode] = useState<Mode>('off');
  const [baseUrl, setBaseUrl] = useState('');
  const [deviceSecret, setDeviceSecret] = useState('');
  const [showSecret, setShowSecret] = useState(false);
  const [pollSeconds, setPollSeconds] = useState(15);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (!cfgQ.data) return;
    setMode(cfgQ.data.mode);
    setBaseUrl(cfgQ.data.baseUrl ?? '');
    setDeviceSecret(cfgQ.data.deviceSecret ?? '');
    setPollSeconds(Math.round(cfgQ.data.pollIntervalMs / 1000));
    setPaused(cfgQ.data.paused);
  }, [cfgQ.data]);

  const saveMut = useMutation({
    mutationFn: () =>
      ipc.sync.setConfig({
        mode,
        ...(mode === 'http' && baseUrl ? { baseUrl } : {}),
        ...(mode === 'http' && deviceSecret ? { deviceSecret } : {}),
        pollIntervalMs: Math.max(2_000, pollSeconds * 1000),
        paused,
      }),
    onSuccess: () => {
      toast({ title: 'Second till settings saved', variant: 'success' });
      void qc.invalidateQueries({ queryKey: ['sync'] });
    },
    onError: (e) =>
      toast({
        title: 'Save failed',
        description: e instanceof Error ? e.message : String(e),
        variant: 'error',
      }),
  });

  const triggerMut = useMutation({
    mutationFn: () => ipc.sync.triggerNow(),
    onSuccess: () => toast({ title: 'Syncing now', variant: 'success' }),
    onError: (e) =>
      toast({
        title: 'Could not sync',
        description: e instanceof Error ? e.message : String(e),
        variant: 'error',
      }),
  });

  const ready = cfgQ.data?.ready;
  const isDev = versionQ.data?.isDev ?? false;
  const modes = MODES.filter((m) => !m.devOnly || isDev || mode === m.id);

  return (
    <Card>
      <div className="mb-4 flex items-center gap-2">
        <Cloud className="h-5 w-5" />
        <h2 className="text-lg font-semibold">Second till</h2>
        {ready &&
          mode !== 'off' &&
          (ready.ok ? (
            <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
              <CheckCircle2 className="h-3 w-3" /> Ready
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800 dark:bg-amber-950 dark:text-amber-200">
              <AlertTriangle className="h-3 w-3" /> Needs setup
            </span>
          ))}
      </div>

      <p className="mb-4 rounded-xl bg-stone-50 p-3 text-sm leading-relaxed text-stone-600 dark:bg-stone-800/50 dark:text-stone-300">
        Shares orders, menu and stock between two or more till computers. It is{' '}
        <strong>not</strong> needed for one till, and it has nothing to do with
        website orders or backups (those are under Online orders and Backups).
        Leave it <strong>Off</strong> unless a second counter is being added.
      </p>

      <section className="space-y-4">
        <div>
          <label className="mb-2 block text-xs uppercase tracking-wider text-stone-500">
            Second till link
          </label>
          <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
            {modes.map((m) => (
              <button
                key={m.id}
                type="button"
                onClick={() => setMode(m.id)}
                className={cn(
                  'flex flex-col items-start gap-1 rounded-lg border-2 p-3 text-left transition-colors',
                  mode === m.id
                    ? 'border-amber-500 bg-amber-50 dark:bg-amber-950'
                    : 'border-stone-200 hover:border-stone-300 dark:border-stone-700',
                )}
              >
                <span className="text-sm font-semibold">{m.label}</span>
                <span className="text-xs text-stone-500">{m.description}</span>
              </button>
            ))}
          </div>
        </div>

        {mode === 'http' && (
          <>
            <div>
              <label className="mb-1 block text-xs uppercase tracking-wider text-stone-500">
                Sync server address
              </label>
              <input
                type="text"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://sync.example.com"
                className="w-full rounded-lg border border-stone-300 px-3 py-2 font-mono text-sm dark:border-stone-700 dark:bg-stone-800"
              />
              <div className="mt-1 text-xs text-stone-500">
                Given to you by whoever set up the second till.
              </div>
            </div>
            <div>
              <label className="mb-1 block text-xs uppercase tracking-wider text-stone-500">
                This till&rsquo;s password on the sync server
              </label>
              <div className="flex gap-2">
                <input
                  type={showSecret ? 'text' : 'password'}
                  value={deviceSecret}
                  onChange={(e) => setDeviceSecret(e.target.value)}
                  placeholder="Given to you with the server address"
                  className="w-full rounded-lg border border-stone-300 px-3 py-2 font-mono text-sm dark:border-stone-700 dark:bg-stone-800"
                />
                <button
                  type="button"
                  onClick={() => setShowSecret((s) => !s)}
                  className="rounded-lg border border-stone-300 px-3 text-xs dark:border-stone-700"
                >
                  {showSecret ? 'Hide' : 'Show'}
                </button>
              </div>
            </div>
          </>
        )}

        {mode === 'mock' && (
          <div className="flex items-start gap-2 rounded-lg bg-stone-100 p-3 text-sm dark:bg-stone-800">
            <Info className="mt-0.5 h-4 w-4 flex-shrink-0 text-stone-500" />
            <div className="text-stone-600 dark:text-stone-400">
              Push payloads land in
              <code className="ml-1 rounded bg-stone-200 px-1 text-xs dark:bg-stone-700">
                userData/sync-mock/
              </code>
              . Drop JSON files in
              <code className="ml-1 rounded bg-stone-200 px-1 text-xs dark:bg-stone-700">
                userData/sync-mock/inbox/
              </code>{' '}
              to simulate peer events.
            </div>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-xs uppercase tracking-wider text-stone-500">
              Check for changes every (seconds)
            </label>
            <input
              type="number"
              value={pollSeconds}
              min={2}
              max={600}
              onChange={(e) => setPollSeconds(parseInt(e.target.value, 10) || 15)}
              className="w-full rounded-lg border border-stone-300 px-3 py-2 font-mono dark:border-stone-700 dark:bg-stone-800"
            />
          </div>
          <label className="flex items-end gap-2 pb-2 text-sm">
            <input
              type="checkbox"
              checked={paused}
              onChange={(e) => setPaused(e.target.checked)}
            />
            <PauseCircle className="h-4 w-4 text-stone-500" /> Pause (changes wait here)
          </label>
        </div>

        {ready && !ready.ok && mode === 'http' && (
          <div className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-700 dark:bg-amber-950">
            <Info className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-600" />
            <div>
              <div className="font-semibold">Fill these in first:</div>
              <div className="text-amber-900 dark:text-amber-200">
                {ready.missing.join(', ')}
              </div>
            </div>
          </div>
        )}

        <div className="flex justify-end gap-2 border-t border-stone-200 pt-3 dark:border-stone-700">
          <Button
            variant="secondary"
            disabled={triggerMut.isPending || mode === 'off'}
            onClick={() => triggerMut.mutate()}
          >
            Sync now
          </Button>
          <Button variant="primary" disabled={saveMut.isPending} onClick={() => saveMut.mutate()}>
            {saveMut.isPending ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </section>
    </Card>
  );
}
