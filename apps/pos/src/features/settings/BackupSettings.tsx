import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Button, Card, cn } from '@cheeseoclock/ui';
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  Cloud,
  DatabaseBackup,
  Download,
  HardDrive,
  RotateCcw,
  ShieldAlert,
  Trash2,
  Upload,
  Usb,
  XCircle,
} from 'lucide-react';
import { ipc } from '../../ipc/client';
import { useToast } from '../../components/toast/ToastProvider';
import { askConfirm } from '../../components/confirm/ConfirmHost';
import { confirmAndRestore } from './applyRestore';
import { fmtBytes, fmtWhen, localCopyLabel, mergeCopies, type CopyRow, type Tone } from './backupStatus';
import { useBackupSummary } from './useBackupSummary';
import { OnlineBackupSchedule, useSetOnlineFrequency } from './CloudBackupSettings';
import { AuditTrailCard, useAuditChain } from './AuditTrailCard';

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Copies shown before "Show all". */
const FIRST_ROWS = 8;

/**
 * Settings → Backups. One place for every copy of the shop's data: a status
 * line (green / amber / red), one "Back up now" button, the copies on this
 * computer and online in one list, the USB copy, and the rest folded away
 * under Advanced.
 *
 * The safeguards are the main process's and are unchanged: restoring or
 * deleting a copy needs the owner login, today's data is saved as a safety
 * copy (on this computer and online) before a restore, the restore is written
 * into the hash-chained history log, and nothing is staged for a restore
 * until the owner has said yes (see applyRestore.ts).
 */
