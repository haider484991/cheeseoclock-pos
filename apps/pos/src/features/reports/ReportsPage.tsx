import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Card, cn } from '@cheeseoclock/ui';
import { formatCents } from '@cheeseoclock/pos-domain';
import { ipc } from '../../ipc/client';
import { rangeForPreset, type RangePreset, dateInputToIso, fmtDateInput } from './dateRange';
import { BarChart, LineChart } from './charts';
import {
  CalendarRange,
  TrendingUp,
  UtensilsCrossed,
  Users,
  CreditCard,
  Percent,
  Boxes,
  Activity,
  DollarSign,
  ShoppingBag,
  Receipt,
  AlertTriangle,
  type LucideIcon,
} from 'lucide-react';

type Tab = 'overview' | 'items' | 'cashiers' | 'payments' | 'discounts' | 'stock';

const PRESETS: Array<{ id: RangePreset; label: string }> = [
  { id: 'today', label: 'Today' },
  { id: 'yesterday', label: 'Yesterday' },
  { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' },
  { id: 'thisMonth', label: 'This month' },
  { id: 'custom', label: 'Custom' },
];

const TABS: Array<{ id: Tab; label: string; icon: LucideIcon }> = [
  { id: 'overview', label: 'Overview', icon: TrendingUp },
  { id: 'items', label: 'Items & categories', icon: UtensilsCrossed },
  { id: 'cashiers', label: 'Cashiers', icon: Users },
  { id: 'payments', label: 'Payments & modes', icon: CreditCard },
  { id: 'discounts', label: 'Discounts', icon: Percent },
  { id: 'stock', label: 'Stock & COGS', icon: Boxes },
];

export function ReportsPage() {
  const [preset, setPreset] = useState<RangePreset>('7d');
  const [customSince, setCustomSince] = useState(() => fmtDateInput(new Date().toISOString()));
  const [customUntil, setCustomUntil] = useState(() => fmtDateInput(new Date().toISOString()));
  const [tab, setTab] = useState<Tab>('overview');

  const range = useMemo(() => {
    if (preset === 'custom') {
      return {
        sinceIso: dateInputToIso(customSince, false),
        untilIso: dateInputToIso(customUntil, true),
      };
    }
    return rangeForPreset(preset);
  }, [preset, customSince, customUntil]);

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <header className="space-y-1">
        <p className="text-xs font-medium uppercase tracking-widest text-amber-600 dark:text-amber-400">
          Analytics
        </p>
        <h1 className="text-4xl font-bold tracking-tight">Reports</h1>
        <p className="text-stone-500 dark:text-stone-400">
          Sales, items, cashiers, payments, discounts, stock & COGS — restricted to your selected date range.
        </p>
      </header>

      {/* Date range selector */}
      <Card>
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2 text-stone-600 dark:text-stone-400">
            <CalendarRange className="h-4 w-4" />
            <span className="text-xs font-semibold uppercase tracking-wider">Range</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {PRESETS.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => setPreset(p.id)}
                className={cn(
                  'rounded-full px-3 py-1.5 text-xs font-semibold transition-all',
                  preset === p.id
                    ? 'bg-gradient-to-b from-amber-400 to-amber-500 text-stone-900 shadow-soft-sm'
                    : 'bg-stone-100 text-stone-700 hover:bg-stone-200 dark:bg-stone-800 dark:text-stone-300 dark:hover:bg-stone-700',
                )}
              >
                {p.label}
              </button>
            ))}
          </div>
          {preset === 'custom' && (
            <div className="flex items-center gap-2">
              <input
                type="date"
                value={customSince}
                onChange={(e) => setCustomSince(e.target.value)}
                className="rounded-lg border border-stone-300 px-2.5 py-1.5 text-xs font-mono dark:border-stone-700 dark:bg-stone-800"
              />
              <span className="text-stone-400">→</span>
              <input
                type="date"
                value={customUntil}
                onChange={(e) => setCustomUntil(e.target.value)}
                className="rounded-lg border border-stone-300 px-2.5 py-1.5 text-xs font-mono dark:border-stone-700 dark:bg-stone-800"
              />
            </div>
          )}
          <span className="ml-auto rounded-full bg-stone-100 px-3 py-1 font-mono text-xs text-stone-600 dark:bg-stone-800 dark:text-stone-400">
            {range.sinceIso.slice(0, 10)} → {range.untilIso.slice(0, 10)}
          </span>
        </div>
      </Card>

      {/* Tabs */}
      <nav className="flex gap-1 overflow-x-auto border-b border-stone-200/70 dark:border-stone-800/70">
        {TABS.map((t) => {
          const Icon = t.icon;
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={cn(
                '-mb-px flex items-center gap-2 whitespace-nowrap border-b-2 px-4 py-3 text-sm font-medium transition-all',
                active
                  ? 'border-amber-500 text-amber-700 dark:text-amber-300'
                  : 'border-transparent text-stone-500 hover:text-stone-900 dark:hover:text-stone-100',
              )}
            >
              <Icon
                className={cn(
                  'h-4 w-4 transition-transform',
                  active && 'scale-110',
                )}
              />
              {t.label}
            </button>
          );
        })}
      </nav>

      {tab === 'overview' && <OverviewTab range={range} />}
      {tab === 'items' && <ItemsTab range={range} />}
      {tab === 'cashiers' && <CashiersTab range={range} />}
      {tab === 'payments' && <PaymentsTab range={range} />}
      {tab === 'discounts' && <DiscountsTab range={range} />}
      {tab === 'stock' && <StockTab range={range} />}
    </div>
  );
}

