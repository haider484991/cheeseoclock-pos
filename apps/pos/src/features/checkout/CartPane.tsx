import { useEffect, useRef, useState } from 'react';
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
  ArrowRight,
  ArrowLeft,
} from 'lucide-react';
import { cn } from '@cheeseoclock/ui';
import { useTenderGate } from './useTenderGate';
import { useToast } from '../../components/toast/ToastProvider';
import { resetCustomerForm, useCustomerForm } from './useCustomerForm';
import { CustomerInlinePanel } from './CustomerInlinePanel';
import { askConfirm } from '../../components/confirm/ConfirmHost';
import { isDeliveryChargeName, isLeaveOutChoice } from '@cheeseoclock/shared-types';

interface Props {
  step: 'items' | 'details';
  onContinue: () => void;
  onBack: () => void;
  onPay: () => void;
  onDiscount: () => void;
  onSendToKitchen: () => void;
  /** Open the line's choices + allergy / special-request note. */
  onCustomize: (orderItemId: string) => void;
}

/** "Delivery needs a customer phone" → "customer phone"; the row already says "Still needed". */
function shortMissing(missing: string[]): string {
  return missing
    .map((m) => m.replace(/^\w[\w-]* needs (a |an |the )?/i, '').replace(/^delivery /i, ''))
    .join(', ');
}

