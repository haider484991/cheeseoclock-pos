import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Minus, Percent, Plus, RotateCcw, Save, X } from 'lucide-react';
import { cn } from '@cheeseoclock/ui';
import { editChangesNothing, formatCents } from '@cheeseoclock/pos-domain';
import { isDeliveryChargeName, isLeaveOutChoice } from '@cheeseoclock/shared-types';
import { useCheckoutStore } from '../../stores/checkoutStore';
import { useToast } from '../../components/toast/ToastProvider';
import { cartDiscountDetail, FREE_ORDER_LABEL } from './discountWords';
import { isAddedLine } from './editOps';

interface Props {
  /** Save changes: the Save box (what changes, "Was the food made?", the reason, a manager's PIN). */
  onSave: () => void;
  /** Cancel: the order stays as the kitchen has it. */
  onCancel: () => void;
  onDiscount: () => void;
  /** Customize a line added in this change (a line the kitchen has is taken off and added again instead). */
  onCustomize: (orderItemId: string) => void;
}

const MODE_WORDS: Record<string, string> = { takeaway: 'Takeaway', delivery: 'Delivery', dine_in: 'Dine-in', online: 'Online', foodpanda: 'Foodpanda' };

/**
 * The ticket while an order the kitchen has is being changed (Edit order,
 * v0.7.36): the order as Save will leave it, worked out by the till. A line
 * added here says NEW; a line the kitchen has that went up or down says what
 * it was; a line taken off is listed under "Taking off" (the kitchen gets
 * DO NOT MAKE for it). Each change has its own Undo. The customer and the
 * order type stay as they are. Save asks for whatever the change needs.
 */
