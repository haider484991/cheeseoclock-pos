import { useCheckoutStore } from '../../stores/checkoutStore';
import { useQuery } from '@tanstack/react-query';
import { ipc } from '../../ipc/client';
import { cn } from '@cheeseoclock/ui';
import type { OrderMode } from '@cheeseoclock/shared-types';
import { Armchair, ShoppingBag, Bike } from 'lucide-react';
import { CustomerInlinePanel } from './CustomerInlinePanel';
import { useCustomerForm, resetCustomerForm } from './useCustomerForm';

const MODES: Array<{ id: OrderMode; label: string; icon: typeof Armchair }> = [
  { id: 'dine_in', label: 'Dine-in', icon: Armchair },
  { id: 'takeaway', label: 'Takeaway', icon: ShoppingBag },
  { id: 'delivery', label: 'Delivery', icon: Bike },
];

export function OrderModeBar() {
  const mode = useCheckoutStore((s) => s.mode);
  const tableId = useCheckoutStore((s) => s.tableId);
  const setMode = useCheckoutStore((s) => s.setMode);
  const setTableId = useCheckoutStore((s) => s.setTableId);
  const snapshot = useCheckoutStore((s) => s.snapshot);
  const hasItems = (snapshot?.items.length ?? 0) > 0;
  const { form, setForm } = useCustomerForm();

  const tablesQ = useQuery({
    queryKey: ['tables'],
    queryFn: () => ipc.tables.list(),
    enabled: mode === 'dine_in',
  });

  return (
    <div className="flex flex-col gap-2 border-b border-stone-200 bg-white px-4 py-2 dark:border-stone-800 dark:bg-stone-900">
      <div className="flex items-center gap-3">
        <div className="flex gap-1">
          {MODES.map((m) => {
            const Icon = m.icon;
            return (
              <button
                key={m.id}
                type="button"
                disabled={hasItems}
                onClick={() => {
                  setMode(m.id);
                  if (m.id !== 'dine_in') setTableId(null);
                  // Mode change should clear the inline customer form — otherwise
                  // dine-in's empty fields could leak into a takeaway flow, or
                  // the previous customer could "stick" across orders.
                  resetCustomerForm();
                }}
                className={cn(
                  'flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition-colors',
                  'disabled:cursor-not-allowed disabled:opacity-50',
                  mode === m.id
                    ? 'bg-amber-500 text-stone-900'
                    : 'bg-stone-100 hover:bg-stone-200 dark:bg-stone-800 dark:hover:bg-stone-700',
                )}
                title={hasItems ? 'Clear order before changing mode' : `Switch to ${m.label}`}
              >
                <Icon className="h-4 w-4" />
                {m.label}
              </button>
            );
          })}
        </div>

        {mode === 'dine_in' && (
          <div className="flex items-center gap-2 border-l border-stone-200 pl-3 dark:border-stone-700">
            <span className="text-xs uppercase tracking-wider text-stone-500">Table</span>
            <select
              disabled={hasItems}
              value={tableId ?? ''}
              onChange={(e) => setTableId(e.target.value || null)}
              className="rounded-md border border-stone-300 bg-white px-2 py-1 text-sm disabled:opacity-50 dark:border-stone-700 dark:bg-stone-800"
            >
              <option value="">— None —</option>
              {tablesQ.data?.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>
        )}

        {snapshot?.order.orderNumber && (
          <div className="ml-auto font-mono text-sm text-stone-500">
            Order #{snapshot.order.orderNumber}
          </div>
        )}
      </div>

      {(mode === 'takeaway' || mode === 'delivery') && (
        <CustomerInlinePanel mode={mode} form={form} setForm={setForm} />
      )}
    </div>
  );
}