/** The ticket contains items, totals and checkout actions. */
export function CartPane({ step, onContinue, onBack, onPay, onDiscount, onSendToKitchen, onCustomize }: Props) {
  const snapshot = useCheckoutStore((s) => s.snapshot);
  const busy = useCheckoutStore((s) => s.busy);
  const mode = useCheckoutStore((s) => s.mode);
  const lastTouch = useCheckoutStore((s) => s.lastTouch);
  const bumpItemQty = useCheckoutStore((s) => s.bumpItemQty);
  const clearDiscount = useCheckoutStore((s) => s.clearDiscount);
  const discardDraft = useCheckoutStore((s) => s.discardDraft);
  const gate = useTenderGate();
  const { toast } = useToast();
  const { form, setForm } = useCustomerForm();
  const detailsHeading = useRef<HTMLHeadingElement>(null);
  const linesRef = useRef<HTMLDivElement>(null);
  const [flashId, setFlashId] = useState<string | null>(null);

  const items = snapshot?.items ?? [];
  const order = snapshot?.order;
  const totalCents = order?.totalCents ?? 0;
  const subtotalCents = order?.subtotalCents ?? 0;
  const discountCents = order?.discountCents ?? 0;
  const taxCents = order?.taxCents ?? 0;
  const itemCount = items.reduce((n, i) => n + i.quantity, 0);
  const shortNumber = order?.orderNumber.split('-').pop() ?? null;
  const discount = snapshot?.discounts[snapshot.discounts.length - 1] ?? null;

  // Cash on delivery / pay at pickup is the norm here, so "Send to kitchen"
  // leads for takeaway and delivery. Foodpanda is settled by the platform:
  // the till records it as paid and sends it in one step.
  const needsCustomer = mode === 'takeaway' || mode === 'delivery';
  const sendFirst = needsCustomer;
  const showDetails = needsCustomer && step === 'details';

  useEffect(() => {
    if (showDetails) {
      detailsHeading.current?.focus({ preventScroll: true });
      detailsHeading.current?.scrollIntoView({ block: 'nearest' });
    }
  }, [showDetails]);

  // The line just added or changed flashes and scrolls into view, so a tap on
  // the menu is answered on the ticket straight away — no pop-up needed.
  useEffect(() => {
    if (!lastTouch) return;
    setFlashId(lastTouch.lineId);
    const row = linesRef.current?.querySelector<HTMLElement>(`[data-line-id="${lastTouch.lineId}"]`);
    row?.scrollIntoView({ block: 'nearest' });
    const t = window.setTimeout(() => setFlashId(null), 650);
    return () => window.clearTimeout(t);
  }, [lastTouch]);

  async function handleDiscard() {
    if (!order) return;
    const lines = items.length > 0 ? ` Its ${items.length} item${items.length === 1 ? '' : 's'} will be dropped.` : '';
    if (!(await askConfirm(`Discard order #${order.orderNumber}?${lines} Nothing has been sent to the kitchen or charged.`))) return;
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

  function changeQty(orderItemId: string, delta: number) {
    bumpItemQty(orderItemId, delta).catch((e: unknown) => {
      toast({
        title: 'Could not change the quantity',
        description: e instanceof Error ? e.message : 'Unknown error',
        variant: 'error',
      });
    });
  }

  function removeDiscount() {
    clearDiscount().catch((e: unknown) => {
      toast({
        title: 'Could not remove the discount',
        description: e instanceof Error ? e.message : 'Unknown error',
        variant: 'error',
      });
    });
  }

  // Not greyed out while the till saves the last tap (that made the big
  // button flicker on every item): Send and Pay queue behind the save.
  const canAct = items.length > 0 && gate.ok;

  return (
    <aside id="checkout-order" className={`ticket${showDetails ? ' is-details' : ''}`} aria-label="Current order">
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
        {needsCustomer && (
          <ol className="ticket-steps" aria-label="Order progress">
            <li aria-current={!showDetails ? 'step' : undefined}>1 · Review order</li>
            <li aria-current={showDetails ? 'step' : undefined}>2 · {mode === 'delivery' ? 'Delivery details' : 'Customer details'}</li>
          </ol>
        )}
      </header>

      <div ref={linesRef} className={showDetails ? 'ticket-details' : 'ticket-lines'}>
        {showDetails ? (
          <section aria-labelledby="ticket-details-title">
            <div className="ticket-step-heading">
              <h2 id="ticket-details-title" ref={detailsHeading} tabIndex={-1}>{mode === 'delivery' ? 'Delivery details' : 'Customer details'}</h2>
              <button type="button" className="ticket-link" onClick={onBack} disabled={busy}><ArrowLeft className="h-3 w-3" />Edit order</button>
            </div>
            <CustomerInlinePanel mode={mode} form={form} setForm={setForm} />
          </section>
        ) : items.length === 0 ? (
          <div className="ticket-empty">
            <p>Tap a menu item to start the order.</p>
          </div>
        ) : (
          <ul>
            {items.map((item) => (
              <li
                key={item.id}
                data-line-id={item.id}
                className={cn(
                  'ticket-line rounded-lg transition-colors',
                  flashId === item.id ? 'bg-amber-100 duration-75 dark:bg-amber-900/40' : 'duration-500',
                )}
              >
                {/* Quantity taps queue up in order, so they are never greyed
                    out while the till is still saving the last one. */}
                <div className="ticket-qty" role="group" aria-label={`Quantity of ${item.menuItemName}`}>
                  <button
                    type="button"
                    onClick={() => changeQty(item.id, -1)}
                    aria-label={item.quantity === 1 ? `Remove ${item.menuItemName}` : 'One less'}
                    title={item.quantity === 1 ? 'Remove' : 'One less (−)'}
                  >
                    {item.quantity === 1 ? <X className="h-4 w-4" /> : <Minus className="h-4 w-4" />}
                  </button>
                  <span aria-live="polite">{item.quantity}</span>
                  <button
                    type="button"
                    onClick={() => changeQty(item.id, 1)}
                    aria-label="One more"
                    title="One more (+)"
                  >
                    <Plus className="h-4 w-4" />
                  </button>
                </div>
                <div className="ticket-line-body">
                  <div className="ticket-line-name">{item.menuItemName}</div>
                  {item.modifiers.length > 0 && (
                    <div className="ticket-line-mods">
                      {item.modifiers.map((m) => (
                        <span key={m.id} className={isLeaveOutChoice(m.modifierName) ? 'is-leave-out' : undefined}>
                          {m.modifierName}
                          {m.priceDeltaCents !== 0 && ` ${formatCents(m.priceDeltaCents, { showSymbol: false })}`}
                        </span>
                      ))}
                    </div>
                  )}
                  {item.notes && <div className="ticket-line-note">Note: {item.notes}</div>}
                  {/* The delivery charge is a fee, not food: nothing to customize. */}
                  {!isDeliveryChargeName(item.menuItemName) && (
                    <button
                      type="button"
                      className="ticket-link ticket-customize"
                      onClick={() => onCustomize(item.id)}
                    >
                      {/* Owner 2026-09-26: "I don't see the dip options if a customer wants extra" — name what is behind it. */}
                      + Extras · dips · allergy
                    </button>
                  )}
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
                <button
                  type="button"
                  className="ticket-link"
                  style={{ color: 'inherit' }}
                  onClick={onDiscount}
                  title="Change the discount (F3)"
                >
                  <Percent className="h-3 w-3" aria-hidden="true" />
                  Discount
                  {discount && (
                    <span className="font-normal">
                      {' · '}
                      {discount.discountType === 'percent' ? `${discount.value}%` : formatCents(discount.value)}
                      {discount.reason ? ` · ${discount.reason}` : ''}
                    </span>
                  )}
                </button>
                <button type="button" onClick={removeDiscount} aria-label="Remove discount" title="Remove discount">
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
                  disabled={items.length === 0}
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

        {items.length > 0 && !gate.ok && (!needsCustomer || showDetails) && (
          <div className="ticket-gate" role="status">
            <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>Still needed: {shortMissing(gate.missing)}</span>
          </div>
        )}

        <div className="ticket-actions">
          {needsCustomer && !showDetails ? (
            <button type="button" className="ticket-primary" disabled={items.length === 0} onClick={onContinue} title="Continue to customer details (Enter or F2)">
              Confirm order <ArrowRight className="h-5 w-5" aria-hidden="true" />
            </button>
          ) : sendFirst ? (
            <>
              <button
                type="button"
                className="ticket-primary"
                disabled={!canAct}
                onClick={onSendToKitchen}
                title="Send to kitchen (Enter or F2)"
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
            <button type="button" className="ticket-primary" disabled={!canAct} onClick={onPay} title="Take payment (Enter or F1)">
              <Banknote className="h-5 w-5" aria-hidden="true" />
              Pay &amp; send to kitchen
            </button>
          )}
        </div>
        {needsCustomer && !showDetails && <p className="ticket-next">Next: {mode === 'delivery' ? 'customer & delivery details' : 'customer details'}</p>}
        <div className="ticket-keys" aria-hidden="true">
          <span><kbd>Enter</kbd> {needsCustomer && !showDetails ? 'Continue' : sendFirst ? 'Send' : 'Pay'}</span>
          {showDetails && <span><kbd>F1</kbd> Pay</span>}
          <span><kbd>+</kbd><kbd>−</kbd> Qty</span>
          <span><kbd>F3</kbd> Discount</span>
        </div>
      </footer>
    </aside>
  );
}
