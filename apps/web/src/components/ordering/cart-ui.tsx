'use client';

import { useEffect, useState } from 'react';
import type { WebFulfilment } from '@cheeseoclock/shared-types';
import { lineChoices, lineUnitPriceCents, type CartLine } from '@/lib/cart';
import type { DeliveryZone } from '@/lib/delivery-zones';
import { formatCents } from '@/lib/format';
import { isPickupOnly } from '@/lib/menu-view';

export interface CartProps {
  cart: CartLine[];
  subtotal: number;
  deliveryFee: number;
  /** Pickup discount (0 on a delivery). */
  discount: number;
  zone: DeliveryZone | undefined;
  tax: number;
  total: number;
  setQty: (key: string, qty: number) => void;
  onClear: () => void;
  fulfilment: WebFulfilment;
  /** The till takes pickup orders right now. */
  canPickup: boolean;
  /** The pickup discount that till bills. */
  pickupPct: number;
  onFulfilment: (f: WebFulfilment) => void;
  /** Labels of pick-up-only lines in the cart (they block a delivery). */
  pickupOnlyInCart: string[];
  /** "Rs 200–250", from the delivery zones. */
  feeRange: string;
}

/**
 * Delivery or pick-up. Pick-up shows the saving up front — it is the printed
 * menu's headline offer. Hidden entirely while the till can't take pickups.
 */
export function FulfilmentToggle(
  props: Pick<CartProps, 'fulfilment' | 'canPickup' | 'pickupPct' | 'onFulfilment' | 'feeRange'>,
) {
  if (!props.canPickup) return null;
  const opt = (f: WebFulfilment, title: string, note: string) => {
    const on = props.fulfilment === f;
    return (
      <button
        type="button"
        onClick={() => props.onFulfilment(f)}
        aria-pressed={on}
        className={`min-h-[3.25rem] rounded-2xl border-2 px-3 py-2 text-left transition-colors ${
          on ? 'border-ink bg-ink text-cheese' : 'border-paper-line bg-white text-ink hover:border-ink/40'
        }`}
      >
        <span className="block font-cond text-base font-extrabold uppercase leading-tight">{title}</span>
        <span className={`block font-cond text-xs font-bold uppercase ${on ? 'text-cream/80' : 'text-ink-muted'}`}>
          {note}
        </span>
      </button>
    );
  };
  return (
    <div className="grid grid-cols-2 gap-2" role="group" aria-label="Delivery or pick-up">
      {opt('delivery', 'Delivery', `${props.feeRange} · DHA & Clifton`)}
      {opt('pickup', `Pick up · ${props.pickupPct}% off`, 'Collect from DHA Phase 6')}
    </div>
  );
}

/** "Clear order" that asks once, inline — never a browser confirm(). */
export function ClearCartButton({ count, onClear }: { count: number; onClear: () => void }) {
  const [asking, setAsking] = useState(false);
  useEffect(() => {
    if (!asking) return;
    const t = setTimeout(() => setAsking(false), 5000);
    return () => clearTimeout(t);
  }, [asking]);
  if (count === 0) return null;
  if (!asking) {
    return (
      <button
        type="button"
        onClick={() => setAsking(true)}
        className="rounded-full px-3 py-2 font-cond text-sm font-bold uppercase tracking-wide text-ink-muted underline decoration-ink/20 underline-offset-4 hover:text-red-700"
      >
        Clear order
      </button>
    );
  }
  return (
    <span className="flex items-center gap-1.5" role="group" aria-label="Clear the whole order?">
      <button
        type="button"
        onClick={() => {
          setAsking(false);
          onClear();
        }}
        className="rounded-full bg-red-700 px-3 py-2 font-cond text-sm font-bold uppercase tracking-wide text-white"
      >
        Remove all {count}
      </button>
      <button
        type="button"
        onClick={() => setAsking(false)}
        className="rounded-full border border-ink/20 px-3 py-2 font-cond text-sm font-bold uppercase tracking-wide text-ink"
      >
        Keep
      </button>
    </span>
  );
}

export function CartPanel(props: CartProps & { acceptingOrders: boolean; onCheckout: () => void }) {
  const { cart } = props;
  const count = cart.reduce((s, l) => s + l.quantity, 0);
  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <h2 className="font-display text-3xl uppercase tracking-wide text-ink">Your order</h2>
        <ClearCartButton count={count} onClear={props.onClear} />
      </div>
      {cart.length === 0 ? (
        <div className="mt-4 rounded-2xl border-2 border-dashed border-paper-line px-4 py-8 text-center">
          <p className="font-cond text-lg font-bold uppercase text-ink">Nothing here yet</p>
          <p className="mt-1 text-sm text-ink-muted">Tap a price to add it.</p>
        </div>
      ) : (
        <>
          <ul className="mt-3 max-h-[40vh] space-y-2 overflow-y-auto pr-1">
            {cart.map((l) => (
              <CartLineRow
                key={l.key}
                line={l}
                setQty={props.setQty}
                blocked={props.fulfilment === 'delivery' && isPickupOnly(l.item)}
              />
            ))}
          </ul>
          {props.canPickup && (
            <div className="mt-3">
              <FulfilmentToggle {...props} />
            </div>
          )}
          <Totals {...props} />
          <button
            type="button"
            onClick={props.onCheckout}
            className="mt-4 w-full rounded-full bg-ink py-3.5 font-cond text-lg font-bold uppercase tracking-wide text-cheese transition-all hover:bg-ink-soft active:scale-[0.99]"
          >
            {props.acceptingOrders ? `Checkout · ${formatCents(props.total)}` : 'Closed online · order on WhatsApp'}
          </button>
        </>
      )}
    </div>
  );
}

