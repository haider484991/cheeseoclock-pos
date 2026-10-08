import type { Metadata } from 'next';
import { PasswordForm, SignOutButtons } from '@/components/dashboard/AuthForms';
import { Shell } from '@/components/dashboard/Shell';
import { Card, Dot, PageHeader, Row } from '@/components/dashboard/ui';
import { ago, clock } from '@/lib/dashboard/format';
import { roleWord, seesProfit, seesReports } from '@/lib/dashboard/perms';
import { getTills } from '@/lib/dashboard/queries';
import { requireUser } from '@/lib/dashboard/session';
import { tillWord } from '@/lib/dashboard/till-status';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Account' };

export default async function AccountPage() {
  const user = await requireUser('/dashboard/account');
  const now = new Date();
  const tills = await getTills();
  return (
    <Shell user={user}>
      <PageHeader title="Account" sub={`${user.displayName} · ${roleWord(user)}`} />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card title="You">
          <div className="text-sm">
            <Row label="Name" value={user.displayName} />
            <Row label="Username" value={user.username} />
            <Row label="Role" value={roleWord(user)} />
            <Row label="Sales reports and past shifts" value={seesReports(user) ? 'Yes' : 'No'} />
            <Row label="Profit and the drawer log" value={seesProfit(user) ? 'Yes' : 'No'} />
          </div>
          <p className="mt-3 text-xs leading-relaxed text-dash-muted">
            The owner changes who can see what on the till: Settings → Online orders → Phone dashboard. A new setup code from there also
            resets a forgotten password.
          </p>
        </Card>

        <Card title="Change your password">
          <PasswordForm />
        </Card>

        <Card title="Tills sending figures">
          {tills.length === 0 ? (
            <p className="text-sm text-dash-muted">No till has sent anything yet.</p>
          ) : (
            <ul className="divide-y divide-dash-line text-sm">
              {tills.map((t) => {
                const w = tillWord(t, { clock: (i) => clock(i), ago: (i) => ago(i, now) }, now.getTime());
                return (
                  <li key={t.deviceId} className="py-2.5">
                    <p className="flex items-center gap-2 font-medium text-dash-ink">
                      <Dot tone={w.tone} /> {t.name}
                    </p>
                    <p className="ml-4 text-dash-soft">
                      {w.title} · {w.detail}
                    </p>
                    <p className="ml-4 text-xs text-dash-muted">
                      Version {t.appVersion ?? '?'} · first heard {ago(t.firstPushAt, now)}
                      {t.caughtUp ? '' : ' · still sending its history'}
                    </p>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <Card title="Sign out">
          <p className="mb-3 text-sm text-dash-soft">Lost a phone? Sign out of every phone, then sign in again here.</p>
          <SignOutButtons />
        </Card>
      </div>
    </Shell>
  );
}
