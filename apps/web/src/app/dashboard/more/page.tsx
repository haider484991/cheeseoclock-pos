import type { Metadata } from 'next';
import { IconMenu, IconStock, IconUser } from '@/components/dashboard/icons';
import { Shell } from '@/components/dashboard/Shell';
import { Card, ListLink, PageHeader } from '@/components/dashboard/ui';
import { seesReports } from '@/lib/dashboard/perms';
import { requireUser } from '@/lib/dashboard/session';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'More' };

/**
 * The phone's "More": the places the bottom bar has no room for (Stock is on
 * the bar of a login without reports, so it is here only for the others).
 */
export default async function MorePage() {
  const user = await requireUser('/dashboard/more');
  const places = [
    ...(seesReports(user) ? [{ href: '/dashboard/stock', label: 'Stock', sub: 'What is on the shelves, low and out', Icon: IconStock }] : []),
    { href: '/dashboard/menu', label: 'Menu', sub: 'Prices, what is on the website, plate costs', Icon: IconMenu },
    { href: '/dashboard/account', label: 'Account', sub: 'Password, sign out, tills', Icon: IconUser },
  ];
  return (
    <Shell user={user}>
      <PageHeader title="More" />
      <Card flush>
        <ul className="divide-y divide-dash-line">
          {places.map(({ href, label, sub, Icon }) => (
            <li key={href}>
              <ListLink href={href}>
                <div className="flex items-center gap-3">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-dash-sunk text-dash-ink">
                    <Icon className="h-5 w-5" />
                  </span>
                  <span>
                    <span className="block font-medium text-dash-ink">{label}</span>
                    <span className="block text-sm text-dash-muted">{sub}</span>
                  </span>
                </div>
              </ListLink>
            </li>
          ))}
        </ul>
      </Card>
    </Shell>
  );
}
