import type { PointerEvent as ReactPointerEvent, MouseEvent as ReactMouseEvent, ReactNode } from 'react';
import { BellRing, CloudOff, Hourglass, PhoneCall, Printer, X, type LucideIcon } from 'lucide-react';
import { cn } from '@cheeseoclock/ui';
import { describeFailure, describeNewOrders, describePill, isLoud, type AlertState } from './alertState';
import type { WatchNote } from './watchNotes';

/**
 * The one-row alert at the top of every screen: a new website order (green),
 * a website order that did not come in (red), a note from the watch (amber:
 * a kitchen ticket that did not print, a website order the website has not
 * confirmed, an order waiting too long — watchNotes.ts), or — once its alarm
 * is silenced — the reminder to call that customer (light red), which stays
 * until someone logged in closes it. One row at a time, in that order; "+N
 * more" counts the rest.
 *
 * Sized like a toast so it never spreads over the top bar's buttons. It
 * always sits below the one toast slot at the top of the screen, never over
 * it: logged in, just under the top bar (the printer and low-stock notes stay
 * readable); on the PIN screen, just under the slot, so "PIN is wrong", the
 * lock-out note and "website order is having trouble" are never hidden.
 * While a popup is open (payment, discount…) it shrinks to a small pill in
 * the top-left corner with only "Seen", so a tap cannot leave a payment; a
 * note alone shows nothing then. Every Seen (row or pill) and Esc do the
 * same thing: seenOnScreen. A note has no Seen: it goes when what it is about
 * is dealt with.
 *
 * Signed in, a note sits low on the left instead (NOTE_ROW_SIGNED_IN): under
 * the top bar it covered Checkout's Takeaway / Delivery / Foodpanda for as
 * long as it lasted (up to 2 hours). There it is over the bottom of the menu,
 * clear of the order ticket and its Pay button, and has "Hide" (onHideNote):
 * the note goes until something new joins it (watchNotes.ts shownNotes).
 * On the PIN screen notes stay where they were, with no Hide.
 *
 * A "did not come in" or "website cancelled" card's words take up to two
 * lines, so the phone number at their end is never cut off; so do a note's
 * on the PIN screen, so what to do (the time the website cancels, "sign in
 * and open Live Orders") is never cut with "…" either. A new order's row
 * keeps one line.
 *
 * Taps on it must not count as "outside" an open popup (which would close
 * the popup): the pointer-down is stopped here, before Radix sees it on the
 * document, and the buttons never take the keyboard focus from a text box.
 */
export interface AlertBannerProps {
  state: AlertState;
  /** The watch's notes (watchNotes.ts), most urgent first. */
  notes: readonly WatchNote[];
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
  /** Signed in (not a held step-in): a note gets "Hide", which puts that note away until it changes. */
  onHideNote?: ((note: WatchNote) => void) | undefined;
}

/**
 * The toast slot: one note at top 0.375rem, at most 4.25rem tall
 * (components/toast/ToastProvider.tsx). Logged in, the top bar is under it
 * and the banner goes under the top bar; logged out, just under the slot.
 */
const BANNER_TOP_LOGGED_IN = '4.5rem';
const BANNER_TOP_LOGGED_OUT = '4.875rem';

/**
 * A signed-in note: bottom left, never under the top bar. Measured with
 * Segoe UI on Checkout, where the ticket column is 360 px wide under a
 * 1172 px window and 400 px from there to 1511 px:
 *   - left, past the sidebar: its 72 px icon rail below 1280 px (and on
 *     Checkout), its 240 px full width from 1280 px;
 *   - bottom 2.5rem, above the "sound off" pill (bottom 0.5rem, 24 px tall);
 *   - at most 38rem wide and never past 100vw - 28.25rem: at the 1024 px
 *     minimum it is 572 px wide (84–656 px) and the menu column ends at
 *     664 px; at 1366 px it is 608 px (248–856 px) against 966 px. So it
 *     never reaches the ticket, its Pay button, or the order-type buttons.
 * Title and words may take two lines each; it grows upwards.
 */
export const NOTE_ROW_SIGNED_IN =
  'bottom-10 left-[5.25rem] xl:left-[15.5rem] max-h-[7rem] w-[min(38rem,calc(100vw-28.25rem))]';
/**
 * Every other row: centred under the top bar (or the PIN screen's toast
 * slot). A new order's words take one line; a failure card's and a note's
 * up to two (ROW_TWO_LINES).
 */
const ROW_TOP = 'left-1/2 -translate-x-1/2 w-[38rem] max-w-[calc(100vw-2rem)]';

/**
 * A row under the top whose words take two lines. The words' box is 544 px
 * (38rem less the border, padding, icon and gap; no buttons on the PIN
 * screen): in Inter 14 px, "The till keeps trying. Check the internet — at
 * 12:39 am the website cancels it and tells the customer." is 659 px and
 * "Not started: #0002, #0003, #0004 · over 30 min: #0001 — sign in and open
 * Live Orders." 585 px (Segoe UI: 614 and 537). Two lines make the row at
 * most 83.25 px (border 4, padding 16, title 24.75, words 2 × 19.25; 82.45
 * measured in Chromium), inside the 5.5rem (88 px) cap. On the PIN screen it
 * starts at 4.875rem (78 px), so it ends by 166 px (160.45 measured; one
 * line ended at 141.2). The PIN box, the keypad's top, is never above
 * 196 px (LoginPage.tsx: 8 page + 24 card + the 80 px logo, gap and name +
 * 24 "Enter your PIN", on a short window with the card at the top; 243 px
 * at 1024 × 700 with the paused notice), so the keypad stays clear, as it
 * did with one line. The extra 19 px only reach further over the logo and,
 * on a short window, the store name.
 */
