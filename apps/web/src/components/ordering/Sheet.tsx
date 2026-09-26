'use client';

import { useEffect, useId, useRef } from 'react';

const FOCUSABLE =
  'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';

/** The history entry a sheet adds, so the phone's back button closes it. */
interface SheetHistoryState {
  cocSheet?: string;
}

function sheetState(): SheetHistoryState | null {
  try {
    return window.history.state as SheetHistoryState | null;
  } catch {
    return null;
  }
}

/** The token of the open sheet whose history entry is on top, if any. */
let entryOwner: string | null = null;

/**
 * True while an open sheet's own history entry is the current one — so a
 * navigation out of the sheet can replace that entry instead of stacking on
 * it. Kept here rather than read back from history.state, which Next may
 * rewrite (in dev, on every hot reload).
 */
export function sheetOnTopOfHistory(): boolean {
  return entryOwner !== null;
}

function markerOnTop(): boolean {
  return typeof sheetState()?.cocSheet === 'string';
}

/**
 * A closed sheet's "drop my history entry" waits a tick: if another sheet
 * opens in that tick (React StrictMode's remount in dev, or one sheet handing
 * over to the next) it takes the entry over instead. Calling back() straight
 * away raced the new sheet's push — the browser resolved the back against the
 * old entry and the popstate closed the sheet that had just opened.
 */
let pendingBack: ReturnType<typeof setTimeout> | null = null;

/**
 * A bottom sheet on phones, a centred dialog on wider screens.
 *
 * - Focus moves into the sheet when it opens, Tab stays inside it, and focus
 *   goes back to what opened it when it closes.
 * - Esc, a tap on the backdrop and the phone's back button all close it. The
 *   back button matters most: on Android it is how people dismiss things, and
 *   without its own history entry it took them off the menu page instead.
 * - The page behind does not scroll while it is open.
 */
export function Sheet({
  onClose,
  children,
  label,
}: {
  onClose: () => void;
  children: React.ReactNode;
  label: string;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });
  const token = useId();

  useEffect(() => {
    const panel = panelRef.current;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panel?.focus({ preventScroll: true });

    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab' || !panel) return;
      const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.getClientRects().length > 0,
      );
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === panel)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);

    let pushed = false;
    try {
      if (pendingBack !== null && markerOnTop()) {
        clearTimeout(pendingBack);
        pendingBack = null;
        window.history.replaceState({ cocSheet: token } satisfies SheetHistoryState, '');
      } else {
        window.history.pushState({ cocSheet: token } satisfies SheetHistoryState, '');
      }
      pushed = true;
      entryOwner = token;
    } catch {
      // No history API (very old WebView): back just leaves the page, as before.
    }
    const onPop = () => {
      if (sheetState()?.cocSheet !== token) {
        pushed = false;
        if (entryOwner === token) entryOwner = null;
        onCloseRef.current();
      }
    };
    window.addEventListener('popstate', onPop);

    return () => {
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('popstate', onPop);
      document.body.style.overflow = prevOverflow;
      if (entryOwner === token) entryOwner = null;
      // Closed from inside (✕, Add, backdrop): drop the entry we added, so the
      // next back press leaves the page instead of doing nothing. Closed by a
      // navigation (checkout → tracking page): the entry is already gone.
      if (pushed && sheetState()?.cocSheet === token) {
        if (pendingBack !== null) clearTimeout(pendingBack);
        pendingBack = setTimeout(() => {
          pendingBack = null;
          if (sheetState()?.cocSheet === token) window.history.back();
        }, 0);
      }
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [token]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-ink/70 backdrop-blur-sm sm:items-center sm:p-4"
      onClick={() => onCloseRef.current()}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        className="sheet-max-h flex w-full animate-sheet-up flex-col overflow-hidden rounded-t-3xl bg-paper text-ink shadow-soft-lg outline-none focus-visible:ring-0 sm:max-w-lg sm:rounded-3xl"
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

export function CloseButton({ onClose, label = 'Close' }: { onClose: () => void; label?: string }) {
  return (
    <button
      type="button"
      onClick={onClose}
      className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-white text-lg text-ink shadow-soft-sm hover:bg-paper-deep"
      aria-label={label}
    >
      <span aria-hidden>✕</span>
    </button>
  );
}
