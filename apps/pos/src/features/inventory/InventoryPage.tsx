import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { cn } from '@cheeseoclock/ui';
import { stockStatus } from '@cheeseoclock/pos-domain';
import type { Ingredient } from '@cheeseoclock/shared-types';
import { ipc } from '../../ipc/client';
import { PO_LIST_KEY, fetchPurchaseList } from './purchaseListQuery';
import { useSessionState } from '../../components/list';
import { IngredientsTab } from './IngredientsTab';
import { RecipesTab } from './RecipesTab';
import { MovementsTab } from './MovementsTab';
import { SuppliersTab } from './SuppliersTab';
import { PurchaseOrdersTab } from './PurchaseOrdersTab';
import { StockTakesTab } from './StockTakesTab';
import { STOCK_COUNTS_KEY } from './CountSheet';
import { RecipeCalculatorTab } from './RecipeCalculator';
import { presetRecipeCalculator } from '../costing/deepLinks';
import { Carrot, BookOpen, History, Truck, ClipboardList, ClipboardCheck, Calculator } from 'lucide-react';

type Tab = 'ingredients' | 'calculator' | 'recipes' | 'movements' | 'stocktakes' | 'suppliers' | 'pos';

const TABS: Array<{ id: Tab; label: string; icon: typeof Carrot }> = [
  { id: 'ingredients', label: 'Ingredients', icon: Carrot },
  // Owner, 2026-09-27: "how much ingredients a recipe needs for making anything".
  { id: 'calculator', label: 'Recipe calculator', icon: Calculator },
  { id: 'recipes', label: 'Recipes', icon: BookOpen },
  { id: 'movements', label: 'Stock history', icon: History },
  // Costing spec Phase 8: count the shelves; what went missing.
  { id: 'stocktakes', label: 'Stock takes', icon: ClipboardCheck },
  { id: 'suppliers', label: 'Suppliers', icon: Truck },
  { id: 'pos', label: 'Purchases', icon: ClipboardList },
];

export function InventoryPage() {
  const [tab, setTab] = useSessionState<Tab>('inv.tab', 'ingredients');
  /** Set when "Stock history" is opened for one ingredient from the Ingredients list. */
  const [historyFor, setHistoryFor] = useState<Pick<Ingredient, 'id' | 'name'> | null>(null);

  // Same queries (and cache) as the tabs, for the little counts on the tab bar.
  const ingredientsQ = useQuery({
    queryKey: ['inventory', 'ingredients', 'all'],
    queryFn: () => ipc.inventory.listIngredients(),
  });
  const posQ = useQuery({
    queryKey: PO_LIST_KEY,
    queryFn: fetchPurchaseList,
  });
  const countsQ = useQuery({
    queryKey: [...STOCK_COUNTS_KEY, 'list'],
    queryFn: () => ipc.inventory.stockCountList({ limit: 200 }),
  });
  const needBuying = (ingredientsQ.data ?? []).filter((i) => stockStatus(i) !== 'ok').length;
  const beingCounted = (countsQ.data ?? []).filter((c) => c.status === 'open').length;
  const openPos = (posQ.data ?? []).filter((p) => p.status === 'draft' || p.status === 'ordered' || p.status === 'partial').length;
  const badge: Partial<Record<Tab, { n: number; title: string }>> = {
    ingredients: { n: needBuying, title: `${needBuying} low or out of stock` },
    pos: { n: openPos, title: `${openPos} purchase orders still open` },
    stocktakes: { n: beingCounted, title: `${beingCounted} stock take${beingCounted === 1 ? '' : 's'} being counted` },
  };

  return (
    <div className="mx-auto max-w-7xl">
      <header className="mb-4">
        <h1 className="text-3xl font-bold tracking-tight">Inventory</h1>
        <p className="mt-1 text-stone-600 dark:text-stone-400">
          What is in stock, what each dish uses, and what to buy.
        </p>
      </header>

      <nav className="mb-4 flex gap-1 overflow-x-auto border-b border-stone-200 dark:border-stone-800" aria-label="Inventory sections">
        {TABS.map((t) => {
          const Icon = t.icon;
          const active = tab === t.id;
          const b = badge[t.id];
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => {
                if (t.id !== 'movements') setHistoryFor(null);
                setTab(t.id);
              }}
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
              {b && b.n > 0 && (
                <span
                  title={b.title}
                  className={cn(
                    'min-w-[1.25rem] rounded-full px-1.5 text-center text-xs font-bold tabular-nums',
                    t.id === 'ingredients'
                      ? 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200'
                      : 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-200',
                  )}
                >
                  {b.n}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      {tab === 'ingredients' && (
        <IngredientsTab
          onShowHistory={(i) => {
            setHistoryFor({ id: i.id, name: i.name });
            setTab('movements');
          }}
        />
      )}
      {tab === 'calculator' && <RecipeCalculatorTab />}
      {tab === 'recipes' && (
        <RecipesTab
          onCalculate={(item) => {
            // "Calculate" on a recipe card: that item added to what is being worked out.
            presetRecipeCalculator(item);
            setTab('calculator');
          }}
        />
      )}
      {tab === 'movements' && (
        <MovementsTab ingredient={historyFor} onClearIngredient={() => setHistoryFor(null)} />
      )}
      {tab === 'stocktakes' && <StockTakesTab />}
      {tab === 'suppliers' && <SuppliersTab />}
      {tab === 'pos' && <PurchaseOrdersTab />}
    </div>
  );
}