export function CartLineRow({
  line,
  setQty,
  blocked = false,
}: {
  line: CartLine;
  setQty: (key: string, qty: number) => void;
  /** A pick-up-only line in a delivery order. */
  blocked?: boolean;
}) {
  const { leaveOuts, others } = lineChoices(line);
  return (
    <li className={`flex items-start gap-2 rounded-2xl p-3 ${blocked ? 'bg-red-50 ring-2 ring-red-600/40' : 'bg-paper'}`}>
      <div className="min-w-0 flex-1">
        <div className="font-cond text-base font-bold uppercase leading-tight text-ink">{line.label}</div>
        {leaveOuts.length > 0 && (
          <div className="mt-0.5 text-xs font-bold leading-snug text-red-700">{leaveOuts.join(' · ')}</div>
        )}
        {others.length > 0 && <div className="mt-0.5 text-xs leading-snug text-ink-muted">{others.join(' · ')}</div>}
        {line.notes && (
          <div className="mt-0.5 break-words text-xs font-semibold leading-snug text-ink">Note: {line.notes}</div>
        )}
        {blocked && (
          <div className="mt-0.5 text-xs font-bold uppercase leading-snug text-red-700">Pick-up only</div>
        )}
        <div className="mt-1 font-cond text-sm font-bold tabular-nums text-ink">
          {formatCents(lineUnitPriceCents(line) * line.quantity)}
        </div>
      </div>
      <Stepper value={line.quantity} onChange={(q) => setQty(line.key, q)} label={line.label} />
    </li>
  );
}

/**
 * − n +. With min 0, the minus at 1 is a bin: the customer sees that it
 * removes the line rather than guessing.
 */
export function Stepper({
  value,
  onChange,
  label,
  min = 0,
  max = 50,
  large = false,
}: {
  value: number;
  onChange: (v: number) => void;
  label: string;
  min?: number;
  max?: number;
  large?: boolean;
}) {
  const removes = min === 0 && value <= 1;
  const btn = `grid place-items-center rounded-full font-bold text-ink hover:bg-paper-deep disabled:opacity-30 ${
    large ? 'h-11 w-11 text-xl' : 'h-9 w-9 text-lg'
  }`;
  return (
    <div className="flex shrink-0 items-center gap-0.5 rounded-full border border-ink/15 bg-white p-0.5">
      <button
        type="button"
        onClick={() => onChange(Math.max(min, value - 1))}
        className={`${btn} ${removes ? 'text-red-700' : ''}`}
        disabled={value <= min}
        aria-label={removes ? `Remove ${label}` : `One less ${label}`}
      >
        {removes ? (
          <svg viewBox="0 0 24 24" aria-hidden className="h-[18px] w-[18px] fill-none stroke-current stroke-2">
            <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        ) : (
          <span aria-hidden>−</span>
        )}
      </button>
      <span className="min-w-[2ch] text-center font-cond text-base font-bold tabular-nums text-ink" aria-live="polite">
        <span className="sr-only">{label}: </span>
        {value}
      </span>
      <button
        type="button"
        onClick={() => onChange(Math.min(max, value + 1))}
        className={btn}
        disabled={value >= max}
        aria-label={`One more ${label}`}
      >
        <span aria-hidden>+</span>
      </button>
    </div>
  );
}

export function Totals(props: CartProps) {
  const pickup = props.fulfilment === 'pickup';
  return (
    <dl className="mt-4 space-y-1.5 border-t-2 border-dashed border-paper-line pt-3 text-sm">
      <div className="flex justify-between text-ink-muted">
        <dt>Subtotal</dt>
        <dd className="tabular-nums">{formatCents(props.subtotal)}</dd>
      </div>
      {pickup ? (
        <div className="flex justify-between font-semibold text-emerald-700">
          <dt>Pick-up {props.pickupPct}% off</dt>
          <dd className="tabular-nums">−{formatCents(props.discount)}</dd>
        </div>
      ) : (
        <div className="flex justify-between text-ink-muted">
          <dt>Delivery{props.zone ? ` · ${props.zone.name}` : ''}</dt>
          <dd className="tabular-nums">{props.zone ? formatCents(props.deliveryFee) : props.feeRange}</dd>
        </div>
      )}
      <div className="flex justify-between text-ink-muted">
        <dt>Tax (est.)</dt>
        <dd className="tabular-nums">{formatCents(props.tax)}</dd>
      </div>
      <div className="flex justify-between pt-1 font-cond text-xl font-extrabold uppercase text-ink">
        <dt>Total</dt>
        <dd className="tabular-nums">
          {formatCents(props.total)}
          {!pickup && !props.zone && <span className="ml-1 text-xs font-bold text-ink-muted">+ delivery</span>}
        </dd>
      </div>
    </dl>
  );
}
