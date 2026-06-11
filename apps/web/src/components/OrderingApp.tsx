'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { formatCents } from '@/lib/format';
import type {
  PublishedMenu,
  PublishedMenuItem,
} from '@cheeseoclock/shared-types';

/**
 * The full ordering experience on one page:
 *   category rail → item grid → (modifier sheet) → cart → checkout → submit.
 *
 * Totals shown here are estimates re-priced server-side on submit; the POS
 * receipt is the authoritative bill (COD — the rider collects against it).
 */

interface CartLine {
  key: string; // posItemId + sorted modifier ids — merges identical lines
  item: PublishedMenuItem;
  quantity: number;
  modifierIds: string[];
}

/** Placeholder emoji for items without a photo — keyed off the item name. */
function foodEmoji(name: string): string {
  const n = name.toLowerCase();
  if (n.includes('pizza')) return '🍕';
  if (n.includes('burger')) return '🍔';
  if (n.includes('fries') || n.includes('chips')) return '🍟';
  if (n.includes('wing') || n.includes('chicken') || n.includes('broast')) return '🍗';
  if (n.includes('sandwich') || n.includes('shawarma') || n.includes('wrap') || n.includes('roll')) return '🌯';
  if (n.includes('pasta') || n.includes('spaghetti') || n.includes('noodle')) return '🍝';
  if (n.includes('shake') || n.includes('smoothie')) return '🥤';
  if (n.includes('cola') || n.includes('drink') || n.includes('juice') || n.includes('water')) return '🥤';
  if (n.includes('ice cream') || n.includes('dessert') || n.includes('cake') || n.includes('brownie')) return '🍰';
  if (n.includes('salad')) return '🥗';
  return '🍽️';
}

