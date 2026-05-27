import { useEffect, useState } from 'react';
import { Button } from '@cheeseoclock/ui';
import { Download, RefreshCcw, X } from 'lucide-react';

/**
 * Floating banner that appears when the main-process auto-updater downloads a
 * new version. The cashier can install immediately (quit + relaunch) or dismiss
 * — the update will install on next clean quit either way.
 *
 * Listens for `updater:available` and `updater:ready` broadcasts emitted by
 * apps/pos/electron/services/auto-updater.ts.
 */
type State =
  | { kind: 'idle' }
  | { kind: 'downloading'; version: string | null }
  | { kind: 'ready'; version: string | null };

export function UpdateBanner() {
  const [state, setState] = useState<State>({ kind: 'idle' });
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const w = window as unknown as {
      updaterEvents?: {
        onAvailable: (cb: (p: { version: string | null }) => void) => () => void;
        onReady: (cb: (p: { version: string | null }) => void) => () => void;
        getState?: () => Promise<State>;
      };
    };
    const ev = w.updaterEvents;
    if (!ev) return;

    // Pull the current state once on mount in case the broadcast fired before
    // this component (or the renderer) was alive. Live events still drive
    // updates after that.
    let cancelled = false;
    if (ev.getState) {
      void ev.getState()
        .then((s) => {
          if (cancelled) return;
          if (s.kind !== 'idle') setState(s);
        })
        .catch(() => {
          // Older preload without getState — ignore, live events still work.
        });
    }

    const offA = ev.onAvailable((p) => setState({ kind: 'downloading', version: p.version }));
    const offR = ev.onReady((p) => {
      setState({ kind: 'ready', version: p.version });
      setDismissed(false);
    });
    return () => {
      cancelled = true;
      offA();
      offR();
    };
  }, []);

  if (state.kind === 'idle' || dismissed) return null;

  const isReady = state.kind === 'ready';

  return (
    <div className="fixed bottom-4 left-1/2 z-[100] -translate-x-1/2 animate-fade-in">
      <div className="flex items-center gap-3 rounded-2xl bg-gradient-to-r from-amber-50 to-amber-100/80 px-4 py-3 shadow-soft-lg ring-1 ring-amber-200 backdrop-blur-md dark:from-amber-950 dark:to-amber-900/60 dark:ring-amber-800">
        <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-amber-400 to-amber-600 text-white shadow-lift">
          {isReady ? <RefreshCcw className="h-5 w-5" /> : <Download className="h-5 w-5 animate-pulse" />}
        </div>
        <div className="flex-1 text-sm">
          <div className="font-semibold text-amber-900 dark:text-amber-100">
            {isReady ? 'Update ready' : 'Downloading update…'}
            {state.version && (
              <span className="ml-2 font-mono text-xs font-normal text-amber-700 dark:text-amber-300">
                v{state.version}
              </span>
            )}
          </div>
          <div className="text-xs text-amber-800 dark:text-amber-200">
            {isReady
              ? 'Restart now to install, or it will apply when you next close the app.'
              : 'You can keep working — the new version installs in the background.'}
          </div>
        </div>
        {isReady && (
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              const w = window as unknown as {
                updaterEvents?: { installNow: () => void };
              };
              w.updaterEvents?.installNow();
            }}
          >
            Restart now
          </Button>
        )}
        <button
          type="button"
          onClick={() => setDismissed(true)}
          className="rounded p-1 text-amber-700 hover:bg-amber-200/50 dark:text-amber-300"
          aria-label="Dismiss"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
