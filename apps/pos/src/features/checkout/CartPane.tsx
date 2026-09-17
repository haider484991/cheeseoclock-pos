import { useCheckoutStore } from '../../stores/checkoutStore';
import { formatCents } from '@cheeseoclock/pos-domain';
import {
  Minus,
  Plus,
  X,
  Percent,
  ChefHat,
  Banknote,
  AlertTriangle,
} from 'lucide-react';
import { useTenderGate } from './useTenderGate';
import { useToast } from '../../components/toast/ToastProvider';
import { resetCustomerForm } from './useCustomerForm';

interface Props {
  onPay: () => void;
  onDiscount: () => void;
  onSendToKitchen: () => void;
}

/** "Delivery needs a customer phone" → "customer phone"; the row already says "Still needed". */
function shortMissing(missing: string[]): string {
  return missing
    .map((m) => m.replace(/^\w[\w-]* needs (a |an |the )?/i, '').replace(/^delivery /i, ''))
    .join(', ');
}

/** The ticket contains items, totals and checkout actions. */
export function CartPane({ onPay, onDiscount, onSendToKitchen }: Props) {
  const snapshot = useCheckoutStore((s) => s.snapshot);
  const busy = useCheckoutStore((s) => s.busy);
  const mode = useCheckoutStore((s) => s.mode);
  const updateItemQty = useCheckoutStore((s) => s.updateItemQty);
  const clearDiscount = useCheckoutStore((s) => s.clearDiscount);
  const discardDraft = useCheckoutStore((s) => s.discardDraft);
  const gate = useTenderGate();
  const { toast } = useToast();

  const items = snapshot?.items ?? [];
  const order = snapshot?.order;
  const totalCents = order?.totalCents ?? 0;
  const subtotalCents = order?.subtotalCents ?? 0;
  const discountCents = order?.discountCents ?? 0;
  const taxCents = order?.taxCents ?? 0;
  const itemCount = items.reduce((n, i) => n + i.quantity, 0);
  const shortNumber = order?.orderNumber.split('-').pop() ?? null;

  // Cash on delivery / pay at pickup is the norm here, so "Send to kitchen"
  // leads for takeaway and delivery. Foodpanda is settled by the platform:
  // the till records it as paid and sends it in one step.
  const needsCustomer = mode === 'takeaway' || mode === 'delivery';
  const sendFirst = needsCustomer;

  async function handleDiscard() {
    if (!order) return;
    const lines = items.length > 0 ? ` Its ${items.length} item${items.length === 1 ? '' : 's'} will be dropped.` : '';
    if (!confirm(`Discard order #${order.orderNumber}?${lines} Nothing has been sent to the kitchen or charged.`)) return;
    try {
      await discardDraft();
      resetCustomerForm();
    } catch (e) {
      toast({
        title: 'Could not discard order',
        description: e instanceof Error ? e.message : 'Unknown error',
        variant: 'error',
      });
    }
  }

  const canAct = items.length > 0 && !busy && gate.ok;

  return (
    <aside id="checkout-order" className="ticket" aria-label="Current order">
      <header className="ticket-head">
        <div className="ticket-id">
          <span className="ticket-number">{shortNumber ? `#${shortNumber}` : 'New order'}</span>
          <span className="ticket-count">
            {itemCount === 0 ? 'nothing yet' : `${itemCount} item${itemCount === 1 ? '' : 's'}`}
          </span>
          {order?.status === 'open' && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void handleDiscard()}
              className="ticket-discard"
              title="Discard this order"
              aria-label="Discard this order"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      </header>

      <div className="ticket-lines">
        {items.length === 0 ? (
          <div className="ticket-empty">
            <p>Tap a menu item to start the order.</p>
          </div>
        ) : (
          <ul>
            {items.map((item) => (
              <li key={item.id} className="ticket-line">
                <div className="ticket-qty" role="group" aria-label={`Quantity of ${item.menuItemName}`}>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void updateItemQty(item.id, item.quantity - 1)}
                    aria-label={item.quantity === 1 ? `Remove ${item.menuItemName}` : 'One less'}
                    title={item.quantity === 1 ? 'Remove' : 'One less'}
                  >
                    {item.quantity === 1 ? <X className="h-4 w-4" /> : <Minus className="h-4 w-4" />}
                  </button>
                  <span aria-live="polite">{item.quantity}</span>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void updateItemQty(item.id, item.quantity + 1)}
                    aria-label="One more"
                    title="One more"
                  >
                    <Plus className="h-4 w-4" />
                  </button>
                </div>
                <div className="ticket-line-body">
                  <div className="ticket-line-name">{item.menuItemName}</div>
                  {item.modifiers.length > 0 && (
                    <div className="ticket-line-mods">
                      {item.modifiers.map((m) => (
                        <span key={m.id}>
                          {m.modifierName}
                          {m.priceDeltaCents !== 0 && ` ${formatCents(m.priceDeltaCents, { showSymbol: false })}`}
                        </span>
                      ))}
                    </div>
                  )}
                  {item.notes && <div className="ticket-line-note">{item.notes}</div>}
                </div>
                <div className="ticket-line-price">{formatCents(item.lineTotalCents, { showSymbol: false })}</div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <footer className="ticket-foot">
        <dl className="ticket-totals">
          <div>
            <dt>Subtotal</dt>
            <dd>{formatCents(subtotalCents, { showSymbol: false })}</dd>
          </div>
          {discountCents > 0 ? (
            <div className="is-discount">
              <dt>
                Discount
                <button type="button" onClick={() => void clearDiscount()} aria-label="Remove discount" title="Remove discount">
                  <X className="h-3 w-3" />
                </button>
              </dt>
              <dd>−{formatCents(discountCents, { showSymbol: false })}</dd>
            </div>
          ) : (
            <div>
              <dt>
                <button
                  type="button"
                  className="ticket-link"
                  disabled={items.length === 0 || busy}
                  onClick={onDiscount}
                  title="Apply a discount (F3)"
                >
                  <Percent className="h-3 w-3" aria-hidden="true" />
                  Add discount
                </button>
              </dt>
              <dd />
            </div>
          )}
          <div>
            <dt>Tax</dt>
            <dd>{formatCents(taxCents, { showSymbol: false })}</dd>
          </div>
          <div className="is-total">
            <dt>Total</dt>
            <dd>{formatCents(totalCents)}</dd>
          </div>
        </dl>

        {items.length > 0 && !gate.ok && (
          <div className="ticket-gate" role="status">
            <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>Still needed: {shortMissing(gate.missing)}</span>
          </div>
        )}

        <div className="ticket-actions">
          {sendFirst ? (
            <>
              <button
                type="button"
                className="ticket-primary"
                disabled={!canAct}
                onClick={onSendToKitchen}
                title="Send to kitchen (F2)"
              >
                <ChefHat className="h-5 w-5" aria-hidden="true" />
                Send to kitchen
              </button>
              <button
                type="button"
                className="ticket-secondary"
                disabled={!canAct}
                onClick={onPay}
                title="Take payment now (F1)"
              >
                <Banknote className="h-5 w-5" aria-hidden="true" />
                Pay now
              </button>
            </>
          ) : (
            <button type="button" className="ticket-primary" disabled={!canAct} onClick={onPay} title="Take payment (F1)">
              <Banknote className="h-5 w-5" aria-hidden="true" />
              Pay &amp; send to kitchen
            </button>
          )}
        </div>
        <div className="ticket-keys" aria-hidden="true">
          <span><kbd>F2</kbd> Send</span>
          <span><kbd>F1</kbd> Pay</span>
          <span><kbd>F3</kbd> Discount</span>
        </div>
      </footer>
    </aside>
  );
}