export function BackupsPanel({ onGoToOnline }: { onGoToOnline: () => void }) {
  return (
    <div className="space-y-6">
      <BackupStatusCard onGoToOnline={onGoToOnline} />
      <CopiesCard />
      <UsbCard />
      <AdvancedBackups onGoToOnline={onGoToOnline} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Status + Back up now
// ---------------------------------------------------------------------------

const TONE_TEXT: Record<Tone, string> = {
  good: 'text-emerald-600 dark:text-emerald-400',
  warn: 'text-amber-600 dark:text-amber-400',
  bad: 'text-red-600 dark:text-red-400',
};

export function ToneIcon({ tone, className }: { tone: Tone; className?: string }) {
  const Icon = tone === 'good' ? CheckCircle2 : tone === 'warn' ? AlertTriangle : XCircle;
  return <Icon className={cn('shrink-0', TONE_TEXT[tone], className)} aria-hidden />;
}

function BackupStatusCard({ onGoToOnline }: { onGoToOnline: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const { summary, connected, isError } = useBackupSummary();
  const chainQ = useAuditChain();
  const turnOn = useSetOnlineFrequency();
  const chain = chainQ.data;
  const historyChanged = !!chain && (!chain.ok || (!!chain.anchor && !chain.anchor.present));

  const backupNowMut = useMutation({
    mutationFn: async () => {
      let localError: string | null = null;
      let onlineError: string | null = null;
      try {
        await ipc.backup.create();
      } catch (e) {
        localError = errorMessage(e);
      }
      if (connected) {
        try {
          await ipc.webBridge.backupNow();
        } catch (e) {
          onlineError = errorMessage(e);
        }
      }
      return { localError, onlineError, online: connected };
    },
    onSuccess: ({ localError, onlineError, online }) => {
      if (!localError && online && !onlineError) {
        toast({ title: 'Backed up', description: 'Saved on this computer and online.', variant: 'success' });
      } else if (!localError && !online) {
        toast({
          title: 'Backed up on this computer',
          description: 'Connect the website (Online orders) to also keep a copy online.',
          variant: 'success',
        });
      } else if (!localError) {
        toast({
          title: 'Saved on this computer only',
          description: `The online copy did not go through: ${onlineError}`,
          variant: 'warning',
        });
      } else if (online && !onlineError) {
        toast({
          title: 'Saved online only',
          description: `Could not save on this computer: ${localError}`,
          variant: 'warning',
        });
      } else {
        toast({
          title: 'Backup failed',
          description: [localError, onlineError].filter(Boolean).join(' · '),
          variant: 'error',
        });
      }
      void qc.invalidateQueries({ queryKey: ['backup'] });
      void qc.invalidateQueries({ queryKey: ['webBridge'] });
      void qc.invalidateQueries({ queryKey: ['audit'] });
    },
  });

  const tone: Tone = historyChanged ? 'bad' : (summary?.tone ?? 'good');

  return (
    <Card
      className={cn(
        'ring-2',
        !summary && 'ring-stone-200/60',
        summary && tone === 'good' && 'ring-emerald-200 dark:ring-emerald-900',
        summary && tone === 'warn' && 'ring-amber-200 dark:ring-amber-900',
        summary && tone === 'bad' && 'ring-red-300 dark:ring-red-900',
      )}
    >
      <div className="flex flex-wrap items-start gap-4">
        {summary ? (
          <ToneIcon tone={tone} className="mt-0.5 h-9 w-9" />
        ) : (
          <DatabaseBackup className="mt-0.5 h-9 w-9 shrink-0 text-stone-400" aria-hidden />
        )}
        <div className="min-w-0 flex-1">
          <h2 className="text-xl font-bold tracking-tight" data-testid="backup-headline">
            {historyChanged
              ? 'The history log was changed'
              : (summary?.headline ?? (isError ? 'Could not read the backup status' : 'Checking backups…'))}
          </h2>
          {summary && (
            <ul className="mt-2 space-y-1 text-sm">
              {[summary.local, summary.online].map((line) => (
                <li key={line.text} className="flex items-start gap-2">
                  <ToneIcon tone={line.tone} className="mt-0.5 h-4 w-4" />
                  <span className="text-stone-700 dark:text-stone-200">{line.text}</span>
                </li>
              ))}
            </ul>
          )}
          {summary?.onlineFix === 'connect' && (
            <Button size="sm" variant="secondary" className="mt-3" onClick={onGoToOnline}>
              Connect the website
              <ArrowRight className="h-3.5 w-3.5" />
            </Button>
          )}
          {summary?.onlineFix === 'turn-on' && (
            <Button
              size="sm"
              variant="secondary"
              className="mt-3"
              disabled={turnOn.isPending}
              onClick={() => turnOn.mutate('daily')}
            >
              <Cloud className="h-3.5 w-3.5" />
              Save a copy online every day
            </Button>
          )}
        </div>
        <Button
          variant="primary"
          size="lg"
          disabled={backupNowMut.isPending}
          onClick={() => backupNowMut.mutate()}
          data-testid="backup-now"
        >
          <DatabaseBackup className="h-5 w-5" />
          {backupNowMut.isPending ? 'Backing up…' : 'Back up now'}
        </Button>
      </div>

      {historyChanged && (
        <div
          role="alert"
          className="mt-4 flex items-start gap-2 rounded-xl border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-800 dark:bg-red-950/50 dark:text-red-200"
        >
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Something changed the till&rsquo;s history log (the sealed record of every sale and
            change). Do not restore anything over this computer: leave it as it is and contact
            whoever looks after your till. Details are under Advanced → History log check.
          </span>
        </div>
      )}

      <p className="mt-4 text-xs text-stone-500">
        The till backs itself up every day without you doing anything. Press &ldquo;Back up
        now&rdquo; before a big change, like a new menu.
      </p>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// The list of copies
// ---------------------------------------------------------------------------

function restoreQuestion(row: CopyRow): string {
  const otherPc =
    row.where === 'online' && row.fromOtherPc
      ? `\n\nThis copy was made on “${row.fromOtherPc}”. After the restart, enter the website connection password again (Settings → Online orders).`
      : '';
  return (
    `Restore the copy from ${fmtWhen(row.at)}?\n` +
    'Orders, menu, stock, customers and settings on this till all go back to how they were then, and the app restarts.\n\n' +
    'Today’s data is saved first as a safety copy (on this computer, and online when the website is connected), so this can be undone. The restore is written into the history log. Only the owner login can do this.' +
    otherPc
  );
}

function CopiesCard() {
  const { toast } = useToast();
  const { connected } = useBackupSummary();
  const [showAll, setShowAll] = useState(false);

  const localQ = useQuery({
    queryKey: ['backup', 'list'],
    queryFn: () => ipc.backup.list(),
    refetchInterval: 60_000,
  });
  const onlineQ = useQuery({
    queryKey: ['webBridge', 'cloudBackups'],
    queryFn: () => ipc.webBridge.listCloudBackups(),
    enabled: connected,
  });

  const restoreMut = useMutation({
    mutationFn: (row: CopyRow) =>
      confirmAndRestore(restoreQuestion(row), () =>
        row.where === 'local'
          ? ipc.backup.stageRestoreFromPath(row.copy.fullPath)
          : ipc.webBridge.restoreCloudBackup(row.copy.id),
      ),
    onError: (e) => toast({ title: 'Restore did not start', description: errorMessage(e), variant: 'error' }),
  });

  const rows = mergeCopies(localQ.data ?? [], connected ? (onlineQ.data ?? []) : []);
  const visible = showAll ? rows : rows.slice(0, FIRST_ROWS);

  return (
    <Card>
      <div className="mb-1 flex items-center gap-2">
        <RotateCcw className="h-5 w-5" />
        <h2 className="text-lg font-semibold">Your backup copies</h2>
        <span className="ml-auto text-xs text-stone-500">{rows.length} copies</span>
      </div>
      <p className="mb-4 text-sm text-stone-500">
        Newest first. Restoring a copy puts the whole till back to how it was at that moment.
      </p>

      {localQ.isLoading ? (
        <div className="py-6 text-center text-sm text-stone-400">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="rounded-xl border-2 border-dashed border-stone-200 py-8 text-center text-sm text-stone-500 dark:border-stone-700">
          No copies yet. Press &ldquo;Back up now&rdquo; above to make the first one.
        </div>
      ) : (
        <ul className="divide-y divide-stone-100 overflow-hidden rounded-xl ring-1 ring-stone-200 dark:divide-stone-800 dark:ring-stone-700" data-testid="backup-copies">
          {visible.map((row) => {
            const busy = restoreMut.isPending && restoreMut.variables?.key === row.key;
            return (
              <li key={row.key} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <span
                  className={cn(
                    'flex h-9 w-9 shrink-0 items-center justify-center rounded-lg',
                    row.where === 'local'
                      ? 'bg-stone-100 text-stone-600 dark:bg-stone-800 dark:text-stone-300'
                      : 'bg-sky-50 text-sky-700 dark:bg-sky-950 dark:text-sky-300',
                  )}
                  aria-hidden
                >
                  {row.where === 'local' ? <HardDrive className="h-4 w-4" /> : <Cloud className="h-4 w-4" />}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="font-medium first-letter:uppercase">{fmtWhen(row.at)}</div>
                  <div className="text-xs text-stone-500">
                    {row.where === 'local'
                      ? 'On this computer'
                      : row.fromOtherPc
                        ? `Online · made on ${row.fromOtherPc}`
                        : 'Online'}
                    {' · '}
                    {row.label}
                    {row.where === 'online' && row.copy.orderCount != null
                      ? ` · ${row.copy.orderCount.toLocaleString()} orders`
                      : ''}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={restoreMut.isPending}
                  onClick={() => restoreMut.mutate(row)}
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  {busy ? 'Getting it ready…' : 'Restore…'}
                </Button>
              </li>
            );
          })}
        </ul>
      )}

      {rows.length > FIRST_ROWS && (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="mt-3 text-sm font-semibold text-amber-700 hover:underline dark:text-amber-300"
        >
          {showAll ? 'Show fewer' : `Show all ${rows.length} copies`}
        </button>
      )}

      <p className="mt-3 text-xs text-stone-500">
        {!connected
          ? 'Online copies show here once the website is connected.'
          : onlineQ.isLoading
            ? 'Checking the online copies…'
            : onlineQ.isError
              ? `Could not check the online copies right now: ${errorMessage(onlineQ.error)}`
              : 'Online copies from every till of the shop are listed, so a new computer can be restored from an old one.'}
      </p>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// USB
// ---------------------------------------------------------------------------

const FILE_QUESTION =
  'Restore from a USB copy?\nYou pick the file next. Orders, menu, stock, customers and settings on this till are replaced by it, and the app restarts.\n\nToday’s data is saved first as a safety copy, so this can be undone. A copy that was changed after it was saved is refused.';

function UsbCard() {
  const { toast } = useToast();

  const exportMut = useMutation({
    mutationFn: () => ipc.backup.export(),
    onSuccess: (r) => {
      if (r.path) toast({ title: 'Copy saved', description: `Saved to ${r.path}`, variant: 'success' });
    },
    onError: (e) => toast({ title: 'Could not save the copy', description: errorMessage(e), variant: 'error' }),
  });

  const restoreMut = useMutation({
    mutationFn: () => confirmAndRestore(FILE_QUESTION, () => ipc.backup.stageRestoreFromPicker()),
    onError: (e) => toast({ title: 'Restore did not start', description: errorMessage(e), variant: 'error' }),
  });

  return (
    <Card>
      <div className="mb-1 flex items-center gap-2">
        <Usb className="h-5 w-5" />
        <h2 className="text-lg font-semibold">Extra copy on a USB stick</h2>
      </div>
      <p className="mb-4 text-sm text-stone-500">
        Once a week, save a copy to a USB stick and keep it at home. If this computer is stolen or
        breaks, the till can be brought back from it, even without the internet.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" onClick={() => exportMut.mutate()} disabled={exportMut.isPending}>
          <Download className="h-4 w-4" />
          {exportMut.isPending ? 'Saving…' : 'Save a copy to USB…'}
        </Button>
        <Button variant="secondary" onClick={() => restoreMut.mutate()} disabled={restoreMut.isPending}>
          <Upload className="h-4 w-4" />
          {restoreMut.isPending ? 'Restoring…' : 'Restore from a USB copy…'}
        </Button>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Advanced (folded away)
// ---------------------------------------------------------------------------

function AdvancedBackups({ onGoToOnline }: { onGoToOnline: () => void }) {
  return (
    <details className="group rounded-2xl bg-white shadow-soft ring-1 ring-stone-200/60 dark:bg-stone-900 dark:ring-stone-800/80">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-5 py-4 [&::-webkit-details-marker]:hidden">
        <ChevronDown className="h-4 w-4 text-stone-500 transition-transform group-open:rotate-180" />
        <span className="font-semibold">Advanced</span>
        <span className="text-sm text-stone-500">
          Online schedule, what is kept, history log check, deleting copies
        </span>
      </summary>
      <div className="space-y-6 border-t border-stone-200 px-5 py-5 dark:border-stone-800">
        <OnlineBackupSchedule onGoToOnline={onGoToOnline} />
        <WhatIsKept />
        <AuditTrailCard />
        <DeleteLocalCopies />
      </div>
    </details>
  );
}

function WhatIsKept() {
  const localQ = useQuery({
    queryKey: ['backup', 'list'],
    queryFn: () => ipc.backup.list(),
    refetchInterval: 60_000,
  });
  const first = localQ.data?.[0];
  const folder = first ? first.fullPath.replace(/[\\/][^\\/]*$/, '') : null;
  return (
    <section>
      <h3 className="text-sm font-semibold">What is kept, and where</h3>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-stone-600 dark:text-stone-300">
        <li>
          <strong>On this computer:</strong> one complete copy a day; the last 14 days are kept.
          Copies from &ldquo;Back up now&rdquo; and safety copies stay until you delete them below.
        </li>
        <li>
          <strong>Online:</strong> the website keeps the newest 3 copies, the first copy of each day
          for 2 weeks, and every safety copy for a month, from every till. Nobody can change or
          delete a copy once it is stored. Online copies hold everything except history-log entries
          older than 90 days.
        </li>
        <li>
          <strong>USB:</strong> complete. The till checks it was not changed before restoring it.
        </li>
      </ul>
      {folder && (
        <p className="mt-2 break-all text-xs text-stone-500">
          Folder on this computer: <span className="font-mono">{folder}</span>
        </p>
      )}
    </section>
  );
}

function DeleteLocalCopies() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const localQ = useQuery({
    queryKey: ['backup', 'list'],
    queryFn: () => ipc.backup.list(),
    refetchInterval: 60_000,
  });
  const deleteMut = useMutation({
    mutationFn: (fileName: string) => ipc.backup.delete(fileName),
    onSuccess: () => {
      toast({ title: 'Copy deleted', variant: 'success' });
      void qc.invalidateQueries({ queryKey: ['backup'] });
    },
    onError: (e) => toast({ title: 'Could not delete', description: errorMessage(e), variant: 'error' }),
  });

  const items = localQ.data ?? [];
  const total = items.reduce((s, i) => s + i.sizeBytes, 0);

  return (
    <section className="rounded-xl border border-red-200 p-4 dark:border-red-900/60">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-red-700 dark:text-red-300">
        <Trash2 className="h-4 w-4" />
        Delete copies on this computer
      </h3>
      <p className="mt-1 text-sm text-stone-500">
        Only to free up disk space ({items.length} copies, {fmtBytes(total)} in total). A deleted
        copy cannot be brought back; online copies are not touched. Needs the owner login.
      </p>
      {items.length > 0 && (
        <ul className="mt-3 max-h-64 divide-y divide-stone-100 overflow-auto rounded-lg ring-1 ring-stone-200 dark:divide-stone-800 dark:ring-stone-700">
          {items.map((b) => (
            <li key={b.fileName} className="flex items-center gap-3 px-3 py-2 text-sm">
              <div className="min-w-0 flex-1">
                <div className="first-letter:uppercase">{fmtWhen(b.createdAtIso)}</div>
                <div className="text-xs text-stone-500">
                  {localCopyLabel(b.fileName)} · {fmtBytes(b.sizeBytes)}
                </div>
              </div>
              <Button
                size="sm"
                variant="ghost"
                className="text-red-600 hover:bg-red-50 hover:text-red-700 dark:text-red-400 dark:hover:bg-red-950"
                disabled={deleteMut.isPending}
                onClick={() => {
                  void askConfirm(
                    `Delete the copy from ${fmtWhen(b.createdAtIso)}?\nIt is removed from this computer for good. Online copies are not affected.`,
                  ).then((ok) => {
                    if (ok) deleteMut.mutate(b.fileName);
                  });
                }}
              >
                Delete
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
