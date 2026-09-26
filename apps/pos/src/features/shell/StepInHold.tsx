import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { create } from 'zustand';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@cheeseoclock/ui';
import { LogOut, ShieldCheck } from 'lucide-react';
import { useSessionStore } from '../../stores/sessionStore';
import { useToast } from '../../components/toast/ToastProvider';
import { SecretInput } from '../../components/secret/SecretInput';
import { IpcError } from '../../ipc/client';
import { stepInClock, stepInTimeLabel } from './stepInClock';

/** "Keep my login" tapped in the top bar before the time is up. */
export const useKeepLoginAsk = create<{ open: boolean }>(() => ({ open: false }));

/**
 * A manager or the owner stepping in on a cashier's till (auth-service
 * STEP_IN_MAX_MS): a warning a minute before, then — however busy the till —
 * the till holds the login and this box goes OVER the page, which keeps
 * everything on it (a half-edited item, a drawer count being typed). Their
 * own PIN or password carries on as a normal login; "Hand back to cashier"
 * logs out. The same box opens early from the top bar ("Keep my login").
 * Mounted once, in AppShell.
 */
export function StepInHold() {
  const user = useSessionStore((s) => s.user);
  const refresh = useSessionStore((s) => s.refresh);
  const logout = useSessionStore((s) => s.logout);
  const keepStepIn = useSessionStore((s) => s.keepStepIn);
  const asked = useKeepLoginAsk((s) => s.open);
  const { toast } = useToast();
  const qc = useQueryClient();
  const [secret, setSecret] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const endsAt = user?.stepInEndsAt ?? null;
  const held = user?.stepInHeld === true;

  // The warning a minute before, and asking the till at the time itself (the
  // box then comes up even if nothing on the page calls the till).
  useEffect(() => {
    if (!endsAt || held) return;
    const clock = stepInClock(endsAt, Date.now());
    if (!clock) return;
    const timers: number[] = [];
    if (clock.warnInMs !== null) {
      timers.push(
        window.setTimeout(() => {
          toast({
            title: `Your login stops at ${stepInTimeLabel(endsAt)}`,
            description:
              'A cashier was using this till. Then type your PIN to keep working — nothing on the screen is lost. Or tap "Hand back to cashier".',
            variant: 'warning',
            duration: 60_000,
          });
        }, clock.warnInMs),
      );
    }
    timers.push(window.setTimeout(() => void refresh(), clock.holdInMs + 500));
    return () => timers.forEach((t) => window.clearTimeout(t));
  }, [endsAt, held, refresh, toast]);

  const open = !!user && !!endsAt && (held || asked);
  useEffect(() => {
    if (!open) {
      setSecret('');
      setProblem(null);
    }
  }, [open]);
  // Kept or handed back: the early ask is done.
  useEffect(() => {
    if (!endsAt) useKeepLoginAsk.setState({ open: false });
  }, [endsAt]);

  if (!open || !user || !endsAt) return null;

  async function keep() {
    if (busy || !secret.trim()) return;
    setBusy(true);
    try {
      await keepStepIn(secret);
      useKeepLoginAsk.setState({ open: false });
      toast({ title: 'Your login carries on', description: 'It works like a normal login now.', variant: 'success' });
      // Anything the page asked for while it was held: ask again.
      void qc.invalidateQueries();
    } catch (e) {
      setSecret('');
      setProblem(e instanceof IpcError || e instanceof Error ? e.message : 'That did not work. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog.Root
      open
      onOpenChange={(next) => {
        // Held: only the PIN or "Hand back" closes it.
        if (!next && !held) useKeepLoginAsk.setState({ open: false });
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[70] bg-black/50 backdrop-blur-sm" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-[70] w-[440px] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 rounded-xl bg-white p-5 shadow-xl dark:bg-stone-900"
          onEscapeKeyDown={(e) => held && e.preventDefault()}
          onPointerDownOutside={(e) => held && e.preventDefault()}
          onInteractOutside={(e) => held && e.preventDefault()}
        >
          <Dialog.Title className="flex items-center gap-2 text-lg font-semibold">
            <ShieldCheck className="h-5 w-5 text-amber-600" />
            {held ? `Is this still ${user.fullName}?` : 'Keep your login'}
          </Dialog.Title>
          <Dialog.Description className="mt-2 text-sm text-stone-600 dark:text-stone-400">
            {held
              ? 'A cashier was using this till, so your login stops after 10 minutes. Type your PIN or password to keep working. Nothing on the screen is lost.'
              : `A cashier was using this till, so your login stops at ${stepInTimeLabel(endsAt)}. Type your PIN or password now to keep working without a break.`}
          </Dialog.Description>
          <form
            className="mt-4"
            onSubmit={(e) => {
              e.preventDefault();
              void keep();
            }}
          >
            <SecretInput
              autoFocus
              value={secret}
              onChange={(v) => {
                setSecret(v);
                setProblem(null);
              }}
              aria-label={`${user.fullName}'s PIN or password`}
              wrapperClassName="flex gap-2"
              className="w-full rounded-lg border border-stone-300 px-3 py-2 text-lg tracking-widest dark:border-stone-700 dark:bg-stone-800"
            />
            {problem && (
              <p role="alert" className="mt-2 text-sm font-medium text-red-600 dark:text-red-400">
                {problem}
              </p>
            )}
            <div className="mt-5 flex flex-wrap justify-end gap-2">
              {held ? (
                <Button type="button" variant="secondary" onClick={() => void logout()}>
                  <LogOut className="h-4 w-4" />
                  Hand back to cashier
                </Button>
              ) : (
                <Button type="button" variant="secondary" onClick={() => useKeepLoginAsk.setState({ open: false })}>
                  Not now
                </Button>
              )}
              <Button type="submit" variant="primary" disabled={busy || !secret.trim()}>
                {busy ? 'Checking…' : 'Keep working'}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
