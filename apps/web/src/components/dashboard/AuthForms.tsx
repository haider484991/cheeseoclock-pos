'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent, type ReactNode } from 'react';
import { DASH_PASSWORD_MIN, formatSetupCode, normalizeSetupCode } from '@cheeseoclock/shared-types';
import { cx } from './ui';

/**
 * The dashboard's forms: sign in, first-time setup with the till's code, a
 * new password, sign out. Each posts JSON to the dashboard's own API (the
 * cookie never leaves /dashboard) and shows the website's own words when it
 * refuses. A successful sign-in loads the dashboard fresh, so nothing from
 * before the sign-in lingers.
 */

async function post(path: string, body: unknown): Promise<{ ok: boolean; message?: string; error?: string }> {
  try {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
      credentials: 'same-origin',
    });
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; message?: string; error?: string };
    return { ok: res.ok && json.ok === true, message: json.message, error: json.error };
  } catch {
    return { ok: false, message: 'No connection. Check the phone’s internet and try again.' };
  }
}

const INPUT =
  'mt-1 block w-full rounded-xl border border-dash-line bg-dash-surface px-3.5 py-3 text-base text-dash-ink placeholder:text-dash-muted focus:border-dash-ink focus:outline-none';
const LABEL = 'block text-sm font-medium text-dash-soft';

function SubmitButton({ busy, children }: { busy: boolean; children: ReactNode }) {
  return (
    <button
      type="submit"
      disabled={busy}
      className="mt-2 w-full rounded-xl bg-dash-accent px-4 py-3.5 text-base font-semibold text-dash-accent-ink transition active:scale-[0.99] disabled:opacity-60"
    >
      {busy ? 'One moment…' : children}
    </button>
  );
}

function ErrorBox({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <p role="alert" className="rounded-xl bg-dash-bad-bg px-3.5 py-2.5 text-sm font-medium text-dash-bad-text">
      {text}
    </p>
  );
}

function PasswordInput({ id, value, onChange, autoComplete, label }: { id: string; value: string; onChange: (v: string) => void; autoComplete: string; label: string }) {
  const [show, setShow] = useState(false);
  return (
    <div>
      <label htmlFor={id} className={LABEL}>
        {label}
      </label>
      <div className="relative">
        <input
          id={id}
          type={show ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete={autoComplete}
          required
          className={cx(INPUT, 'pr-16')}
        />
        <button
          type="button"
          onClick={() => setShow((s) => !s)}
          className="absolute inset-y-0 right-0 mt-1 px-3.5 text-sm font-medium text-dash-soft"
          aria-label={show ? 'Hide the password' : 'Show the password'}
        >
          {show ? 'Hide' : 'Show'}
        </button>
      </div>
    </div>
  );
}

export function SignInForm({ next }: { next: string }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await post('/dashboard/api/sign-in', { username, password });
    if (r.ok) {
      window.location.assign(next);
      return;
    }
    setBusy(false);
    setError(r.message ?? 'Could not sign in. Try again.');
  }

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <ErrorBox text={error} />
      <div>
        <label htmlFor="username" className={LABEL}>
          Username
        </label>
        <input
          id="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          required
          className={INPUT}
        />
      </div>
      <PasswordInput id="password" label="Password" value={password} onChange={setPassword} autoComplete="current-password" />
      <SubmitButton busy={busy}>Sign in</SubmitButton>
      <p className="pt-1 text-center text-sm text-dash-soft">
        First time?{' '}
        <Link href={`/dashboard/setup${username ? `?u=${encodeURIComponent(username.trim().toLowerCase())}` : ''}`} className="font-semibold text-dash-ink underline underline-offset-2">
          Use your setup code
        </Link>
      </p>
    </form>
  );
}

