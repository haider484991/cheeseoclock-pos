import { cn } from './cn.js';

export interface NumberPadProps {
  value: string;
  onChange: (next: string) => void;
  onSubmit?: () => void;
  maxLength?: number;
  /** Render digits as • for PIN entry. */
  mask?: boolean;
  className?: string;
  /**
   * Show the box above the keys with what was typed (default true). The
   * Close shift note count turns it off: its rows show the figures.
   */
  showDisplay?: boolean;
  /** The words on the bottom-right key (default 'Enter'). */
  enterLabel?: string;
  /** The keys' height class (default 'h-16'). */
  keyClassName?: string;
  /**
   * tabIndex on all 12 keys. Left out, the keys carry no tabindex at all
   * (LoginPage and TenderDialog); -1 keeps Tab on the rows they type into.
   */
  keyTabIndex?: number;
  /** A name for the keys, read out by a screen reader; left out, they carry none. */
  label?: string;
}

const KEYS: Array<string | { label: string; action: 'back' | 'enter' }> = [
  '1', '2', '3',
  '4', '5', '6',
  '7', '8', '9',
  { label: '←', action: 'back' },
  '0',
  { label: 'Enter', action: 'enter' },
];

/**
 * The on-screen number keys. Every prop after className is additive: with
 * them left out, the markup is byte for byte what it was before they existed
 * (apps/pos src/components/numberPadDefaults.test.tsx holds that markup).
 */
export function NumberPad({
  value,
  onChange,
  onSubmit,
  maxLength = 8,
  mask = false,
  className,
  showDisplay = true,
  enterLabel = 'Enter',
  keyClassName = 'h-16',
  keyTabIndex,
  label,
}: NumberPadProps) {
  const display = mask ? '•'.repeat(value.length) : value;

  function pressDigit(d: string) {
    if (value.length >= maxLength) return;
    onChange(value + d);
  }
  function pressBack() {
    onChange(value.slice(0, -1));
  }

  return (
    <div className={cn('flex flex-col gap-4', className)}>
      {showDisplay && (
        <div
          className="flex h-16 items-center justify-center rounded-lg border-2 border-stone-300 bg-white px-4 text-3xl font-mono tracking-widest text-stone-900 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-100"
          aria-label="PIN entry"
        >
          {display || <span className="text-stone-400">_</span>}
        </div>
      )}
      <div
        className="grid grid-cols-3 gap-3"
        role={label === undefined ? undefined : 'group'}
        aria-label={label}
      >
        {KEYS.map((k, i) => {
          if (typeof k === 'string') {
            return (
              <button
                key={i}
                type="button"
                tabIndex={keyTabIndex}
                onClick={() => pressDigit(k)}
                className={`${keyClassName} rounded-lg bg-stone-100 text-2xl font-semibold text-stone-900 hover:bg-stone-200 active:bg-stone-300 dark:bg-stone-800 dark:text-stone-100 dark:hover:bg-stone-700`}
              >
                {k}
              </button>
            );
          }
          const isEnter = k.action === 'enter';
          return (
            <button
              key={i}
              type="button"
              tabIndex={keyTabIndex}
              onClick={() => (isEnter ? onSubmit?.() : pressBack())}
              className={cn(
                `${keyClassName} rounded-lg text-xl font-semibold`,
                isEnter
                  ? 'bg-amber-500 text-stone-900 hover:bg-amber-400'
                  : 'bg-stone-300 text-stone-900 hover:bg-stone-400 dark:bg-stone-700 dark:text-stone-100',
              )}
            >
              {isEnter ? enterLabel : k.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