export function EditOrderTicket({ onSave, onCancel, onDiscount, onCustomize }: Props) {
  const snapshot = useCheckoutStore((s) => s.snapshot);
  const edit = useCheckoutStore((s) => s.edit);
  const lastTouch = useCheckoutStore((s) => s.lastTouch);
  const bumpItemQty = useCheckoutStore((s) => s.bumpItemQty);
  const clearDiscount = useCheckoutStore((s) => s.clearDiscount);
  const undoEditLine = useCheckoutStore((s) => s.undoEditLine);
  const { toast } = useToast();
  const linesRef = useRef<HTMLDivElement>(null);
  const [flashId, setFlashId] = useState<string | null>(null);

  // The line just added or changed flashes and scrolls into view, as at the counter.
  useEffect(() => {
    if (!lastTouch) return;
    setFlashId(lastTouch.lineId);
    linesRef.current?.querySelector<HTMLElement>(`[data-line-id="${lastTouch.lineId}"]`)?.scrollIntoView({ block: 'nearest' });
    const t = window.setTimeout(() => setFlashId(null), 650);
    return () => window.clearTimeout(t);
  }, [lastTouch]);

  if (!snapshot || !edit) return null;
  const { order, items } = snapshot;
  const baseQty = new Map(edit.base.items.map((l) => [l.id as string, l.quantity]));
  const takenOff = edit.base.items.filter((b) => !items.some((i) => i.id === b.id));
  const changed = !editChangesNothing(edit.diff);
  const discount = snapshot.discounts[snapshot.discounts.length - 1] ?? null;
  const free = discount?.freeOrder === true;
  const short = order.orderNumber.split('-').pop() ?? order.orderNumber;
  const who = [MODE_WORDS[order.mode] ?? order.mode, snapshot.customerName, snapshot.customerPhone].filter(Boolean).join(' · ');

  const failed = (title: string) => (e: unknown) =>
    toast({ title, description: e instanceof Error ? e.message : 'Unknown error', variant: 'error' });

  function changeQty(orderItemId: string, delta: number) {
    bumpItemQty(orderItemId, delta).catch(failed('Could not change the quantity'));
  }
  function undo(lineId: string) {
    undoEditLine(lineId).catch(failed('Could not undo that'));
  }

  return (
    <aside id="checkout-order" className="ticket is-editing" aria-label={`Changing order #${short}`}>
      <header className="ticket-head">
        <div className="ticket-id">
          <span className="ticket-number">#{short}</span>
          <span className="ticket-count">Changing an order the kitchen has</span>
          <button type="button" onClick={onCancel} className="ticket-discard" title="Cancel the change (Esc)" aria-label="Cancel the change">
            <X className="h-4 w-4" />
          </button>
        </div>
        {who && <p className="ticket-edit-who">{who}</p>}
        {order.source === 'web' && <p className="ticket-edit-who">The customer’s website page keeps showing the first items: tell them the new total.</p>}
      </header>

      <div ref={linesRef} className="ticket-lines">
        <ul>
          {items.map((item) => {
            const added = isAddedLine(edit.ops, item.id) || !baseQty.has(item.id);
            const was = baseQty.get(item.id);
            const qtyChanged = !added && was !== undefined && was !== item.quantity;
            const fee = isDeliveryChargeName(item.menuItemName);
            return (
              <li
                key={item.id}
                data-line-id={item.id}
                className={cn('ticket-line rounded-lg transition-colors', flashId === item.id ? 'bg-amber-100 duration-75 dark:bg-amber-900/40' : 'duration-500')}
              >
                <div className="ticket-qty" role="group" aria-label={`Quantity of ${item.menuItemName}`}>
                  <button
                    type="button"
                    onClick={() => changeQty(item.id, -1)}
                    aria-label={item.quantity === 1 ? `Take ${item.menuItemName} off` : 'One less'}
                    title={item.quantity === 1 ? 'Take it off' : 'One less (−)'}
                  >
                    {item.quantity === 1 ? <X className="h-4 w-4" /> : <Minus className="h-4 w-4" />}
                  </button>
                  <span aria-live="polite">{item.quantity}</span>
                  <button type="button" onClick={() => changeQty(item.id, 1)} aria-label="One more" title="One more (+)">
                    <Plus className="h-4 w-4" />
                  </button>
                </div>
                <div className="ticket-line-body">
                  <div className="ticket-line-name">
                    {item.menuItemName}
                    {added && <span className="ticket-edit-badge is-new">NEW</span>}
                    {qtyChanged && <span className="ticket-edit-badge">was {was}</span>}
                  </div>
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
                  <div className="flex flex-wrap gap-x-3">
                    {added && !fee && (
                      <button type="button" className="ticket-link ticket-customize" onClick={() => onCustomize(item.id)}>
                        + Extras · dips · allergy
                      </button>
                    )}
                    {qtyChanged && (
                      <button type="button" className="ticket-link" onClick={() => undo(item.id)}>
                        <RotateCcw className="h-3 w-3" aria-hidden="true" />
                        Undo
                      </button>
                    )}
                  </div>
                </div>
                <div className="ticket-line-price">{formatCents(item.lineTotalCents, { showSymbol: false })}</div>
              </li>
            );
          })}
        </ul>
        {takenOff.length > 0 && (
          <section className="ticket-taking-off" aria-label="Taking off">
            <h3>Taking off · the kitchen gets DO NOT MAKE</h3>
            <ul>
              {takenOff.map((l) => (
                <li key={l.id}>
                  <span>
                    {l.quantity} × {l.menuItemName}
                  </span>
                  <button type="button" className="ticket-link" onClick={() => undo(l.id)}>
                    <RotateCcw className="h-3 w-3" aria-hidden="true" />
                    Undo
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>

      <footer className="ticket-foot">
        <dl className="ticket-totals">
          <div>
            <dt>Subtotal</dt>
            <dd>{formatCents(order.subtotalCents, { showSymbol: false })}</dd>
          </div>
          {discount && (order.discountCents > 0 || free) ? (
            <div className="is-discount">
              <dt>
                <button type="button" className="ticket-link" style={{ color: 'inherit' }} onClick={onDiscount} title="Change the discount (F3)">
                  <Percent className="h-3 w-3" aria-hidden="true" />
                  {free ? FREE_ORDER_LABEL : 'Discount'}
                  <span className="font-normal">{cartDiscountDetail(discount, items)}</span>
                </button>
                <button
                  type="button"
                  onClick={() => clearDiscount().catch(failed('Could not take the discount off'))}
                  aria-label="Take the discount off"
                  title="Take the discount off"
                >
                  <X className="h-3 w-3" />
                </button>
              </dt>
              <dd>−{formatCents(order.discountCents, { showSymbol: false })}</dd>
            </div>
          ) : (
            <div>
              <dt>
                <button type="button" className="ticket-link" onClick={onDiscount} title="Add a discount (F3)">
                  <Percent className="h-3 w-3" aria-hidden="true" />
                  Add discount
                </button>
              </dt>
              <dd />
            </div>
          )}
          <div>
            <dt>Tax</dt>
            <dd>{formatCents(order.taxCents, { showSymbol: false })}</dd>
          </div>
          <div className="is-total">
            <dt>Total</dt>
            <dd>{formatCents(order.totalCents)}</dd>
          </div>
        </dl>
        {changed && edit.diff.totalBeforeCents !== order.totalCents && (
          <p className="ticket-next">Was {formatCents(edit.diff.totalBeforeCents)} before this change</p>
        )}
        {edit.needs.pin && (
          <div className="ticket-gate" role="status">
            <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{edit.needs.why.join('. ')} — Save asks for a manager’s PIN or password.</span>
          </div>
        )}
        <div className="ticket-actions">
          <button type="button" className="ticket-primary" disabled={!changed} onClick={onSave} title="Save the change (Enter)">
            <Save className="h-5 w-5" aria-hidden="true" />
            Save changes
          </button>
          <button type="button" className="ticket-secondary" onClick={onCancel} title="Leave the order as the kitchen has it (Esc)">
            Cancel
          </button>
        </div>
        {!changed && <p className="ticket-next">Add items from the menu, or change a line. Nothing is saved until Save.</p>}
        <div className="ticket-keys" aria-hidden="true">
          <span>
            <kbd>Enter</kbd> Save
          </span>
          <span>
            <kbd>Esc</kbd> Cancel
          </span>
          <span>
            <kbd>+</kbd>
            <kbd>−</kbd> Qty
          </span>
          <span>
            <kbd>F3</kbd> Discount
          </span>
        </div>
      </footer>
    </aside>
  );
}
