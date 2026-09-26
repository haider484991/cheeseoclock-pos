'use client';

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { formatCents } from '@/lib/format';
import { BUSINESS, WA_ORDER_URL } from '@/lib/business';
import { DELIVERY_ZONES, deliveryChargeItemFor, findZone } from '@/lib/delivery-zones';
import { priceOrder, type PricedLine } from '@/lib/pricing';
import {
  ALLERGY_NOTICE,
  buildMenuView,
  dealWorthCents,
  isDealSection,
  isPickupOnly,
  sizeLabel,
  type MenuCard,
  type MenuVariant,
} from '@/lib/menu-view';
import {
  addLine,
  cartCount as countLines,
  cartSubtotalCents,
  lineUnitPriceCents,
  linesSummary,
  restoreLines,
  setLineQty,
  toSavedLines,
  type CartLine,
} from '@/lib/cart';
import {
  STORAGE_KEYS,
  isTrackable,
  parseCartSnapshot,
  parseDetails,
  parseLastOrder,
  parseReorder,
  readStored,
  removeStored,
  serializeCartSnapshot,
  serializeLastOrder,
  writeStored,
  type LastOrder,
} from '@/lib/device-memory';
import { menuImageSrcSet } from '@/lib/images';
import { feeRangeText, trackPath } from '@/lib/order-display';
import type { PublishedMenu, PublishedMenuItem, WebFulfilment } from '@cheeseoclock/shared-types';
import { CartPanel, type CartProps } from './ordering/cart-ui';
import { CheckoutSheet, type PlacedOrder } from './ordering/CheckoutSheet';
import { ItemSheet } from './ordering/ItemSheet';
import { sheetOnTopOfHistory } from './ordering/Sheet';

/** Idempotency key for one checkout; the server dedupes resends on it. */
function newOrderId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Very old WebViews: still a valid v4 UUID, just from Math.random.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

/**
 * The full ordering experience on one page, set like the printed menu:
 *   category rail → sections of cards (sizes folded into one card) →
 *   item sheet (size, choices, quantity) → cart → checkout (delivery area
 *   is required; the zone decides the delivery fee) → submit.
 *
 * The cart survives a closed tab or a stray tap on the header (it is kept on
 * the phone, re-checked against today's menu), the customer's details are
 * remembered when they ask, and a returning customer can track or repeat
 * their last order from the top of the page.
 *
 * Totals shown here are estimates re-priced server-side on submit; the POS
 * receipt is the authoritative bill (COD — the rider collects against it).
 */

function variantLabel(card: MenuCard, v: MenuVariant): string {
  return v.size ? `${card.name} · ${sizeLabel(v.size)}` : card.name;
}

type PickFn = (card: MenuCard, variantIndex: number) => void;

const FEE_RANGE = feeRangeText(DELIVERY_ZONES);