function OverviewTab({ range }: { range: { sinceIso: string; untilIso: string } }) {
  const summary = useQuery({
    queryKey: ['reports', 'summary', range],
    queryFn: () => ipc.reports.salesSummary(range),
  });
  const byDay = useQuery({
    queryKey: ['reports', 'byDay', range],
    queryFn: () => ipc.reports.salesByDay(range),
  });
  const byHour = useQuery({
    queryKey: ['reports', 'byHour', range],
    queryFn: () => ipc.reports.salesByHour(range),
  });

  const s = summary.data;
  return (
    <div className="space-y-6">
      <SectionLabel>Key metrics</SectionLabel>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat
          icon={DollarSign}
          tone="from-emerald-400 to-emerald-600"
          label="Revenue"
          value={s ? formatCents(s.totalCents) : '—'}
        />
        <Stat
          icon={ShoppingBag}
          tone="from-sky-400 to-blue-500"
          label="Orders"
          value={s ? String(s.orderCount) : '—'}
        />
        <Stat
          icon={UtensilsCrossed}
          tone="from-amber-400 to-orange-500"
          label="Items sold"
          value={s ? String(s.itemCount) : '—'}
        />
        <Stat
          icon={Receipt}
          tone="from-violet-400 to-purple-500"
          label="Avg ticket"
          value={s ? formatCents(s.avgTicketCents) : '—'}
        />
        <Stat
          icon={Activity}
          tone="from-fuchsia-400 to-pink-500"
          label="Tax collected"
          value={s ? formatCents(s.taxCents) : '—'}
        />
        <Stat
          icon={Percent}
          tone="from-teal-400 to-emerald-500"
          label="Discounts given"
          value={s ? formatCents(s.discountCents) : '—'}
        />
        <Stat
          icon={AlertTriangle}
          tone="from-stone-400 to-stone-600"
          label="Voided orders"
          value={s ? String(s.voidedCount) : '—'}
        />
        <Stat
          icon={AlertTriangle}
          tone="from-rose-400 to-red-500"
          label="Voided value"
          value={s ? formatCents(s.voidedCents) : '—'}
        />
      </div>

      <SectionLabel>Trends</SectionLabel>
      <Card>
        <ChartHeader icon={TrendingUp} title="Revenue by day" />
        <LineChart
          points={(byDay.data ?? []).map((d) => ({ label: d.day.slice(5), value: d.totalCents }))}
        />
      </Card>

      <Card>
        <ChartHeader icon={Activity} title="Sales by hour of day" />
        <BarChart
          data={Array.from({ length: 24 }, (_, h) => {
            const row = byHour.data?.find((x) => x.hour === h);
            return { label: String(h), value: row?.totalCents ?? 0 };
          })}
        />
      </Card>
    </div>
  );
}

