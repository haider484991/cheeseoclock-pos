import { useEffect, type KeyboardEvent } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { create } from 'zustand';
import { Button } from '@cheeseoclock/ui';
import type { CloseTillAsk } from '@cheeseoclock/shared-types';
import { ipc, onCloseTillRequested } from '../../ipc/client';

/*
 * "Close the till?" (v0.7.33): X, Alt+F4 or the taskbar's Close while
 * website orders come in through this till. The main process holds the close
 * and asks here first (electron/services/till-close.ts); it never asks for an
 * update, a restore, Windows shutting down, or a screen that cannot answer.
 * "Keep the till open" has the focus, and Esc, Enter and a tap outside keep
 * it open too.
 *
 * Its own store, not askConfirm: a second question there answers an open
 * one "No", it sits under StepInHold, and it has no id to answer the till
 * with. It sits above the toasts (z-100) and under the new-order banner
 * (z-110), so a new order still shows over it. The update banner (z-115) stays
 * on top: "Restart now" quits the till, which needs no question.
 */

export const CLOSE_TILL_TITLE = 'Close the till?';
export const CLOSE_TILL_KEEP = 'Keep the till open';
export const CLOSE_TILL_CLOSE = 'Close the till';
export const CLOSE_TILL_CLOSING = 'Closing…';

/** The words under the title: what closing stops, and the website orders still on the board. */
export function closeTillLines(openWebOrders: number): string[] {
  const lines = ['Website orders stop until the till is opened again.'];
  if (openWebOrders === 1) lines.push('1 website order is still on Live Orders.');
  else if (openWebOrders > 1) lines.push(`${openWebOrders} website orders are still on Live Orders.`);
  return lines;
}

interface CloseTillState {
  ask: CloseTillAsk | null;
  /** "Close the till" was pressed: the till says goodbye to the website, then closes. */
  closing: boolean;
  /** X pressed again while the question is up: focus "Keep the till open" again. */
  nudge: number;
}

export const useCloseTillStore = create<CloseTillState>(() => ({ ask: null, closing: false, nudge: 0 }));

/** The till asks (system:close-requested). The same question again only brings it back to the front. */
export function closeTillRequested(req: CloseTillAsk): void {
  const s = useCloseTillStore.getState();
  if (s.ask?.requestId === req.requestId) useCloseTillStore.setState({ nudge: s.nudge + 1 });
  else useCloseTillStore.setState({ ask: req, closing: false, nudge: 0 });
}

/** Drop the question if it is still this one (out of date, or the till did not close after all). */
function dropIfStill(requestId: string): void {
  if (useCloseTillStore.getState().ask?.requestId === requestId) {
    useCloseTillStore.setState({ ask: null, closing: false, nudge: 0 });
  }
}

/** "Keep the till open" (also Esc and a tap outside); nothing while the till is already closing. */
export function keepTillOpen(): void {
  const { ask, closing } = useCloseTillStore.getState();
  if (!ask || closing) return;
  useCloseTillStore.setState({ ask: null, closing: false, nudge: 0 });
  void ipc.system.closeAnswer(ask.requestId, false).catch(() => {});
}

/** "Close the till": "Closing…" until the window goes; an out-of-date answer drops the question. */
export async function closeTill(): Promise<void> {
  const { ask, closing } = useCloseTillStore.getState();
  if (!ask || closing) return;
  useCloseTillStore.setState({ closing: true });
  try {
    // The window goes in a moment: "Closing…" stays until it does.
    if ((await ipc.system.closeAnswer(ask.requestId, true)).closing) return;
  } catch {
    // Not closing after all: the question goes, and the next X asks again.
  }
  dropIfStill(ask.requestId);
}

/**
 * Keys typed while the question is up are the question's. Without this the
 * PIN screen (which listens on the window) takes Enter as "Sign in" with an
 * empty PIN, and digits go into the PIN. Esc still reaches the dialog: Radix
 * hears it on the document first.
 */
export function keepKeysInQuestion(e: Pick<KeyboardEvent, 'stopPropagation'>): void {
  e.stopPropagation();
}

/** The question itself (exported for its tests). */
export function CloseTillQuestion({
  ask,
  closing,
  onKeep,
  onClose,
}: {
  ask: CloseTillAsk;
  closing: boolean;
  onKeep: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog.Root open onOpenChange={(open) => !open && onKeep()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[105] bg-black/40 backdrop-blur-sm" />
        <Dialog.Content
          data-close-till=""
          className="fixed left-1/2 top-1/2 z-[105] w-[460px] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 rounded-xl bg-white p-5 shadow-xl dark:bg-stone-900"
          onOpenAutoFocus={(e) => {
            // Enter must keep the till open: the safe answer has the focus.
            e.preventDefault();
            (e.currentTarget as HTMLElement).querySelector<HTMLButtonElement>('[data-answer="keep"]')?.focus();
          }}
          onEscapeKeyDown={(e) => {
            if (closing) e.preventDefault();
          }}
          onKeyDown={keepKeysInQuestion}
        >
          <Dialog.Title className="font-semibold">{CLOSE_TILL_TITLE}</Dialog.Title>
          <Dialog.Description className="mt-2 whitespace-pre-line text-sm text-stone-600 dark:text-stone-400">
            {closeTillLines(ask.openWebOrders).join('\n')}
          </Dialog.Description>
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="secondary" data-answer="keep" onClick={onKeep}>
              {CLOSE_TILL_KEEP}
            </Button>
            <Button variant="danger" data-answer="close" disabled={closing} onClick={onClose}>
              {closing ? CLOSE_TILL_CLOSING : CLOSE_TILL_CLOSE}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Mounted once at the root, outside the sign-in gate (main.tsx). */
export function CloseTillHost() {
  const ask = useCloseTillStore((s) => s.ask);
  const closing = useCloseTillStore((s) => s.closing);
  const nudge = useCloseTillStore((s) => s.nudge);

  useEffect(() => onCloseTillRequested(closeTillRequested), []);

  // Tell the till the question is up (until then it closes by itself after
  // 5 s); a question the till no longer has goes. Again on a second X, which
  // also puts the focus back on "Keep the till open".
  useEffect(() => {
    if (!ask) return;
    const id = ask.requestId;
    void ipc.system
      .closeShown(id)
      .then((r) => {
        if (!r.pending) dropIfStill(id);
      })
      .catch(() => {});
    if (nudge > 0) document.querySelector<HTMLButtonElement>('[data-close-till] [data-answer="keep"]')?.focus();
  }, [ask, nudge]);

  // "Closing…" disables the button that had the focus: keep the keys in the
  // question (keepKeysInQuestion) for the moment until the window goes.
  useEffect(() => {
    if (closing) document.querySelector<HTMLElement>('[data-close-till]')?.focus();
  }, [closing]);

  if (!ask) return null;
  return <CloseTillQuestion ask={ask} closing={closing} onKeep={keepTillOpen} onClose={() => void closeTill()} />;
}
