import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Card } from '@cheeseoclock/ui';
import { Cloud, CloudUpload, AlertTriangle, ArrowRight, Monitor } from 'lucide-react';
import { ipc } from '../../ipc/client';
import { useToast } from '../../components/toast/ToastProvider';

type BackupFrequency = 'off' | 'daily' | 'weekly' | 'monthly';

const FREQUENCIES: Array<{ id: BackupFrequency; label: string }> = [
  { id: 'daily', label: 'Every day' },
  { id: 'weekly', label: 'Every week' },
  { id: 'monthly', label: 'Every month' },
  { id: 'off', label: 'Off' },
];

const RESTORE_CONFIRM =
  'Restore this cloud copy? A safety copy of the data on this PC is uploaded to the cloud first, then the app restarts on the chosen copy. Only the owner login can do this, and the restore is recorded in the audit trail.';

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Backups → Cloud copy. Rides on the website connection (URL + bridge secret
 * from the Online orders tab): the POS compresses a slimmed snapshot and
 * uploads it with a manifest; the website keeps the newest three, one per day
 * for two weeks, and every safety copy for a month — from every till.
 */
export function CloudBackupSettings({ onGoToOnline }: { onGoToOnline: () => void }) {
  const { toast } = useToast();
  const qc = useQueryClient();

  const cfgQ = useQuery({
    queryKey: ['webBridge', 'config'],
    queryFn: () => ipc.webBridge.getConfig(),
  });
  const statusQ = useQuery({
    queryKey: ['webBridge', 'status'],
    queryFn: () => ipc.webBridge.getStatus(),
    refetchInterval: 15_000,
  });
  const ready = statusQ.data?.ready ?? false;
  const secretUnreadable = cfgQ.data?.secretUnreadable ?? false;
  const listQ = useQuery({
    queryKey: ['webBridge', 'cloudBackups'],
    queryFn: () => ipc.webBridge.listCloudBackups(),
    enabled: ready,
  });

  const [freq, setFreq] = useState<BackupFrequency>('daily');
  useEffect(() => {
    if (cfgQ.data) setFreq(cfgQ.data.cloudBackupFrequency);
  }, [cfgQ.data]);

  const freqMut = useMutation({
    mutationFn: (next: BackupFrequency) => {
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
        title: next === 'off' ? 'Cloud backup switched off' : 'Cloud backup schedule saved',
        variant: 'success',
      });
      void qc.invalidateQueries({ queryKey: ['webBridge'] });
    },
    onError: (e) => {
      toast({
        title: 'Could not save the schedule',
        description: errorMessage(e),
        variant: 'error',
      });
      void cfgQ.refetch();
    },
  });

  const backupNowMut = useMutation({
    mutationFn: () => ipc.webBridge.backupNow(),
    onSuccess: (r) => {
      toast({
        title: 'Copied to the cloud',
        description: `${(r.sizeBytes / 1024).toFixed(0)} KB compressed`,
        variant: 'success',
      });
      void qc.invalidateQueries({ queryKey: ['webBridge'] });
      void qc.invalidateQueries({ queryKey: ['audit'] });
    },
    onError: (e) =>
      toast({ title: 'Cloud copy failed', description: errorMessage(e), variant: 'error' }),
  });

  const restoreMut = useMutation({
    mutationFn: (id: string) => ipc.webBridge.restoreCloudBackup(id),
    onSuccess: async () => {
      toast({
        title: 'Restore staged',
        description: 'Uploading a safety copy, then restarting on the chosen copy.',
      });
      await ipc.backup.applyAndRelaunch();
    },
    onError: (e) =>
      toast({ title: 'Cloud restore failed', description: errorMessage(e), variant: 'error' }),
  });

  const status = statusQ.data;
  const copies = listQ.data ?? [];

  return (
    <Card>
      <div className="mb-2 flex items-center gap-2">
        <Cloud className="h-5 w-5" />
        <h2 className="text-lg font-semibold">Cloud copy</h2>
        {status?.lastCloudBackupAt && (
          <span className="ml-auto text-xs text-stone-500">
            Last copy {new Date(status.lastCloudBackupAt).toLocaleString()}
          </span>
        )}
      </div>
      <p className="mb-4 text-sm text-stone-500">
        A compressed copy of the database goes to your website&rsquo;s cloud
        storage on a schedule. The website keeps the newest three, the first copy
        of each day for two weeks, and every safety copy for a month, from every
        till, and nothing can change a copy once it is stored. Each copy holds
        orders, customers, menu, stock, settings and the last 90 days of audit
        history; local snapshots and USB copies are complete.
      </p>

      {status && !ready ? (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
          <div className="mb-3 flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <div>
              {secretUnreadable
                ? 'The website secret saved in this data was sealed on another PC and cannot be read here. Enter it again under Online orders, then come back.'
                : 'Cloud copies travel over the website connection. Enter the Website URL and bridge secret under Online orders first, then come back here.'}
            </div>
          </div>
          <Button size="sm" variant="secondary" onClick={onGoToOnline}>
            Go to Online orders
            <ArrowRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-2 text-sm">
              <span className="text-stone-600 dark:text-stone-300">Copy to the cloud</span>
              <select
                value={freq}
                disabled={freqMut.isPending || !cfgQ.data}
                onChange={(e) => {
                  const next = e.target.value as BackupFrequency;
                  setFreq(next);
                  freqMut.mutate(next);
                }}
                className="rounded-lg border border-stone-200 bg-white px-3 py-2 text-sm dark:border-stone-700 dark:bg-stone-800"
              >
                {FREQUENCIES.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.label}
                  </option>
                ))}
              </select>
            </label>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => backupNowMut.mutate()}
              disabled={backupNowMut.isPending}
            >
              <CloudUpload className="h-3.5 w-3.5" />
              {backupNowMut.isPending ? 'Uploading…' : 'Copy to cloud now'}
            </Button>
          </div>

          {status?.lastCloudBackupError && (
            <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-200">
              <AlertTriangle className="mr-1 inline h-3 w-3" />
              Last attempt failed: {status.lastCloudBackupError}
            </p>
          )}

          <div className="mt-4 overflow-hidden rounded-xl border border-stone-200 dark:border-stone-700">
            {listQ.isLoading ? (
              <div className="p-4 text-center text-xs text-stone-400">Loading…</div>
            ) : listQ.isError ? (
              <div className="p-4 text-center text-xs text-red-600">
                Could not read the cloud list: {errorMessage(listQ.error)}
              </div>
            ) : copies.length === 0 ? (
              <div className="p-4 text-center text-xs text-stone-400">
                No cloud copies yet. The first one uploads within a day, or click
                &ldquo;Copy to cloud now&rdquo;.
              </div>
            ) : (
              <table className="w-full text-sm" data-testid="cloud-copy-table">
                <thead className="bg-stone-50 text-left text-xs uppercase tracking-wider text-stone-500 dark:bg-stone-800/60">
                  <tr>
                    <th className="px-3 py-2">When</th>
                    <th className="px-3 py-2">PC</th>
                    <th className="px-3 py-2 text-right">Orders</th>
                    <th className="px-3 py-2 text-right">Size</th>
                    <th className="px-3 py-2 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-stone-100 dark:divide-stone-700">
                  {copies.map((b) => (
                    <tr key={b.id}>
                      <td className="px-3 py-2">
                        <div className="font-medium">{new Date(b.createdAt).toLocaleString()}</div>
                        <div className="text-[10px] text-stone-400">
                          {b.reason === 'before-restore'
                            ? 'safety copy before a restore'
                            : b.reason === 'scheduled'
                              ? 'scheduled'
                              : b.reason === 'manual'
                                ? 'made by hand'
                                : 'earlier version'}
                          {b.appVersion ? ` · v${b.appVersion}` : ''}
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <span className="inline-flex items-center gap-1">
                          <Monitor className="h-3 w-3 text-stone-400" />
                          {b.deviceName ?? 'unnamed PC'}
                        </span>
                        {b.isThisDevice && (
                          <span className="ml-1 rounded bg-stone-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-stone-600 dark:bg-stone-700 dark:text-stone-300">
                            this PC
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right font-mono">
                        {b.orderCount ?? '—'}
                        {b.lastOrderAt && (
                          <div className="text-[10px] font-sans text-stone-400">
                            last sale {new Date(b.lastOrderAt).toLocaleDateString()}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-stone-500">
                        {(b.sizeBytes / 1024).toFixed(0)} KB
                      </td>
                      <td className="px-3 py-2 text-right">
                        <button
                          type="button"
                          className="font-semibold text-amber-600 hover:underline"
                          disabled={restoreMut.isPending}
                          onClick={() => {
                            if (confirm(RESTORE_CONFIRM)) restoreMut.mutate(b.id);
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
          {copies.some((b) => !b.isThisDevice) && (
            <p className="mt-2 text-xs text-stone-400">
              Copies from another PC restore here too. Afterwards, enter the website
              secret again under Online orders: secrets are sealed to the PC that saved
              them.
            </p>
          )}
        </>
      )}
    </Card>
  );
}
