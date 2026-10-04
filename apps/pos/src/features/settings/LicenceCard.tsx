import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Card } from '@cheeseoclock/ui';
import type { LicenceStatus } from '@cheeseoclock/shared-types';
import { BadgeCheck, Copy, KeyRound, ShieldAlert, Timer } from 'lucide-react';
import { ipc, IpcError } from '../../ipc/client';

/** The query every licence screen shares; the banner polls it too. */
export const LICENCE_STATUS_QUERY = ['licence', 'status'] as const;

function stateWords(s: LicenceStatus): { label: string; tone: string; Icon: typeof BadgeCheck } {
  switch (s.state) {
    case 'active':
      return { label: 'Licensed', tone: 'bg-emerald-100 text-emerald-800 ring-emerald-200 dark:bg-emerald-900/40 dark:text-emerald-200 dark:ring-emerald-800', Icon: BadgeCheck };
    case 'trial':
      return { label: `Free trial · ${s.daysLeft} ${s.daysLeft === 1 ? 'day' : 'days'} left`, tone: 'bg-amber-100 text-amber-900 ring-amber-200 dark:bg-amber-900/40 dark:text-amber-100 dark:ring-amber-800', Icon: Timer };
    case 'grace':
      return { label: `Renewal due · ${s.daysLeft} ${s.daysLeft === 1 ? 'day' : 'days'} left`, tone: 'bg-amber-100 text-amber-900 ring-amber-200 dark:bg-amber-900/40 dark:text-amber-100 dark:ring-amber-800', Icon: Timer };
    case 'expired':
      return { label: 'Sales stopped', tone: 'bg-red-100 text-red-800 ring-red-200 dark:bg-red-900/40 dark:text-red-100 dark:ring-red-800', Icon: ShieldAlert };
  }
}

function dateWords(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
}

export function LicenceCard() {
  const qc = useQueryClient();
  const statusQ = useQuery({ queryKey: LICENCE_STATUS_QUERY, queryFn: () => ipc.licence.status() });
  const [key, setKey] = useState('');
  const [copied, setCopied] = useState(false);
  const activate = useMutation({
    mutationFn: (token: string) => ipc.licence.activate(token),
    onSuccess: () => {
      setKey('');
      void qc.invalidateQueries({ queryKey: LICENCE_STATUS_QUERY });
    },
  });

  const resetClock = useMutation({
    mutationFn: () => ipc.licence.resetClock(),
    onSuccess: () => void qc.invalidateQueries({ queryKey: LICENCE_STATUS_QUERY }),
  });

  const s = statusQ.data;
  const words = s ? stateWords(s) : null;
  const errorText = activate.error instanceof IpcError ? activate.error.message : activate.error ? 'The key could not be checked. Try again.' : null;

  async function copyDeviceId() {
    if (!s) return;
    try {
      await navigator.clipboard.writeText(s.deviceId);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  }

  return (
    <Card>
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <KeyRound className="h-5 w-5" />
          <h2 className="text-lg font-semibold">Licence</h2>
        </div>
        {words && (
          <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold ring-1 ${words.tone}`}>
            <words.Icon className="h-3.5 w-3.5" />
            {words.label}
          </span>
        )}
      </div>

      <p className="text-sm text-stone-700 dark:text-stone-200">{s?.message ?? 'Checking…'}</p>
      {s?.problem && (
        <p className="mt-2 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-800 ring-1 ring-red-200 dark:bg-red-950/40 dark:text-red-100 dark:ring-red-900">
          The stored key is being ignored: {s.problem}
        </p>
      )}
      {s?.clockSuspect && (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900 ring-1 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-100 dark:ring-amber-900">
          <span>
            This computer’s clock was set ahead at some point, so the licence counts from that later time. If the date and
            time are right now, press Fix clock.
          </span>
          <Button onClick={() => resetClock.mutate()} disabled={resetClock.isPending}>
            {resetClock.isPending ? 'Fixing…' : 'Fix clock'}
          </Button>
        </div>
      )}

      <dl className="mt-4 grid grid-cols-2 gap-x-8 gap-y-2 border-t border-stone-200 pt-4 text-sm dark:border-stone-700">
        <dt className="text-stone-500">Plan</dt>
        <dd className="font-medium">{s?.plan ? s.plan[0]!.toUpperCase() + s.plan.slice(1) : 'Free trial'}</dd>
        <dt className="text-stone-500">Licensed to</dt>
        <dd>{s?.shop ?? '—'}</dd>
        <dt className="text-stone-500">{s?.state === 'trial' || (s?.state === 'expired' && !s.plan) ? 'Trial ends' : 'Paid until'}</dt>
        <dd>{dateWords(s?.paidUntil ?? null)}</dd>
        <dt className="text-stone-500">Device ID</dt>
        <dd className="flex items-center gap-2">
          <span className="font-mono text-xs text-stone-600 dark:text-stone-300">{s?.deviceId ?? '—'}</span>
          <button
            type="button"
            onClick={() => void copyDeviceId()}
            className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-stone-500 hover:bg-stone-100 hover:text-stone-800 dark:hover:bg-stone-800 dark:hover:text-stone-100"
            title="Copy the Device ID"
          >
            <Copy className="h-3.5 w-3.5" />
            {copied ? 'Copied' : 'Copy'}
          </button>
        </dd>
      </dl>

      <div className="mt-4 rounded-xl border border-stone-200 bg-stone-50/60 p-4 dark:border-stone-700 dark:bg-stone-900/40">
        <div className="text-sm font-semibold text-stone-700 dark:text-stone-200">Enter a licence key</div>
        <p className="mt-1 text-xs text-stone-500">
          Send the Device ID above to get a key for this till. Paste the whole key here (it starts with COC1). A key for a later period replaces the current one.
        </p>
        <textarea
          value={key}
          onChange={(e) => setKey(e.target.value)}
          rows={3}
          spellCheck={false}
          placeholder="COC1.…"
          className="mt-2 w-full rounded-lg border border-stone-300 bg-white px-3 py-2 font-mono text-xs text-stone-800 outline-none focus:border-amber-500 focus:ring-2 focus:ring-amber-200 dark:border-stone-600 dark:bg-stone-950 dark:text-stone-100"
        />
        {errorText && <p className="mt-2 text-xs text-red-700 dark:text-red-300">{errorText}</p>}
        {activate.isSuccess && !errorText && (
          <p className="mt-2 text-xs text-emerald-700 dark:text-emerald-300">Key accepted. This till is licensed.</p>
        )}
        <div className="mt-3">
          <Button onClick={() => activate.mutate(key)} disabled={!key.trim() || activate.isPending}>
            {activate.isPending ? 'Checking…' : 'Activate'}
          </Button>
        </div>
      </div>
    </Card>
  );
}
