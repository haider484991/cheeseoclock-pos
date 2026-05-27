import { cn } from './cn.js';

export interface NumberPadProps {
  value: string;
  onChange: (next: string) => void;
  onSubmit?: () => void;
  maxLength?: number;
  /** Render digits as • for PIN entry. */
  mask?: boolean;
  className?: string;
}

const KEYS: Array<string | { label: string; action: 'back' | 'enter' }> = [
  '1', '2', '3',
  '4', '5', '6',
  '7', '8', '9',
  { label: '←', action: 'back' },
  '0',
  { label: 'Enter', action: 'enter' },
];

export function NumberPad({
  value,
  onChange,
  onSubmit,
  maxLength = 8,
  mask = false,
  className,
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
      <div
        className="flex h-16 items-center justify-center rounded-lg border-2 border-stone-300 bg-white px-4 text-3xl font-mono tracking-widest text-stone-900 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-100"
        aria-label="PIN entry"
      >
        {display || <span className="text-stone-400">_</span>}
      </div>
      <div className="grid grid-cols-3 gap-3">
        {KEYS.map((k, i) => {
          if (typeof k === 'string') {
            return (
              <button
                key={i}
                type="button"
                onClick={() => pressDigit(k)}
                className="h-16 rounded-lg bg-stone-100 text-2xl font-semibold text-stone-900 hover:bg-stone-200 active:bg-stone-300 dark:bg-stone-800 dark:text-stone-100 dark:hover:bg-stone-700"
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
              onClick={() => (isEnter ? onSubmit?.() : pressBack())}
              className={cn(
                'h-16 rounded-lg text-xl font-semibold',
                isEnter
                  ? 'bg-amber-500 text-stone-900 hover:bg-amber-400'
                  : 'bg-stone-300 text-stone-900 hover:bg-stone-400 dark:bg-stone-700 dark:text-stone-100',
              )}
            >
              {k.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
