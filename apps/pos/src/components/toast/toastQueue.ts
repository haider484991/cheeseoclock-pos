/**
 * The rules for the till's pop-up notes, kept pure so they can be tested.
 *
 * At a busy counter a note must say its piece and get out of the way: a
 * "done" note goes in two seconds, a problem stays until someone closes it,
 * and never more than three are on screen at once (owner, 2026-09-26: the
 * old notes piled up over the Pay button and could not be closed).
 */

export type ToastVariant = 'info' | 'success' | 'warning' | 'error';

export interface ToastItem {
  id: string;
  title: string;
  description?: string;
  variant: ToastVariant;
  /** ms before auto-dismiss; `Infinity` keeps it until closed. */
  duration: number;
}

/** Most notes on screen at once. */
export const MAX_VISIBLE_TOASTS = 3;

const DEFAULT_MS: Record<ToastVariant, number> = {
  success: 2_000,
  info: 5_000,
  warning: 6_000,
  error: Infinity,
};

/** A success note never lingers longer than this, whatever the caller asked. */
const SUCCESS_MAX_MS = 3_000;

/**
 * How long a note stays up. Errors stay until closed — someone has to act on
 * them. Successes are quick. Info and warnings keep a caller's own duration
 * (a low-stock warning or a website order asks for longer on purpose).
 */
export function toastDuration(variant: ToastVariant, requested?: number): number {
  if (variant === 'error') return Infinity;
  if (variant === 'success') return Math.min(requested ?? DEFAULT_MS.success, SUCCESS_MAX_MS);
  if (requested === undefined || !(requested > 0)) return DEFAULT_MS[variant];
  return requested;
}

function sameMessage(a: ToastItem, b: ToastItem): boolean {
  return a.variant === b.variant && a.title === b.title && (a.description ?? '') === (b.description ?? '');
}

/**
 * Add a note to the list. The same message again replaces the old copy (its
 * timer starts over) instead of stacking. Over the limit, the oldest note
 * that closes by itself goes first; notes that stay until closed are kept
 * (the screen shows the newest few and says how many more are waiting).
 */
export function addToast(list: ReadonlyArray<ToastItem>, item: ToastItem, max = MAX_VISIBLE_TOASTS): ToastItem[] {
  const next = list.filter((t) => !sameMessage(t, item));
  next.push(item);
  while (next.length > max) {
    const i = next.findIndex((t) => t.duration !== Infinity);
    if (i === -1) break;
    next.splice(i, 1);
  }
  return next;
}

/** What is on screen (newest last) and how many more are waiting behind it. */
export function visibleToasts(list: ReadonlyArray<ToastItem>, max = MAX_VISIBLE_TOASTS): { shown: ToastItem[]; waiting: number } {
  const shown = list.slice(Math.max(0, list.length - max));
  return { shown, waiting: list.length - shown.length };
}
