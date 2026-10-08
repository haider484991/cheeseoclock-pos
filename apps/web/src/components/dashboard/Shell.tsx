import Link from 'next/link';
import type { ReactNode } from 'react';
import { BrandMark } from '@/components/BrandMark';
import type { DashUser } from '@/lib/dashboard/session';
import { roleWord, seesReports } from '@/lib/dashboard/perms';
import { DashNav } from './DashNav';
import { IconUser } from './icons';

/**
 * Every signed-in dashboard page: the shop's own dark bar with the logo, the
 * places to go (DashNav), and the page. Room is left under the page for the
 * phone's tab bar and the iPhone's home line.
 */
export function Shell({ user, children }: { user: DashUser; children: ReactNode }) {
  const initials = user.displayName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');
  return (
    <div className="min-h-dvh">
      <header className="sticky top-0 z-40 bg-[#151412] text-[#f4f0e6]">
        <div className="mx-auto flex h-14 max-w-7xl items-center justify-between gap-3 px-4">
          <Link href="/dashboard" className="flex items-center gap-2.5" aria-label="Dashboard home">
            <BrandMark className="!h-9" />
            <span className="hidden border-l border-white/20 pl-2.5 font-cond text-sm font-bold uppercase tracking-[0.18em] text-[#f5b301] sm:inline">
              Dashboard
            </span>
          </Link>
          <Link href="/dashboard/account" className="flex items-center gap-2 rounded-full py-1 pl-3 pr-1 text-sm hover:bg-white/10">
            <span className="hidden text-right leading-tight sm:block">
              <span className="block font-medium">{user.displayName}</span>
              <span className="block text-[11px] text-white/60">{roleWord(user)}</span>
            </span>
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[#f5b301] text-xs font-bold text-[#151412]" aria-hidden>
              {initials || <IconUser />}
            </span>
          </Link>
        </div>
      </header>
      <div className="mx-auto flex max-w-7xl gap-8 px-4 lg:py-6">
        <aside className="sticky top-20 hidden h-max w-56 shrink-0 lg:block">
          <DashNav reports={seesReports(user)} variant="side" />
        </aside>
        <main id="main" className="min-w-0 flex-1 pb-28 pt-4 lg:pb-12 lg:pt-0">
          {children}
        </main>
      </div>
      <DashNav reports={seesReports(user)} variant="bottom" />
    </div>
  );
}