export function SetupForm({ username: initialUser }: { username: string }) {
  const [username, setUsername] = useState(initialUser);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < DASH_PASSWORD_MIN) return setError(`Use at least ${DASH_PASSWORD_MIN} characters for your password.`);
    if (password !== again) return setError('The two passwords are not the same.');
    setBusy(true);
    const r = await post('/dashboard/api/setup', { username, code, password });
    if (r.ok) {
      window.location.assign('/dashboard');
      return;
    }
    setBusy(false);
    setError(r.message ?? 'Could not finish setting up. Try again.');
  }

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <ErrorBox text={error} />
      <div>
        <label htmlFor="username" className={LABEL}>
          Username
        </label>
        <input
          id="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          required
          className={INPUT}
        />
      </div>
      <div>
        <label htmlFor="code" className={LABEL}>
          Setup code
        </label>
        <input
          id="code"
          value={code}
          onChange={(e) => setCode(formatSetupCode(normalizeSetupCode(e.target.value).slice(0, 12)))}
          autoComplete="one-time-code"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          inputMode="text"
          placeholder="XXXX-XXXX-XXXX"
          required
          className={cx(INPUT, 'font-mono tracking-[0.15em]')}
        />
      </div>
      <PasswordInput id="password" label={`Pick a password (at least ${DASH_PASSWORD_MIN} characters)`} value={password} onChange={setPassword} autoComplete="new-password" />
      <PasswordInput id="again" label="Type it again" value={again} onChange={setAgain} autoComplete="new-password" />
      <SubmitButton busy={busy}>Finish and sign in</SubmitButton>
      <p className="pt-1 text-center text-sm text-dash-soft">
        Already set up?{' '}
        <Link href="/dashboard/sign-in" className="font-semibold text-dash-ink underline underline-offset-2">
          Sign in
        </Link>
      </p>
    </form>
  );
}

export function PasswordForm() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setDone(false);
    if (next !== again) return setError('The two new passwords are not the same.');
    setBusy(true);
    const r = await post('/dashboard/api/password', { current, next });
    setBusy(false);
    if (r.ok) {
      setDone(true);
      setCurrent('');
      setNext('');
      setAgain('');
      return;
    }
    setError(r.message ?? 'Could not change the password. Try again.');
  }

  return (
    <form onSubmit={submit} className="space-y-3" noValidate>
      <ErrorBox text={error} />
      {done ? (
        <p role="status" className="rounded-xl bg-dash-good-bg px-3.5 py-2.5 text-sm font-medium text-dash-good-text">
          Password changed. Your other phones are signed out.
        </p>
      ) : null}
      <PasswordInput id="current" label="Current password" value={current} onChange={setCurrent} autoComplete="current-password" />
      <PasswordInput id="next" label={`New password (at least ${DASH_PASSWORD_MIN} characters)`} value={next} onChange={setNext} autoComplete="new-password" />
      <PasswordInput id="again2" label="New password again" value={again} onChange={setAgain} autoComplete="new-password" />
      <SubmitButton busy={busy}>Change password</SubmitButton>
    </form>
  );
}

export function SignOutButtons() {
  const router = useRouter();
  const [busy, setBusy] = useState<null | 'one' | 'all'>(null);
  async function out(everywhere: boolean) {
    setBusy(everywhere ? 'all' : 'one');
    await post('/dashboard/api/sign-out', everywhere ? { everywhere: true } : {});
    router.replace('/dashboard/sign-in');
    router.refresh();
  }
  return (
    <div className="flex flex-col gap-2 sm:flex-row">
      <button
        type="button"
        onClick={() => void out(false)}
        disabled={busy !== null}
        className="rounded-xl border border-dash-line bg-dash-surface px-4 py-3 text-sm font-semibold text-dash-ink hover:border-dash-axis disabled:opacity-60"
      >
        {busy === 'one' ? 'Signing out…' : 'Sign out of this phone'}
      </button>
      <button
        type="button"
        onClick={() => void out(true)}
        disabled={busy !== null}
        className="rounded-xl border border-dash-line bg-dash-surface px-4 py-3 text-sm font-semibold text-dash-bad-text hover:border-dash-axis disabled:opacity-60"
      >
        {busy === 'all' ? 'Signing out…' : 'Sign out of every phone'}
      </button>
    </div>
  );
}
