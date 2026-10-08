import type { Metadata } from 'next';
import { Shell } from '@/components/dashboard/Shell';
import { StockList } from '@/components/dashboard/StockList';
import { levelOf } from '@/lib/dashboard/stock-level';
import { Card, Chip, ChipRow, Empty, PageHeader, StatTile, TD, TD_NUM, TH, TableWrap } from '@/components/dashboard/ui';
import { ago, count, dayClock, money, moneyWhole, stockQty } from '@/lib/dashboard/format';
import { addDays, todayOf } from '@/lib/dashboard/period';
import { seesCosts } from '@/lib/dashboard/perms';
import { getStock, getTills, listStockMoves, tillsWith } from '@/lib/dashboard/queries';
import { requireUser } from '@/lib/dashboard/session';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Stock' };

const MOVE_WORDS: Record<string, string> = {
  delivery: 'Delivered',
  waste: 'Wasted',
  count: 'Counted',
  adjustment: 'Changed by hand',
  transfer: 'Moved',
  sale: 'Used in a sale',
};

export default async function StockPage({ searchParams }: { searchParams: { till?: string; show?: string } }) {
  const user = await requireUser('/dashboard/stock');
  const now = new Date();
  const [tills, withStock] = await Promise.all([getTills(), tillsWith('stock')]);
  const deviceId = withStock.includes(searchParams.till ?? '') ? searchParams.till! : withStock[0];
  if (!deviceId) {
    return (
      <Shell user={user}>
        <PageHeader title="Stock" />
        <Empty title="No stock list yet">It appears once a till with the update sends its stock.</Empty>
      </Shell>
    );
  }
  const today = todayOf(now);
  const [items, moves] = await Promise.all([
    getStock(deviceId),
    listStockMoves({ deviceId, from: addDays(today, -13), to: today, reasons: ['delivery', 'waste', 'count', 'adjustment', 'transfer'] }),
  ]);
  const costs = seesCosts(user);
  const active = items.filter((i) => i.active);
  const out = active.filter((i) => levelOf(i) === 'out').length;
  const low = active.filter((i) => levelOf(i) === 'low').length;
  const value = active.reduce((t, i) => t + (i.pricePerThousandCents !== null && i.onHand > 0 ? Math.round((i.onHand * i.pricePerThousandCents) / 1000) : 0), 0);
  const till = tills.find((t) => t.deviceId === deviceId);
  const sentAt = items.reduce((m, i) => (i.updatedAt > m ? i.updatedAt : m), '');

  return (
    <Shell user={user}>
      <PageHeader title="Stock" sub={`${till?.name ?? 'Till'}'s count · sent ${ago(sentAt, now)}`} />
      {withStock.length > 1 ? (
        <ChipRow label="Till">
          {withStock.map((d) => (
            <Chip key={d} href={`/dashboard/stock?till=${encodeURIComponent(d)}`} active={d === deviceId}>
              {tills.find((t) => t.deviceId === d)?.name ?? 'Till'}
            </Chip>
          ))}
        </ChipRow>
      ) : null}
      <div className="mb-4 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        <StatTile label="Out of stock" value={count(out)} tone={out > 0 ? 'bad' : undefined} />
        <StatTile label="Low" value={count(low)} tone={low > 0 ? 'warn' : undefined} />
        <StatTile label="Ingredients" value={count(active.length)} />
        {costs ? <StatTile label="Stock value" value={moneyWhole(value)} sub="At the prices on the till" /> : null}
      </div>

      <StockList
        items={active.map((i) => ({ ...i, pricePerThousandCents: costs ? i.pricePerThousandCents : null }))}
        initialShow={searchParams.show === 'low' ? 'low' : 'all'}
        withValue={costs}
      />

      <Card title="Last two weeks" sub="Deliveries, waste, counts and changes by hand (not what sales used)." flush className="mt-4">
        {moves.length === 0 ? (
          <p className="px-4 pb-4 text-sm text-dash-muted">Nothing in the last two weeks.</p>
        ) : (
          <TableWrap caption="Stock movements in the last two weeks">
            <thead className="border-y border-dash-line bg-dash-sunk">
              <tr>
                <th className={TH}>When</th>
                <th className={TH}>What</th>
                <th className={`${TH} text-right`}>Amount</th>
                {costs ? <th className={`${TH} text-right`}>Value</th> : null}
              </tr>
            </thead>
            <tbody>
              {moves.map((m) => (
                <tr key={m.id} className="border-b border-dash-line last:border-0">
                  <td className={`${TD} whitespace-nowrap text-dash-soft`}>{dayClock(m.at)}</td>
                  <td className={TD}>
                    <span className="font-medium text-dash-ink">{m.ingredient}</span>
                    <span className="block text-dash-soft">
                      {MOVE_WORDS[m.reason] ?? m.reason}
                      {m.detail?.startsWith('waste:') ? ` · ${m.detail.slice(6).replace(/_/g, ' ')}` : ''}
                      {m.note ? ` · ${m.note}` : ''}
                      {m.by ? ` · ${m.by}` : ''}
                    </span>
                  </td>
                  <td className={`${TD_NUM} ${m.delta < 0 ? 'text-dash-bad-text' : 'text-dash-good-text'}`}>
                    {m.delta > 0 ? '+' : '−'}
                    {stockQty(Math.abs(m.delta), m.unit)}
                  </td>
                  {costs ? <td className={TD_NUM}>{m.valueCents === null ? '–' : money(Math.abs(m.valueCents))}</td> : null}
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </Card>
    </Shell>
  );
}
