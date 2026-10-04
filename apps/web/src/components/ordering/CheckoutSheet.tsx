'use client';

import { useId, useRef, useState } from 'react';
import { NOT_ON_VALUE_DEALS } from '@cheeseoclock/shared-types';
import { BUSINESS } from '@/lib/business';
import { whatsappOrderText } from '@/lib/cart';
import {
  problemFromServer,
  validateCheckout,
  type CheckoutField,
  type CheckoutProblem,
  type OrderErrorBody,
} from '@/lib/checkout-validation';
import { checkoutAreaHint, copyText, deliveryAreasText, zoneOptionGroups, type SiteFacts } from '@/lib/delivery-facts';
import {
  STORAGE_KEYS,
  parseDetails,
  readStored,
  removeStored,
  serializeDetails,
  writeStored,
} from '@/lib/device-memory';
import { formatCents } from '@/lib/format';
import { isPickupOnly } from '@/lib/menu-view';
import { CHECKOUT_PAY_DELIVERY, CHECKOUT_PAY_PICKUP } from '@/lib/page-copy';
import { shopHoursInSentence, whatsappUrlWith } from '@/lib/shop-facts';
import { CartLineRow, ClearCartButton, FulfilmentToggle, MinimumNote, Totals, type CartProps } from './cart-ui';
import { CloseButton, Sheet } from './Sheet';
import { useShopFacts } from './ShopContext';

export interface PlacedOrder {
  orderId: string;
  /** As the customer typed it; the tracking page matches it server-side. */
  phone: string;
  /** What the server priced the order at, paisa (api/orders: totalCents, tax and delivery in it): the Meta Pixel's Purchase value. */
  totalCents?: number;
}

/**
 * The cart and the checkout in one sheet: on a phone, "View order" opens this
 * and it is the whole cart. Details the customer asked us to remember are
 * filled in; a problem sends them to the field to fix; a server refusal sits
 * right above the button, where the thumb already is.
 */
