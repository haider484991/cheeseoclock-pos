import type { ReactNode } from 'react';
import { BrandMark } from '@/components/BrandMark';

/** The sign-in and setup pages: the shop's bar on top, one card in the middle. */
export function AuthCard({ title, lead, children, foot }: { title: string; lead: ReactNode; children: ReactNode; foot?: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="bg-[#151412]">
        <div className="mx-auto flex h-14 max-w-md items-center px-4">
          <BrandMark className="!h-9" />
        </div>
      </header>
      <main id="main" className="flex flex-1 items-start justify-center px-4 py-8 sm:items-center">
        <div className="w-full max-w-md">
          <div className="rounded-2xl border border-dash-line bg-dash-surface p-5 sm:p-7" style={{ boxShadow: 'var(--d-shadow)' }}>
            <p className="font-cond text-xs font-bold uppercase tracking-[0.2em] text-dash-muted">Owner &amp; manager dashboard</p>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight text-dash-ink">{title}</h1>
            <div className="mb-5 mt-1.5 text-sm leading-relaxed text-dash-soft">{lead}</div>
            {children}
          </div>
          {foot ? <div className="mt-4 px-1 text-center text-xs leading-relaxed text-dash-muted">{foot}</div> : null}
        </div>
      </main>
    </div>
  );
}
