import { forwardRef, useCallback, useRef, useState, type InputHTMLAttributes, type Ref } from 'react';
import { cn } from '@cheeseoclock/ui';
import { SECRET_MAX_INPUT } from '@cheeseoclock/shared-schemas/sign-in-secret';

export interface SecretInputProps
  extends Omit<
    InputHTMLAttributes<HTMLInputElement>,
    'type' | 'value' | 'onChange' | 'inputMode' | 'maxLength' | 'spellCheck' | 'autoCorrect' | 'autoCapitalize'
  > {
  value: string;
  onChange: (next: string) => void;
  /**
   * 'switchable' (default): a touch screen opens its number keyboard (most
   * managers have a PIN), with an ABC / 123 button beside the box for a
   * password. A physical keyboard types either way.
   * 'text': the letters keyboard and no button (the sign-in password box).
   */
  keyboard?: 'switchable' | 'text';
  /** Classes for the box-plus-button row; `className` styles the box itself. */
  wrapperClassName?: string;
}

/**
 * The box a PIN or a password is typed into: sign-in and every manager
 * approval (discount, cancel, refund, cash in/out). Always masked, and never
 * spell-checked, auto-corrected or remembered — Electron spell-checks text
 * boxes by default and the Windows touch keyboard learns words typed into
 * them. No digit filtering: the till decides by what was typed (digits only
 * = a PIN), and says which rule was broken.
 */
export const SecretInput = forwardRef<HTMLInputElement, SecretInputProps>(function SecretInput(
  {
    value,
    onChange,
    keyboard = 'switchable',
    wrapperClassName,
    className,
    placeholder = 'PIN or password',
    autoComplete = 'off',
    ...rest
  },
  ref,
) {
  const [letters, setLetters] = useState(keyboard === 'text');
  const inner = useRef<HTMLInputElement | null>(null);
  const setRefs = useCallback(
    (el: HTMLInputElement | null) => {
      inner.current = el;
      assignRef(ref, el);
    },
    [ref],
  );

  const box = (
    <input
      {...rest}
      ref={setRefs}
      type="password"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      inputMode={letters ? 'text' : 'numeric'}
      maxLength={SECRET_MAX_INPUT}
      autoComplete={autoComplete}
      autoCorrect="off"
      autoCapitalize="off"
      spellCheck={false}
      placeholder={placeholder}
      className={className}
    />
  );
  if (keyboard === 'text') return box;

  function switchKeyboard() {
    setLetters((l) => !l);
    // The touch keyboard reads the box's keyboard type when it gets focus.
    const el = inner.current;
    el?.blur();
    requestAnimationFrame(() => el?.focus());
  }

  return (
    <div className={cn('flex items-stretch gap-2', wrapperClassName)}>
      {box}
      <button
        type="button"
        // Keep the tap from taking focus away from the box first.
        onMouseDown={(e) => e.preventDefault()}
        onClick={switchKeyboard}
        aria-label={letters ? 'Number keyboard' : 'Letters keyboard, for a password'}
        title={letters ? 'Number keyboard' : 'Password? Tap for letters'}
        className="shrink-0 rounded-lg border border-stone-300 bg-white px-3 text-xs font-bold tracking-wide text-stone-700 hover:bg-stone-50 dark:border-stone-600 dark:bg-stone-800 dark:text-stone-200 dark:hover:bg-stone-700"
      >
        {letters ? '123' : 'ABC'}
      </button>
    </div>
  );
});

function assignRef<T>(ref: Ref<T> | undefined, value: T | null): void {
  if (typeof ref === 'function') ref(value);
  else if (ref) (ref as { current: T | null }).current = value;
}
