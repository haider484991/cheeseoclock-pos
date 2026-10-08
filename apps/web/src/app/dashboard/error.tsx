'use client';

import { useEffect } from 'react';

/**
 * A dashboard page crashed while rendering (the database asleep a moment too
 * long, say): the dashboard's own words and a way back, not the shop's
 * customer page ("order on WhatsApp").
 */
export default function DashboardError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);
  return (
    <main id="main" className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center px-4 text-center">
      <h1 className="text-2xl font-semibold tracking-tight text-dash-ink">The dashboard could not load that</h1>
      <p className="mt-2 text-sm text-dash-soft">The website may have been waking up. Try again in a moment.</p>
      <div className="mt-6 flex gap-2">
        <button type="button" onClick={reset} className="rounded-xl bg-dash-accent px-5 py-3 font-semibold text-dash-accent-ink">
          Try again
        </button>
        <a href="/dashboard" className="rounded-xl border border-dash-line bg-dash-surface px-5 py-3 font-semibold text-dash-ink">
          Dashboard home
        </a>
      </div>
    </main>
  );
}
