/**
 * A gold medallion with the deal menu's drawn icon: a herb leaf (sauces), a wheat ear (dough), a slice (crust) — the
 * pizza promise's three lines (lib/page-copy PIZZA_PROMISE), on /menu and on the home page.
 */
export function PromiseIcon({ kind }: { kind: 'sauce' | 'dough' | 'crust' }) {
  return (
    <span aria-hidden className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-cheese shadow-[2px_2px_0_0_rgba(250,250,249,0.9)]">
      <svg viewBox="0 0 24 24" className="h-6 w-6 fill-none stroke-ink" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
        {kind === 'sauce' && (
          <>
            <path d="M5 19C5 10.5 10.5 5 19 5c0 8.5-5.5 14-14 14z" />
            <path d="M5 19L14.5 9.5" />
            <path d="M9.5 14.5h3.5M12 12V8.8" />
          </>
        )}
        {kind === 'dough' && (
          <>
            <path d="M12 22V7" />
            <ellipse cx="9.4" cy="9" rx="1.5" ry="3" transform="rotate(-28 9.4 9)" />
            <ellipse cx="14.6" cy="9" rx="1.5" ry="3" transform="rotate(28 14.6 9)" />
            <ellipse cx="9.4" cy="14" rx="1.5" ry="3" transform="rotate(-28 9.4 14)" />
            <ellipse cx="14.6" cy="14" rx="1.5" ry="3" transform="rotate(28 14.6 14)" />
            <ellipse cx="12" cy="4.2" rx="1.4" ry="2.6" />
          </>
        )}
        {kind === 'crust' && (
          <>
            <path d="M3.5 6.5c5.5-2.6 11.5-2.6 17 0L12 21.5z" />
            <path d="M4.6 9c4.9-2 9.9-2 14.8 0" />
            <circle cx="10" cy="12.5" r="1.3" />
            <circle cx="13.8" cy="11.8" r="1.1" />
            <circle cx="12" cy="16" r="1.1" />
          </>
        )}
      </svg>
    </span>
  );
}
