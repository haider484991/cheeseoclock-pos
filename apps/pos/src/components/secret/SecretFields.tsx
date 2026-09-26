import { useState } from 'react';
import { cn } from '@cheeseoclock/ui';
import type { SecretKind } from '@cheeseoclock/shared-types';
import {
  PASSWORD_MIN_CHARS,
  PIN_MAX_DIGITS,
  PIN_MIN_DIGITS,
  SECRET_MAX_INPUT,
  secretProblemFor,
} from '@cheeseoclock/shared-schemas/sign-in-secret';
import { Eye, EyeOff, Grid3x3, Keyboard } from 'lucide-react';
import { SecretHint } from './SecretHint';
import { pinBoxValue, secretsDiffer } from './secretRules';

const KINDS: Array<{ id: SecretKind; label: string; hint: string; icon: typeof Keyboard }> = [
  {
    id: 'pin',
    label: 'Number PIN',
    hint: `${PIN_MIN_DIGITS} to ${PIN_MAX_DIGITS} numbers, quick on the keypad`,
    icon: Grid3x3,
  },
  {
    id: 'password',
    label: 'Password',
    hint: `${PASSWORD_MIN_CHARS} or more characters with at least one letter`,
    icon: Keyboard,
  },
];

/**
 * Choose a number PIN or a password, type it, type it again. Used on the
 * Users page (someone's sign-in) and in first-time setup (the owner's own).
 * The boxes are masked unless "Show" is tapped, and never spell-checked or
 * remembered. What is typed is checked against the till's own rules as it
 * is typed; a clash with someone else's is only known when saving.
 */
export function SecretFields({
  kind,
  onKind,
  secret,
  onSecret,
  confirm,
  onConfirm,
  idPrefix,
  who,
  autoFocus = false,
}: {
  kind: SecretKind;
  onKind: (k: SecretKind) => void;
  secret: string;
  onSecret: (v: string) => void;
  confirm: string;
  onConfirm: (v: string) => void;
  /** Keeps the box ids unique on the page. */
  idPrefix: string;
  /** "How will they sign in?" (Users) or "How will you sign in?" (setup). */
  who: 'they' | 'you';
  autoFocus?: boolean;
}) {
  const [show, setShow] = useState(false);
  const isPin = kind === 'pin';
  const problem = secret.trim() !== '' ? secretProblemFor(kind, secret) : null;
  const differ = secretsDiffer(secret, confirm);
  const typed = (v: string) => (isPin ? pinBoxValue(v) : v);
  const boxClass =
    'w-full rounded-lg border border-stone-300 px-3 py-2 text-base dark:border-stone-700 dark:bg-stone-800' +
    (isPin ? ' font-mono tracking-widest' : '');

  function choose(next: SecretKind) {
    if (next === kind) return;
    onKind(next);
    // A half-typed PIN is not the start of a password (or the reverse).
    onSecret('');
    onConfirm('');
  }

  return (
    <div className="space-y-3">
      <div>
        <div id={`${idPrefix}-kind-label`} className="mb-2 text-xs uppercase tracking-wider text-stone-500">
          {who === 'you' ? 'How will you sign in?' : 'How will they sign in?'}
        </div>
        <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-labelledby={`${idPrefix}-kind-label`}>
          {KINDS.map((k) => {
            const Icon = k.icon;
            const on = kind === k.id;
            return (
              <button
                key={k.id}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => choose(k.id)}
                className={cn(
                  'flex items-start gap-2 rounded-lg border-2 p-3 text-left transition-colors',
                  on
                    ? 'border-amber-500 bg-amber-50 dark:bg-amber-950'
                    : 'border-stone-200 hover:border-stone-300 dark:border-stone-700',
                )}
              >
                <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                <span>
                  <span className="block text-sm font-semibold">{k.label}</span>
                  <span className="block text-xs text-stone-500">{k.hint}</span>
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <div className="mb-1 flex items-center justify-between gap-2">
          <label htmlFor={`${idPrefix}-secret`} className="text-xs uppercase tracking-wider text-stone-500">
            {isPin ? 'PIN (not used by anyone else)' : 'Password (not used by anyone else)'}
          </label>
          <button
            type="button"
            onClick={() => setShow((s) => !s)}
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium text-stone-600 hover:bg-stone-100 dark:text-stone-300 dark:hover:bg-stone-800"
            aria-pressed={show}
          >
            {show ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
            {show ? 'Hide' : 'Show'}
          </button>
        </div>
        <input
          id={`${idPrefix}-secret`}
          type={show ? 'text' : 'password'}
          value={secret}
          autoFocus={autoFocus}
          onChange={(e) => onSecret(typed(e.target.value))}
          inputMode={isPin ? 'numeric' : 'text'}
          maxLength={isPin ? PIN_MAX_DIGITS : SECRET_MAX_INPUT}
          autoComplete="new-password"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          className={boxClass}
        />
        {problem && <div className="mt-1 text-xs text-red-600 dark:text-red-400">{problem}</div>}
        {!isPin && !problem && (
          <div className="mt-1 text-xs text-stone-500">Capital and small letters count.</div>
        )}
      </div>

      <div>
        <label htmlFor={`${idPrefix}-confirm`} className="mb-1 block text-xs uppercase tracking-wider text-stone-500">
          {isPin ? 'Type the PIN again' : 'Type the password again'}
        </label>
        <input
          id={`${idPrefix}-confirm`}
          type={show ? 'text' : 'password'}
          value={confirm}
          onChange={(e) => onConfirm(typed(e.target.value))}
          inputMode={isPin ? 'numeric' : 'text'}
          maxLength={isPin ? PIN_MAX_DIGITS : SECRET_MAX_INPUT}
          autoComplete="new-password"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          className={boxClass}
        />
        {differ && (
          <div className="mt-1 text-xs text-red-600 dark:text-red-400">
            {isPin ? "The two PINs don't match" : "The two passwords don't match"}
          </div>
        )}
        <SecretHint value={secret + confirm} rules={false} className="mt-1" />
      </div>
    </div>
  );
}
