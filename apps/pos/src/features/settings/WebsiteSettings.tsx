import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Card } from '@cheeseoclock/ui';
import { Globe, Send, RefreshCw, CheckCircle2, AlertTriangle } from 'lucide-react';
import { ipc } from '../../ipc/client';
import { useToast } from '../../components/toast/ToastProvider';

/**
 * Settings → Website. Connects this POS to cheeseoclock.net:
 *  - site URL + bridge secret (must match BRIDGE_SECRET on Vercel)
 *  - enable/disable polling for online orders
 *  - "Publish menu" pushes the current menu to the site
 *  - live status: last poll, imported count, errors
 */
export function WebsiteSettings() {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [siteUrl, setSiteUrl] = useState('');
  const [secret, setSecret] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  const cfgQ = useQuery({
    queryKey: ['webBridge', 'config'],
    queryFn: () => ipc.webBridge.getConfig(),
  });
  const statusQ = useQuery({
    queryKey: ['webBridge', 'status'],
    queryFn: () => ipc.webBridge.getStatus(),
    refetchInterval: 15_000,
  });

  // Hydrate the form once when config loads.
  useEffect(() => {
    if (cfgQ.data && !hydrated) {
      setSiteUrl(cfgQ.data.siteUrl ?? '');
      setSecret(cfgQ.data.bridgeSecret ?? '');
      setEnabled(cfgQ.data.enabled);
      setHydrated(true);
    }
  }, [cfgQ.data, hydrated]);

  const saveMut = useMutation({
    mutationFn: () =>
      ipc.webBridge.setConfig({
        enabled,
        siteUrl: siteUrl.trim() || undefined,
        bridgeSecret: secret.trim() || undefined,
      }),
    onSuccess: () => {
      toast({ title: 'Website settings saved' });
      void qc.invalidateQueries({ queryKey: ['webBridge'] });
    },
    onError: (e) =>
      toast({
        title: 'Save failed',
        description: e instanceof Error ? e.message : 'Unknown error',
        variant: 'error',
      }),
  });

  const publishMut = useMutation({
    mutationFn: () => ipc.webBridge.publishMenu(),
    onSuccess: (r) =>
      toast({
        title: 'Menu published 🎉',
        description: `${r.items} items in ${r.categories} categories are now live on the website.`,
      }),
    onError: (e) =>
      toast({
        title: 'Publish failed',
        description: e instanceof Error ? e.message : 'Unknown error',
        variant: 'error',
      }),
  });

  const status = statusQ.data;

  return (
    <Card>
      <div className="mb-4 flex items-center gap-2">
        <Globe className="h-5 w-5" />
        <h2 className="text-lg font-semibold">Website — online ordering</h2>
        {status?.enabled && status.ready && (
          <span className="ml-auto inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs font-semibold text-emerald-700 ring-1 ring-emerald-200 dark:bg-emerald-950 dark:text-emerald-200 dark:ring-emerald-800">
            <CheckCircle2 className="h-3 w-3" />
            Connected
          </span>
        )}
      </div>

      <p className="mb-4 text-sm text-stone-500">
        Orders placed on your website appear on the Live Orders board
        automatically, and customers can track delivery live. Publish the menu
        whenever you change items or prices.
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-stone-700 dark:text-stone-200">
            Website URL
          </span>
          <input
            value={siteUrl}
            onChange={(e) => setSiteUrl(e.target.value)}
            placeholder="https://cheeseoclock.net"
            className="w-full rounded-lg border border-stone-200 px-3 py-2 font-mono text-sm focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200 dark:border-stone-700 dark:bg-stone-800"
          />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block font-medium text-stone-700 dark:text-stone-200">
            Bridge secret
          </span>
          <input
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            placeholder="Same value as BRIDGE_SECRET on Vercel"
            type="password"
            className="w-full rounded-lg border border-stone-200 px-3 py-2 font-mono text-sm focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200 dark:border-stone-700 dark:bg-stone-800"
          />
        </label>
      </div>

      <label className="mt-3 flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          className="h-4 w-4 rounded border-stone-300 text-amber-500 focus:ring-amber-400"
        />
        <span className="font-medium text-stone-700 dark:text-stone-200">
          Accept online orders
        </span>
        <span className="text-xs text-stone-400">(polls the website every 20s)</span>
      </label>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => saveMut.mutate()} disabled={saveMut.isPending}>
          {saveMut.isPending ? 'Saving…' : 'Save settings'}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => publishMut.mutate()}
          disabled={publishMut.isPending}
        >
          <Send className="h-3.5 w-3.5" />
          {publishMut.isPending ? 'Publishing…' : 'Publish menu to website'}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => void ipc.webBridge.pollNow().then(() => statusQ.refetch())}
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Check for orders now
        </Button>
      </div>

      {status && (
        <dl className="mt-4 grid grid-cols-2 gap-x-8 gap-y-1 border-t border-stone-200 pt-3 text-xs dark:border-stone-700 sm:grid-cols-4">
          <div>
            <dt className="text-stone-500">Status</dt>
            <dd className="font-semibold">
              {status.enabled ? (status.ready ? 'Active' : 'Needs setup') : 'Off'}
            </dd>
          </div>
          <div>
            <dt className="text-stone-500">Last check</dt>
            <dd className="font-mono">
              {status.lastPollAt ? new Date(status.lastPollAt).toLocaleTimeString() : '—'}
            </dd>
          </div>
          <div>
            <dt className="text-stone-500">Orders imported</dt>
            <dd className="font-mono">{status.importedTotal}</dd>
          </div>
          <div>
            <dt className="text-stone-500">Errors</dt>
            <dd className={status.lastError ? 'text-red-600' : ''}>
              {status.lastError ? (
                <span className="inline-flex items-center gap-1" title={status.lastError}>
                  <AlertTriangle className="h-3 w-3" />
                  {status.consecutiveFails} fail{status.consecutiveFails === 1 ? '' : 's'}
                </span>
              ) : (
                'None'
              )}
            </dd>
          </div>
        </dl>
      )}
    </Card>
  );
}
