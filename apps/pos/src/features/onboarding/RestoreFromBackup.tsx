import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Button } from '@cheeseoclock/ui';
import { ArrowLeft, Cloud, Usb, RefreshCw, ShieldCheck } from 'lucide-react';
import type { CloudBackupEntry } from '@cheeseoclock/shared-types';
import { ipc } from '../../ipc/client';
import { useToast } from '../../components/toast/ToastProvider';

const CONFIRM =
  'Restore this copy onto this PC? The app will restart on it. Anything already on this PC is archived first, so this can be undone.';

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Onboarding → "Restore from a backup instead". A replacement PC has no
 * users yet, so nothing here needs a login: the main process allows these
 * calls only while the users table is empty.
 */
export function RestoreFromBackup({ onBack }: { onBack: () => void }) {
  const { toast } = useToast();
  const [siteUrl, setSiteUrl] = useState('https://www.cheeseoclock.net');
  const [secret, setSecret] = useState('');
  const [copies, setCopies] = useState<CloudBackupEntry[] | null>(null);

  const fileMut = useMutation({
    mutationFn: () => ipc.backup.stageRestoreFromPicker(),
    onSuccess: (r) => {
      if (!r.staged) return;
      if (confirm(CONFIRM)) void ipc.backup.applyAndRelaunch();
    },
    onError: (e) =>
      toast({ title: 'Restore failed', description: errorMessage(e), variant: 'error' }),
  });

  const findMut = useMutation({
    mutationFn: () =>
      ipc.webBridge.previewCloudBackups({ siteUrl: siteUrl.trim(), bridgeSecret: secret.trim() }),
    onSuccess: (list) => setCopies(list),
    onError: (e) =>
      toast({
        title: 'Could not reach the website',
        description: errorMessage(e),
        variant: 'error',
      }),
  });

  const cloudMut = useMutation({
    mutationFn: (id: string) =>
      ipc.webBridge.restoreCloudBackupWith({
        siteUrl: siteUrl.trim(),
        bridgeSecret: secret.trim(),
        id,
      }),
    onSuccess: (r) => {
      if (r.staged) void ipc.backup.applyAndRelaunch();
    },
    onError: (e) =>
      toast({ title: 'Cloud restore failed', description: errorMessage(e), variant: 'error' }),
  });

  const inputClass =
    'w-full rounded-xl border border-stone-300 px-3 py-2 font-mono text-sm dark:border-stone-700 dark:bg-stone-800';

  return (
    <div className="glass-surface space-y-5 rounded-3xl p-7 shadow-soft-lg ring-1 ring-stone-200/60 dark:ring-stone-700/60">
      <div>
        <h2 className="text-lg font-bold">Restore this PC from a backup</h2>
        <p className="mt-1 text-xs text-stone-500">
          Brings back the menu, staff logins, customers, orders and settings from a
          copy. Nothing is lost on this PC: whatever is here is archived before the
          copy takes over.
        </p>
      </div>

      <section className="rounded-2xl border border-stone-200 p-4 dark:border-stone-700">
        <div className="mb-1 flex items-center gap-2 text-sm font-semibold">
          <Usb className="h-4 w-4" /> From a USB stick or file
        </div>
        <p className="mb-3 text-xs text-stone-500">
          A copy made with Backups → &ldquo;Save a copy to USB…&rdquo;, or a snapshot
          from the old PC&rsquo;s backups folder. A copy that was changed since it was
          saved is refused.
        </p>
        <Button variant="secondary" onClick={() => fileMut.mutate()} disabled={fileMut.isPending}>
          Choose the file…
        </Button>
      </section>

      <section className="rounded-2xl border border-stone-200 p-4 dark:border-stone-700">
        <div className="mb-1 flex items-center gap-2 text-sm font-semibold">
          <Cloud className="h-4 w-4" /> From the cloud
        </div>
        <p className="mb-3 text-xs text-stone-500">
          Needs the website address and the bridge secret. The connection is kept, so
          this PC comes up already linked to the website.
        </p>
        <div className="grid gap-2 sm:grid-cols-2">
          <input
            value={siteUrl}
            onChange={(e) => setSiteUrl(e.target.value)}
            placeholder="https://www.cheeseoclock.net"
            aria-label="Website URL"
            className={inputClass}
          />
          <input
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            type="password"
            placeholder="Bridge secret"
            aria-label="Bridge secret"
            className={inputClass}
          />
        </div>
        <Button
          size="sm"
          variant="secondary"
          className="mt-2"
          onClick={() => findMut.mutate()}
          disabled={findMut.isPending || !secret.trim() || !siteUrl.trim()}
        >
          <RefreshCw className="h-3.5 w-3.5" />
          {findMut.isPending ? 'Looking…' : 'Find copies'}
        </Button>

        {copies && copies.length === 0 && (
          <p className="mt-3 text-xs text-stone-500">No copies found on this website yet.</p>
        )}
        {copies && copies.length > 0 && (
          <div className="mt-3 max-h-64 overflow-auto rounded-xl border border-stone-200 dark:border-stone-700">
            <table className="w-full text-xs">
              <thead className="bg-stone-50 text-left uppercase tracking-wider text-stone-500 dark:bg-stone-800/60">
                <tr>
                  <th className="px-3 py-2">When</th>
                  <th className="px-3 py-2">PC</th>
                  <th className="px-3 py-2 text-right">Orders</th>
                  <th className="px-3 py-2 text-right"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100 dark:divide-stone-700">
                {copies.map((b) => (
                  <tr key={b.id} data-testid="cloud-copy-row">
                    <td className="px-3 py-2">
                      <div className="font-medium">{new Date(b.createdAt).toLocaleString()}</div>
                      <div className="text-[10px] text-stone-400">
                        {b.reason === 'before-restore' ? 'safety copy' : (b.reason ?? 'copy')}
                        {b.appVersion ? ` · v${b.appVersion}` : ''}
                      </div>
                    </td>
                    <td className="px-3 py-2">{b.deviceName ?? 'earlier version'}</td>
                    <td className="px-3 py-2 text-right font-mono">
                      {b.orderCount ?? '—'}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button
                        type="button"
                        className="font-semibold text-amber-600 hover:underline"
                        disabled={cloudMut.isPending}
                        onClick={() => {
                          if (confirm(CONFIRM)) cloudMut.mutate(b.id);
                        }}
                      >
                        Restore
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <div className="flex items-center justify-between">
        <Button variant="ghost" onClick={onBack}>
          <ArrowLeft className="h-4 w-4" />
          Back to setup
        </Button>
        <span className="inline-flex items-center gap-1 text-[11px] text-stone-400">
          <ShieldCheck className="h-3 w-3" />
          Every restore is recorded in the audit trail.
        </span>
      </div>
    </div>
  );
}