function ItemsTab({ range }: { range: { sinceIso: string; untilIso: string } }) {
  const byCat = useQuery({
    queryKey: ['reports', 'byCategory', range],
    queryFn: () => ipc.reports.salesByCategory(range),
  });
  const topItems = useQuery({
    queryKey: ['reports', 'topItems', range],
    queryFn: () => ipc.reports.topItems({ ...range, limit: 30 }),
  });

  return (
    <div className="space-y-4">
      <Card>
        <ChartHeader icon={Boxes} title="Sales by category" />
        <BarChart
          data={(byCat.data ?? []).map((c) => ({ label: c.categoryName, value: c.revenueCents }))}
        />
        <DataTable
          rows={(byCat.data ?? []).map((c) => [
            c.categoryName,
            String(c.itemCount),
            formatCents(c.revenueCents),
          ])}
          headers={['Category', 'Items sold', 'Revenue']}
          alignRight={[false, true, true]}
        />
      </Card>
      <Card>
        <ChartHeader icon={UtensilsCrossed} title="Top items" />
        <DataTable
          rows={(topItems.data ?? []).map((t) => [
            t.menuItemName,
            t.categoryName,
            String(t.quantity),
            formatCents(t.revenueCents),
          ])}
          headers={['Item', 'Category', 'Qty sold', 'Revenue']}
          alignRight={[false, false, true, true]}
        />
      </Card>
    </div>
  );
}

function CashiersTab({ range }: { range: { sinceIso: string; untilIso: string } }) {
  const q = useQuery({
    queryKey: ['reports', 'cashiers', range],
    queryFn: () => ipc.reports.salesByCashier(range),
  });
  return (
    <Card>
      <ChartHeader icon={Users} title="Sales by cashier" />
      <DataTable
        rows={(q.data ?? []).map((c) => [
          c.cashierName,
          String(c.orderCount),
          formatCents(c.totalCents),
          String(c.voidedCount),
        ])}
        headers={['Cashier', 'Orders', 'Revenue', 'Voids']}
        alignRight={[false, true, true, true]}
      />
    </Card>
  );
}

function PaymentsTab({ range }: { range: { sinceIso: string; untilIso: string } }) {
  const byMode = useQuery({
    queryKey: ['reports', 'byMode', range],
    queryFn: () => ipc.reports.salesByMode(range),
  });
  const byMethod = useQuery({
    queryKey: ['reports', 'byMethod', range],
    queryFn: () => ipc.reports.salesByPaymentMethod(range),
  });
  const MODE_LABEL: Record<string, string> = {
    dine_in: 'Dine-in',
    takeaway: 'Takeaway',
    delivery: 'Delivery',
    online: 'Online',
  };
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Card>
        <ChartHeader icon={Activity} title="By order mode" />
        <BarChart
          data={(byMode.data ?? []).map((m) => ({
            label: MODE_LABEL[m.mode] ?? m.mode,
            value: m.totalCents,
          }))}
        />
        <DataTable
          rows={(byMode.data ?? []).map((m) => [
            MODE_LABEL[m.mode] ?? m.mode,
            String(m.orderCount),
            formatCents(m.totalCents),
          ])}
          headers={['Mode', 'Orders', 'Revenue']}
          alignRight={[false, true, true]}
        />
      </Card>
      <Card>
        <ChartHeader icon={CreditCard} title="By payment method" />
        <BarChart
          data={(byMethod.data ?? []).map((m) => ({
            label: m.method,
            value: m.amountCents,
          }))}
          color="#16a34a"
        />
        <DataTable
          rows={(byMethod.data ?? []).map((m) => [
            m.method,
            String(m.paymentCount),
            formatCents(m.amountCents),
          ])}
          headers={['Method', 'Payments', 'Amount']}
          alignRight={[false, true, true]}
        />
      </Card>
    </div>
  );
}

function DiscountsTab({ range }: { range: { sinceIso: string; untilIso: string } }) {
  const q = useQuery({
    queryKey: ['reports', 'discounts', range],
    queryFn: () => ipc.reports.discounts(range),
  });
  return (
    <Card>
      <ChartHeader icon={Percent} title="Discounts" />
      <div className="mb-4 grid grid-cols-2 gap-3">
        <Stat
          icon={Percent}
          tone="from-emerald-400 to-emerald-600"
          label="Count"
          value={q.data ? String(q.data.count) : '—'}
        />
        <Stat
          icon={DollarSign}
          tone="from-amber-400 to-orange-500"
          label="Total given"
          value={q.data ? formatCents(q.data.totalAmountCents) : '—'}
        />
      </div>
      <DataTable
        rows={(q.data?.byReason ?? []).map((r) => [
          r.reason,
          String(r.count),
          formatCents(r.amountCents),
        ])}
        headers={['Reason', 'Count', 'Total']}
        alignRight={[false, true, true]}
      />
    </Card>
  );
}

