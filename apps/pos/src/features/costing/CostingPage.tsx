import { cn } from '@cheeseoclock/ui';
import { ListChecks, Target, UtensilsCrossed } from 'lucide-react';
import { useSessionState } from '../../components/list';
import { useMenuCosts } from './costingQueries';
import { MenuCostsTab } from './MenuCostsTab';
import { MissingCostsTab } from './MissingCostsTab';
import { TargetsTab } from './TargetsTab';

/**
 * Costing (costing spec, Phase 1): what every dish costs to make at today's
 * prices, whether its food cost is on target, and what still needs a price.
 * Read-only: prices and recipes are changed in Inventory, and every row that
 * needs fixing links there. Managers and the owner only (COST_CAPABILITY;
 * the main process refuses anyone else).
 */
type Tab = 'menu' | 'missing' | 'targets';

const TABS: Array<{ id: Tab; label: string; icon: typeof ListChecks }> = [
  { id: 'menu', label: 'Menu costs', icon: UtensilsCrossed },
  { id: 'missing', label: 'Missing costs', icon: ListChecks },
  { id: 'targets', label: 'Targets', icon: Target },
];

export function CostingPage() {
  const [tab, setTab] = useSessionState<Tab>('costing.tab', 'menu');
  // The badge: what still stops the till costing the menu.
  const menuQ = useMenuCosts();
  const missing = menuQ.data?.missingCount ?? 0;

  return (
    <div className="mx-auto max-w-7xl">
      <header className="mb-4">
        <h1 className="text-3xl font-bold tracking-tight">Costing</h1>
        <p className="mt-1 text-stone-600 dark:text-stone-400">
          What each dish costs to make at today&apos;s prices, what you keep per sale, and whether it is on target.
          Prices and recipes are changed in Inventory.
        </p>
      </header>

      <nav className="mb-4 flex gap-1 overflow-x-auto border-b border-stone-200 dark:border-stone-800" aria-label="Costing sections">
        {TABS.map((t) => {
          const Icon = t.icon;
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              aria-current={active ? 'page' : undefined}
              className={cn(
                '-mb-px flex items-center gap-2 whitespace-nowrap border-b-2 px-4 py-3 text-sm font-medium transition-colors',
                active
                  ? 'border-amber-500 text-amber-700 dark:text-amber-300'
                  : 'border-transparent text-stone-600 hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-100',
              )}
            >
              <Icon className="h-4 w-4" />
              {t.label}
              {t.id === 'missing' && missing > 0 && (
                <span
                  title={`${missing} ${missing === 1 ? 'thing' : 'things'} to fill in`}
                  className="min-w-[1.25rem] rounded-full bg-red-100 px-1.5 text-center text-xs font-bold tabular-nums text-red-800 dark:bg-red-950 dark:text-red-200"
                >
                  {missing}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      {tab === 'menu' && <MenuCostsTab onShowMissing={() => setTab('missing')} onShowTargets={() => setTab('targets')} />}
      {tab === 'missing' && <MissingCostsTab />}
      {tab === 'targets' && <TargetsTab />}
    </div>
  );
}
