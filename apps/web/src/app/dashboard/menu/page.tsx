import type { Metadata } from 'next';
import { Shell } from '@/components/dashboard/Shell';
import { Card, Chip, ChipRow, Empty, Note, PageHeader, Pill, StatTile } from '@/components/dashboard/ui';
import { ago, count, money, percent } from '@/lib/dashboard/format';
import { seesCosts } from '@/lib/dashboard/perms';
import { getMenu, getTills, tillsWith } from '@/lib/dashboard/queries';
import { requireUser } from '@/lib/dashboard/session';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Menu' };

/**
 * The menu as a till holds it now (not only what the website shows): every
 * item, its price, whether the till sells it and whether the website shows
 * it, and — for those who see costs — what a plate costs to make at today's
 * prices (the till's Costing).
 */
export default async function MenuPage({ searchParams }: { searchParams: { till?: string } }) {
  const user = await requireUser('/dashboard/menu');
  const now = new Date();
  const [tills, withMenu] = await Promise.all([getTills(), tillsWith('menu')]);
  const deviceId = withMenu.includes(searchParams.till ?? '') ? searchParams.till! : withMenu[0];
  const got = deviceId ? await getMenu(deviceId) : null;
  if (!got) {
    return (
      <Shell user={user}>
        <PageHeader title="Menu" />
        <Empty title="No menu yet">It appears once a till with the update sends its menu.</Empty>
      </Shell>
    );
  }
  const { menu, receivedAt } = got;
  const costs = seesCosts(user);
  const cats = [...menu.categories].sort((a, b) => a.displayOrder - b.displayOrder || a.name.localeCompare(b.name));
  const items = [...menu.items].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  const onSale = items.filter((i) => i.active).length;
  const offWeb = items.filter((i) => i.active && i.web === 'off').length;
  const till = tills.find((t) => t.deviceId === deviceId);
  const groups = [
    ...cats.map((c) => ({ id: c.id, name: c.name, active: c.active, onWebsite: c.onWebsite, items: items.filter((i) => i.categoryId === c.id) })),
    { id: '_none', name: 'No category', active: true, onWebsite: true, items: items.filter((i) => !cats.some((c) => c.id === i.categoryId)) },
  ].filter((g) => g.items.length > 0);

  return (
    <Shell user={user}>
      <PageHeader title="Menu" sub={`${till?.name ?? 'Till'} · last changed ${ago(menu.updatedAt, now)} · sent ${ago(receivedAt, now)}`} />
      {withMenu.length > 1 ? (
        <ChipRow label="Till">
          {withMenu.map((d) => (
            <Chip key={d} href={`/dashboard/menu?till=${encodeURIComponent(d)}`} active={d === deviceId}>
              {tills.find((t) => t.deviceId === d)?.name ?? 'Till'}
            </Chip>
          ))}
        </ChipRow>
      ) : null}
      <div className="mb-4 grid grid-cols-3 gap-2.5">
        <StatTile label="On sale" value={count(onSale)} />
        <StatTile label="Hidden on the till" value={count(items.length - onSale)} />
        <StatTile label="Not on the website" value={count(offWeb)} />
      </div>
      <div className="space-y-4">
        {groups.map((g) => (
          <Card
            key={g.id}
            title={g.name}
            sub={!g.active ? 'This category is hidden on the till' : !g.onWebsite ? 'This category is not on the website' : undefined}
            flush
          >
            <ul className="divide-y divide-dash-line">
              {g.items.map((i) => {
                const fc = costs && i.costCents !== null && i.priceCents > 0 ? i.costCents : null;
                return (
                  <li key={i.id} className="flex items-start justify-between gap-3 px-4 py-2.5">
                    <div className="min-w-0">
                      <p className={i.active ? 'font-medium text-dash-ink' : 'font-medium text-dash-muted line-through'}>{i.name}</p>
                      <div className="mt-1 flex flex-wrap gap-1.5">
                        {!i.active ? <Pill tone="neutral">Hidden on the till</Pill> : null}
                        {i.web === 'off' ? <Pill tone="warn">Not on the website</Pill> : null}
                        {i.web === 'pickup_only' ? <Pill tone="info">Website: pick-up only</Pill> : null}
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      <p className="tnum font-semibold text-dash-ink">{money(i.priceCents)}</p>
                      {costs ? (
                        <p className="tnum text-xs text-dash-muted">
                          {fc !== null ? `costs ${money(fc)} · ${percent(fc, i.priceCents)}` : 'cost not known'}
                        </p>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          </Card>
        ))}
      </div>
      {costs ? <Note>Prices are before tax. A plate’s cost is its recipe at today’s ingredient prices; the % is of the price before tax.</Note> : null}
    </Shell>
  );
}
