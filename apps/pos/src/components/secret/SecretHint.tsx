import { cn } from '@cheeseoclock/ui';
import { hasNonEnglishChars, secretProblem } from '@cheeseoclock/shared-schemas/sign-in-secret';
import { useCapsLock } from './useCapsLock';

/**
 * One small line under a PIN or password box, only when there is something
 * to say: the keyboard is on Urdu, Caps Lock is on while letters are typed,
 * or (with `rules`) which rule what was typed breaks — so a greyed-out
 * button is never a mystery ("A password needs at least one letter").
 */
export function SecretHint({
  value,
  rules = true,
  className,
}: {
  value: string;
  /** Also say which PIN / password rule is broken. */
  rules?: boolean;
  className?: string;
}) {
  const caps = useCapsLock();
  const notes: string[] = [];
  if (hasNonEnglishChars(value)) {
    notes.push('Switch the keyboard to English (Windows key + Space)');
  } else if (rules && value.trim() !== '') {
    const problem = secretProblem(value);
    if (problem) notes.push(problem);
  }
  if (caps && /[A-Za-z]/.test(value)) notes.push('Caps Lock is on');
  if (notes.length === 0) return null;
  return (
    <p
      role="status"
      aria-live="polite"
      className={cn('text-xs font-medium text-amber-700 dark:text-amber-300', className)}
    >
      {notes.join(' · ')}
    </p>
  );
}
