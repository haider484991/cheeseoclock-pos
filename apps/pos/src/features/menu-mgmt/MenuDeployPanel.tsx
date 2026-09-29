import { useMutation } from '@tanstack/react-query';
import { Button, Card, cn } from '@cheeseoclock/ui';
import { Eye, Send } from 'lucide-react';
import type { MenuDeployView, MenuImportPreview } from '@cheeseoclock/shared-types';
import { ipc, IpcError } from '../../ipc/client';
import { useToast } from '../../components/toast/ToastProvider';
import { dayTime, phaseTone, showChangesLabel } from '../settings/shop-rules/menuDeployWords';

const TONE_CLASS = {
  good: 'border-emerald-300 bg-emerald-50 text-emerald-950 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-100',
  warn: 'border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100',
  bad: 'border-red-300 bg-red-50 text-red-950 dark:border-red-800 dark:bg-red-950/40 dark:text-red-100',
  plain: 'border-stone-200 bg-white text-stone-800 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-100',
} as const;

/**
 * Menu → Import, above the file picker: the newest menu file from the costing
 * PC (v0.7.32) — where this till stands, in one sentence, whatever the mode.
 * When it waits for someone (Wait for my OK, given up after 5 tries, or the
 * other till stopped halfway) "Show the changes" puts the normal preview
 * below — the same as a picked file, never Start fresh — and its Apply puts
 * the file in (ImportTab).
 */
export function MenuDeployPanel({
  view,
  busy,
  onPreview,
}: {
  view: MenuDeployView | undefined;
  busy: boolean;
  onPreview: (p: MenuImportPreview & { packageId: string }) => void;
}) {
  const { toast } = useToast();
  const previewMut = useMutation({
    mutationFn: (packageId: string) => ipc.menuDeploy.preview(packageId),
    onSuccess: (p) => onPreview(p),
    onError: (e) =>
      toast({ title: 'Could not show the changes', description: e instanceof IpcError ? e.message : String(e), variant: 'error' }),
  });
  if (!view || !view.websiteLinked || (view.phase === 'idle' && !view.key)) return null;
  const tone = phaseTone(view.phase);
  return (
    <Card className={cn('border-2', TONE_CLASS[tone])}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-2xl">
          <h2 className="flex items-center gap-2 font-semibold">
            <Send className="h-4 w-4" /> Menu file from the costing PC
          </h2>
          <p className="mt-1 text-sm" aria-live="polite">
            {view.message}
          </p>
          {view.package && (
            <p className="mt-1 text-xs opacity-80">
              File #{view.package.seq}: {view.package.fileName} — made {dayTime(view.package.generatedAt)}, {view.package.itemCount} items,{' '}
              {view.package.ingredientCount} ingredients.
              {view.mode === 'ask' ? ' Settings → Kitchen & stock: wait for your OK.' : ''}
            </p>
          )}
        </div>
        {view.canApplyNow && view.package && (
          <Button variant="secondary" disabled={busy || previewMut.isPending} onClick={() => previewMut.mutate(view.package!.id)}>
            <Eye className="h-4 w-4" /> {previewMut.isPending ? 'Reading…' : showChangesLabel(view)}
          </Button>
        )}
      </div>
    </Card>
  );
}
