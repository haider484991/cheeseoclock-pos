import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Button, NumberPad } from '@cheeseoclock/ui';
import { PIN_MAX_DIGITS, normalizeSecret, secretProblem } from '@cheeseoclock/shared-schemas/sign-in-secret';
import { useSessionStore } from '../../stores/sessionStore';
import { useToast } from '../../components/toast/ToastProvider';
import { SecretInput } from '../../components/secret/SecretInput';
import { SecretHint } from '../../components/secret/SecretHint';
import { ipc } from '../../ipc/client';
import { Grid3x3, Keyboard, Pizza, Lock } from 'lucide-react';
import { StoreLogo } from '../settings/StoreLogo';
import { isTypingField } from '../checkout/keys';
import { keypadDigits, signInKey, signInProblemTitle, type SignInMode } from './signInKeys';

/**
 * Logo, name and tagline at the top of the sign-in screen. Also drawn by the
 * Branding settings preview, so what the owner sees there is exactly this.
 * The logo is shown whole: a wide logo gets a wide frame, never a crop.
 */
export function LoginBrand({
  logoUrl,
  storeName,
  tagline,
}: {
  logoUrl?: string | null | undefined;
  storeName: string;
  tagline?: string | null | undefined;
}) {
  return (
    <div className="mb-4 flex flex-col items-center gap-3">
      <div className="relative max-w-full">
        <StoreLogo
          src={logoUrl}
          height={88}
          maxWidth={300}
          className="rounded-2xl shadow-lift"
          fallback={
            <span className="flex h-20 w-20 items-center justify-center rounded-2xl bg-gradient-to-br from-amber-400 to-amber-600 text-white shadow-lift">
              <Pizza className="h-10 w-10" />
            </span>
          }
        />
        <div className="absolute -bottom-1 -right-1 flex h-7 w-7 items-center justify-center rounded-full bg-white shadow-soft ring-1 ring-stone-200 dark:bg-stone-800 dark:ring-stone-700">
          <Lock className="h-3.5 w-3.5 text-stone-600 dark:text-stone-300" />
        </div>
      </div>
      <h1 className="mt-2 text-center text-3xl font-bold tracking-tight">{storeName}</h1>
      {tagline && (
        <p className="text-center text-sm text-stone-500 dark:text-stone-400">{tagline}</p>
      )}
    </div>
  );
}

const SWITCH_BUTTON =
  'flex h-12 w-full items-center justify-center gap-2 rounded-lg border-2 border-stone-300 text-base font-semibold text-stone-700 hover:bg-stone-100 active:bg-stone-200 dark:border-stone-600 dark:text-stone-200 dark:hover:bg-stone-800';

/**
 * The sign-in screen, and also the idle-lock unlock: when an owner or
 * manager login ends on its own, the till comes back here.
 *
 * It always opens on the keypad: most people at the counter have a number
 * PIN, and a cashier must never find a password box waiting because the
 * owner signed in with one. "Use a password" (or just typing a letter on a
 * keyboard) opens the password box. Either screen takes either kind — the
 * till tells a PIN from a password by what was typed.
 */
