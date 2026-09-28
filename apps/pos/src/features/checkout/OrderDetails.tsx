import { cn } from '@cheeseoclock/ui';
import { CAME_BY_CHOICES, CAME_BY_LABEL, type CameBy, type OrderMode } from '@cheeseoclock/shared-types';
import { cameByChipsShown } from '@cheeseoclock/pos-domain';
import { ShoppingBag, Bike, Smartphone, Footprints, Phone, MessageCircle } from 'lucide-react';
import { useCheckoutStore } from '../../stores/checkoutStore';
import { useToast } from '../../components/toast/ToastProvider';
import { resetCustomerForm } from './useCustomerForm';
import { NoShiftBanner } from '../shell/NoShiftBanner';
import { useCheckoutRules } from '../settings/shop-rules/useShopSetting';

const MODES: Array<{ id: OrderMode; label: string; icon: typeof ShoppingBag }> = [
  { id: 'takeaway', label: 'Takeaway', icon: ShoppingBag },
  { id: 'delivery', label: 'Delivery', icon: Bike },
  { id: 'foodpanda', label: 'Foodpanda', icon: Smartphone },
];

const CAME_BY_ICON: Record<CameBy, typeof ShoppingBag> = { walk_in: Footprints, phone: Phone, whatsapp: MessageCircle };

/**
 * Order type stays beside the menu; customer entry follows item confirmation.
 * The switch is never greyed out: it takes effect on screen at once and is
 * saved to the order in turn with the item taps (checkoutStore's queue).
 *
 * Under it, on a takeaway or delivery, the came-by chips (Walk-in · Phone ·
 * WhatsApp) when the owner asks how each order came in, or when one of his
 * automatic offers needs to know (Settings → Money & discounts). The till
 * puts the offer on by itself; the chip locks when the order is sent.
 */
export function OrderDetails() {
  const mode = useCheckoutStore((s) => s.mode);
  const setMode = useCheckoutStore((s) => s.setMode);
  const cameBy = useCheckoutStore((s) => s.cameBy);
  const setCameBy = useCheckoutStore((s) => s.setCameBy);
  const startedAt = useCheckoutStore((s) => s.snapshot?.order.createdAt ?? null);
  const rules = useCheckoutRules();
  const { toast } = useToast();
  const offers = rules.data?.offers ?? null;
  // An order is judged by when it was started; before the first item, by now.
  const showChips = cameByChipsShown(offers, mode, startedAt ?? new Date().toISOString());

  async function switchMode(next: OrderMode) {
    if (next === mode) return;
    try {
      await setMode(next);
      resetCustomerForm();
    } catch (e) {
      toast({ title: 'Could not change order type', description: e instanceof Error ? e.message : 'Unknown error', variant: 'error' });
    }
  }

  async function tapCameBy(next: CameBy) {
    try {
      // Tapping the lit chip again: not said.
      await setCameBy(cameBy === next ? null : next);
    } catch (e) {
      toast({ title: 'Could not save how the order came in', description: e instanceof Error ? e.message : 'Unknown error', variant: 'error' });
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
            <button key={id} type="button" aria-pressed={mode === id} onClick={() => void switchMode(id)} className={cn('ticket-mode', mode === id && 'is-active')}>
              <Icon className="h-4 w-4" aria-hidden="true" />{label}
            </button>
          ))}
        </div>
      </div>
      {showChips && (
        <div className="order-details-heading mt-2">
          <div>
            <h2 className="text-xs font-semibold text-stone-500">
              How did it come in?{offers?.askCameBy ? '' : ' (for the owner’s offers)'}
            </h2>
          </div>
          <div className="ticket-modes" role="group" aria-label="How the order came in">
            {CAME_BY_CHOICES.map((id) => {
              const Icon = CAME_BY_ICON[id];
              return (
                <button
                  key={id}
                  type="button"
                  aria-pressed={cameBy === id}
                  onClick={() => void tapCameBy(id)}
                  className={cn('ticket-mode', cameBy === id && 'is-active')}
                >
                  <Icon className="h-4 w-4" aria-hidden="true" />
                  {CAME_BY_LABEL[id]}
                </button>
              );
            })}
          </div>
        </div>
      )}
      {/* Orders still go to the kitchen with no shift open; the money waits for one. */}
      <NoShiftBanner className="mt-2" />
    </section>
  );
}
