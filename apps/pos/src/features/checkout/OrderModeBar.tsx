import { useCheckoutStore } from '../../stores/checkoutStore';
import { cn } from '@cheeseoclock/ui';
import type { OrderMode } from '@cheeseoclock/shared-types';
import { ShoppingBag, Bike, Smartphone } from 'lucide-react';
import { CustomerInlinePanel } from './CustomerInlinePanel';
import { useCustomerForm, resetCustomerForm } from './useCustomerForm';
import { useToast } from '../../components/toast/ToastProvider';

const MODES: Array<{ id: OrderMode; label: string; icon: typeof ShoppingBag }> = [
  { id: 'takeaway', label: 'Takeaway', icon: ShoppingBag },
  { id: 'delivery', label: 'Delivery', icon: Bike },
  { id: 'foodpanda', label: 'Foodpanda', icon: Smartphone },
];

export function OrderModeBar() {
  const { toast } = useToast();
  const mode = useCheckoutStore((s) => s.mode);
  const setMode = useCheckoutStore((s) => s.setMode);
  const snapshot = useCheckoutStore((s) => s.snapshot);
  const busy = useCheckoutStore((s) => s.busy);
  const { form, setForm } = useCustomerForm();

  async function switchMode(next: OrderMode) {
    if (next === mode) return;
    try {
      // Persists to the open order too, so the kitchen ticket, the Live Orders
      // board and the reports match what's on screen.
      await setMode(next);
      resetCustomerForm();
    } catch (e) {
      toast({
        title: 'Could not change mode',
        description: e instanceof Error ? e.message : 'Unknown error',
        variant: 'error',
      });
    }
  }

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
                disabled={busy}
                onClick={() => void switchMode(m.id)}
                className={cn(
                  'flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition-colors',
                  'disabled:cursor-not-allowed disabled:opacity-50',
                  mode === m.id
                    ? 'bg-amber-500 text-stone-900'
                    : 'bg-stone-100 hover:bg-stone-200 dark:bg-stone-800 dark:hover:bg-stone-700',
                )}
                title={`Switch to ${m.label}`}
              >
                <Icon className="h-4 w-4" />
                {m.label}
              </button>
            );
          })}
        </div>

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