export function LoginPage() {
  const [mode, setMode] = useState<SignInMode>('pin');
  const [secret, setSecret] = useState('');
  const navigate = useNavigate();
  const login = useSessionStore((s) => s.login);
  const refresh = useSessionStore((s) => s.refresh);
  const status = useSessionStore((s) => s.status);
  const { toast } = useToast();
  const passwordRef = useRef<HTMLInputElement>(null);
  const busy = useRef(false);
  const brandingQ = useQuery({
    queryKey: ['system', 'branding'],
    queryFn: () => ipc.system.getBranding(),
    staleTime: 60_000,
  });
  const versionQ = useQuery({
    queryKey: ['system', 'version'],
    queryFn: () => ipc.system.getVersion(),
    staleTime: Infinity,
  });
  const isDev = versionQ.data?.isDev ?? false;
  const logoUrl = brandingQ.data?.logoUrl ?? undefined;
  const storeName = brandingQ.data?.storeName ?? 'CheeseOclock POS';
  const tagline = brandingQ.data?.storeTagline ?? undefined;

  useEffect(() => {
    void refresh().then(() => {
      const u = useSessionStore.getState().user;
      if (u) navigate('/', { replace: true });
    });
  }, [navigate, refresh]);

  async function submit() {
    // One at a time: every extra press would count as another wrong guess.
    if (busy.current || useSessionStore.getState().status === 'loading') return;
    const { mode: nowMode, secret: keyed } = latest.current;
    // On the keypad, numeric-keypad symbols held out of sight were slips: a PIN is its digits.
    const typed = nowMode === 'pin' ? keypadDigits(keyed) : keyed;
    const problem = secretProblem(typed);
    if (problem) {
      toast({
        title: signInProblemTitle(nowMode, typed),
        description: problem,
        variant: 'warning',
      });
      return;
    }
    busy.current = true;
    try {
      await login(normalizeSecret(typed));
      setSecret('');
      navigate('/', { replace: true });
    } catch (e) {
      setSecret('');
      // The error caught here — the store's copy is a render behind.
      toast({
        title: "Can't sign in",
        description: e instanceof Error ? e.message : 'PIN or password is wrong',
        variant: 'error',
      });
      if (latest.current.mode === 'password') passwordRef.current?.focus();
    } finally {
      busy.current = false;
    }
  }

  // The keyboard listener is added once and reads the newest values here.
  const latest = useRef({ mode, secret, submit });
  latest.current = { mode, secret, submit };

  function showPassword(carried: string) {
    setMode('password');
    setSecret(carried);
    // The box mounts on this render: focus it, caret after what was carried over.
    requestAnimationFrame(() => {
      const el = passwordRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(carried.length, carried.length);
    });
  }

  function showKeypad() {
    setMode('pin');
    setSecret('');
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // The password box (like any text box) types for itself.
      if (e.defaultPrevented || e.isComposing || isTypingField(e.target as Element | null)) return;
      const action = signInKey(latest.current.mode, latest.current.secret, e);
      if (action.type === 'ignore') return;
      // Also stops Enter or Space from pressing a keypad button that has focus.
      e.preventDefault();
      if (action.type === 'set') setSecret(action.value);
      else if (action.type === 'submit') void latest.current.submit();
      else if (action.type === 'switch') showPassword(action.value);
      else if (action.type === 'focus') {
        setSecret(action.value);
        passwordRef.current?.focus();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const verifying = status === 'loading';

  return (
    <div className="relative flex h-full items-center justify-center overflow-hidden">
      {/* Ambient gradient orbs */}
      <div
        className="pointer-events-none absolute -top-40 -left-40 h-96 w-96 rounded-full opacity-40 blur-3xl"
        style={{ background: 'radial-gradient(circle, rgba(251,191,36,0.4) 0%, transparent 70%)' }}
        aria-hidden
      />
      <div
        className="pointer-events-none absolute -bottom-40 -right-40 h-[28rem] w-[28rem] rounded-full opacity-30 blur-3xl"
        style={{ background: 'radial-gradient(circle, rgba(244,114,182,0.25) 0%, transparent 70%)' }}
        aria-hidden
      />

      <div className="relative w-[460px] animate-scale-in">
        <div className="glass-surface rounded-3xl p-8 shadow-soft-lg ring-1 ring-stone-200/60 dark:ring-stone-700/60">
          <LoginBrand logoUrl={logoUrl} storeName={storeName} tagline={tagline} />
          <p className="mb-4 text-center text-xs font-medium uppercase tracking-widest text-stone-400">
            {mode === 'pin' ? 'Enter your PIN' : 'Type your password'}
          </p>

          {mode === 'pin' ? (
            <>
              <NumberPad
                value={keypadDigits(secret)}
                onChange={setSecret}
                onSubmit={() => void submit()}
                mask
                maxLength={PIN_MAX_DIGITS}
              />
              <button type="button" onClick={() => showPassword('')} className={`mt-3 ${SWITCH_BUTTON}`}>
                <Keyboard className="h-5 w-5" aria-hidden="true" />
                Use a password
              </button>
            </>
          ) : (
            <form
              className="flex flex-col gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                void submit();
              }}
            >
              <SecretInput
                ref={passwordRef}
                keyboard="text"
                value={secret}
                onChange={setSecret}
                autoFocus
                aria-label="Password"
                placeholder="Password"
                className="h-16 w-full rounded-lg border-2 border-stone-300 bg-white px-4 text-center text-2xl text-stone-900 focus:border-amber-400 focus:outline-none focus:ring-2 focus:ring-amber-200 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-100"
              />
              <SecretHint value={secret} rules={false} className="text-center" />
              <p className="text-center text-xs text-stone-500">
                Tap the box to type. Capital and small letters count.
              </p>
              <Button type="submit" variant="primary" size="lg" disabled={verifying} className="w-full">
                Sign in
              </Button>
              <button type="button" onClick={showKeypad} className={SWITCH_BUTTON}>
                <Grid3x3 className="h-5 w-5" aria-hidden="true" />
                Use the number pad
              </button>
            </form>
          )}

          {verifying ? (
            <p className="mt-4 text-center text-sm font-medium text-amber-700 dark:text-amber-300">
              Verifying…
            </p>
          ) : isDev ? (
            <p className="mt-4 text-center text-[11px] uppercase tracking-widest text-stone-400">
              Dev PINs · admin 9999 · manager 5678 · cashier 1234
            </p>
          ) : null}
        </div>

        <div className="mt-4 text-center text-[10px] uppercase tracking-widest text-stone-400">
          Built for restaurants · Offline-first · FBR-ready
        </div>
      </div>
    </div>
  );
}