export function CheckoutSheet(
  props: CartProps & {
    zoneId: string;
    onZone: (id: string) => void;
    /** Where the owner delivers and the fees (switched-off areas are listed, not choosable). */
    deliveryFacts: SiteFacts;
    acceptingOrders: boolean;
    /** The owner's words while the website is closed (v0.7.30, worked out on the server); null = this sheet's own. */
    closedNotice?: string | null;
    onClose: () => void;
    /** The idempotency key for this cart (same cart → same key, so a resend is not a second order). */
    orderIdFor: () => string;
    onPlaced: (placed: PlacedOrder) => void;
  },
) {
  // The shop's details (the owner's; OrderingApp provides them): the pick-up address, the allergy
  // notice, the WhatsApp line and the name in the message, how the customer pays.
  const shop = useShopFacts();
  const [saved] = useState(() => parseDetails(readStored(STORAGE_KEYS.details)));
  const [name, setName] = useState(saved?.name ?? '');
  const [phone, setPhone] = useState(saved?.phone ?? '');
  const [address, setAddress] = useState(saved?.address ?? '');
  const [notes, setNotes] = useState('');
  const [remember, setRemember] = useState(true);
  const [hasSaved, setHasSaved] = useState(saved !== null);
  const [submitting, setSubmitting] = useState(false);
  const [problem, setProblem] = useState<CheckoutProblem | null>(null);
  // A double tap fires two clicks before React has re-rendered the disabled
  // button; the ref closes that gap synchronously.
  const inFlight = useRef(false);

  const fieldRefs = useRef(new Map<CheckoutField, HTMLElement>());
  const setFieldRef = (f: CheckoutField) => (el: HTMLElement | null) => {
    if (el) fieldRefs.current.set(f, el);
    else fieldRefs.current.delete(f);
  };
  const footerErrorRef = useRef<HTMLParagraphElement>(null);

  const pickup = props.fulfilment === 'pickup';
  const cartCount = props.cart.reduce((s, l) => s + l.quantity, 0);

  // A problem clears as soon as the customer touches what it was about,
  // instead of shouting at them until the next submit.
  function edited(field: CheckoutField | 'any') {
    setProblem((p) => (p && (field === 'any' || p.field === field) ? null : p));
  }

  function show(p: CheckoutProblem) {
    setProblem(p);
    // Focusing the field scrolls it into view; a problem with no field of its
    // own is shown above the button, which is always on screen.
    requestAnimationFrame(() => {
      const el = p.field ? fieldRefs.current.get(p.field) : null;
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        if (p.field !== 'cart') el.focus({ preventScroll: true });
      } else {
        footerErrorRef.current?.scrollIntoView({ block: 'nearest' });
      }
    });
  }

  function forgetDetails() {
    removeStored(STORAGE_KEYS.details);
    setHasSaved(false);
    setName('');
    setPhone('');
    setAddress('');
  }

  async function submit() {
    if (inFlight.current) return;
    setProblem(null);
    const invalid = validateCheckout({
      fulfilment: props.fulfilment,
      hasZone: Boolean(props.zone),
      name,
      phone,
      address,
      cartSize: props.cart.length,
      pickupOnlyInCart: props.pickupOnlyInCart,
      canPickup: props.canPickup,
      deliveryAreas: deliveryAreasText(props.deliveryFacts),
      minDeliveryOrderCents: props.minDeliveryOrderCents,
      foodSubtotalCents: props.subtotal,
    });
    if (invalid) return show(invalid);
    if (!props.acceptingOrders) {
      return show({ field: null, message: props.closedNotice ?? 'We are not taking online orders right now.' });
    }

    inFlight.current = true;
    setSubmitting(true);
    try {
      const res = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientOrderId: props.orderIdFor(),
          customerName: name.trim(),
          customerPhone: phone.trim(),
          fulfilment: props.fulfilment,
          ...(pickup ? {} : { addressLine: address.trim(), zoneId: props.zone?.id }),
          notes: notes.trim() || undefined,
          items: props.cart.map((l) => ({
            posItemId: l.item.posItemId,
            quantity: l.quantity,
            modifierIds: l.modifierIds,
            ...(l.notes ? { notes: l.notes } : {}),
          })),
        }),
      });
      type Reply = OrderErrorBody & { ok?: boolean; data?: { orderId: string; totalCents?: number } };
      let json: Reply | null = null;
      try {
        json = (await res.json()) as Reply;
      } catch {
        // A gateway error page, not our JSON — handled as a failed order below.
      }
      if (!json?.ok || !json.data) {
        inFlight.current = false;
        setSubmitting(false);
        return show(problemFromServer(json));
      }
      if (remember) {
        writeStored(
          STORAGE_KEYS.details,
          serializeDetails({ name: name.trim(), phone: phone.trim(), address: address.trim(), zoneId: props.zoneId }),
        );
      } else {
        removeStored(STORAGE_KEYS.details);
      }
      // Stays "Placing…" while the tracking page loads.
      props.onPlaced({ orderId: json.data.orderId, phone: phone.trim(), totalCents: json.data.totalCents });
    } catch {
      inFlight.current = false;
      setSubmitting(false);
      show({ field: null, message: 'Network problem — check your connection and tap Place order again.' });
    }
  }

  // The area list by the owner's groups ("DHA", "Clifton", …), in display order.
  const zoneGroups = zoneOptionGroups(props.deliveryFacts.zones);
  const fieldError = (f: CheckoutField) => (problem?.field === f ? problem.message : null);
  const footerError = problem && (problem.field === null || problem.field === 'cart') ? problem.message : null;
  const waText = whatsappOrderText(props.cart, {
    fulfilment: props.fulfilment,
    areaName: props.zone?.name,
    name,
    address,
    shopName: shop.profile.name,
  });
  const payFacts = { ...props.deliveryFacts, shop };

  return (
    <Sheet onClose={props.onClose} label="Your order and checkout">
      <div className="flex shrink-0 items-start justify-between gap-3 bg-ink px-5 py-5 text-cream">
        <div>
          <h3 className="font-display text-3xl uppercase leading-none tracking-wide">Your order</h3>
          <p className="mt-1.5 font-cond text-sm font-bold uppercase tracking-wide text-cheese">
            {!props.acceptingOrders
              ? 'Online ordering is closed right now'
              : pickup
                ? `Pick-up · ${props.pickupPct}% off${props.dealInCart ? `, ${NOT_ON_VALUE_DEALS}` : ''} · pay at the counter`
                : (props.deliveryPct ?? 0) > 0
                  ? `${props.deliveryPct}% off food${props.dealInCart ? `, ${NOT_ON_VALUE_DEALS}` : ''} · cash on delivery`
                  : 'Cash on delivery · pay the rider'}
          </p>
        </div>
        <CloseButton onClose={props.onClose} label="Close — keep browsing" />
      </div>

      <div className="flex-1 overflow-y-auto overscroll-contain px-5 pb-5">
        {props.cart.length === 0 ? (
          <div className="mt-6 rounded-2xl border-2 border-dashed border-paper-line px-4 py-10 text-center">
            <p className="font-cond text-lg font-bold uppercase text-ink">Your order is empty</p>
            <p className="mt-1 text-sm text-ink-muted">Tap a price on the menu to add it.</p>
            <button
              type="button"
              onClick={props.onClose}
              className="mt-4 rounded-full bg-ink px-6 py-3 font-cond text-base font-bold uppercase tracking-wide text-cheese"
            >
              Back to the menu
            </button>
          </div>
        ) : (
          <>
            <ul ref={setFieldRef('cart')} className="mt-4 scroll-mt-4 space-y-2">
              {props.cart.map((l) => (
                <CartLineRow
                  key={l.key}
                  line={l}
                  setQty={(key, q) => {
                    edited('cart');
                    props.setQty(key, q);
                  }}
                  blocked={!pickup && isPickupOnly(l.item)}
                />
              ))}
            </ul>
            <div className="mt-2 flex items-center justify-between gap-2">
              <button
                type="button"
                onClick={props.onClose}
                className="rounded-full px-1 py-2 font-cond text-sm font-bold uppercase tracking-wide text-ink underline decoration-cheese decoration-2 underline-offset-4"
              >
                + Add more items
              </button>
              <ClearCartButton count={cartCount} onClear={props.onClear} />
            </div>

            {props.canPickup && (
              <div className="mt-5">
                <FulfilmentToggle
                  {...props}
                  onFulfilment={(f) => {
                    edited('any');
                    props.onFulfilment(f);
                  }}
                />
              </div>
            )}

            <div className="mt-5 space-y-4">
              {pickup ? (
                <div className="rounded-2xl border-2 border-ink bg-white p-4">
                  <p className="font-cond text-sm font-extrabold uppercase tracking-widest text-ink">Collect from</p>
                  <p className="mt-1 text-sm font-semibold text-ink">
                    {shop.profile.address.street}, {BUSINESS.locality}
                  </p>
                  <p className="mt-1 text-xs text-ink-muted">
                    We&rsquo;ll have it ready — follow it live after you order. Pay at the counter.
                  </p>
                </div>
              ) : (
                <FieldShell
                  label="Delivery area"
                  error={fieldError('zone')}
                  hint={
                    props.zone
                      ? `Delivery to ${props.zone.name}: ${formatCents(props.zone.feeCents)}`
                      : checkoutAreaHint(props.deliveryFacts, props)
                  }
                >
                  {(ids) => (
                    <select
                      ref={setFieldRef('zone')}
                      {...ids}
                      value={props.zoneId}
                      onChange={(e) => {
                        edited('zone');
                        props.onZone(e.target.value);
                      }}
                      className={`w-full rounded-xl border-2 bg-white px-3 py-3 text-base font-semibold text-ink outline-none transition-colors focus:border-ink ${
                        fieldError('zone') ? 'border-red-600' : props.zone ? 'border-ink' : 'border-cheese'
                      }`}
                    >
                      <option value="">Choose your area…</option>
                      {zoneGroups.map((g) => (
                        <optgroup key={g.group} label={g.group}>
                          {g.options.map((o) => (
                            <option key={o.id} value={o.id} disabled={o.disabled}>
                              {o.label}
                            </option>
                          ))}
                        </optgroup>
                      ))}
                    </select>
                  )}
                </FieldShell>
              )}
              <TextField
                inputRef={setFieldRef('name')}
                label="Your name"
                value={name}
                onChange={(v) => {
                  edited('name');
                  setName(v);
                }}
                placeholder="Ahmed Khan"
                autoComplete="name"
                maxLength={80}
                error={fieldError('name')}
              />
              <TextField
                inputRef={setFieldRef('phone')}
                label="Mobile number"
                value={phone}
                onChange={(v) => {
                  edited('phone');
                  setPhone(v);
                }}
                placeholder="0300 1234567"
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                maxLength={20}
                error={fieldError('phone')}
                hint={pickup ? 'We call this number if there is a question about your order.' : 'The rider calls this number when they arrive.'}
              />
              {!pickup && (
                <TextField
                  inputRef={setFieldRef('address')}
                  label="House & street"
                  value={address}
                  onChange={(v) => {
                    edited('address');
                    setAddress(v);
                  }}
                  placeholder="House 12, Street 4, Khayaban-e-…"
                  autoComplete="street-address"
                  maxLength={300}
                  error={fieldError('address')}
                />
              )}
              <TextField
                label={pickup ? 'Notes for the counter (optional)' : 'Directions for the rider (optional)'}
                value={notes}
                onChange={setNotes}
                placeholder={pickup ? 'I’ll be there at 9 pm' : 'Near the park, ring the bell twice'}
                maxLength={400}
              />
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                <label className="flex cursor-pointer items-center gap-2 py-1 text-sm font-semibold text-ink">
                  <input
                    type="checkbox"
                    checked={remember}
                    onChange={(e) => setRemember(e.target.checked)}
                    className="h-5 w-5 accent-ink"
                  />
                  Remember my details on this phone
                </label>
                {hasSaved && (
                  <button
                    type="button"
                    onClick={forgetDetails}
                    className="py-1 text-xs font-semibold text-ink-muted underline underline-offset-2 hover:text-ink"
                  >
                    Forget saved details
                  </button>
                )}
              </div>
              <p className="text-xs leading-snug text-ink-muted">{shop.website.allergyNotice}</p>
            </div>

            <Totals {...props} />
            <MinimumNote {...props} />

            {!props.acceptingOrders &&
              (props.closedNotice ? (
                // The owner's closed notice replaces the explanation; the WhatsApp button below stays.
                <p className="mt-3 rounded-xl border-2 border-ink bg-cheese px-3 py-2 text-sm font-semibold text-ink">
                  {props.closedNotice}
                </p>
              ) : (
                <p className="mt-3 rounded-xl border-2 border-ink bg-cheese px-3 py-2 text-sm font-semibold text-ink">
                  The kitchen isn&rsquo;t taking website orders at the moment ({shopHoursInSentence(shop)}). Send
                  this order on WhatsApp instead — we reply fast.
                </p>
              ))}
          </>
        )}
      </div>

      {props.cart.length > 0 && (
        <div className="pb-safe-4 shrink-0 border-t border-paper-line bg-white px-5 pt-3">
          {footerError && (
            <p
              ref={footerErrorRef}
              role="alert"
              className="mb-3 rounded-xl border-2 border-red-600/40 bg-red-50 px-3 py-2 text-sm font-semibold text-red-700"
            >
              {footerError}
              {problem?.field === null && (
                <>
                  {' '}
                  <a
                    href={whatsappUrlWith(shop, waText)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="whitespace-nowrap underline underline-offset-2"
                  >
                    Send it on WhatsApp →
                  </a>
                </>
              )}
            </p>
          )}
          {props.acceptingOrders ? (
            <button
              type="button"
              onClick={() => void submit()}
              disabled={submitting}
              aria-busy={submitting}
              className="min-h-[3.5rem] w-full rounded-full bg-ink py-3.5 font-cond text-xl font-bold uppercase tracking-wide text-cheese transition-all hover:bg-ink-soft active:scale-[0.99] disabled:cursor-wait disabled:opacity-70"
            >
              {submitting ? (
                <span className="inline-flex items-center gap-2">
                  <span aria-hidden className="h-4 w-4 animate-spin rounded-full border-2 border-cheese border-t-transparent" />
                  Placing your order…
                </span>
              ) : !pickup && !props.zone ? (
                `Place order · ${formatCents(props.total)} + delivery`
              ) : (
                `Place order · ${formatCents(props.total)}`
              )}
            </button>
          ) : (
            <a
              href={whatsappUrlWith(shop, waText)}
              target="_blank"
              rel="noopener noreferrer"
              className="flex min-h-[3.5rem] w-full items-center justify-center rounded-full bg-[#1FA855] py-3.5 font-cond text-xl font-bold uppercase tracking-wide text-white transition-all hover:bg-[#178a45] active:scale-[0.99]"
            >
              Send this order on WhatsApp
            </a>
          )}
          <p className="mt-2 text-center text-xs text-ink-muted">
            {!props.acceptingOrders
              ? 'Opens WhatsApp with your order typed out — we confirm the total there.'
              : pickup
                ? copyText(CHECKOUT_PAY_PICKUP, payFacts)
                : copyText(CHECKOUT_PAY_DELIVERY, payFacts)}
          </p>
        </div>
      )}
    </Sheet>
  );
}

