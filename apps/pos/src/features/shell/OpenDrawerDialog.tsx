import { useState, type FormEvent } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import * as Dialog from '@radix-ui/react-dialog';
import { Button, cn } from '@cheeseoclock/ui';
import { ArrowUpFromLine, Inbox, X } from 'lucide-react';
import { ipc } from '../../ipc/client';
import { useToast } from '../../components/toast/ToastProvider';
import { useSessionStore } from '../../stores/sessionStore';
import { DRAWER_REASONS, drawerReason, drawerResultToast, type DrawerReasonChip } from './drawerToast';
import { OPEN_DRAWER_CASH_BUTTON, OPEN_DRAWER_NOTE_TEXT, OPEN_DRAWER_NOTE_TITLE } from './noteChangeWords';

/**
 * Open the cash drawer with no sale — for change, to check a note. A manager
 * or the owner opens it directly; a cashier needs a manager's PIN or password
 * (any the sign-in accepts, so the box takes letters too). Every open is
 * saved with the person's name before the drawer opens, and shows in Reports.
 */
export function OpenDrawerDialog({
  onClose,
  onCashInOut,
}: {
  onClose: () => void;
  /** Money in or out is Drawer cash in / out's (v0.7.42): this box leads there, for the shift open now. */
  onCashInOut?: (shiftId: string) => void;
}) {
  const canDirect = useSessionStore((s) => s.can('cash.movement'));
  const [chip, setChip] = useState<DrawerReasonChip | null>(null);
  const [other, setOther] = useState('');
  const [pin, setPin] = useState('');
  const { toast } = useToast();
  const shiftQ = useQuery({ queryKey: ['shifts', 'current'], queryFn: () => ipc.shifts.current() });
  const noShift = shiftQ.isSuccess && !shiftQ.data;

  const openMut = useMutation({
    mutationFn: () =>
      ipc.shifts.openDrawer({
        kind: 'no_sale',
        reason: drawerReason(chip, other),
        ...(canDirect ? {} : { approverPin: pin }),
      }),
    onSuccess: (r) => {
      toast({ ...drawerResultToast(r), ...(r.opened && !r.noPrinter ? {} : { duration: 15_000 }) });
      onClose();
    },
    onError: (e) => {
      // Most likely a wrong PIN: stay open and let them try again.
      setPin('');
      toast({
        title: 'Could not open the drawer',
        description: e instanceof Error ? e.message : 'Unknown error',
        variant: 'error',
      });
    },
  });

  const ready = canDirect || pin.trim() !== '';

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!ready || openMut.isPending) return;
    openMut.mutate();
  }

  return (
    <Dialog.Root open onOpenChange={(o) => !o && !openMut.isPending && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-[420px] max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 rounded-2xl bg-white p-5 shadow-soft-lg dark:bg-stone-900">
          <form onSubmit={submit}>
            <header className="mb-4 flex items-start justify-between gap-3">
              <div className="flex items-start gap-2">
                <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-200">
                  <Inbox className="h-4 w-4" />
                </span>
                <div>
                  <Dialog.Title className="text-lg font-semibold">Open cash drawer</Dialog.Title>
                  <Dialog.Description className="mt-0.5 text-xs text-stone-500">
                    No sale. It is saved with your name.
                  </Dialog.Description>
                </div>
              </div>
              <button
                type="button"
                onClick={onClose}
                className="rounded p-1 text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-800"
                aria-label="Close"
              >
                <X className="h-4 w-4" />
              </button>
            </header>

            <div role="note" lang="ur-Latn" className="mb-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-700 dark:bg-amber-950">
              <p className="font-semibold text-amber-900 dark:text-amber-100">{OPEN_DRAWER_NOTE_TITLE}</p>
              <p className="mt-1 text-amber-900 dark:text-amber-100">{OPEN_DRAWER_NOTE_TEXT}</p>
              {onCashInOut && shiftQ.data && (
                <button
                  type="button"
                  onClick={() => shiftQ.data && onCashInOut(shiftQ.data.id)}
                  disabled={openMut.isPending}
                  className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-amber-400 bg-white px-3 py-1.5 text-sm font-semibold text-amber-900 hover:bg-amber-100 dark:border-amber-700 dark:bg-stone-900 dark:text-amber-100"
                >
                  <ArrowUpFromLine className="h-4 w-4" />
                  {OPEN_DRAWER_CASH_BUTTON}
                </button>
              )}
            </div>

            {noShift && (
              <p className="mb-3 rounded-lg bg-stone-100 px-3 py-2 text-xs text-stone-600 dark:bg-stone-800 dark:text-stone-300">
                No shift is open — this is still saved with your name.
              </p>
            )}

            <div className="space-y-3">
              <div>
                <span className="mb-1 block text-sm font-medium text-stone-700 dark:text-stone-200">
                  Why? (optional)
                </span>
                <div className="grid grid-cols-3 gap-2">
                  {DRAWER_REASONS.map((r) => (
                    <button
                      key={r}
                      type="button"
                      aria-pressed={chip === r}
                      onClick={() => setChip(chip === r ? null : r)}
                      className={cn(
                        'rounded-lg border-2 px-2 py-2 text-sm font-semibold transition-colors',
                        chip === r
                          ? 'border-amber-500 bg-amber-50 dark:bg-amber-950'
                          : 'border-stone-200 hover:border-stone-300 dark:border-stone-700',
                      )}
                    >
                      {r}
                    </button>
                  ))}
                </div>
              </div>
              {chip === 'Other' && (
                <label className="block text-sm">
                  <span className="mb-1 block font-medium text-stone-700 dark:text-stone-200">
                    What for? (optional)
                  </span>
                  <input
                    value={other}
                    onChange={(e) => setOther(e.target.value)}
                    maxLength={80}
                    autoFocus
                    className="w-full rounded-lg border border-stone-200 px-3 py-2 text-sm focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200 dark:border-stone-700 dark:bg-stone-800"
                  />
                </label>
              )}
              {!canDirect && (
                <label className="block rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-700 dark:bg-amber-950">
                  <span className="mb-2 block text-sm font-semibold text-amber-900 dark:text-amber-100">
                    Manager PIN or password
                  </span>
                  <input
                    type="password"
                    autoComplete="off"
                    value={pin}
                    onChange={(e) => setPin(e.target.value)}
                    autoFocus={chip !== 'Other'}
                    className="w-full rounded-lg border border-amber-300 bg-white px-3 py-2 font-mono tracking-widest dark:border-amber-700 dark:bg-stone-900"
                    placeholder="Ask a manager"
                  />
                </label>
              )}
            </div>

            <div className="mt-5 flex gap-2">
              <Button type="button" variant="ghost" size="md" className="flex-1" onClick={onClose} disabled={openMut.isPending}>
                Cancel
              </Button>
              <Button
                type="submit"
                variant="primary"
                size="md"
                className="flex-1"
                // A manager or the owner just presses Enter.
                autoFocus={canDirect}
                disabled={!ready || openMut.isPending}
              >
                {openMut.isPending ? 'Opening…' : 'Open drawer'}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