export function OrderingApp({ menu }: { menu: PublishedMenu }) {
  const categories = useMemo(
    () =>
      [...menu.categories]
        .sort((a, b) => a.displayOrder - b.displayOrder)
        .filter((c) => c.items.length > 0),
    [menu],
  );
  const [activeCat, setActiveCat] = useState(categories[0]?.posCategoryId ?? '');
  const [cart, setCart] = useState<CartLine[]>([]);
  const [modifierFor, setModifierFor] = useState<PublishedMenuItem | null>(null);
  const [checkoutOpen, setCheckoutOpen] = useState(false);

  const active = categories.find((c) => c.posCategoryId === activeCat) ?? categories[0];

  function lineUnitPrice(line: CartLine): number {
    const mods = line.item.modifierGroups.flatMap((g) => g.modifiers);
    return (
      line.item.basePriceCents +
      line.modifierIds.reduce(
        (s, id) => s + (mods.find((m) => m.posModifierId === id)?.priceDeltaCents ?? 0),
        0,
      )
    );
  }

  const subtotal = cart.reduce((s, l) => s + lineUnitPrice(l) * l.quantity, 0);
  const tax = cart.reduce(
    (s, l) =>
      s + Math.round((lineUnitPrice(l) * l.quantity * l.item.taxRateBps) / 10_000),
    0,
  );
  const total = subtotal + tax;
  const cartCount = cart.reduce((s, l) => s + l.quantity, 0);

  function addToCart(item: PublishedMenuItem, modifierIds: string[]) {
    const key = `${item.posItemId}|${[...modifierIds].sort().join(',')}`;
    setCart((prev) => {
      const existing = prev.find((l) => l.key === key);
      if (existing) {
        return prev.map((l) => (l.key === key ? { ...l, quantity: l.quantity + 1 } : l));
      }
      return [...prev, { key, item, quantity: 1, modifierIds }];
    });
  }

  function handleItemClick(item: PublishedMenuItem) {
    if (item.modifierGroups.length > 0) {
      setModifierFor(item);
    } else {
      addToCart(item, []);
    }
  }

  function setQty(key: string, qty: number) {
    setCart((prev) =>
      qty <= 0
        ? prev.filter((l) => l.key !== key)
        : prev.map((l) => (l.key === key ? { ...l, quantity: qty } : l)),
    );
  }

  return (
    <div className="pb-28 lg:grid lg:grid-cols-[1fr_22rem] lg:gap-8 lg:pb-8">
      <div>
        <h1 className="text-3xl font-black tracking-tight">Menu</h1>
        <p className="mt-1 text-sm text-stone-500">
          Tap an item to add it · 💵 cash on delivery
        </p>

        {/* Category rail */}
        <nav className="sticky top-16 z-30 -mx-4 mt-4 flex gap-2 overflow-x-auto bg-stone-50/95 px-4 py-3 backdrop-blur-sm">
          {categories.map((c) => (
            <button
              key={c.posCategoryId}
              onClick={() => setActiveCat(c.posCategoryId)}
              className={`whitespace-nowrap rounded-full px-4 py-2 text-sm font-bold transition-colors ${
                c.posCategoryId === active?.posCategoryId
                  ? 'bg-stone-900 text-white'
                  : 'bg-white text-stone-600 shadow-soft-sm ring-1 ring-stone-200 hover:bg-stone-100'
              }`}
            >
              {c.name}
            </button>
          ))}
        </nav>

        {/* Item grid */}
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {(active?.items ?? [])
            .slice()
            .sort((a, b) => a.sortOrder - b.sortOrder)
            .map((item) => (
              <button
                key={item.posItemId}
                onClick={() => handleItemClick(item)}
                className="group flex gap-3 rounded-2xl bg-white p-3 text-left shadow-soft-sm ring-1 ring-stone-100 transition-all hover:shadow-soft-md hover:ring-amber-200 active:scale-[0.99]"
              >
                <div className="flex h-20 w-20 flex-shrink-0 items-center justify-center overflow-hidden rounded-xl bg-gradient-to-br from-amber-100 to-orange-100 text-3xl">
                  {item.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={item.imageUrl}
                      alt=""
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    foodEmoji(item.name)
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <h3 className="font-bold leading-tight">{item.name}</h3>
                  {item.description && (
                    <p className="mt-0.5 line-clamp-2 text-xs text-stone-500">
                      {item.description}
                    </p>
                  )}
                  <div className="mt-1.5 flex items-center justify-between">
                    <span className="font-mono text-sm font-bold text-amber-700">
                      {formatCents(item.basePriceCents)}
                    </span>
                    <span className="rounded-full bg-amber-100 px-2.5 py-1 text-xs font-bold text-amber-800 opacity-0 transition-opacity group-hover:opacity-100">
                      {item.modifierGroups.length > 0 ? 'Customize +' : 'Add +'}
                    </span>
                  </div>
                </div>
              </button>
            ))}
        </div>
      </div>

      {/* Cart — desktop side panel */}
      <aside className="hidden lg:block">
        <div className="sticky top-24 rounded-2xl bg-white p-4 shadow-soft-md ring-1 ring-stone-100">
          <CartPanel
            cart={cart}
            lineUnitPrice={lineUnitPrice}
            subtotal={subtotal}
            tax={tax}
            total={total}
            setQty={setQty}
            onCheckout={() => setCheckoutOpen(true)}
          />
        </div>
      </aside>

      {/* Cart — mobile bottom bar */}
      {cartCount > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t border-stone-200 bg-white p-3 shadow-soft-lg lg:hidden">
          <button
            onClick={() => setCheckoutOpen(true)}
            className="flex w-full items-center justify-between rounded-2xl bg-gradient-to-b from-amber-400 to-amber-500 px-5 py-4 font-bold text-stone-900 shadow-lift active:scale-[0.99]"
          >
            <span>
              🛒 {cartCount} item{cartCount === 1 ? '' : 's'}
            </span>
            <span className="font-mono">{formatCents(total)} →</span>
          </button>
        </div>
      )}

      {modifierFor && (
        <ModifierSheet
          item={modifierFor}
          onClose={() => setModifierFor(null)}
          onConfirm={(ids) => {
            addToCart(modifierFor, ids);
            setModifierFor(null);
          }}
        />
      )}

      {checkoutOpen && (
        <CheckoutSheet
          cart={cart}
          lineUnitPrice={lineUnitPrice}
          subtotal={subtotal}
          tax={tax}
          total={total}
          setQty={setQty}
          onClose={() => setCheckoutOpen(false)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function CartPanel(props: {
  cart: CartLine[];
  lineUnitPrice: (l: CartLine) => number;
  subtotal: number;
  tax: number;
  total: number;
  setQty: (key: string, qty: number) => void;
  onCheckout: () => void;
}) {
  const { cart } = props;
  return (
    <div>
      <h2 className="font-black">Your order</h2>
      {cart.length === 0 ? (
        <p className="mt-4 pb-2 text-center text-sm text-stone-400">
          Cart is empty — tap an item to add it.
        </p>
      ) : (
        <>
          <ul className="mt-3 max-h-80 space-y-2 overflow-y-auto">
            {cart.map((l) => (
              <CartLineRow key={l.key} line={l} unit={props.lineUnitPrice(l)} setQty={props.setQty} />
            ))}
          </ul>
          <Totals subtotal={props.subtotal} tax={props.tax} total={props.total} />
          <button
            onClick={props.onCheckout}
            className="mt-3 w-full rounded-2xl bg-gradient-to-b from-amber-400 to-amber-500 py-3.5 font-bold text-stone-900 shadow-soft-sm transition-all hover:shadow-lift active:scale-[0.99]"
          >
            Checkout — {formatCents(props.total)}
          </button>
        </>
      )}
    </div>
  );
}

function CartLineRow({
  line,
  unit,
  setQty,
}: {
  line: CartLine;
  unit: number;
  setQty: (key: string, qty: number) => void;
}) {
  const allMods = line.item.modifierGroups.flatMap((g) => g.modifiers);
  const names = line.modifierIds
    .map((id) => allMods.find((m) => m.posModifierId === id)?.name)
    .filter(Boolean);
  return (
    <li className="flex items-start gap-2 rounded-xl bg-stone-50 p-2.5">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-bold leading-tight">{line.item.name}</div>
        {names.length > 0 && (
          <div className="mt-0.5 truncate text-xs text-stone-500">+ {names.join(', ')}</div>
        )}
        <div className="mt-1 font-mono text-xs font-bold text-amber-700">
          {formatCents(unit * line.quantity)}
        </div>
      </div>
      <div className="flex items-center gap-1 rounded-lg bg-white p-0.5 shadow-soft-sm">
        <button
          onClick={() => setQty(line.key, line.quantity - 1)}
          className="h-7 w-7 rounded-md font-bold text-stone-500 hover:bg-stone-100"
          aria-label="Decrease"
        >
          −
        </button>
        <span className="min-w-[1.5ch] text-center font-mono text-sm font-bold">
          {line.quantity}
        </span>
        <button
          onClick={() => setQty(line.key, line.quantity + 1)}
          className="h-7 w-7 rounded-md font-bold text-stone-500 hover:bg-stone-100"
          aria-label="Increase"
        >
          +
        </button>
      </div>
    </li>
  );
}

function Totals({ subtotal, tax, total }: { subtotal: number; tax: number; total: number }) {
  return (
    <dl className="mt-3 space-y-1 border-t border-stone-100 pt-3 text-sm">
      <div className="flex justify-between text-stone-500">
        <dt>Subtotal</dt>
        <dd className="font-mono">{formatCents(subtotal)}</dd>
      </div>
      <div className="flex justify-between text-stone-500">
        <dt>Tax (est.)</dt>
        <dd className="font-mono">{formatCents(tax)}</dd>
      </div>
      <div className="flex justify-between text-base font-black">
        <dt>Total</dt>
        <dd className="font-mono text-amber-700">{formatCents(total)}</dd>
      </div>
    </dl>
  );
}

// ---------------------------------------------------------------------------

function ModifierSheet({
  item,
  onClose,
  onConfirm,
}: {
  item: PublishedMenuItem;
  onClose: () => void;
  onConfirm: (modifierIds: string[]) => void;
}) {
  // Pre-select defaults.
  const [selected, setSelected] = useState<Set<string>>(
    () =>
      new Set(
        item.modifierGroups.flatMap((g) =>
          g.modifiers.filter((m) => m.isDefault).map((m) => m.posModifierId),
        ),
      ),
  );

  function toggle(groupId: string, modId: string) {
    const group = item.modifierGroups.find((g) => g.posGroupId === groupId);
    if (!group) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (group.selectionType === 'single') {
        // Radio behavior: clear siblings.
        for (const m of group.modifiers) next.delete(m.posModifierId);
        next.add(modId);
      } else if (next.has(modId)) {
        next.delete(modId);
      } else {
        const chosen = group.modifiers.filter((m) => next.has(m.posModifierId)).length;
        if (group.maxSelect > 0 && chosen >= group.maxSelect) return prev;
        next.add(modId);
      }
      return next;
    });
  }

  const unmetGroups = item.modifierGroups.filter((g) => {
    if (!g.isRequired) return false;
    const chosen = g.modifiers.filter((m) => selected.has(m.posModifierId)).length;
    return chosen < Math.max(1, g.minSelect);
  });

  const extra = item.modifierGroups
    .flatMap((g) => g.modifiers)
    .filter((m) => selected.has(m.posModifierId))
    .reduce((s, m) => s + m.priceDeltaCents, 0);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 backdrop-blur-sm sm:items-center" onClick={onClose}>
      <div
        className="max-h-[85vh] w-full overflow-y-auto rounded-t-3xl bg-white p-5 shadow-soft-lg sm:max-w-md sm:rounded-3xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-lg font-black">{item.name}</h3>
            <p className="text-sm text-stone-500">Customize your order</p>
          </div>
          <button onClick={onClose} className="rounded-lg p-1.5 text-stone-400 hover:bg-stone-100" aria-label="Close">
            ✕
          </button>
        </div>

        {item.modifierGroups
          .slice()
          .sort((a, b) => a.sortOrder - b.sortOrder)
          .map((g) => (
            <fieldset key={g.posGroupId} className="mt-4">
              <legend className="text-sm font-bold">
                {g.name}{' '}
                {g.isRequired && <span className="text-xs font-semibold text-amber-600">required</span>}
              </legend>
              <div className="mt-2 space-y-1.5">
                {g.modifiers
                  .slice()
                  .sort((a, b) => a.sortOrder - b.sortOrder)
                  .map((m) => {
                    const checked = selected.has(m.posModifierId);
                    return (
                      <label
                        key={m.posModifierId}
                        className={`flex cursor-pointer items-center justify-between rounded-xl border-2 px-3 py-2.5 text-sm transition-colors ${
                          checked
                            ? 'border-amber-400 bg-amber-50'
                            : 'border-stone-100 bg-white hover:border-stone-200'
                        }`}
                      >
                        <span className="flex items-center gap-2">
                          <input
                            type={g.selectionType === 'single' ? 'radio' : 'checkbox'}
                            checked={checked}
                            onChange={() => toggle(g.posGroupId, m.posModifierId)}
                            className="h-4 w-4 accent-amber-500"
                          />
                          <span className="font-semibold">{m.name}</span>
                        </span>
                        {m.priceDeltaCents !== 0 && (
                          <span className="font-mono text-xs text-stone-500">
                            +{formatCents(m.priceDeltaCents)}
                          </span>
                        )}
                      </label>
                    );
                  })}
              </div>
            </fieldset>
          ))}

        <button
          disabled={unmetGroups.length > 0}
          onClick={() => onConfirm([...selected])}
          className="mt-5 w-full rounded-2xl bg-gradient-to-b from-amber-400 to-amber-500 py-3.5 font-bold text-stone-900 shadow-soft-sm transition-all hover:shadow-lift active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-50"
        >
          {unmetGroups.length > 0
            ? `Choose ${unmetGroups[0]?.name ?? 'options'}`
            : `Add to cart — ${formatCents(item.basePriceCents + extra)}`}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function CheckoutSheet(props: {
  cart: CartLine[];
  lineUnitPrice: (l: CartLine) => number;
  subtotal: number;
  tax: number;
  total: number;
  setQty: (key: string, qty: number) => void;
  onClose: () => void;
}) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');
  const [area, setArea] = useState('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    if (name.trim().length < 2) return setError('Please enter your name.');
    if (phone.trim().length < 10) return setError('Please enter your mobile number.');
    if (address.trim().length < 5) return setError('Please enter your delivery address.');
    if (props.cart.length === 0) return setError('Your cart is empty.');
    setSubmitting(true);
    try {
      const res = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customerName: name.trim(),
          customerPhone: phone.trim(),
          addressLine: address.trim(),
          area: area.trim() || undefined,
          notes: notes.trim() || undefined,
          items: props.cart.map((l) => ({
            posItemId: l.item.posItemId,
            quantity: l.quantity,
            modifierIds: l.modifierIds,
          })),
        }),
      });
      const json = (await res.json()) as {
        ok: boolean;
        data?: { orderId: string };
        error?: string;
      };
      if (!json.ok || !json.data) {
        setError(
          json.error === 'menu_not_published'
            ? 'The menu was just updated — please refresh and try again.'
            : 'Could not place the order. Please try again or order on WhatsApp.',
        );
        setSubmitting(false);
        return;
      }
      router.push(
        `/track/${json.data.orderId}?phone=${encodeURIComponent(phone.trim())}&placed=1`,
      );
    } catch {
      setError('Network problem — check your connection and try again.');
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 backdrop-blur-sm sm:items-center" onClick={props.onClose}>
      <div
        className="max-h-[92vh] w-full overflow-y-auto rounded-t-3xl bg-white p-5 shadow-soft-lg sm:max-w-lg sm:rounded-3xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-lg font-black">Checkout</h3>
            <p className="text-sm text-stone-500">💵 Cash on delivery · pay the rider</p>
          </div>
          <button onClick={props.onClose} className="rounded-lg p-1.5 text-stone-400 hover:bg-stone-100" aria-label="Close">
            ✕
          </button>
        </div>

        <ul className="mt-4 space-y-2">
          {props.cart.map((l) => (
            <CartLineRow key={l.key} line={l} unit={props.lineUnitPrice(l)} setQty={props.setQty} />
          ))}
        </ul>
        <Totals subtotal={props.subtotal} tax={props.tax} total={props.total} />

        <div className="mt-4 space-y-3">
          <Field label="Your name" value={name} onChange={setName} placeholder="Ahmed Khan" autoFocus />
          <Field
            label="Mobile number"
            value={phone}
            onChange={setPhone}
            placeholder="0300 1234567"
            type="tel"
          />
          <Field
            label="Delivery address"
            value={address}
            onChange={setAddress}
            placeholder="House 12, Street 4, Khayaban-e-…"
          />
          <div className="grid grid-cols-2 gap-3">
            <Field label="Area (optional)" value={area} onChange={setArea} placeholder="Phase 6" />
            <Field label="Notes (optional)" value={notes} onChange={setNotes} placeholder="Ring the bell twice" />
          </div>
        </div>

        {error && (
          <p className="mt-3 rounded-xl bg-red-50 px-3 py-2 text-sm font-semibold text-red-700">
            {error}
          </p>
        )}

        <button
          onClick={() => void submit()}
          disabled={submitting || props.cart.length === 0}
          className="mt-4 w-full rounded-2xl bg-gradient-to-b from-amber-400 to-amber-500 py-4 text-lg font-bold text-stone-900 shadow-lift transition-all hover:shadow-soft-lg active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {submitting ? 'Placing your order…' : `Place order — ${formatCents(props.total)}`}
        </button>
        <p className="mt-2 text-center text-xs text-stone-400">
          By ordering you agree to pay cash on delivery. Final bill is confirmed by
          the restaurant.
        </p>
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  type = 'text',
  autoFocus,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  autoFocus?: boolean;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-bold text-stone-700">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoFocus={autoFocus}
        className="w-full rounded-xl border-2 border-stone-200 px-3.5 py-2.5 text-sm font-medium outline-none transition-colors placeholder:text-stone-300 focus:border-amber-400"
      />
    </label>
  );
}
