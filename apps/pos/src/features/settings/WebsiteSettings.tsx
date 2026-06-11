import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Card } from '@cheeseoclock/ui';
import {
  Globe,
  Send,
  RefreshCw,
  CheckCircle2,
  AlertTriangle,
  CloudUpload,
  CloudDownload,
} from 'lucide-react';
import { ipc } from '../../ipc/client';
import { useToast } from '../../components/toast/ToastProvider';

type BackupFrequency = 'off' | 'daily' | 'weekly' | 'monthly';

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
  const [backupFreq, setBackupFreq] = useState<BackupFrequency>('daily');
  const [showCloudBackups, setShowCloudBackups] = useState(false);
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
      setBackupFreq(cfgQ.data.cloudBackupFrequency);
      setHydrated(true);
    }
  }, [cfgQ.data, hydrated]);

  const saveMut = useMutation({
    mutationFn: () =>
      ipc.webBridge.setConfig({
        enabled,
        siteUrl: siteUrl.trim() || undefined,
        bridgeSecret: secret.trim() || undefined,
        cloudBackupFrequency: backupFreq,
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

  const backupNowMut = useMutation({
    mutationFn: () => ipc.webBridge.backupNow(),
    onSuccess: (r) => {
      toast({
        title: 'Backed up to cloud ☁️',
        description: `${r.fileName} (${(r.sizeBytes / 1024).toFixed(0)} KB compressed)`,
      });
      void qc.invalidateQueries({ queryKey: ['webBridge'] });
    },
    onError: (e) =>
      toast({
        title: 'Cloud backup failed',
        description: e instanceof Error ? e.message : 'Unknown error',
        variant: 'error',
      }),
  });

  const cloudListQ = useQuery({
    queryKey: ['webBridge', 'cloudBackups'],
    queryFn: () => ipc.webBridge.listCloudBackups(),
    enabled: showCloudBackups,
  });

  const restoreMut = useMutation({
    mutationFn: (id: string) => ipc.webBridge.restoreCloudBackup(id),
    onSuccess: async () => {
      toast({
        title: 'Restore staged',
        description: 'The app will restart and apply the cloud backup.',
      });
      // Same confirm-then-relaunch flow as local restore.
      await ipc.backup.applyAndRelaunch();
    },
    onError: (e) =>
      toast({
        title: 'Cloud restore failed',
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
        <span className="text-xs text-stone-400">(checks for new orders every ~10 seconds)</span>
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

      {/* Cloud backup */}
      <div className="mt-5 border-t border-stone-200 pt-4 dark:border-stone-700">
        <div className="mb-2 flex items-center gap-2">
          <CloudUpload className="h-4 w-4 text-stone-500" />
          <h3 className="text-sm font-semibold">Cloud backup</h3>
          {status?.lastCloudBackupAt && (
            <span className="text-xs text-stone-400">
              last: {new Date(status.lastCloudBackupAt).toLocaleString()}
            </span>
          )}
        </div>
        <p className="mb-3 text-xs text-stone-500">
          A compressed copy of the POS database is uploaded to your website&rsquo;s
          cloud database on a schedule (the newest 8 are kept). This is your
          off-site disaster recovery — works alongside the local daily backups.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={backupFreq}
            onChange={(e) => setBackupFreq(e.target.value as BackupFrequency)}
            className="rounded-lg border border-stone-200 bg-white px-3 py-2 text-sm dark:border-stone-700 dark:bg-stone-800"
            title="How often to upload (takes effect after Save settings)"
          >
            <option value="daily">Back up daily</option>
            <option value="weekly">Back up weekly</option>
            <option value="monthly">Back up monthly</option>
            <option value="off">Cloud backup off</option>
          </select>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => backupNowMut.mutate()}
            disabled={backupNowMut.isPending}
          >
            <CloudUpload className="h-3.5 w-3.5" />
            {backupNowMut.isPending ? 'Uploading…' : 'Back up to cloud now'}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setShowCloudBackups((v) => !v)}
          >
            <CloudDownload className="h-3.5 w-3.5" />
            {showCloudBackups ? 'Hide cloud backups' : 'View cloud backups'}
          </Button>
        </div>
        {status?.lastCloudBackupError && (
          <p className="mt-2 text-xs text-red-600">
            Last attempt failed: {status.lastCloudBackupError}
          </p>
        )}
        {showCloudBackups && (
          <div className="mt-3 overflow-hidden rounded-xl border border-stone-200 dark:border-stone-700">
            {cloudListQ.isLoading ? (
              <div className="p-4 text-center text-xs text-stone-400">Loading…</div>
            ) : (cloudListQ.data ?? []).length === 0 ? (
              <div className="p-4 text-center text-xs text-stone-400">
                No cloud backups yet — click &ldquo;Back up to cloud now&rdquo;.
              </div>
            ) : (
              <table className="w-full text-xs">
                <tbody className="divide-y divide-stone-100 dark:divide-stone-700">
                  {(cloudListQ.data ?? []).map((b) => (
                    <tr key={b.id}>
                      <td className="px-3 py-2 font-mono">{b.fileName}</td>
                      <td className="px-3 py-2 text-stone-500">
                        {(b.sizeBytes / 1024).toFixed(0)} KB
                      </td>
                      <td className="px-3 py-2 text-stone-500">
                        {new Date(b.createdAt).toLocaleString()}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <button
                          type="button"
                          className="font-semibold text-amber-600 hover:underline"
                          onClick={() => {
                            if (
                              confirm(
                                'Restore this cloud backup? Current data will be replaced and the app will restart.',
                              )
                            ) {
                              restoreMut.mutate(b.id);
                            }
                          }}
                        >
                          Restore
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
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

      {status?.lastImportError && (
        <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-200">
          <AlertTriangle className="mr-1 inline h-3 w-3" />
          An order couldn&rsquo;t be imported: {status.lastImportError}
        </p>
      )}
    </Card>
  );
}
