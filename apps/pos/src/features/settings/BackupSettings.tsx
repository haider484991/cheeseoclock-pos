import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, Card } from '@cheeseoclock/ui';
import { ipc } from '../../ipc/client';
import { useToast } from '../../components/toast/ToastProvider';
import {
  Database,
  Download,
  Upload,
  Trash2,
  HardDrive,
  Clock,
  AlertTriangle,
  RotateCcw,
  Usb,
} from 'lucide-react';

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString();
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const RESTORE_CONFIRM =
  'Restore this snapshot? Everything on this PC will be replaced by it and the app will restart.\n\nThe current data is archived first (a before-restore-*.db file in the backups folder), so this can be undone.\n\nProceed?';

/** Backups → Local snapshots: the automatic daily copies kept on this PC. */
export function BackupSettings() {
  const qc = useQueryClient();
  const { toast } = useToast();

  const listQ = useQuery({
    queryKey: ['backup', 'list'],
    queryFn: () => ipc.backup.list(),
    refetchInterval: 60_000,
  });

  const createMut = useMutation({
    mutationFn: () => ipc.backup.create(),
    onSuccess: (r) => {
      toast({
        title: 'Snapshot saved',
        description: `${r.fileName} (${fmtBytes(r.sizeBytes)})`,
        variant: 'success',
      });
      void qc.invalidateQueries({ queryKey: ['backup'] });
    },
    onError: (e) =>
      toast({ title: 'Snapshot failed', description: errorMessage(e), variant: 'error' }),
  });

  const restoreMut = useMutation({
    mutationFn: (path: string) => ipc.backup.stageRestoreFromPath(path),
    onSuccess: () => {
      if (confirm(RESTORE_CONFIRM)) void ipc.backup.applyAndRelaunch();
    },
    onError: (e) =>
      toast({ title: 'Restore failed', description: errorMessage(e), variant: 'error' }),
  });

  const deleteMut = useMutation({
    mutationFn: (fileName: string) => ipc.backup.delete(fileName),
    onSuccess: () => {
      toast({ title: 'Snapshot deleted', variant: 'success' });
      void qc.invalidateQueries({ queryKey: ['backup'] });
    },
    onError: (e) =>
      toast({ title: 'Delete failed', description: errorMessage(e), variant: 'error' }),
  });

  const items = listQ.data ?? [];
  const totalSize = items.reduce((s, i) => s + i.sizeBytes, 0);

  return (
    <Card>
      <div className="mb-2 flex items-start justify-between">
        <div className="flex items-center gap-2">
          <Database className="h-5 w-5" />
          <h2 className="text-lg font-semibold">Local snapshots</h2>
        </div>
        <div className="text-right text-xs text-stone-500">
          {items.length} on this PC · {fmtBytes(totalSize)}
        </div>
      </div>
      <p className="mb-4 text-sm text-stone-500">
        The app saves a complete copy of the database every day and keeps the
        last 14. They live on this PC, so they protect against mistakes, not
        against a disk failure; the cloud copy and USB copy below cover that.
      </p>

      <div className="mb-3">
        <Button
          variant="secondary"
          onClick={() => createMut.mutate()}
          disabled={createMut.isPending}
        >
          <Database className="h-4 w-4" />
          {createMut.isPending ? 'Saving…' : 'Save a snapshot now'}
        </Button>
      </div>

      {items.length === 0 ? (
        <div className="rounded-lg border-2 border-dashed border-stone-200 py-8 text-center text-sm text-stone-500 dark:border-stone-700">
          No snapshots yet. The first one is saved automatically within 24 hours.
        </div>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wider text-stone-500">
            <tr>
              <th className="pb-2">When</th>
              <th className="pb-2">Kind</th>
              <th className="pb-2 text-right">Size</th>
              <th className="pb-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {items.map((b) => (
              <tr key={b.fileName} className="border-t border-stone-100 dark:border-stone-800">
                <td className="py-2">
                  <div className="font-medium">{fmtDate(b.createdAtIso)}</div>
                  <div className="font-mono text-[10px] text-stone-500">{b.fileName}</div>
                </td>
                <td className="py-2">
                  {b.kind === 'auto' ? (
                    <span className="inline-flex items-center gap-1 rounded bg-stone-100 px-2 py-0.5 text-xs text-stone-700 dark:bg-stone-700 dark:text-stone-300">
                      <Clock className="h-3 w-3" />
                      Automatic
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-200">
                      <HardDrive className="h-3 w-3" />
                      Manual
                    </span>
                  )}
                </td>
                <td className="py-2 text-right font-mono">{fmtBytes(b.sizeBytes)}</td>
                <td className="py-2 text-right">
                  <button
                    type="button"
                    onClick={() => restoreMut.mutate(b.fullPath)}
                    className="rounded p-1.5 text-stone-500 hover:bg-stone-100 hover:text-stone-900 dark:hover:bg-stone-800"
                    title="Restore this snapshot"
                    aria-label="Restore"
                  >
                    <RotateCcw className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (confirm(`Delete the snapshot from ${fmtDate(b.createdAtIso)}?`))
                        deleteMut.mutate(b.fileName);
                    }}
                    className="rounded p-1.5 text-red-500 hover:bg-red-50 dark:hover:bg-red-950"
                    title="Delete this snapshot"
                    aria-label="Delete"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

/** Backups → USB copy and restore: the off-site copy the owner makes by hand. */
export function UsbRestoreSettings() {
  const { toast } = useToast();

  const exportMut = useMutation({
    mutationFn: () => ipc.backup.export(),
    onSuccess: (r) => {
      if (r.path) {
        toast({ title: 'Copy saved', description: `Saved to ${r.path}`, variant: 'success' });
      }
    },
    onError: (e) =>
      toast({ title: 'Export failed', description: errorMessage(e), variant: 'error' }),
  });

  const restoreFromFileMut = useMutation({
    mutationFn: () => ipc.backup.stageRestoreFromPicker(),
    onSuccess: (r) => {
      if (!r.staged) return;
      if (confirm(RESTORE_CONFIRM)) void ipc.backup.applyAndRelaunch();
    },
    onError: (e) =>
      toast({ title: 'Restore failed', description: errorMessage(e), variant: 'error' }),
  });

  return (
    <Card>
      <div className="mb-2 flex items-center gap-2">
        <Usb className="h-5 w-5" />
        <h2 className="text-lg font-semibold">USB copy and restore</h2>
      </div>
      <p className="mb-4 text-sm text-stone-500">
        Every Friday, save a copy to a USB stick and keep it away from the shop.
        It is the only copy that survives this PC and the cloud account both
        failing. Restore from file accepts any copy made here, from a USB stick
        or from the backups folder.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" onClick={() => exportMut.mutate()} disabled={exportMut.isPending}>
          <Download className="h-4 w-4" />
          Save a copy to USB…
        </Button>
        <Button
          variant="secondary"
          onClick={() => restoreFromFileMut.mutate()}
          disabled={restoreFromFileMut.isPending}
        >
          <Upload className="h-4 w-4" />
          Restore from file…
        </Button>
      </div>
      <div className="mt-4 flex items-start gap-2 rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
        <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
        <div>
          <strong>Restore replaces everything.</strong> Orders, customers, menu and
          stock on this PC are overwritten by the chosen copy. The current
          database is archived first as a <code>before-restore-*.db</code> file in
          the backups folder, so a restore can be undone.
        </div>
      </div>
    </Card>
  );
}
