import type { PointerEvent as ReactPointerEvent, MouseEvent as ReactMouseEvent, ReactNode } from 'react';
import { BellRing, PhoneCall, X } from 'lucide-react';
import { cn } from '@cheeseoclock/ui';
import { describeFailure, describeNewOrders, isLoud, type AlertState } from './alertState';

/**
 * The one-row alert at the top of every screen: a new website order (green),
 * a website order that did not come in (red), or — once its alarm is
 * silenced — the reminder to call that customer (light red), which stays
 * until someone logged in closes it.
 *
 * Sized like a toast so it never spreads over the top bar's buttons. It
 * always sits below the one toast slot at the top of the screen, never over
 * it: logged in, just under the top bar (the printer and low-stock notes stay
 * readable); on the PIN screen, just under the slot, so "PIN is wrong", the
 * lock-out note and "website order is having trouble" are never hidden.
 * While a popup is open (payment, discount…) it shrinks to a small pill in
 * the top-left corner with only "Seen", so a tap cannot leave a payment.
 * Every Seen (row or pill) and Esc do the same thing: seenOnScreen.
 *
 * Taps on it must not count as "outside" an open popup (which would close
 * the popup): the pointer-down is stopped here, before Radix sees it on the
 * document, and the buttons never take the keyboard focus from a text box.
 */
export interface AlertBannerProps {
  state: AlertState;
  loggedIn: boolean;
  /** Logged in and allowed to open Live Orders. */
  canView: boolean;
  /** A popup is open: show the small pill. */
  compact: boolean;
  formatMoney: (cents: number) => string;
  onView: () => void;
  /** Seen on any row or the pill: acts on the row shown (the alarm, else the new orders). */
  onSeen: () => void;
  onCloseFailure: (webOrderId: string) => void;
}

/**
 * The toast slot: one note at top 0.375rem, at most 4.25rem tall
 * (components/toast/ToastProvider.tsx). Logged in, the top bar is under it
 * and the banner goes under the top bar; logged out, just under the slot.
 */
const BANNER_TOP_LOGGED_IN = '4.5rem';
const BANNER_TOP_LOGGED_OUT = '4.875rem';

const keepPopupOpen = (e: ReactPointerEvent) => e.stopPropagation();
const keepFocus = (e: ReactMouseEvent) => e.preventDefault();

function BannerButton(props: { onClick: () => void; children: ReactNode; tone: 'solid' | 'ghost'; label?: string }) {
  return (
    <button
      type="button"
      onMouseDown={keepFocus}
      onClick={props.onClick}
      aria-label={props.label}
      className={cn(
        'h-11 shrink-0 rounded-xl px-4 text-base font-bold transition-colors',
        props.tone === 'solid'
          ? 'bg-white text-stone-900 shadow-soft-sm hover:bg-stone-100'
          : 'bg-black/15 text-current hover:bg-black/25',
      )}
    >
      {props.children}
    </button>
  );
}

export function AlertBanner(p: AlertBannerProps) {
  const { state } = p;
  const loudFailures = state.failures.filter((f) => !f.silenced);
  const quietFailures = state.failures.filter((f) => f.silenced);
  const total = state.orders.length + state.failures.length;
  if (total === 0) return null;

  if (p.compact) {
    if (!isLoud(state)) return null;
    const alarm = loudFailures.length > 0;
    return (
      <div
        role="alert"
        onPointerDown={keepPopupOpen}
        style={{ pointerEvents: 'auto' }}
        className={cn(
          'fixed left-1.5 top-1.5 z-[110] flex max-w-[11rem] items-center gap-2 rounded-full py-1 pl-3 pr-1 text-sm font-bold text-white shadow-soft-lg',
          alarm ? 'bg-red-600' : 'bg-emerald-600',
        )}
      >
        <BellRing className="h-4 w-4 shrink-0 motion-safe:animate-pulse" aria-hidden="true" />
        <span className="truncate">
          {alarm ? 'Order not in' : state.orders.length === 1 ? 'New order' : `${state.orders.length} new`}
        </span>
        <button
          type="button"
          onMouseDown={keepFocus}
          onClick={p.onSeen}
          className="h-9 shrink-0 rounded-full bg-white px-3 text-sm font-bold text-stone-900"
        >
          Seen
        </button>
      </div>
    );
  }

  let tone: 'alarm' | 'orders' | 'note';
  let icon: ReactNode;
  let text: { title: string; detail: string; tooltip?: string };
  let buttons: ReactNode;
  let shown = 1;

  if (loudFailures.length > 0) {
    const f = loudFailures[0]!;
    tone = 'alarm';
    icon = <BellRing className="h-7 w-7 shrink-0 motion-safe:animate-pulse" aria-hidden="true" />;
    text = describeFailure(f, p.loggedIn);
    buttons = (
      <BannerButton tone="solid" onClick={p.onSeen}>
        Seen
      </BannerButton>
    );
  } else if (state.orders.length > 0) {
    tone = 'orders';
    shown = state.orders.length;
    icon = <BellRing className="h-7 w-7 shrink-0 motion-safe:animate-pulse" aria-hidden="true" />;
    text = describeNewOrders(state.orders, p.formatMoney);
    if (!p.loggedIn) text = { ...text, detail: text.detail ? `${text.detail} · log in to open Live Orders` : 'Log in to open Live Orders' };
    buttons = (
      <>
        {p.canView && (
          <BannerButton tone="solid" onClick={p.onView}>
            View
          </BannerButton>
        )}
        <BannerButton tone={p.canView ? 'ghost' : 'solid'} onClick={p.onSeen}>
          Seen
        </BannerButton>
      </>
    );
  } else {
    const f = quietFailures[0]!;
    tone = 'note';
    icon = <PhoneCall className="h-6 w-6 shrink-0" aria-hidden="true" />;
    text = describeFailure(f, p.loggedIn);
    buttons = p.loggedIn ? (
      <button
        type="button"
        onMouseDown={keepFocus}
        onClick={() => p.onCloseFailure(f.webOrderId)}
        aria-label="Close — the customer has been called"
        title="Close — the customer has been called"
        className="grid h-11 w-11 shrink-0 place-items-center rounded-xl opacity-80 transition hover:bg-black/5 hover:opacity-100 dark:hover:bg-white/10"
      >
        <X className="h-5 w-5" />
      </button>
    ) : null;
  }

  const more = total - shown;

  return (
    <div
      role="alert"
      aria-live="assertive"
      onPointerDown={keepPopupOpen}
      style={{ pointerEvents: 'auto', top: p.loggedIn ? BANNER_TOP_LOGGED_IN : BANNER_TOP_LOGGED_OUT }}
      title={text.tooltip}
      className={cn(
        'fixed left-1/2 z-[110] flex max-h-[4.5rem] w-[38rem] max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-3 overflow-hidden rounded-2xl border-2 py-2 pl-4 pr-2 shadow-soft-lg animate-fade-in',
        tone === 'alarm' && 'border-red-700 bg-red-600 text-white',
        tone === 'orders' && 'border-emerald-700 bg-emerald-600 text-white',
        tone === 'note' &&
          'border-red-300 bg-red-50 text-red-950 dark:border-red-700 dark:bg-red-950 dark:text-red-50',
      )}
    >
      {icon}
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <div className="truncate text-lg font-bold leading-snug">{text.title}</div>
          {more > 0 && (
            <span className="shrink-0 rounded-full bg-black/20 px-2 text-xs font-bold">+{more} more</span>
          )}
        </div>
        {text.detail && <div className="truncate text-sm leading-snug opacity-95">{text.detail}</div>}
      </div>
      {buttons}
    </div>
  );
}
