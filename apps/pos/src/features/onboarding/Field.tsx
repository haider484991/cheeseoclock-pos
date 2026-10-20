import type { ReactNode } from 'react';

/** One labelled box of the setup screen. */
export function Field({ label, htmlFor, children }: { label: string; htmlFor?: string; children: ReactNode }) {
  return (
    <div>
      <label htmlFor={htmlFor} className="mb-1 block text-xs font-semibold uppercase tracking-wider text-stone-500">
        {label}
      </label>
      {children}
    </div>
  );
}