function StockTab({ range }: { range: { sinceIso: string; untilIso: string } }) {
  const low = useQuery({ queryKey: ['reports', 'lowStock'], queryFn: () => ipc.reports.lowStock() });
  const cogs = useQuery({
    queryKey: ['reports', 'cogs', range],
    queryFn: () => ipc.reports.cogs(range),
  });
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Card>
        <ChartHeader icon={AlertTriangle} title="Low stock right now" />
        <DataTable
          rows={(low.data ?? []).map((i) => [
            i.name,
            `${i.currentQty} ${i.unit}`,
            `${i.lowThreshold} ${i.unit}`,
          ])}
          headers={['Ingredient', 'On hand', 'Threshold']}
          alignRight={[false, true, true]}
          empty="Nothing under threshold."
        />
      </Card>
      <Card>
        <ChartHeader icon={DollarSign} title="Cost of goods sold (period)" />
        <div className="mb-4">
          <Stat
            icon={DollarSign}
            tone="from-rose-400 to-red-500"
            label="Total COGS"
            value={cogs.data ? formatCents(cogs.data.totalCogsCents) : '—'}
          />
        </div>
        <DataTable
          rows={(cogs.data?.byIngredient ?? []).map((c) => [
            c.name,
            `${c.qtyConsumed} ${c.unit}`,
            formatCents(c.costCents),
          ])}
          headers={['Ingredient', 'Qty consumed', 'Cost']}
          alignRight={[false, true, true]}
          empty="No sales with recipes in this range."
        />
      </Card>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Shared building blocks
// -----------------------------------------------------------------------------

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-stone-500">
      <span className="inline-block h-px w-6 bg-stone-300 dark:bg-stone-700" />
      {children}
    </div>
  );
}

function ChartHeader({ icon: Icon, title }: { icon: LucideIcon; title: string }) {
  return (
    <div className="mb-3 flex items-center gap-2">
      <Icon className="h-4 w-4 text-stone-500" />
      <h3 className="text-sm font-semibold tracking-tight">{title}</h3>
    </div>
  );
}

interface StatProps {
  icon: LucideIcon;
  tone: string;
  label: string;
  value: string;
}

function Stat({ icon: Icon, tone, label, value }: StatProps) {
  return (
    <Card className="relative overflow-hidden">
      {/* Soft tinted background blob in the corner */}
      <div
        className={cn(
          'pointer-events-none absolute -right-6 -top-6 h-20 w-20 rounded-full bg-gradient-to-br opacity-10 blur-xl',
          tone,
        )}
        aria-hidden
      />
      <div className="relative flex items-start justify-between gap-2">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-widest text-stone-500">
            {label}
          </div>
          <div className="mt-1 text-2xl font-bold tracking-tight">{value}</div>
        </div>
        <div
          className={cn(
            'flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-gradient-to-br text-white shadow-soft-sm',
            tone,
          )}
        >
          <Icon className="h-4 w-4" />
        </div>
      </div>
    </Card>
  );
}

function DataTable({
  headers,
  rows,
  alignRight,
  empty,
}: {
  headers: string[];
  rows: string[][];
  alignRight: boolean[];
  empty?: string;
}) {
  if (rows.length === 0) {
    return (
      <div className="py-6 text-center text-sm text-stone-500">{empty ?? 'No data.'}</div>
    );
  }
  return (
    <table className="w-full text-sm">
      <thead className="text-left text-xs uppercase tracking-wider text-stone-500">
        <tr>
          {headers.map((h, i) => (
            <th key={i} className={cn('pb-2 font-semibold', alignRight[i] && 'text-right')}>
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, ri) => (
          <tr
            key={ri}
            className="border-t border-stone-100 transition-colors hover:bg-stone-50 dark:border-stone-800 dark:hover:bg-stone-800/50"
          >
            {row.map((cell, ci) => (
              <td key={ci} className={cn('py-2.5', alignRight[ci] && 'text-right font-mono')}>
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