const ROW_TWO_LINES = 'max-h-[5.5rem]';
const ROW_ONE_LINE = 'max-h-[4.5rem]';

/**
 * The pill's widest (it is only as wide as its words). Around the words:
 * 12 px padding, the 16 px bell, two 8 px gaps, "Seen" (24 px padding and
 * 34.6 px of Inter bold 14 px) and 4 px: 106.6 px. At 11rem that left
 * 69.4 px, and "New order" (70.8 px) showed as "New or…". 15rem leaves
 * 133.4 px: "New order #0042" is 120.6 px (Segoe UI 113.9), "Cancelled
 * #0045" 118, "12 new orders" 94.9, "Order not in" 80.6. Still a corner
 * pill: at its widest it ends at 246 px, and at the 1024 px minimum the
 * 460 px "Close the till?" box starts at 282 px.
 */
export const PILL_MAX_WIDTH = 'max-w-[15rem]';

const keepPopupOpen = (e: ReactPointerEvent) => e.stopPropagation();
const keepFocus = (e: ReactMouseEvent) => e.preventDefault();

const NOTE_ICONS: Record<WatchNote['kind'], LucideIcon> = {
  ticket: Printer,
  unconfirmed: CloudOff,
  waiting: Hourglass,
};

function BannerButton(props: {
  onClick: () => void;
  children: ReactNode;
  tone: 'solid' | 'ghost';
  label?: string;
  /** Less padding, for a second button next to View. */
  narrow?: boolean;
}) {
  return (
    <button
      type="button"
      onMouseDown={keepFocus}
      onClick={props.onClick}
      aria-label={props.label}
      title={props.label}
      className={cn(
        'h-11 shrink-0 rounded-xl text-base font-bold transition-colors',
        props.narrow ? 'px-3' : 'px-4',
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
  const total = state.orders.length + state.failures.length + p.notes.length;
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
          'fixed left-1.5 top-1.5 z-[110] flex items-center gap-2 rounded-full py-1 pl-3 pr-1 text-sm font-bold text-white shadow-soft-lg',
          PILL_MAX_WIDTH,
          alarm ? 'bg-red-600' : 'bg-emerald-600',
        )}
      >
        <BellRing className="h-4 w-4 shrink-0 motion-safe:animate-pulse" aria-hidden="true" />
        <span className="truncate">{describePill(state)}</span>
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

  let tone: 'alarm' | 'orders' | 'reminder' | 'note';
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
    if (!p.loggedIn) text = { ...text, detail: text.detail ? `${text.detail} · sign in to open Live Orders` : 'Sign in to open Live Orders' };
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
  } else if (p.notes.length > 0) {
    const n = p.notes[0]!;
    const Icon = NOTE_ICONS[n.kind];
    const hide = p.onHideNote;
    tone = 'reminder';
    icon = <Icon className="h-6 w-6 shrink-0" aria-hidden="true" />;
    text = { title: n.title, detail: n.detail };
    buttons = (
      <>
        {p.canView && (
          <BannerButton tone="solid" onClick={p.onView}>
            View
          </BannerButton>
        )}
        {hide && (
          <BannerButton tone="ghost" narrow onClick={() => hide(n)} label="Hide this note until it changes">
            Hide
          </BannerButton>
        )}
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
  // Signed in, a note sits low on the left (NOTE_ROW_SIGNED_IN); every other row under the top.
  const low = tone === 'reminder' && p.loggedIn;
  // A failure card ends with the phone number to call, and a note with what to
  // do: their words may take two lines. Only a new order's row keeps one.
  const twoLines = tone !== 'orders';

  return (
    <div
      // A note is news, not an alarm: read out when the screen reader is free.
      role={tone === 'reminder' ? 'status' : 'alert'}
      aria-live={tone === 'reminder' ? 'polite' : 'assertive'}
      onPointerDown={keepPopupOpen}
      style={
        low
          ? { pointerEvents: 'auto' }
          : { pointerEvents: 'auto', top: p.loggedIn ? BANNER_TOP_LOGGED_IN : BANNER_TOP_LOGGED_OUT }
      }
      title={text.tooltip}
      className={cn(
        'fixed z-[110] flex items-center gap-3 overflow-hidden rounded-2xl border-2 py-2 pl-4 pr-2 shadow-soft-lg animate-fade-in',
        low ? NOTE_ROW_SIGNED_IN : ROW_TOP,
        !low && (twoLines ? ROW_TWO_LINES : ROW_ONE_LINE),
        tone === 'alarm' && 'border-red-700 bg-red-600 text-white',
        tone === 'orders' && 'border-emerald-700 bg-emerald-600 text-white',
        tone === 'reminder' &&
          'border-amber-500 bg-amber-100 text-amber-950 dark:border-amber-600 dark:bg-amber-950 dark:text-amber-50',
        tone === 'note' &&
          'border-red-300 bg-red-50 text-red-950 dark:border-red-700 dark:bg-red-950 dark:text-red-50',
      )}
    >
      {icon}
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <div className={cn('min-w-0 text-lg font-bold leading-snug', low ? 'line-clamp-2' : 'truncate')}>
            {text.title}
          </div>
          {more > 0 && (
            <span className="shrink-0 rounded-full bg-black/20 px-2 text-xs font-bold">+{more} more</span>
          )}
        </div>
        {text.detail && (
          <div className={cn('text-sm leading-snug opacity-95', low || twoLines ? 'line-clamp-2' : 'truncate')}>
            {text.detail}
          </div>
        )}
      </div>
      {buttons}
    </div>
  );
}
