import { useEffect, useRef } from 'react';
import { cn } from '@cheeseoclock/ui';
import { Search, X } from 'lucide-react';

export interface SearchBoxProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** Accessible name; defaults to the placeholder. */
  label?: string;
  autoFocus?: boolean;
  className?: string;
  /**
   * Let "/" or Ctrl+F jump to this box from anywhere on the screen (not while
   * typing in another field). One search box per screen should have it.
   */
  hotkey?: boolean;
}

/**
 * The search field every list uses: instant, clears with the X or Esc, and
 * reachable from the keyboard with "/" or Ctrl+F.
 */
export function SearchBox({
  value,
  onChange,
  placeholder = 'Search…',
  label,
  autoFocus,
  className,
  hotkey = true,
}: SearchBoxProps) {
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!hotkey) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing =
        !!t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName));
      const isFind = (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f';
      if (isFind || (e.key === '/' && !typing && !e.ctrlKey && !e.metaKey && !e.altKey)) {
        // A dialog on top owns the keyboard.
        if (document.querySelector('[role="dialog"]')) return;
        e.preventDefault();
        ref.current?.focus();
        ref.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hotkey]);

  return (
    <div className={cn('relative min-w-[12rem] flex-1', className)}>
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-stone-400" />
      <input
        ref={ref}
        type="search"
        value={value}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && value) {
            e.stopPropagation();
            onChange('');
          }
        }}
        placeholder={placeholder}
        aria-label={label ?? placeholder}
        spellCheck={false}
        autoComplete="off"
        className={cn(
          'h-10 w-full rounded-lg border border-stone-300 bg-white pl-9 pr-9 text-sm',
          'placeholder:text-stone-400 focus:border-amber-500 focus:outline-none focus:ring-2 focus:ring-amber-200',
          'dark:border-stone-700 dark:bg-stone-800 dark:focus:ring-amber-900',
          // the browser's own clear button duplicates ours
          '[&::-webkit-search-cancel-button]:appearance-none',
        )}
      />
      {value && (
        <button
          type="button"
          onClick={() => {
            onChange('');
            ref.current?.focus();
          }}
          className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-md p-1.5 text-stone-500 hover:bg-stone-100 hover:text-stone-800 dark:hover:bg-stone-700 dark:hover:text-stone-100"
          aria-label="Clear search"
        >
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}