/** Label, control, then either the error or the hint under it — wired for screen readers. */
function FieldShell({
  label,
  error,
  hint,
  children,
}: {
  label: string;
  error: string | null;
  hint?: string;
  children: (ids: { id: string; 'aria-invalid': boolean; 'aria-describedby'?: string }) => React.ReactNode;
}) {
  const id = useId();
  const noteId = `${id}-note`;
  const note = error ?? hint;
  return (
    <div>
      <label htmlFor={id} className="mb-1 block font-cond text-sm font-extrabold uppercase tracking-widest text-ink">
        {label}
      </label>
      {children({ id, 'aria-invalid': Boolean(error), ...(note ? { 'aria-describedby': noteId } : {}) })}
      {note && (
        <span
          id={noteId}
          className={`mt-1 block text-xs leading-snug ${error ? 'font-semibold text-red-700' : 'text-ink-muted'}`}
        >
          {note}
        </span>
      )}
    </div>
  );
}

function TextField({
  label,
  value,
  onChange,
  placeholder,
  type = 'text',
  inputMode,
  autoComplete,
  maxLength,
  error = null,
  hint,
  inputRef,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  inputMode?: React.HTMLAttributes<HTMLInputElement>['inputMode'];
  autoComplete?: string;
  maxLength?: number;
  error?: string | null;
  hint?: string;
  inputRef?: (el: HTMLInputElement | null) => void;
}) {
  return (
    <FieldShell label={label} error={error} hint={hint}>
      {(ids) => (
        <input
          ref={inputRef}
          {...ids}
          type={type}
          inputMode={inputMode}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          autoComplete={autoComplete}
          maxLength={maxLength}
          className={`w-full rounded-xl border-2 bg-white px-3.5 py-3 text-base font-medium text-ink outline-none transition-colors placeholder:text-ink/35 focus:border-ink ${
            error ? 'border-red-600' : 'border-paper-line'
          }`}
        />
      )}
    </FieldShell>
  );
}
