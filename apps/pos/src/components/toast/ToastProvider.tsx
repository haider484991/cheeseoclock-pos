import * as RadixToast from '@radix-ui/react-toast';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { cn } from '@cheeseoclock/ui';
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { useSessionStore } from '../../stores/sessionStore';
import {
  addToast,
  removeToast,
  signedInPersonChanged,
  toastDuration,
  toastsAfterSignOut,
  visibleToasts,
  type ToastAction,
  type ToastItem,
  type ToastVariant,
} from './toastQueue';

interface ToastContextValue {
  toast: (input: {
    /**
     * The note's own id: a later note with the same id replaces it, and
     * dismiss(id) closes it (a shift report that printed in the end takes
     * its "did not print" away). Not given: a fresh one.
     */
    id?: string;
    title: string;
    description?: string;
    variant?: ToastVariant;
    /**
     * ms before it closes by itself. Errors ignore this and stay until closed;
     * a success is capped at a few seconds (see toastQueue.ts).
     */
    duration?: number;
    /** One button on the note; pressing it closes the note. */
    action?: ToastAction;
    /** Stays up when the person signed in changes: a note about the shop (a website order), not the login. */
    keepOnLogout?: boolean;
  }) => void;
  /** Close the note with this id, if it is still up. */
  dismiss: (id: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}

const ICON: Record<ToastVariant, typeof Info> = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  error: XCircle,
};

const TONE: Record<ToastVariant, string> = {
  info: 'border-stone-300 bg-white text-stone-900 dark:border-stone-600 dark:bg-stone-900 dark:text-stone-100',
  success:
    'border-emerald-300 bg-emerald-50 text-emerald-950 dark:border-emerald-700 dark:bg-emerald-950 dark:text-emerald-50',
  warning: 'border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-50',
  error: 'border-red-300 bg-red-50 text-red-950 dark:border-red-700 dark:bg-red-950 dark:text-red-50',
};

const ICON_TONE: Record<ToastVariant, string> = {
  info: 'text-stone-500',
  success: 'text-emerald-600 dark:text-emerald-400',
  warning: 'text-amber-600 dark:text-amber-400',
  error: 'text-red-600 dark:text-red-400',
};

/**
 * Calls `clear` each time the person signed in changes (a log-out, the idle
 * lock, a hand-back, someone else signing in); returns the stop.
 */
export function onSignedInPersonChange(clear: () => void): () => void {
  return useSessionStore.subscribe((state, before) => {
    if (signedInPersonChanged(before.user, state.user)) clear();
  });
}

/**
 * Pop-up notes. They sit at the top centre, over the empty middle of the top
 * bar — never over the order ticket's Send / Pay / Confirm buttons or the menu
 * grid — and only the cards themselves take clicks, so the space around them
 * stays usable. Every note has a close (X) button and can be swiped up; a
 * success goes by itself in two seconds, an error stays until closed — or
 * until the person signed in changes: the notes are that login's, and the
 * next one is not shown them (only a note kept on purpose stays).
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const toast = useCallback<ToastContextValue['toast']>(
    ({ id, title, description, variant = 'info', duration, action, keepOnLogout }) => {
      setItems((prev) =>
        addToast(prev, {
          id: id ?? crypto.randomUUID(),
          instance: crypto.randomUUID(),
          title,
          description,
          variant,
          duration: toastDuration(variant, duration),
          ...(action ? { action } : {}),
          ...(keepOnLogout ? { keepOnLogout: true } : {}),
        }),
      );
    },
    [],
  );

  const dismiss = useCallback((id: string) => {
    setItems((prev) => removeToast(prev, id));
  }, []);

  // Someone else at the till (or nobody): the last login's notes go with it.
  useEffect(() => onSignedInPersonChange(() => setItems(toastsAfterSignOut)), []);

  const value = useMemo(() => ({ toast, dismiss }), [toast, dismiss]);
  // ONE note on screen, inside the top bar: a stack reached down over the
  // order-type buttons (owner: notes that "can't be X'd out" slowed confirming).
  // The rest wait behind it, newest first, and the card says how many.
  const { shown, waiting } = visibleToasts(items, 1);

  return (
    <ToastContext.Provider value={value}>
      <RadixToast.Provider swipeDirection="up" label="Notification">
        {children}
        {shown.map((t, i) => {
          const Icon = ICON[t.variant];
          // The note at the bottom of the stack says how many more are queued.
          const moreBehind = i === 0 && waiting > 0 ? waiting : 0;
          return (
            <RadixToast.Root
              key={t.instance ?? t.id}
              duration={t.duration}
              type={t.variant === 'error' || t.variant === 'warning' ? 'foreground' : 'background'}
              onOpenChange={(open) => !open && dismiss(t.id)}
              className={cn(
                'pointer-events-auto flex max-h-[4.25rem] w-full items-start gap-2.5 overflow-hidden rounded-xl border py-1.5 pl-3 pr-1.5 shadow-soft-lg animate-fade-in',
                'data-[swipe=move]:translate-y-[var(--radix-toast-swipe-move-y)] data-[swipe=cancel]:translate-y-0 data-[swipe=cancel]:transition-transform',
                TONE[t.variant],
              )}
            >
              <Icon className={cn('mt-0.5 h-5 w-5 shrink-0', ICON_TONE[t.variant])} aria-hidden="true" />
              <div className="min-w-0 flex-1 py-0.5">
                <div className="flex items-baseline gap-2">
                  <RadixToast.Title className="truncate text-sm font-semibold leading-snug">{t.title}</RadixToast.Title>
                  {moreBehind > 0 && (
                    <span className="shrink-0 rounded-full bg-black/10 px-1.5 text-[11px] font-bold dark:bg-white/15" title={`${moreBehind} more — close this to see ${moreBehind === 1 ? 'it' : 'them'}`}>
                      +{moreBehind} more
                    </span>
                  )}
                </div>
                {t.description && (
                  <RadixToast.Description className="mt-0.5 line-clamp-2 text-[13px] leading-snug opacity-90" title={t.description}>
                    {t.description}
                  </RadixToast.Description>
                )}
              </div>
              {t.action && (
                <RadixToast.Action
                  altText={t.action.label}
                  onClick={() => {
                    t.action?.onClick();
                    dismiss(t.id);
                  }}
                  className="-my-0.5 h-10 shrink-0 whitespace-nowrap rounded-lg border border-black/15 px-3 text-sm font-semibold transition hover:bg-black/5 dark:border-white/25 dark:hover:bg-white/10"
                >
                  {t.action.label}
                </RadixToast.Action>
              )}
              <RadixToast.Close
                aria-label="Close"
                title="Close"
                className="-my-0.5 grid h-10 w-10 shrink-0 place-items-center rounded-lg opacity-70 transition hover:bg-black/5 hover:opacity-100 dark:hover:bg-white/10"
              >
                <X className="h-5 w-5" />
              </RadixToast.Close>
            </RadixToast.Root>
          );
        })}
        {/* Newest on top. pointer-events-none: the gaps between cards and the
            viewport's own box never swallow a tap meant for the screen below. */}
        <RadixToast.Viewport className="pointer-events-none fixed left-1/2 top-1.5 z-[100] flex w-[36rem] max-w-[calc(100vw-2rem)] -translate-x-1/2 flex-col-reverse gap-2 outline-none" />
      </RadixToast.Provider>
    </ToastContext.Provider>
  );
}
