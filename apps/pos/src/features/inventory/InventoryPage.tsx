import { useState } from 'react';
import { cn } from '@cheeseoclock/ui';
import { IngredientsTab } from './IngredientsTab';
import { RecipesTab } from './RecipesTab';
import { MovementsTab } from './MovementsTab';
import { SuppliersTab } from './SuppliersTab';
import { PurchaseOrdersTab } from './PurchaseOrdersTab';
import { Carrot, BookOpen, History, Truck, ClipboardList } from 'lucide-react';

type Tab = 'ingredients' | 'recipes' | 'movements' | 'suppliers' | 'pos';

const TABS: Array<{ id: Tab; label: string; icon: typeof Carrot }> = [
  { id: 'ingredients', label: 'Ingredients', icon: Carrot },
  { id: 'recipes', label: 'Recipes', icon: BookOpen },
  { id: 'movements', label: 'Movements', icon: History },
  { id: 'suppliers', label: 'Suppliers', icon: Truck },
  { id: 'pos', label: 'Purchase orders', icon: ClipboardList },
];

export function InventoryPage() {
  const [tab, setTab] = useState<Tab>('ingredients');
  return (
    <div className="mx-auto max-w-7xl">
      <header className="mb-4">
        <h1 className="text-3xl font-bold tracking-tight">Inventory</h1>
        <p className="mt-1 text-stone-600 dark:text-stone-400">
          Ingredients, recipes, stock movements, suppliers, and purchase orders.
        </p>
      </header>

      <nav className="mb-4 flex gap-1 overflow-x-auto border-b border-stone-200 dark:border-stone-800">
        {TABS.map((t) => {
          const Icon = t.icon;
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={cn(
                '-mb-px flex items-center gap-2 whitespace-nowrap border-b-2 px-4 py-3 text-sm font-medium transition-colors',
                active
                  ? 'border-amber-500 text-amber-700 dark:text-amber-300'
                  : 'border-transparent text-stone-600 hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-100',
              )}
            >
              <Icon className="h-4 w-4" />
              {t.label}
            </button>
          );
        })}
      </nav>

      {tab === 'ingredients' && <IngredientsTab />}
      {tab === 'recipes' && <RecipesTab />}
      {tab === 'movements' && <MovementsTab />}
      {tab === 'suppliers' && <SuppliersTab />}
      {tab === 'pos' && <PurchaseOrdersTab />}
    </div>
  );
}
