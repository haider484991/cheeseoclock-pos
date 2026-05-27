import { useState } from 'react';
import { cn } from '@cheeseoclock/ui';
import { CategoriesTab } from './CategoriesTab';
import { ItemsTab } from './ItemsTab';
import { ModifiersTab } from './ModifiersTab';
import { TaxTab } from './TaxTab';
import { Folder, Pizza, SlidersHorizontal, Receipt } from 'lucide-react';

type Tab = 'items' | 'categories' | 'modifiers' | 'tax';

const TABS: Array<{ id: Tab; label: string; icon: typeof Folder }> = [
  { id: 'items', label: 'Items', icon: Pizza },
  { id: 'categories', label: 'Categories', icon: Folder },
  { id: 'modifiers', label: 'Modifiers', icon: SlidersHorizontal },
  { id: 'tax', label: 'Tax', icon: Receipt },
];

export function MenuPage() {
  const [tab, setTab] = useState<Tab>('items');
  return (
    <div className="mx-auto max-w-7xl">
      <header className="mb-4">
        <h1 className="text-3xl font-bold tracking-tight">Menu</h1>
        <p className="mt-1 text-stone-600 dark:text-stone-400">
          Manage what you sell. Changes are immediate in the checkout view.
        </p>
      </header>

      <nav className="mb-4 flex gap-1 border-b border-stone-200 dark:border-stone-800">
        {TABS.map((t) => {
          const Icon = t.icon;
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={cn(
                '-mb-px flex items-center gap-2 border-b-2 px-4 py-3 text-sm font-medium transition-colors',
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

      {tab === 'items' && <ItemsTab />}
      {tab === 'categories' && <CategoriesTab />}
      {tab === 'modifiers' && <ModifiersTab />}
      {tab === 'tax' && <TaxTab />}
    </div>
  );
}