export function OrderingApp({
  menu,
  acceptingOrders,
  pickupAvailable,
  pickupDiscountPercent,
}: {
  menu: PublishedMenu;
  acceptingOrders: boolean;
  /** The till can take pickup orders right now (lib/store-status). */
  pickupAvailable: boolean;
  /** The pickup discount that till bills — shown and priced here. */
  pickupDiscountPercent: number;
}) {
  const router = useRouter();
  // Server-rendered starting point, then kept honest client-side: a customer
  // can sit on this page long after the shop stops taking orders. The POST is
  // the real gate (see api/orders) — this only keeps the buttons truthful.
  const [open, setOpen] = useState(acceptingOrders);
  const [canPickup, setCanPickup] = useState(pickupAvailable);
  const [pickupPct, setPickupPct] = useState(pickupDiscountPercent);
  useEffect(() => {
    let cancelled = false;
    async function check() {
      try {
        const res = await fetch('/api/store-status', { cache: 'no-store' });
        const json = (await res.json()) as {
          ok: boolean;
          data?: { acceptingOrders: boolean; pickupAvailable?: boolean; pickupDiscountPercent?: number };
        };
        if (!cancelled && json.ok && json.data) {
          setOpen(json.data.acceptingOrders);
          setCanPickup(json.data.pickupAvailable === true);
          if (typeof json.data.pickupDiscountPercent === 'number') setPickupPct(json.data.pickupDiscountPercent);
        }
      } catch {
        // Keep the last known state; submitting is still guarded server-side.
      }
    }
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') void check();
    }, 60_000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void check();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  const sections = useMemo(() => buildMenuView(menu), [menu]);
  const railSections = useMemo(() => sections.map((s) => ({ anchor: s.anchor, name: s.name })), [sections]);
  // Each deal's contents bought one by one, for its "Save Rs …" badge.
  const dealWorth = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of sections) {
      if (!isDealSection(s.name)) continue;
      for (const c of s.cards) {
        const item = c.variants[0]?.item;
        const worth = item ? dealWorthCents(menu, item) : null;
        if (item && worth !== null && worth > item.basePriceCents) m.set(item.posItemId, worth);
      }
    }
    return m;
  }, [menu, sections]);

  const [cart, setCart] = useState<CartLine[]>([]);
  const [sheet, setSheet] = useState<{ card: MenuCard; variantIndex: number } | null>(null);
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [zoneId, setZoneId] = useState('');
  const [lastOrder, setLastOrder] = useState<LastOrder | null>(null);
  const [toast, setToast] = useState<{ id: number; text: string; ms: number } | null>(null);
  /** The saved cart has been read; from here on the cart is written back. */
  const hydrated = useRef(false);
  /** The order went through — don't write the (sent) cart back on the way out. */
  const placed = useRef(false);

  const flash = useCallback((text: string, ms = 1800) => {
    setToast({ id: Date.now(), text, ms });
  }, []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast((cur) => (cur?.id === toast.id ? null : cur)), toast.ms);
    return () => clearTimeout(t);
  }, [toast]);

  // Declared before the restore below so, on the first pass, it sees
  // `hydrated` still false and doesn't wipe the saved cart with an empty one.
  useEffect(() => {
    if (!hydrated.current || placed.current) return;
    if (cart.length === 0) removeStored(STORAGE_KEYS.cart);
    else writeStored(STORAGE_KEYS.cart, serializeCartSnapshot(toSavedLines(cart)));
  }, [cart]);

  // What this phone remembers: the half-built cart, an "order again" handed
  // over by the tracking page, the delivery area, the last order.
  useEffect(() => {
    const now = Date.now();
    let lines = restoreLines(menu, parseCartSnapshot(readStored(STORAGE_KEYS.cart), now)).lines;
    const reorder = parseReorder(readStored(STORAGE_KEYS.reorder), now);
    if (reorder.length > 0) {
      removeStored(STORAGE_KEYS.reorder);
      const again = restoreLines(menu, reorder);
      for (const l of again.lines) lines = addLine(lines, l);
      if (again.lines.length === 0) flash('Those items are no longer on the menu', 3000);
      else if (again.dropped > 0) flash(`Added your order · ${again.dropped} no longer on the menu`, 3000);
      else flash('Added your last order');
    }
    if (lines.length > 0) setCart(lines);
    const details = parseDetails(readStored(STORAGE_KEYS.details));
    const savedZone = details?.zoneId || readStored(STORAGE_KEYS.zone) || '';
    if (findZone(savedZone)) setZoneId(savedZone);
    setLastOrder(parseLastOrder(readStored(STORAGE_KEYS.lastOrder), now));
    hydrated.current = true;
  }, [menu, flash]);

  // "/menu#value-deals" from the home page: the loading skeleton was on screen
  // when Next looked for the section, so find it now that it exists.
  useEffect(() => {
    const id = decodeURIComponent(window.location.hash.slice(1));
    if (id && sections.some((s) => s.anchor === id)) {
      document.getElementById(id)?.scrollIntoView({ block: 'start', behavior: 'instant' });
    }
  }, [sections]);

  function chooseZone(id: string) {
    setZoneId(id);
    if (findZone(id)) writeStored(STORAGE_KEYS.zone, id);
  }

  const [chosenFulfilment, setFulfilment] = useState<WebFulfilment>('delivery');
  // Pickup silently falls back to delivery if the till stops offering it.
  const fulfilment: WebFulfilment = canPickup ? chosenFulfilment : 'delivery';
  const pickup = fulfilment === 'pickup';
  const zone = pickup ? undefined : findZone(zoneId);

  // Same maths as the server and the till (lib/pricing). The delivery fee is
  // a real till item, taxed like one; pickup takes its discount off the lot.
  const subtotal = cartSubtotalCents(cart);
  const priced: PricedLine[] = cart.map((l) => ({
    lineTotalCents: lineUnitPriceCents(l) * l.quantity,
    taxRateBps: l.item.taxRateBps,
  }));
  const feeItem = zone ? deliveryChargeItemFor(menu, zone.feeCents) : undefined;
  const deliveryFee = zone && cart.length > 0 ? zone.feeCents : 0;
  if (deliveryFee > 0) priced.push({ lineTotalCents: deliveryFee, taxRateBps: feeItem?.taxRateBps ?? 0 });
  const totals = priceOrder(priced, pickup ? pickupPct : 0);
  const { discountCents: discount, taxCents: tax, totalCents: total } = totals;
  const cartCount = countLines(cart);
  const pickupOnlyInCart = cart.filter((l) => isPickupOnly(l.item)).map((l) => l.label);

  const qtyByItem = useMemo(() => {
    const m = new Map<string, number>();
    for (const l of cart) m.set(l.item.posItemId, (m.get(l.item.posItemId) ?? 0) + l.quantity);
    return m;
  }, [cart]);

  const addToCart = useCallback(
    (item: PublishedMenuItem, label: string, modifierIds: string[], quantity = 1, notes: string | null = null) => {
      setCart((prev) => addLine(prev, { item, label, quantity, modifierIds, notes }));
      flash(`Added ${quantity > 1 ? `${quantity} × ` : ''}${label}`);
    },
    [flash],
  );

  /** A size tap: straight into the cart unless the item has choices to make. */
  const pickVariant: PickFn = useCallback(
    (card, variantIndex) => {
      const v = card.variants[variantIndex];
      if (!v || (card.pickupOnly && !canPickup)) return;
      if (v.item.modifierGroups.length > 0) {
        setSheet({ card, variantIndex });
      } else {
        addToCart(v.item, variantLabel(card, v), []);
      }
    },
    [canPickup, addToCart],
  );

  const setQty = useCallback((key: string, qty: number) => setCart((prev) => setLineQty(prev, key, qty)), []);
  const clearCart = useCallback(() => {
    setCart([]);
    flash('Order cleared');
  }, [flash]);

  function orderAgain(o: LastOrder) {
    const { lines, dropped } = restoreLines(menu, o.lines);
    if (lines.length === 0) {
      flash('Those items are no longer on the menu', 3000);
      return;
    }
    setCart((prev) => lines.reduce((acc, l) => addLine(acc, l), prev));
    if (o.fulfilment === 'pickup' && canPickup) setFulfilment('pickup');
    flash(dropped > 0 ? `Added your last order · ${dropped} no longer on the menu` : 'Added your last order', 3000);
  }

  // The same cart re-submitted (double tap, retry after a lost response, the
  // sheet closed and reopened) keeps its idempotency key, so the server hands
  // back the order it already has; a changed cart is a new order.
  const checkoutKey = useRef<{ sig: string; id: string } | null>(null);
  function orderIdFor(): string {
    const sig = JSON.stringify([fulfilment, zone?.id ?? null, cart.map((l) => [l.key, l.quantity])]);
    if (checkoutKey.current?.sig !== sig) checkoutKey.current = { sig, id: newOrderId() };
    return checkoutKey.current.id;
  }

  function onPlaced({ orderId, phone }: PlacedOrder) {
    placed.current = true;
    writeStored(
      STORAGE_KEYS.lastOrder,
      serializeLastOrder({ orderId, phone, placedAt: Date.now(), fulfilment, lines: toSavedLines(cart) }),
    );
    removeStored(STORAGE_KEYS.cart);
    // Replace the checkout sheet's history entry, so Back from the tracking
    // page lands on the menu rather than on a closed sheet.
    const url = trackPath(orderId, phone, true);
    if (sheetOnTopOfHistory()) router.replace(url);
    else router.push(url);
  }

  const closeSheet = useCallback(() => setSheet(null), []);
  const closeCheckout = useCallback(() => setCheckoutOpen(false), []);

  const cartProps: CartProps = {
    cart,
    subtotal,
    deliveryFee,
    discount,
    zone,
    tax,
    total,
    setQty,
    onClear: clearCart,
    fulfilment,
    canPickup,
    pickupPct,
    onFulfilment: setFulfilment,
    pickupOnlyInCart,
    feeRange: FEE_RANGE,
  };

  return (
    <div className="pb-28 lg:pb-12">
      <MenuHeader canPickup={canPickup} pickupPct={pickupPct} />

      {lastOrder && (
        <ReturningBanner
          menu={menu}
          lastOrder={lastOrder}
          cartEmpty={cart.length === 0}
          onOrderAgain={() => orderAgain(lastOrder)}
        />
      )}

      {!open && <ClosedBanner />}

      <CategoryRail sections={railSections} />

      <div className="mx-auto max-w-6xl px-4 lg:grid lg:grid-cols-[1fr_22rem] lg:gap-8">
        <div>
          {sections.map((s) => (
            <section key={s.id} id={s.anchor} className="scroll-mt-36 pt-8" aria-labelledby={`${s.anchor}-title`}>
              <SectionTitle id={`${s.anchor}-title`} name={s.name} note={sectionNote(s.name)} />
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                {s.cards.map((card, i) =>
                  isDealSection(s.name) ? (
                    <DealCard
                      key={card.key}
                      card={card}
                      n={i + 1}
                      worthCents={dealWorth.get(card.variants[0]?.item.posItemId ?? '') ?? null}
                      qtyByItem={qtyByItem}
                      canPickup={canPickup}
                      onPick={pickVariant}
                    />
                  ) : isSignature(s.name) || card.image ? (
                    <PhotoCard
                      key={card.key}
                      card={card}
                      qtyByItem={qtyByItem}
                      canPickup={canPickup}
                      onPick={pickVariant}
                    />
                  ) : (
                    <ItemCard
                      key={card.key}
                      card={card}
                      qtyByItem={qtyByItem}
                      canPickup={canPickup}
                      onPick={pickVariant}
                    />
                  ),
                )}
              </div>
            </section>
          ))}
          <p className="mt-10 text-center font-cond text-sm font-semibold uppercase tracking-wider text-ink-muted">
            Prices in PKR · 15% tax added on the bill · pay cash on delivery or at the counter
          </p>
        </div>

        {/* Cart — desktop side panel */}
        <aside className="hidden pt-8 lg:block" aria-label="Your order">
          <div className="sticky top-36 rounded-3xl border border-paper-line bg-white p-5 shadow-soft-md">
            <CartPanel {...cartProps} acceptingOrders={open} onCheckout={() => setCheckoutOpen(true)} />
          </div>
        </aside>
      </div>

      {/* Cart — mobile bottom bar */}
      {cartCount > 0 && (
        <div className="pb-safe fixed inset-x-0 bottom-0 z-40 border-t border-ink/10 bg-paper/95 px-3 pt-3 backdrop-blur lg:hidden">
          <button
            type="button"
            onClick={() => setCheckoutOpen(true)}
            className="flex min-h-[3.5rem] w-full items-center justify-between gap-3 rounded-full bg-ink px-5 py-3.5 font-cond text-lg font-bold uppercase tracking-wide text-cheese shadow-soft-lg active:scale-[0.99]"
          >
            <span className="flex items-center gap-2">
              <span className="grid h-7 min-w-7 place-items-center rounded-full bg-cheese px-2 text-sm text-ink">
                {cartCount}
                <span className="sr-only"> {cartCount === 1 ? 'item' : 'items'} ·</span>
              </span>
              {open ? 'View order' : 'View order · closed'}
            </span>
            <span className="tabular-nums">{formatCents(total)}</span>
          </button>
        </div>
      )}

      {/* Always mounted, so screen readers announce what goes in it. */}
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-24 z-50 flex justify-center px-4 lg:bottom-8"
      >
        {toast && (
          <div
            key={toast.id}
            className="animate-pop-in rounded-full bg-ink px-5 py-2.5 text-center font-cond text-sm font-bold uppercase tracking-wide text-cheese shadow-soft-lg"
          >
            <span aria-hidden>✓ </span>
            {toast.text}
          </div>
        )}
      </div>

      {sheet && (
        <ItemSheet
          card={sheet.card}
          initialVariant={sheet.variantIndex}
          onClose={closeSheet}
          onConfirm={(v, ids, qty, notes) => {
            addToCart(v.item, variantLabel(sheet.card, v), ids, qty, notes);
            setSheet(null);
          }}
        />
      )}

      {checkoutOpen && (
        <CheckoutSheet
          {...cartProps}
          zoneId={zoneId}
          onZone={chooseZone}
          acceptingOrders={open}
          onClose={closeCheckout}
          orderIdFor={orderIdFor}
          onPlaced={onPlaced}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function isSignature(sectionName: string): boolean {
  return /signature/i.test(sectionName);
}

function sectionNote(sectionName: string): string | null {
  if (/signature/i.test(sectionName)) return 'Large 12" only';
  if (/deal/i.test(sectionName)) return 'Choice of pizzas only from the regular menu';
  if (/^pizza|regular/i.test(sectionName)) return 'Medium 9" · Large 12"';
  return null;
}

function MenuHeader({ canPickup, pickupPct }: { canPickup: boolean; pickupPct: number }) {
  return (
    <div className="bg-ink text-cream">
      <div className="mx-auto max-w-6xl px-4 pb-7 pt-8 md:pb-9 md:pt-10">
        <p className="font-cond text-sm font-bold uppercase tracking-[0.22em] text-cheese">
          {canPickup ? 'Order online · delivery or pick-up' : 'Order online · cash on delivery'}
        </p>
        <h1 className="mt-1 font-display text-6xl uppercase leading-none tracking-wide md:text-7xl">The Menu</h1>
        <p className="mt-2 font-cond text-lg font-semibold italic text-cream/80">{BUSINESS.tagline}</p>
        <ul className="mt-5 flex flex-wrap gap-2 font-cond text-sm font-bold uppercase tracking-wide">
          {canPickup && (
            <li className="rounded-full bg-cheese px-3.5 py-1.5 text-ink shadow-glow">
              {pickupPct}% off when you order online &amp; pick up
            </li>
          )}
          <li className={`rounded-full px-3.5 py-1.5 ${canPickup ? 'border border-cream/20' : 'bg-cheese text-ink'}`}>
            Delivery {FEE_RANGE} · DHA &amp; Clifton
          </li>
          <li className="rounded-full border border-cream/20 px-3.5 py-1.5">12 noon – 1 am</li>
          <li className="rounded-full border border-cream/20 px-3.5 py-1.5">Cash on delivery</li>
        </ul>
        <p className="mt-4 max-w-2xl text-sm leading-snug text-cream/75">{ALLERGY_NOTICE}</p>
      </div>
    </div>
  );
}

/**
 * For a customer who has ordered from this phone before: follow the order
 * that may still be on its way, or put the last one back in the cart.
 */
function ReturningBanner({
  menu,
  lastOrder,
  cartEmpty,
  onOrderAgain,
}: {
  menu: PublishedMenu;
  lastOrder: LastOrder;
  cartEmpty: boolean;
  onOrderAgain: () => void;
}) {
  const summary = useMemo(() => linesSummary(menu, lastOrder.lines), [menu, lastOrder]);
  const trackable = isTrackable(lastOrder);
  const canRepeat = cartEmpty && summary.length > 0;
  if (!trackable && !canRepeat) return null;
  const time = new Date(lastOrder.placedAt).toLocaleTimeString('en-PK', { hour: 'numeric', minute: '2-digit' });
  return (
    <div className="mx-auto mt-5 max-w-6xl px-4">
      <div className="flex flex-col gap-3 rounded-2xl border-2 border-ink bg-white p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="font-cond text-base font-extrabold uppercase tracking-wide text-ink">
            {trackable ? `Your order from ${time}` : 'Welcome back'}
          </p>
          {summary && (
            <p className="truncate text-sm text-ink-muted">
              {trackable ? summary : `Last time: ${summary}`}
            </p>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {trackable && (
            <Link
              href={trackPath(lastOrder.orderId)}
              className="rounded-full bg-ink px-5 py-2.5 font-cond text-base font-bold uppercase tracking-wide text-cheese hover:bg-ink-soft"
            >
              Track it →
            </Link>
          )}
          {canRepeat && (
            <button
              type="button"
              onClick={onOrderAgain}
              className={`rounded-full px-5 py-2.5 font-cond text-base font-bold uppercase tracking-wide ${
                trackable ? 'border-2 border-ink text-ink hover:bg-paper-deep' : 'bg-ink text-cheese hover:bg-ink-soft'
              }`}
            >
              Order again
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Sticky category pills with scroll-spy: the pill for the section under the
 * reader lights up, and a tap scrolls to that section.
 */
function CategoryRail({ sections }: { sections: Array<{ anchor: string; name: string }> }) {
  const [active, setActive] = useState(sections[0]?.anchor ?? '');
  const railRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const els = sections.map((s) => document.getElementById(s.anchor)).filter((e): e is HTMLElement => e !== null);
    if (els.length === 0 || typeof IntersectionObserver === 'undefined') return;
    const obs = new IntersectionObserver(
      (entries) => {
        const hit = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        if (hit) setActive(hit.target.id);
      },
      { rootMargin: '-35% 0px -60% 0px' },
    );
    els.forEach((e) => obs.observe(e));
    return () => obs.disconnect();
  }, [sections]);

  // Keep the lit pill in view on narrow screens. Scrolls the rail only, and
  // instantly: scrollIntoView would also nudge the page, and a second smooth
  // scroll can cut short the page's own smooth scroll to the section just
  // tapped (older Chrome runs one smooth scroll at a time).
  useEffect(() => {
    const rail = railRef.current;
    const pill = rail?.querySelector<HTMLElement>(`[data-anchor="${active}"]`);
    if (!rail || !pill) return;
    const offset = pill.getBoundingClientRect().left - rail.getBoundingClientRect().left;
    const left = rail.scrollLeft + offset - (rail.clientWidth - pill.offsetWidth) / 2;
    rail.scrollTo({ left: Math.max(0, left), behavior: 'instant' });
  }, [active]);

  return (
    <nav
      aria-label="Menu sections"
      className="sticky top-16 z-30 border-b border-ink/10 bg-paper/95 backdrop-blur-md sm:top-[4.5rem]"
    >
      <div ref={railRef} className="scrollbar-hide mx-auto flex max-w-6xl gap-2 overflow-x-auto px-4 py-3">
        {sections.map((s) => (
          <a
            key={s.anchor}
            href={`#${s.anchor}`}
            data-anchor={s.anchor}
            aria-current={s.anchor === active ? 'true' : undefined}
            onClick={() => setActive(s.anchor)}
            className={`whitespace-nowrap rounded-full px-4 py-2 font-cond text-[0.95rem] font-bold uppercase tracking-wide transition-colors ${
              s.anchor === active
                ? 'bg-ink text-cheese'
                : isDealSection(s.name)
                  ? 'border border-ink bg-cheese text-ink hover:bg-cheese-hot'
                  : 'border border-ink/15 bg-white text-ink-soft hover:border-ink/40'
            }`}
          >
            {s.name}
          </a>
        ))}
      </div>
    </nav>
  );
}

function SectionTitle({ id, name, note }: { id: string; name: string; note: string | null }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-1 border-b-[3px] border-ink pb-2">
      <h2 id={id} className="font-display text-4xl uppercase leading-none tracking-wide text-ink md:text-5xl">
        {name}
      </h2>
      {note && <p className="font-cond text-sm font-bold uppercase tracking-wider text-ink-muted">{note}</p>}
    </div>
  );
}

function InCartBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span className="shrink-0 rounded-full bg-cheese px-2 py-0.5 font-cond text-xs font-bold uppercase text-ink">
      {count} in order
    </span>
  );
}

function PickupOnly() {
  return (
    <a
      href={WA_ORDER_URL}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center rounded-full border-2 border-dashed border-ink/25 px-3 py-1.5 font-cond text-sm font-bold uppercase tracking-wide text-ink-muted hover:border-ink/50"
    >
      Pick-up only · ask on WhatsApp
    </a>
  );
}

/** Size buttons: each shows its size and price and adds that exact item. */
function VariantButtons({
  card,
  qtyByItem,
  canPickup,
  onPick,
  dark = false,
  onGold = false,
}: {
  card: MenuCard;
  qtyByItem: Map<string, number>;
  canPickup: boolean;
  onPick: PickFn;
  dark?: boolean;
  /** On a gold deal card: a solid ink button. */
  onGold?: boolean;
}) {
  // Pick-up-only food is orderable only while online pick-up is.
  if (card.pickupOnly && !canPickup) return <PickupOnly />;
  const sized = card.variants.length > 1;
  return (
    <div className={sized ? 'grid grid-cols-2 gap-2' : 'flex flex-wrap items-center gap-2'}>
      {card.variants.map((v, i) => {
        const inCart = qtyByItem.get(v.item.posItemId) ?? 0;
        const hasChoices = v.item.modifierGroups.length > 0;
        return (
          <button
            type="button"
            key={v.item.posItemId}
            onClick={() => onPick(card, i)}
            aria-label={`${hasChoices ? 'Choose options for' : 'Add'} ${variantLabel(card, v)}, ${formatCents(
              v.item.basePriceCents,
            )}${inCart > 0 ? ` (${inCart} in your order)` : ''}`}
            className={`group/btn relative flex min-h-[2.75rem] items-center gap-2 py-1.5 pr-1.5 font-cond font-bold uppercase tracking-wide transition-all active:scale-95 ${
              sized ? 'justify-between rounded-2xl pl-3 text-left' : 'rounded-full pl-3.5'
            } ${
              onGold
                ? 'bg-ink py-2 text-lg text-cheese hover:bg-ink-soft'
                : dark
                  ? 'bg-cheese text-ink hover:bg-cheese-hot'
                  : 'border-2 border-ink bg-white text-ink hover:bg-ink hover:text-cheese'
            }`}
          >
            {sized ? (
              <span className="leading-tight">
                <span className="block text-[0.7rem] opacity-75">{sizeLabel(v.size)}</span>
                <span className="block tabular-nums">{formatCents(v.item.basePriceCents)}</span>
              </span>
            ) : (
              <>
                {v.size && <span className="text-xs opacity-80">{sizeLabel(v.size)}</span>}
                <span className="tabular-nums">{formatCents(v.item.basePriceCents)}</span>
              </>
            )}
            <span
              aria-hidden
              className={`grid h-7 w-7 place-items-center rounded-full text-lg leading-none ${
                dark && !onGold ? 'bg-ink text-cheese' : 'bg-cheese text-ink'
              }`}
            >
              {hasChoices ? '›' : '+'}
            </span>
            {inCart > 0 && (
              <span
                aria-hidden
                className="absolute -right-1 -top-2 grid h-5 min-w-5 place-items-center rounded-full bg-red-600 px-1 text-[0.7rem] text-white"
              >
                {inCart}
              </span>
            )}
          </button>
        );
      })}
      {card.pickupOnly && (
        <span className="font-cond text-xs font-bold uppercase tracking-wider opacity-70">Pick-up only</span>
      )}
    </div>
  );
}

interface CardProps {
  card: MenuCard;
  qtyByItem: Map<string, number>;
  canPickup: boolean;
  onPick: PickFn;
}

function countFor(card: MenuCard, qtyByItem: Map<string, number>): number {
  return card.variants.reduce((s, v) => s + (qtyByItem.get(v.item.posItemId) ?? 0), 0);
}

/** Signature pizzas and anything photographed: the food leads. */
const PhotoCard = memo(function PhotoCard({ card, qtyByItem, canPickup, onPick }: CardProps) {
  const count = countFor(card, qtyByItem);
  return (
    <article className="group relative flex overflow-hidden rounded-3xl bg-ink text-cream shadow-soft-md">
      <div className="relative w-[42%] shrink-0 overflow-hidden bg-[radial-gradient(circle_at_50%_55%,rgba(245,179,1,0.28),transparent_68%)]">
        {card.image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={card.image}
            srcSet={menuImageSrcSet(card.image)}
            sizes="(min-width: 1024px) 200px, 45vw"
            alt={card.name}
            loading="lazy"
            decoding="async"
            className="absolute left-1/2 top-1/2 w-[118%] max-w-none -translate-x-[38%] -translate-y-1/2 drop-shadow-[0_18px_24px_rgba(0,0,0,0.55)] transition-transform duration-700 group-hover:rotate-[24deg]"
          />
        ) : (
          <div aria-hidden className="grid h-full place-items-center font-display text-5xl text-cheese/30">
            CO
          </div>
        )}
      </div>
      <div className="flex min-w-0 flex-1 flex-col p-4 pl-3">
        <div className="flex items-start justify-between gap-2">
          <h3 className="font-display text-2xl uppercase leading-none tracking-wide">{card.name}</h3>
          <InCartBadge count={count} />
        </div>
        {card.description && (
          <p className="mt-1.5 line-clamp-4 text-[0.82rem] leading-snug text-cream/70">{card.description}</p>
        )}
        <div className="mt-auto pt-3">
          <VariantButtons card={card} qtyByItem={qtyByItem} canPickup={canPickup} onPick={onPick} dark />
        </div>
      </div>
    </article>
  );
});

/** Everything else: set like a line on the printed menu. */
const ItemCard = memo(function ItemCard({ card, qtyByItem, canPickup, onPick }: CardProps) {
  const count = countFor(card, qtyByItem);
  const single = card.variants.length === 1 ? card.variants[0] : undefined;
  return (
    <article className="flex flex-col rounded-2xl border border-paper-line bg-white p-4 shadow-soft-sm transition-shadow hover:shadow-soft-md">
      <div className="flex items-start justify-between gap-2">
        <h3 className="font-cond text-xl font-extrabold uppercase leading-tight tracking-wide text-ink">
          {card.name}
          {single?.size && (
            <span className="ml-2 align-middle text-xs font-bold tracking-widest text-ink-muted">
              {sizeLabel(single.size)}
            </span>
          )}
        </h3>
        <InCartBadge count={count} />
      </div>
      {card.description && <p className="mt-1 text-sm leading-snug text-ink-muted">{card.description}</p>}
      <div className="mt-auto pt-3">
        <VariantButtons card={card} qtyByItem={qtyByItem} canPickup={canPickup} onPick={onPick} />
      </div>
    </article>
  );
});

/**
 * A value deal, set like the printed menu's gold deals panel: numbered, a big
 * price, and what it saves against buying the same things one by one (worked
 * out from the live menu — no badge when that can't be priced).
 */
const DealCard = memo(function DealCard({
  card,
  n,
  worthCents,
  qtyByItem,
  canPickup,
  onPick,
}: CardProps & { n: number; worthCents: number | null }) {
  const count = countFor(card, qtyByItem);
  const price = card.variants[0]?.item.basePriceCents ?? 0;
  const save = worthCents !== null ? worthCents - price : 0;
  const num = String(n).padStart(2, '0');
  return (
    <article className="relative flex flex-col overflow-hidden rounded-3xl border-2 border-ink bg-cheese p-5 text-ink shadow-soft-md">
      <span
        aria-hidden
        className="pointer-events-none absolute -bottom-7 -right-1 select-none font-display text-[8.5rem] leading-none text-ink/[0.08]"
      >
        {num}
      </span>
      <div className="relative flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-cond text-xs font-extrabold uppercase tracking-[0.22em] text-ink/70">Value deal {num}</p>
          <h3 className="mt-1 font-display text-3xl uppercase leading-none tracking-wide">{card.name}</h3>
        </div>
        {save > 0 && (
          <span className="shrink-0 -rotate-6 rounded-xl bg-ink px-2.5 py-1.5 text-center font-cond font-extrabold uppercase leading-none text-cheese shadow-soft-sm">
            <span className="block text-[0.65rem] tracking-widest">Save</span>
            <span className="mt-0.5 block text-lg tabular-nums">{formatCents(save)}</span>
          </span>
        )}
      </div>
      {card.description && <p className="relative mt-2 font-cond text-lg font-bold leading-snug">{card.description}</p>}
      {save > 0 && worthCents !== null && (
        <p className="relative mt-0.5 text-sm font-medium text-ink/70">
          <s className="tabular-nums">{formatCents(worthCents)}</s> if bought separately
        </p>
      )}
      <div className="relative mt-auto flex flex-wrap items-center gap-3 pt-4">
        <VariantButtons card={card} qtyByItem={qtyByItem} canPickup={canPickup} onPick={onPick} onGold />
        {count > 0 && (
          <span className="rounded-full bg-ink px-2.5 py-1 font-cond text-xs font-bold uppercase text-cheese">
            {count} in order
          </span>
        )}
      </div>
    </article>
  );
});

// ---------------------------------------------------------------------------

/**
 * Shown when the till is not accepting online orders — the shop is closed, or
 * the POS is switched off. The menu stays browsable and WhatsApp still works,
 * so an interested customer is redirected rather than turned away.
 */
function ClosedBanner() {
  return (
    <div className="mx-auto mt-5 max-w-6xl px-4">
      <div className="rounded-2xl border-2 border-ink bg-cheese p-4 text-ink">
        <p className="font-display text-2xl uppercase tracking-wide">We&rsquo;re not taking online orders right now</p>
        <p className="mt-1 text-sm font-medium">
          The kitchen isn&rsquo;t accepting website orders at the moment ({BUSINESS.hours.toLowerCase()}). You can
          still build your order here and send it to us on WhatsApp from &ldquo;View order&rdquo; — we reply fast.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {BUSINESS.whatsappLines.map((l) => (
            <a
              key={l.url}
              href={`${l.url}?text=${encodeURIComponent("Hi Cheese O'Clock! I'd like to place an order: ")}`}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-full bg-ink px-5 py-2.5 font-cond font-bold uppercase tracking-wide text-cheese transition-transform hover:scale-105"
            >
              WhatsApp {l.display}
            </a>
          ))}
        </div>
      </div>
    </div>
  );
}
