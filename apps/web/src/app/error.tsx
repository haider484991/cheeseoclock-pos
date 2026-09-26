'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { BUSINESS, WA_ORDER_URL } from '@/lib/business';

/**
 * A page crashed while rendering (a database hiccup on the menu, say). The
 * customer gets a way forward instead of Next's bare error screen: try again,
 * or order the way that never breaks — WhatsApp or a phone call.
 */
export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="mx-auto flex min-h-[70vh] max-w-xl flex-col items-center justify-center px-4 py-16 text-center">
      <p className="font-cond text-sm font-bold uppercase tracking-[0.24em] text-cheese">{BUSINESS.name}</p>
      <h1 className="mt-2 font-display text-5xl uppercase leading-none tracking-wide text-cream">
        Something went wrong
      </h1>
      <p className="mt-4 text-cream/70">
        This page didn&rsquo;t load properly. Try again — or order on WhatsApp or by phone, we&rsquo;re right here.
      </p>
      <div className="mt-8 flex flex-wrap justify-center gap-3">
        <button
          type="button"
          onClick={reset}
          className="rounded-full bg-cheese px-8 py-3.5 font-display text-xl uppercase tracking-wide text-night shadow-glow transition-all hover:bg-cheese-hot active:scale-95"
        >
          Try again
        </button>
        <a
          href={WA_ORDER_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="rounded-full border border-cream/25 px-6 py-3.5 font-cond text-lg font-bold uppercase tracking-wide text-cream transition-colors hover:border-cheese hover:text-cheese"
        >
          WhatsApp us
        </a>
        <a
          href={`tel:${BUSINESS.phoneE164}`}
          className="rounded-full border border-cream/25 px-6 py-3.5 font-cond text-lg font-bold uppercase tracking-wide text-cream transition-colors hover:border-cheese hover:text-cheese"
        >
          Call {BUSINESS.phoneDisplay}
        </a>
      </div>
      <Link href="/" className="mt-6 text-sm font-semibold text-smoke underline underline-offset-4 hover:text-cheese">
        Back to the home page
      </Link>
    </main>
  );
}
