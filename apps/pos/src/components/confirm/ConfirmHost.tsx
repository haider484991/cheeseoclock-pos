import * as Dialog from '@radix-ui/react-dialog';
import { create } from 'zustand';
import { Button } from '@cheeseoclock/ui';

/**
 * "Are you sure?" inside the app window.
 *
 * The browser's own confirm() opens a native Windows dialog, and after it
 * closes Electron leaves the keyboard pointing nowhere: text boxes look
 * focused but ignore typing until the window is clicked away and back (a
 * long-standing Electron bug on Windows). At the till that read as "it won't
 * let me type the customer's phone" after discarding an order. So the POS
 * never calls confirm(); it asks with this dialog instead.
 */

interface Ask {
  message: string;
  danger: boolean;
  resolve: (ok: boolean) => void;
}

const useConfirmStore = create<{ ask: Ask | null }>(() => ({ ask: null }));

/** Words that start a question about losing or replacing something. */
const DANGER = /^(delete|discard|deactivate|cancel|replace|restore)\b/i;

/** Ask a yes/no question in the app window; resolves true on Yes. */
export function askConfirm(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    // A second question replaces an open one; the first counts as "No".
    useConfirmStore.getState().ask?.resolve(false);
    useConfirmStore.setState({ ask: { message, danger: DANGER.test(message.trim()), resolve } });
  });
}

function answer(ok: boolean): void {
  const ask = useConfirmStore.getState().ask;
  if (!ask) return;
  useConfirmStore.setState({ ask: null });
  ask.resolve(ok);
}

/** "Discard order #12? Its 2 items…" → title "Discard order #12?", the rest below it. */
function splitQuestion(message: string): [string, string] {
  const nl = message.indexOf('\n');
  const q = message.indexOf('? ');
  const cut = nl >= 0 && (q < 0 || nl < q) ? nl : q >= 0 ? q + 1 : -1;
  return cut < 0 ? [message.trim(), ''] : [message.slice(0, cut).trim(), message.slice(cut).trim()];
}

/** Mounted once at the root of the app. */
export function ConfirmHost() {
  const ask = useConfirmStore((s) => s.ask);
  if (!ask) return null;
  const [title, body] = splitQuestion(ask.message);
  return (
    <Dialog.Root open onOpenChange={(open) => !open && answer(false)}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-black/40 backdrop-blur-sm" />
        <Dialog.Content
          className="fixed left-1/2 top-1/2 z-[60] w-[460px] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 rounded-xl bg-white p-5 shadow-xl dark:bg-stone-900"
          onOpenAutoFocus={(e) => {
            // Enter should not destroy something by accident: focus "No" on risky questions.
            e.preventDefault();
            const root = e.currentTarget as HTMLElement;
            root.querySelector<HTMLButtonElement>(ask.danger ? '[data-answer="no"]' : '[data-answer="yes"]')?.focus();
          }}
        >
          <Dialog.Title className="font-semibold">{title}</Dialog.Title>
          {body ? (
            <Dialog.Description className="mt-2 whitespace-pre-line text-sm text-stone-600 dark:text-stone-400">
              {body}
            </Dialog.Description>
          ) : (
            <Dialog.Description className="sr-only">Confirm</Dialog.Description>
          )}
          <div className="mt-5 flex justify-end gap-2">
            <Button variant="secondary" data-answer="no" onClick={() => answer(false)}>
              No
            </Button>
            <Button variant={ask.danger ? 'danger' : 'primary'} data-answer="yes" onClick={() => answer(true)}>
              Yes
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
