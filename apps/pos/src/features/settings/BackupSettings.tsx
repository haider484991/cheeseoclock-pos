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
} from 'lucide-react';

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleString();
}

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
        title: 'Backup created',
        description: `${r.fileName} (${fmtBytes(r.sizeBytes)})`,
        variant: 'success',
      });
      void qc.invalidateQueries({ queryKey: ['backup'] });
    },
    onError: (e) =>
      toast({
        title: 'Backup failed',
        description: e instanceof Error ? e.message : String(e),
        variant: 'error',
      }),
  });

  const exportMut = useMutation({
    mutationFn: () => ipc.backup.export(),
    onSuccess: (r) => {
      if (r.path) {
        toast({
          title: 'Backup exported',
          description: `Saved to ${r.path}`,
          variant: 'success',
        });
      }
    },
    onError: (e) =>
      toast({
        title: 'Export failed',
        description: e instanceof Error ? e.message : String(e),
        variant: 'error',
      }),
  });

  const stageFromPickerMut = useMutation({
    mutationFn: () => ipc.backup.stageRestoreFromPicker(),
    onSuccess: (r) => {
      if (!r.staged) return;
      if (
        confirm(
          'Restore staged. The app will restart and replace the current database with the chosen backup.\n\nThe current data will be auto-archived first (you can recover it from the backups folder).\n\nProceed?',
        )
      ) {
        void ipc.backup.applyAndRelaunch();
      }
    },
    onError: (e) =>
      toast({
        title: 'Restore failed',
        description: e instanceof Error ? e.message : String(e),
        variant: 'error',
      }),
  });

  const stageInternalMut = useMutation({
    mutationFn: (path: string) => ipc.backup.stageRestoreFromPath(path),
    onSuccess: () => {
      if (
        confirm(
          'Restore staged. The app will restart and replace the current database with the chosen backup.\n\nThe current data will be auto-archived first.\n\nProceed?',
        )
      ) {
        void ipc.backup.applyAndRelaunch();
      }
    },
    onError: (e) =>
      toast({
        title: 'Restore failed',
        description: e instanceof Error ? e.message : String(e),
        variant: 'error',
      }),
  });

  const deleteMut = useMutation({
    mutationFn: (fileName: string) => ipc.backup.delete(fileName),
    onSuccess: () => {
      toast({ title: 'Backup deleted', variant: 'success' });
      void qc.invalidateQueries({ queryKey: ['backup'] });
    },
  });

  const items = listQ.data ?? [];
  const totalSize = items.reduce((s, i) => s + i.sizeBytes, 0);

  return (
    <Card>
      <div className="mb-4 flex items-start justify-between">
        <div className="flex items-center gap-2">
          <Database className="h-5 w-5" />
          <h2 className="text-lg font-semibold">Local backup</h2>
        </div>
        <div className="text-right text-xs text-stone-500">
          {items.length} backups · {fmtBytes(totalSize)}
        </div>
      </div>

      <div className="mb-4 rounded-xl border border-stone-200 bg-stone-50 p-3 text-xs text-stone-600 dark:border-stone-700 dark:bg-stone-800 dark:text-stone-300">
        <div className="flex items-start gap-2">
          <Clock className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-600 dark:text-amber-400" />
          <div>
            <strong>Daily auto-backup is on.</strong> The app keeps the last 14 days
            inside the user-data folder. For real protection, also{' '}
            <strong>export a copy</strong> to a USB stick or network drive every week —
            local backups won't survive a disk crash.
          </div>
        </div>
      </div>

      <div className="mb-3 grid grid-cols-3 gap-2">
        <Button variant="primary" onClick={() => createMut.mutate()} disabled={createMut.isPending}>
          <Database className="h-4 w-4" />
          {createMut.isPending ? 'Backing up…' : 'Back up now'}
        </Button>
        <Button
          variant="secondary"
          onClick={() => exportMut.mutate()}
          disabled={exportMut.isPending}
        >
          <Download className="h-4 w-4" />
          Export copy…
        </Button>
        <Button
          variant="secondary"
          onClick={() => stageFromPickerMut.mutate()}
          disabled={stageFromPickerMut.isPending}
        >
          <Upload className="h-4 w-4" />
          Restore from file…
        </Button>
      </div>

      {items.length === 0 ? (
        <div className="rounded-lg border-2 border-dashed border-stone-200 py-8 text-center text-sm text-stone-500 dark:border-stone-700">
          No backups yet. The first auto-backup runs within 24 hours.
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
                      Auto
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
                    onClick={() => stageInternalMut.mutate(b.fullPath)}
                    className="rounded p-1.5 text-stone-500 hover:bg-stone-100 hover:text-stone-900 dark:hover:bg-stone-800"
                    title="Restore this backup"
                    aria-label="Restore"
                  >
                    <RotateCcw className="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (confirm(`Delete backup "${b.fileName}"?`)) deleteMut.mutate(b.fileName);
                    }}
                    className="rounded p-1.5 text-red-500 hover:bg-red-50 dark:hover:bg-red-950"
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

      <div className="mt-4 flex items-start gap-2 rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
        <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
        <div>
          <strong>Restore replaces everything.</strong> Current orders, customers, menu,
          and inventory will be overwritten by the chosen backup. The current
          database is auto-archived first so you can recover it if needed (look in
          the user-data backups folder for a <code>before-restore-*.db</code> file).
        </div>
      </div>
    </Card>
  );
}
