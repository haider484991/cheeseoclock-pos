import { cn } from '@cheeseoclock/ui';
import type { OrderMode } from '@cheeseoclock/shared-types';
import { ShoppingBag, Bike, Smartphone } from 'lucide-react';
import { useCheckoutStore } from '../../stores/checkoutStore';
import { useToast } from '../../components/toast/ToastProvider';
import { resetCustomerForm } from './useCustomerForm';

const MODES: Array<{ id: OrderMode; label: string; icon: typeof ShoppingBag }> = [
  { id: 'takeaway', label: 'Takeaway', icon: ShoppingBag },
  { id: 'delivery', label: 'Delivery', icon: Bike },
  { id: 'foodpanda', label: 'Foodpanda', icon: Smartphone },
];

/** Order type stays beside the menu; customer entry follows item confirmation. */
export function OrderDetails() {
  const mode = useCheckoutStore((s) => s.mode);
  const setMode = useCheckoutStore((s) => s.setMode);
  const busy = useCheckoutStore((s) => s.busy);
  const { toast } = useToast();

  async function switchMode(next: OrderMode) {
    if (next === mode) return;
    try {
      await setMode(next);
      resetCustomerForm();
    } catch (e) {
      toast({ title: 'Could not change order type', description: e instanceof Error ? e.message : 'Unknown error', variant: 'error' });
    }
  }

  return (
    <section className="order-details" aria-labelledby="order-details-title">
      <div className="order-details-heading">
        <div>
          <h1 id="order-details-title">Choose items</h1>
        </div>
        <div className="ticket-modes" role="group" aria-label="Order type">
          {MODES.map(({ id, label, icon: Icon }) => (
            <button key={id} type="button" disabled={busy} aria-pressed={mode === id} onClick={() => void switchMode(id)} className={cn('ticket-mode', mode === id && 'is-active')}>
              <Icon className="h-4 w-4" aria-hidden="true" />{label}
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}
