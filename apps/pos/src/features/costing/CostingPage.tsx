import { cn } from '@cheeseoclock/ui';
import { PROFIT_CAPABILITY } from '@cheeseoclock/shared-types';
import { BellRing, FlaskConical, ListChecks, Target, UtensilsCrossed } from 'lucide-react';
import { presetSessionState, useSessionState } from '../../components/list';
import { useSessionStore } from '../../stores/sessionStore';
import { useCostAlerts, useMenuCosts } from './costingQueries';
import { AlertsTab } from './AlertsTab';
import { MenuCostsTab } from './MenuCostsTab';
import { MissingCostsTab } from './MissingCostsTab';
import { TargetsTab } from './TargetsTab';
import { WHAT_IF_TRY, WhatIfTab } from './WhatIfTab';

/**
 * Costing (costing spec, Phase 1): what every dish costs to make at today's
 * prices, whether its food cost is on target, and what still needs a price.
 * Read-only: prices and recipes are changed in Inventory, and every row that
 * needs fixing links there. Managers and the owner only (COST_CAPABILITY;
 * the main process refuses anyone else). What-if (costing spec Phase 9) is
 * profit.view's: prices tried there are never saved.
 */
type Tab = 'menu' | 'missing' | 'alerts' | 'whatif' | 'targets';

const TABS: Array<{ id: Tab; label: string; icon: typeof ListChecks; profitOnly?: boolean }> = [
  { id: 'menu', label: 'Menu costs', icon: UtensilsCrossed },
  { id: 'missing', label: 'Missing costs', icon: ListChecks },
  { id: 'alerts', label: 'Alerts', icon: BellRing },
  { id: 'whatif', label: 'What-if', icon: FlaskConical, profitOnly: true },
  { id: 'targets', label: 'Targets & fees', icon: Target },
];

export function CostingPage() {
  const canSeeProfit = useSessionStore((s) => s.can(PROFIT_CAPABILITY));
  const [chosen, setTab] = useSessionState<Tab>('costing.tab', 'menu');
  const tab: Tab = chosen === 'whatif' && !canSeeProfit ? 'menu' : chosen;
  const tryPrice = (menuItemId: string) => {
    presetSessionState(WHAT_IF_TRY, { menuItemId });
    setTab('whatif');
  };
  // The badge: what still stops the till costing the menu.
  const menuQ = useMenuCosts();
  const missing = menuQ.data?.missingCount ?? 0;
  // …and the price alerts not seen yet (costing spec Phase 6).
  const alertsQ = useCostAlerts();
  const unseen = alertsQ.data?.unseen ?? 0;

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
        {TABS.filter((t) => !t.profitOnly || canSeeProfit).map((t) => {
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
              {t.id === 'alerts' && unseen > 0 && (
                <span
                  title={`${unseen} ${unseen === 1 ? 'alert' : 'alerts'} not seen yet`}
                  className="min-w-[1.25rem] rounded-full bg-amber-100 px-1.5 text-center text-xs font-bold tabular-nums text-amber-900 dark:bg-amber-950 dark:text-amber-200"
                >
                  {unseen}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      {tab === 'menu' && (
        <MenuCostsTab onShowMissing={() => setTab('missing')} onShowTargets={() => setTab('targets')} onTryPrice={canSeeProfit ? tryPrice : undefined} />
      )}
      {tab === 'missing' && <MissingCostsTab />}
      {tab === 'alerts' && <AlertsTab />}
      {tab === 'whatif' && canSeeProfit && <WhatIfTab />}
      {tab === 'targets' && <TargetsTab />}
    </div>
  );
}
