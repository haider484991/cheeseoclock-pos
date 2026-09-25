'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { formatCents } from '@/lib/format';
import { BUSINESS, WA_ORDER_URL } from '@/lib/business';
import {
  DELIVERY_ZONES,
  deliveryChargeItemFor,
  findZone,
  type DeliveryZone,
} from '@/lib/delivery-zones';
import { priceOrder, type PricedLine } from '@/lib/pricing';
import {
  ALLERGY_NOTICE,
  buildMenuView,
  dealWorthCents,
  groupLabel,
  isDealSection,
  isPickupOnly,
  optionLabel,
  requiredCount,
  sizeLabel,
  type MenuCard,
  type MenuVariant,
} from '@/lib/menu-view';
import {
  isLeaveOutChoice,
  type PublishedMenu,
  type PublishedMenuItem,
  type PublishedModifierGroup,
  type WebFulfilment,
} from '@cheeseoclock/shared-types';

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
 * Totals shown here are estimates re-priced server-side on submit; the POS
 * receipt is the authoritative bill (COD — the rider collects against it).
 */

interface CartLine {
  key: string; // posItemId + sorted modifier ids + note — merges identical lines
  item: PublishedMenuItem;
  /** Card name + size, e.g. "Fajita Pizza · Large 12"". */
  label: string;
  quantity: number;
  modifierIds: string[];
  /** The item's allergy / special request; prints on the kitchen ticket. */
  notes: string | null;
}

const ZONE_KEY = 'coc.zone';

function readSavedZone(): string {
  try {
    return window.localStorage.getItem(ZONE_KEY) ?? '';
  } catch {
    return '';
  }
}

function saveZone(id: string): void {
  try {
    window.localStorage.setItem(ZONE_KEY, id);
  } catch {
    // Private mode — the customer just picks it again next time.
  }
}

function variantLabel(card: MenuCard, v: MenuVariant): string {
  return v.size ? `${card.name} · ${sizeLabel(v.size)}` : card.name;
}

function modifierIndex(item: PublishedMenuItem) {
  return new Map(
    item.modifierGroups.flatMap((g) => g.modifiers.map((m) => [m.posModifierId, m] as const)),
  );
}

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
    const id = setInterval(() => void check(), 60_000);
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
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const saved = readSavedZone();
    if (findZone(saved)) setZoneId(saved);
  }, []);

  function chooseZone(id: string) {
    setZoneId(id);
    if (findZone(id)) saveZone(id);
  }

  const [chosenFulfilment, setFulfilment] = useState<WebFulfilment>('delivery');
  // Pickup silently falls back to delivery if the till stops offering it.
  const fulfilment: WebFulfilment = canPickup ? chosenFulfilment : 'delivery';
  const pickup = fulfilment === 'pickup';
  const zone = pickup ? undefined : findZone(zoneId);

  function lineUnitPrice(line: CartLine): number {
    const mods = modifierIndex(line.item);
    return (
      line.item.basePriceCents +
      line.modifierIds.reduce((s, id) => s + (mods.get(id)?.priceDeltaCents ?? 0), 0)
    );
  }

  // Same maths as the server and the till (lib/pricing). The delivery fee is
  // a real till item, taxed like one; pickup takes its discount off the lot.
  const subtotal = cart.reduce((s, l) => s + lineUnitPrice(l) * l.quantity, 0);
  const priced: PricedLine[] = cart.map((l) => ({
    lineTotalCents: lineUnitPrice(l) * l.quantity,
    taxRateBps: l.item.taxRateBps,
  }));
  const feeItem = zone ? deliveryChargeItemFor(menu, zone.feeCents) : undefined;
  const deliveryFee = zone && cart.length > 0 ? zone.feeCents : 0;
  if (deliveryFee > 0) priced.push({ lineTotalCents: deliveryFee, taxRateBps: feeItem?.taxRateBps ?? 0 });
  const totals = priceOrder(priced, pickup ? pickupPct : 0);
  const { discountCents: discount, taxCents: tax, totalCents: total } = totals;
  const cartCount = cart.reduce((s, l) => s + l.quantity, 0);
  const pickupOnlyInCart = cart.filter((l) => isPickupOnly(l.item)).map((l) => l.label);

  const qtyByItem = useMemo(() => {
    const m = new Map<string, number>();
    for (const l of cart) m.set(l.item.posItemId, (m.get(l.item.posItemId) ?? 0) + l.quantity);
    return m;
  }, [cart]);

  function flash(message: string) {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 1800);
  }

  function addToCart(
    item: PublishedMenuItem,
    label: string,
    modifierIds: string[],
    quantity = 1,
    notes: string | null = null,
  ) {
    const key = `${item.posItemId}|${[...modifierIds].sort().join(',')}|${notes ?? ''}`;
    setCart((prev) => {
      const existing = prev.find((l) => l.key === key);
      if (existing) {
        return prev.map((l) => (l.key === key ? { ...l, quantity: l.quantity + quantity } : l));
      }
      return [...prev, { key, item, label, quantity, modifierIds, notes }];
    });
    flash(`Added ${quantity > 1 ? `${quantity} × ` : ''}${label}`);
  }

  /** A size tap: straight into the cart unless the item has choices to make. */
  function pickVariant(card: MenuCard, variantIndex: number) {
    const v = card.variants[variantIndex];
    if (!v || (card.pickupOnly && !canPickup)) return;
    if (v.item.modifierGroups.length > 0) {
      setSheet({ card, variantIndex });
    } else {
      addToCart(v.item, variantLabel(card, v), []);
    }
  }

  function setQty(key: string, qty: number) {
    setCart((prev) =>
      qty <= 0
        ? prev.filter((l) => l.key !== key)
        : prev.map((l) => (l.key === key ? { ...l, quantity: Math.min(qty, 50) } : l)),
    );
  }

  const cartProps = {
    cart,
    lineUnitPrice,
    subtotal,
    deliveryFee,
    discount,
    zone,
    tax,
    total,
    setQty,
    fulfilment,
    canPickup,
    pickupPct,
    onFulfilment: setFulfilment,
    pickupOnlyInCart,
  };

  return (
    <div className="pb-28 lg:pb-12">
      <MenuHeader canPickup={canPickup} pickupPct={pickupPct} />

      {!open && <ClosedBanner />}

      <CategoryRail sections={sections.map((s) => ({ anchor: s.anchor, name: s.name }))} />

      <div className="mx-auto max-w-6xl px-4 lg:grid lg:grid-cols-[1fr_22rem] lg:gap-8">
        <div>
          {sections.map((s) => (
            <section key={s.id} id={s.anchor} className="scroll-mt-36 pt-8">
              <SectionTitle name={s.name} note={sectionNote(s.name)} />
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
                      onPick={(v) => pickVariant(card, v)}
                    />
                  ) : isSignature(s.name) || card.image ? (
                    <PhotoCard
                      key={card.key}
                      card={card}
                      qtyByItem={qtyByItem}
                      canPickup={canPickup}
                      onPick={(i) => pickVariant(card, i)}
                    />
                  ) : (
                    <ItemCard
                      key={card.key}
                      card={card}
                      qtyByItem={qtyByItem}
                      canPickup={canPickup}
                      onPick={(i) => pickVariant(card, i)}
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
        <aside className="hidden pt-8 lg:block">
          <div className="sticky top-36 rounded-3xl border border-paper-line bg-white p-5 shadow-soft-md">
            <CartPanel
              {...cartProps}
              acceptingOrders={open}
              onCheckout={() => setCheckoutOpen(true)}
            />
          </div>
        </aside>
      </div>

      {/* Cart — mobile bottom bar */}
      {cartCount > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t border-ink/10 bg-paper/95 p-3 backdrop-blur lg:hidden">
          <button
            onClick={() => setCheckoutOpen(true)}
            disabled={!open}
            className="flex w-full items-center justify-between rounded-full bg-ink px-6 py-4 font-cond text-lg font-bold uppercase tracking-wide text-cheese shadow-soft-lg active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-40"
          >
            {open ? (
              <>
                <span className="flex items-center gap-2">
                  <span className="grid h-7 min-w-7 place-items-center rounded-full bg-cheese px-2 text-sm text-ink">
                    {cartCount}
                  </span>
                  View order
                </span>
                <span className="tabular-nums">{formatCents(total)}</span>
              </>
            ) : (
              <span className="w-full text-center">Online ordering is closed right now</span>
            )}
          </button>
        </div>
      )}

      {toast && (
        <div
          role="status"
          className="pointer-events-none fixed inset-x-0 bottom-24 z-50 flex justify-center px-4 lg:bottom-8"
        >
          <div className="animate-pop-in rounded-full bg-ink px-5 py-2.5 font-cond text-sm font-bold uppercase tracking-wide text-cheese shadow-soft-lg">
            ✓ {toast}
          </div>
        </div>
      )}

      {sheet && (
        <ItemSheet
          card={sheet.card}
          initialVariant={sheet.variantIndex}
          onClose={() => setSheet(null)}
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
          onClose={() => setCheckoutOpen(false)}
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
        <h1 className="mt-1 font-display text-6xl uppercase leading-none tracking-wide md:text-7xl">
          The Menu
        </h1>
        <p className="mt-2 font-cond text-lg font-semibold italic text-cream/80">
          {BUSINESS.tagline}
        </p>
        <ul className="mt-5 flex flex-wrap gap-2 font-cond text-sm font-bold uppercase tracking-wide">
          {canPickup && (
            <li className="rounded-full bg-cheese px-3.5 py-1.5 text-ink shadow-glow">
              {pickupPct}% off when you order online &amp; pick up
            </li>
          )}
          <li
            className={`rounded-full px-3.5 py-1.5 ${
              canPickup ? 'border border-cream/20' : 'bg-cheese text-ink'
            }`}
          >
            Delivery Rs 200–250 · DHA &amp; Clifton
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
 * Sticky category pills with scroll-spy: the pill for the section under the
 * reader lights up, and a tap scrolls to that section.
 */
function CategoryRail({ sections }: { sections: Array<{ anchor: string; name: string }> }) {
  const [active, setActive] = useState(sections[0]?.anchor ?? '');
  const railRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const els = sections
      .map((s) => document.getElementById(s.anchor))
      .filter((e): e is HTMLElement => e !== null);
    if (els.length === 0 || typeof IntersectionObserver === 'undefined') return;
    const obs = new IntersectionObserver(
      (entries) => {
        const hit = entries.filter((e) => e.isIntersecting).sort(
          (a, b) => a.boundingClientRect.top - b.boundingClientRect.top,
        )[0];
        if (hit) setActive(hit.target.id);
      },
      { rootMargin: '-35% 0px -60% 0px' },
    );
    els.forEach((e) => obs.observe(e));
    return () => obs.disconnect();
  }, [sections]);

  // Keep the lit pill in view on narrow screens.
  useEffect(() => {
    const pill = railRef.current?.querySelector<HTMLElement>(`[data-anchor="${active}"]`);
    pill?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
  }, [active]);

  return (
    <nav
      aria-label="Menu sections"
      className="sticky top-16 z-30 border-b border-ink/10 bg-paper/95 backdrop-blur-md sm:top-[4.5rem]"
    >
      <div
        ref={railRef}
        className="scrollbar-hide mx-auto flex max-w-6xl gap-2 overflow-x-auto px-4 py-3"
      >
        {sections.map((s) => (
          <a
            key={s.anchor}
            href={`#${s.anchor}`}
            data-anchor={s.anchor}
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

function SectionTitle({ name, note }: { name: string; note: string | null }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-1 border-b-[3px] border-ink pb-2">
      <h2 className="font-display text-4xl uppercase leading-none tracking-wide text-ink md:text-5xl">
        {name}
      </h2>
      {note && (
        <p className="font-cond text-sm font-bold uppercase tracking-wider text-ink-muted">{note}</p>
      )}
    </div>
  );
}

function InCartBadge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span className="rounded-full bg-cheese px-2 py-0.5 font-cond text-xs font-bold uppercase text-ink">
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
  onPick: (variantIndex: number) => void;
  dark?: boolean;
  /** On a gold deal card: a solid ink button. */
  onGold?: boolean;
}) {
  // Pick-up-only food is orderable only while online pick-up is.
  if (card.pickupOnly && !canPickup) return <PickupOnly />;
  const hasChoices = card.variants.some((v) => v.item.modifierGroups.length > 0);
  const sized = card.variants.length > 1;
  return (
    <div className={sized ? 'grid grid-cols-2 gap-2' : 'flex flex-wrap items-center gap-2'}>
      {card.variants.map((v, i) => {
        const inCart = qtyByItem.get(v.item.posItemId) ?? 0;
        return (
          <button
            key={v.item.posItemId}
            onClick={() => onPick(i)}
            className={`group/btn relative flex items-center gap-2 py-1.5 pr-1.5 font-cond font-bold uppercase tracking-wide transition-all active:scale-95 ${
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
              <span className="absolute -right-1 -top-2 grid h-5 min-w-5 place-items-center rounded-full bg-red-600 px-1 text-[0.7rem] text-white">
                {inCart}
              </span>
            )}
            <span className="sr-only">
              {hasChoices ? 'Choose options for' : 'Add'} {variantLabel(card, v)}
            </span>
          </button>
        );
      })}
      {card.pickupOnly && (
        <span className="font-cond text-xs font-bold uppercase tracking-wider opacity-70">
          Pick-up only
        </span>
      )}
    </div>
  );
}

/** Signature pizzas and anything photographed: the food leads. */
function PhotoCard({
  card,
  qtyByItem,
  canPickup,
  onPick,
}: {
  card: MenuCard;
  qtyByItem: Map<string, number>;
  canPickup: boolean;
  onPick: (variantIndex: number) => void;
}) {
  const count = card.variants.reduce((s, v) => s + (qtyByItem.get(v.item.posItemId) ?? 0), 0);
  return (
    <article className="group relative flex overflow-hidden rounded-3xl bg-ink text-cream shadow-soft-md">
      <div className="relative w-[42%] shrink-0 overflow-hidden bg-[radial-gradient(circle_at_50%_55%,rgba(245,179,1,0.28),transparent_68%)]">
        {card.image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={card.image}
            alt={card.name}
            loading="lazy"
            className="absolute left-1/2 top-1/2 w-[118%] max-w-none -translate-x-[38%] -translate-y-1/2 drop-shadow-[0_18px_24px_rgba(0,0,0,0.55)] transition-transform duration-700 group-hover:rotate-[24deg]"
          />
        ) : (
          <div className="grid h-full place-items-center font-display text-5xl text-cheese/30">
            CO
          </div>
        )}
      </div>
      <div className="flex min-w-0 flex-1 flex-col p-4 pl-3">
        <div className="flex items-start justify-between gap-2">
          <h3 className="font-display text-2xl uppercase leading-none tracking-wide">
            {card.name}
          </h3>
          <InCartBadge count={count} />
        </div>
        {card.description && (
          <p className="mt-1.5 line-clamp-4 text-[0.82rem] leading-snug text-cream/70">
            {card.description}
          </p>
        )}
        <div className="mt-auto pt-3">
          <VariantButtons card={card} qtyByItem={qtyByItem} canPickup={canPickup} onPick={onPick} dark />
        </div>
      </div>
    </article>
  );
}

/** Everything else: set like a line on the printed menu. */
function ItemCard({
  card,
  qtyByItem,
  canPickup,
  onPick,
}: {
  card: MenuCard;
  qtyByItem: Map<string, number>;
  canPickup: boolean;
  onPick: (variantIndex: number) => void;
}) {
  const count = card.variants.reduce((s, v) => s + (qtyByItem.get(v.item.posItemId) ?? 0), 0);
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
      {card.description && (
        <p className="mt-1 text-sm leading-snug text-ink-muted">{card.description}</p>
      )}
      <div className="mt-auto pt-3">
        <VariantButtons card={card} qtyByItem={qtyByItem} canPickup={canPickup} onPick={onPick} />
      </div>
    </article>
  );
}

/**
 * A value deal, set like the printed menu's gold deals panel: numbered, a big
 * price, and what it saves against buying the same things one by one (worked
 * out from the live menu — no badge when that can't be priced).
 */
function DealCard({
  card,
  n,
  worthCents,
  qtyByItem,
  canPickup,
  onPick,
}: {
  card: MenuCard;
  n: number;
  worthCents: number | null;
  qtyByItem: Map<string, number>;
  canPickup: boolean;
  onPick: (variantIndex: number) => void;
}) {
  const count = card.variants.reduce((s, v) => s + (qtyByItem.get(v.item.posItemId) ?? 0), 0);
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
          <p className="font-cond text-xs font-extrabold uppercase tracking-[0.22em] text-ink/60">
            Value deal {num}
          </p>
          <h3 className="mt-1 font-display text-3xl uppercase leading-none tracking-wide">{card.name}</h3>
        </div>
        {save > 0 && (
          <span className="shrink-0 -rotate-6 rounded-xl bg-ink px-2.5 py-1.5 text-center font-cond font-extrabold uppercase leading-none text-cheese shadow-soft-sm">
            <span className="block text-[0.65rem] tracking-widest">Save</span>
            <span className="mt-0.5 block text-lg tabular-nums">{formatCents(save)}</span>
          </span>
        )}
      </div>
      {card.description && (
        <p className="relative mt-2 font-cond text-lg font-bold leading-snug">{card.description}</p>
      )}
      {save > 0 && worthCents !== null && (
        <p className="relative mt-0.5 text-sm font-medium text-ink/65">
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
}

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
        <p className="font-display text-2xl uppercase tracking-wide">
          We&rsquo;re not taking online orders right now
        </p>
        <p className="mt-1 text-sm font-medium">
          The kitchen isn&rsquo;t accepting website orders at the moment ({BUSINESS.hours.toLowerCase()}).
          Browse the menu, and order on WhatsApp — we reply fast.
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

interface CartProps {
  cart: CartLine[];
  lineUnitPrice: (l: CartLine) => number;
  subtotal: number;
  deliveryFee: number;
  /** Pickup discount (0 on a delivery). */
  discount: number;
  zone: DeliveryZone | undefined;
  tax: number;
  total: number;
  setQty: (key: string, qty: number) => void;
  fulfilment: WebFulfilment;
  /** The till takes pickup orders right now. */
  canPickup: boolean;
  /** The pickup discount that till bills. */
  pickupPct: number;
  onFulfilment: (f: WebFulfilment) => void;
  /** Labels of pick-up-only lines in the cart (they block a delivery). */
  pickupOnlyInCart: string[];
}

/**
 * Delivery or pick-up. Pick-up shows the saving up front — it is the printed
 * menu's headline offer. Hidden entirely while the till can't take pickups.
 */
function FulfilmentToggle(props: Pick<CartProps, 'fulfilment' | 'canPickup' | 'pickupPct' | 'onFulfilment'>) {
  if (!props.canPickup) return null;
  const opt = (f: WebFulfilment, title: string, note: string) => {
    const on = props.fulfilment === f;
    return (
      <button
        type="button"
        onClick={() => props.onFulfilment(f)}
        aria-pressed={on}
        className={`rounded-2xl border-2 px-3 py-2 text-left transition-colors ${
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
      {opt('delivery', 'Delivery', 'Rs 200–250 · DHA & Clifton')}
      {opt('pickup', `Pick up · ${props.pickupPct}% off`, 'Collect from DHA Phase 6')}
    </div>
  );
}

function CartPanel(props: CartProps & { acceptingOrders: boolean; onCheckout: () => void }) {
  const { cart } = props;
  return (
    <div>
      <h2 className="font-display text-3xl uppercase tracking-wide text-ink">Your order</h2>
      {cart.length === 0 ? (
        <div className="mt-4 rounded-2xl border-2 border-dashed border-paper-line px-4 py-8 text-center">
          <p className="font-cond text-lg font-bold uppercase text-ink">Nothing here yet</p>
          <p className="mt-1 text-sm text-ink-muted">Tap a price to add it.</p>
        </div>
      ) : (
        <>
          <ul className="mt-3 max-h-[40vh] space-y-2 overflow-y-auto pr-1">
            {cart.map((l) => (
              <CartLineRow key={l.key} line={l} unit={props.lineUnitPrice(l)} setQty={props.setQty} />
            ))}
          </ul>
          {props.canPickup && (
            <div className="mt-3">
              <FulfilmentToggle {...props} />
            </div>
          )}
          <Totals {...props} />
          <button
            onClick={props.onCheckout}
            disabled={!props.acceptingOrders}
            className="mt-4 w-full rounded-full bg-ink py-3.5 font-cond text-lg font-bold uppercase tracking-wide text-cheese transition-all hover:bg-ink-soft active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-40"
          >
            {props.acceptingOrders ? `Checkout · ${formatCents(props.total)}` : 'Online ordering is closed'}
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
  const mods = modifierIndex(line.item);
  const names = line.modifierIds
    .map((id) => mods.get(id)?.name)
    .filter((n): n is string => Boolean(n))
    .map(optionLabel);
  const leaveOuts = names.filter(isLeaveOutChoice);
  const others = names.filter((n) => !isLeaveOutChoice(n));
  return (
    <li className="flex items-start gap-2 rounded-2xl bg-paper p-3">
      <div className="min-w-0 flex-1">
        <div className="font-cond text-base font-bold uppercase leading-tight text-ink">{line.label}</div>
        {leaveOuts.length > 0 && (
          <div className="mt-0.5 text-xs font-bold leading-snug text-red-700">{leaveOuts.join(' · ')}</div>
        )}
        {others.length > 0 && (
          <div className="mt-0.5 text-xs leading-snug text-ink-muted">{others.join(' · ')}</div>
        )}
        {line.notes && (
          <div className="mt-0.5 break-words text-xs font-semibold leading-snug text-ink">Note: {line.notes}</div>
        )}
        <div className="mt-1 font-cond text-sm font-bold tabular-nums text-ink">
          {formatCents(unit * line.quantity)}
        </div>
      </div>
      <Stepper
        value={line.quantity}
        onChange={(q) => setQty(line.key, q)}
        label={line.label}
      />
    </li>
  );
}

function Stepper({
  value,
  onChange,
  label,
  min = 0,
}: {
  value: number;
  onChange: (v: number) => void;
  label: string;
  min?: number;
}) {
  return (
    <div className="flex items-center gap-0.5 rounded-full border border-ink/15 bg-white p-0.5">
      <button
        onClick={() => onChange(Math.max(min, value - 1))}
        className="grid h-8 w-8 place-items-center rounded-full text-lg font-bold text-ink hover:bg-paper-deep disabled:opacity-30"
        disabled={value <= min}
        aria-label={`One less ${label}`}
      >
        −
      </button>
      <span className="min-w-[2ch] text-center font-cond text-base font-bold tabular-nums text-ink">
        {value}
      </span>
      <button
        onClick={() => onChange(Math.min(50, value + 1))}
        className="grid h-8 w-8 place-items-center rounded-full text-lg font-bold text-ink hover:bg-paper-deep"
        aria-label={`One more ${label}`}
      >
        +
      </button>
    </div>
  );
}

function Totals(props: CartProps) {
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
          <dd className="tabular-nums">
            {props.zone ? formatCents(props.deliveryFee) : 'Rs 200–250'}
          </dd>
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
          {!pickup && !props.zone && (
            <span className="ml-1 text-xs font-bold text-ink-muted">+ delivery</span>
          )}
        </dd>
      </div>
    </dl>
  );
}

// ---------------------------------------------------------------------------

function Sheet({
  onClose,
  children,
  label,
}: {
  onClose: () => void;
  children: React.ReactNode;
  label: string;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-ink/70 backdrop-blur-sm sm:items-center sm:p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className="flex max-h-[92vh] w-full animate-sheet-up flex-col overflow-hidden rounded-t-3xl bg-paper text-ink shadow-soft-lg sm:max-w-lg sm:rounded-3xl"
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

function CloseButton({ onClose }: { onClose: () => void }) {
  return (
    <button
      onClick={onClose}
      className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-white text-lg text-ink shadow-soft-sm hover:bg-paper-deep"
      aria-label="Close"
    >
      ✕
    </button>
  );
}

/** What the disabled Add button asks for: "Pick 3 more", "Choose your dip". */
function unmetText(group: PublishedModifierGroup, selected: Set<string>): string {
  const need = requiredCount(group);
  const chosen = group.modifiers.filter((m) => selected.has(m.posModifierId)).length;
  if (need > 1) return `Pick ${need - chosen} more`;
  const label = groupLabel(group);
  return /^choose\b/i.test(label) ? label : `Choose ${label.toLowerCase()}`;
}

function ItemSheet({
  card,
  initialVariant,
  onClose,
  onConfirm,
}: {
  card: MenuCard;
  initialVariant: number;
  onClose: () => void;
  onConfirm: (variant: MenuVariant, modifierIds: string[], quantity: number, notes: string | null) => void;
}) {
  const [variantIndex, setVariantIndex] = useState(initialVariant);
  const [notes, setNotes] = useState('');
  const variant = card.variants[variantIndex] ?? card.variants[0]!;
  const item = variant.item;
  const groups = useMemo(
    () => item.modifierGroups.slice().sort((a, b) => a.sortOrder - b.sortOrder),
    [item],
  );
  const [qty, setQty] = useState(1);

  const defaults = (it: PublishedMenuItem) =>
    new Set(
      it.modifierGroups.flatMap((g) =>
        g.modifiers.filter((m) => m.isDefault).map((m) => m.posModifierId),
      ),
    );
  const [selected, setSelected] = useState<Set<string>>(() => defaults(item));

  // Another size is another till item with its own modifier ids. Carry the
  // choices across by name (Medium and Large share their groups' options),
  // falling back to that item's defaults.
  function switchVariant(i: number) {
    const next = card.variants[i];
    if (!next) return;
    const keyOf = (g: PublishedModifierGroup, optionName: string) =>
      `${groupLabel(g)}|${optionLabel(optionName)}`;
    const chosenNames = new Set(
      item.modifierGroups.flatMap((g) =>
        g.modifiers.filter((m) => selected.has(m.posModifierId)).map((m) => keyOf(g, m.name)),
      ),
    );
    const carried = new Set<string>();
    for (const g of next.item.modifierGroups) {
      for (const m of g.modifiers) {
        if (chosenNames.has(keyOf(g, m.name))) carried.add(m.posModifierId);
      }
    }
    setVariantIndex(i);
    setSelected(carried.size > 0 ? carried : defaults(next.item));
  }

  const isUnmet = (g: PublishedModifierGroup, sel: Set<string>) =>
    g.modifiers.filter((m) => sel.has(m.posModifierId)).length < requiredCount(g);

  // A deal has two pizza slots, and on a phone the second sits below the fold:
  // customers picked one pizza, met a grey "Choose 2nd large pizza" button that
  // did nothing, and took it for the deal not adding (owner, 2026-09-25). So a
  // finished single choice scrolls on to the next open group, and the Add
  // button, while choices are missing, takes you to the first one and flags it.
  const groupRefs = useRef(new Map<string, HTMLFieldSetElement>());
  const [flagged, setFlagged] = useState<string | null>(null);
  const flagTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (flagTimer.current) clearTimeout(flagTimer.current);
  }, []);

  function showGroup(groupId: string, flag: boolean) {
    groupRefs.current.get(groupId)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (!flag) return;
    setFlagged(groupId);
    if (flagTimer.current) clearTimeout(flagTimer.current);
    flagTimer.current = setTimeout(() => setFlagged(null), 1400);
  }

  function toggle(group: PublishedModifierGroup, modId: string) {
    const next = new Set(selected);
    if (group.selectionType === 'single') {
      // Radio behavior: clear siblings.
      for (const m of group.modifiers) next.delete(m.posModifierId);
      next.add(modId);
    } else if (next.has(modId)) {
      next.delete(modId);
    } else {
      const chosen = group.modifiers.filter((m) => next.has(m.posModifierId)).length;
      if (group.maxSelect > 0 && chosen >= group.maxSelect) return;
      next.add(modId);
    }
    setSelected(next);
    if (group.selectionType === 'single') {
      const after = groups.slice(groups.indexOf(group) + 1).find((g) => isUnmet(g, next));
      if (after) setTimeout(() => showGroup(after.posGroupId, false), 160);
    }
  }

  const unmet = groups.filter((g) => isUnmet(g, selected));

  const extra = groups
    .flatMap((g) => g.modifiers)
    .filter((m) => selected.has(m.posModifierId))
    .reduce((s, m) => s + m.priceDeltaCents, 0);
  const unit = item.basePriceCents + extra;

  return (
    <Sheet onClose={onClose} label={card.name}>
      <div className="relative shrink-0 bg-ink px-5 pb-5 pt-5 text-cream">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="font-display text-3xl uppercase leading-none tracking-wide">{card.name}</h3>
            {card.description && (
              <p className="mt-2 text-sm leading-snug text-cream/75">{card.description}</p>
            )}
          </div>
          {card.image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={card.image}
              alt=""
              className="-my-2 h-24 w-24 shrink-0 object-contain drop-shadow-[0_10px_16px_rgba(0,0,0,0.5)]"
            />
          ) : null}
          <CloseButton onClose={onClose} />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-5 pb-4">
        {card.variants.length > 1 && (
          <fieldset className="mt-5">
            <legend className="font-cond text-sm font-extrabold uppercase tracking-widest text-ink">
              Size
            </legend>
            <div className="mt-2 grid grid-cols-2 gap-2">
              {card.variants.map((v, i) => (
                <button
                  key={v.item.posItemId}
                  onClick={() => switchVariant(i)}
                  aria-pressed={i === variantIndex}
                  className={`rounded-2xl border-2 px-3 py-2.5 text-left transition-colors ${
                    i === variantIndex
                      ? 'border-ink bg-ink text-cheese'
                      : 'border-paper-line bg-white text-ink hover:border-ink/40'
                  }`}
                >
                  <span className="block font-cond text-base font-extrabold uppercase">
                    {sizeLabel(v.size)}
                  </span>
                  <span className="font-cond text-sm font-bold tabular-nums opacity-80">
                    {formatCents(v.item.basePriceCents)}
                  </span>
                </button>
              ))}
            </div>
          </fieldset>
        )}

        {groups.map((g) => {
          const chosen = g.modifiers.filter((m) => selected.has(m.posModifierId)).length;
          const need = requiredCount(g);
          const full = g.maxSelect > 0 && chosen >= g.maxSelect;
          const done = chosen >= need;
          // Long single lists (a deal's 8 pizzas, the dips) go two-up on a
          // phone too, so a deal's two pizza slots fit on one screen.
          const twoUp = g.selectionType === 'single' && g.modifiers.length >= 6;
          return (
            <fieldset
              key={g.posGroupId}
              ref={(el) => {
                if (el) groupRefs.current.set(g.posGroupId, el);
                else groupRefs.current.delete(g.posGroupId);
              }}
              className={`mt-5 scroll-mt-3 rounded-2xl transition-shadow duration-300 ${
                flagged === g.posGroupId ? 'animate-pulse ring-4 ring-cheese ring-offset-4 ring-offset-paper' : ''
              }`}
            >
              <legend className="flex w-full items-center justify-between gap-2">
                <span className="font-cond text-sm font-extrabold uppercase tracking-widest text-ink">
                  {groupLabel(g)}
                </span>
                {need === 0 ? (
                  <span className="font-cond text-xs font-bold uppercase tracking-wide text-ink-muted">
                    Optional
                  </span>
                ) : g.selectionType === 'multi' && g.maxSelect > 1 ? (
                  <span
                    className={`rounded-full px-2.5 py-0.5 font-cond text-xs font-bold uppercase ${
                      done ? 'bg-emerald-600 text-white' : 'bg-cheese text-ink'
                    }`}
                  >
                    {chosen}/{g.maxSelect} chosen
                  </span>
                ) : need > 0 ? (
                  <span
                    className={`rounded-full px-2.5 py-0.5 font-cond text-xs font-bold uppercase ${
                      done ? 'bg-emerald-600 text-white' : 'bg-cheese text-ink'
                    }`}
                  >
                    {done ? '✓ chosen' : 'Required'}
                  </span>
                ) : null}
              </legend>
              <div className={`mt-2 grid gap-1.5 ${twoUp ? 'grid-cols-2' : 'sm:grid-cols-2'}`}>
                {g.modifiers
                  .slice()
                  .sort((a, b) => a.sortOrder - b.sortOrder)
                  .map((m) => {
                    const checked = selected.has(m.posModifierId);
                    const blocked = !checked && full && g.selectionType === 'multi';
                    return (
                      <label
                        key={m.posModifierId}
                        className={`flex cursor-pointer items-center justify-between gap-2 rounded-xl border-2 px-3 py-2.5 text-sm transition-colors ${
                          checked && isLeaveOutChoice(m.name)
                            ? 'border-red-600 bg-red-50'
                            : checked
                            ? 'border-ink bg-cheese/25'
                            : blocked
                              ? 'cursor-not-allowed border-paper-line bg-white opacity-45'
                              : 'border-paper-line bg-white hover:border-ink/40'
                        }`}
                      >
                        <span className="flex items-center gap-2.5">
                          <input
                            type={g.selectionType === 'single' ? 'radio' : 'checkbox'}
                            name={g.posGroupId}
                            checked={checked}
                            disabled={blocked}
                            onChange={() => toggle(g, m.posModifierId)}
                            className="h-4 w-4 accent-ink"
                          />
                          <span className="font-semibold text-ink">{optionLabel(m.name)}</span>
                        </span>
                        {m.priceDeltaCents !== 0 && (
                          <span className="font-cond text-xs font-bold tabular-nums text-ink-muted">
                            +{formatCents(m.priceDeltaCents)}
                          </span>
                        )}
                      </label>
                    );
                  })}
              </div>
            </fieldset>
          );
        })}

        <label className="mt-5 block">
          <span className="font-cond text-sm font-extrabold uppercase tracking-widest text-ink">
            Allergy or special request
          </span>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value.slice(0, 300))}
            rows={2}
            maxLength={300}
            placeholder="e.g. nut allergy, well done, cut in 8"
            className="mt-2 w-full rounded-xl border-2 border-paper-line bg-white px-3 py-2.5 text-sm text-ink placeholder:text-ink-muted/70 focus:border-ink focus:outline-none"
          />
          <span className="mt-1 block text-xs leading-snug text-ink-muted">
            Goes to the kitchen with this item. Our kitchen shares equipment, so we can&rsquo;t guarantee any
            dish is allergen-free.
          </span>
        </label>
      </div>

      <div className="flex shrink-0 items-center gap-3 border-t border-paper-line bg-white px-5 py-4">
        <Stepper value={qty} onChange={setQty} label={card.name} min={1} />
        <button
          aria-disabled={unmet.length > 0}
          onClick={() =>
            unmet.length > 0
              ? showGroup(unmet[0]!.posGroupId, true)
              : onConfirm(variant, [...selected], qty, notes.trim() || null)
          }
          className={`flex-1 rounded-full bg-ink py-3.5 font-cond text-lg font-bold uppercase tracking-wide text-cheese transition-all active:scale-[0.99] ${
            unmet.length > 0 ? 'opacity-55' : 'hover:bg-ink-soft'
          }`}
        >
          {unmet.length > 0 ? unmetText(unmet[0]!, selected) : `Add · ${formatCents(unit * qty)}`}
        </button>
      </div>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------

function CheckoutSheet(
  props: CartProps & {
    zoneId: string;
    onZone: (id: string) => void;
    acceptingOrders: boolean;
    onClose: () => void;
  },
) {
  const router = useRouter();
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [address, setAddress] = useState('');
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A double tap fires two clicks before React has re-rendered the disabled
  // button; the ref closes that gap synchronously. The order id is minted
  // once per checkout and reused on every retry, so the server can recognise
  // a resend and return the order it already has instead of a second one.
  const inFlight = useRef(false);
  const clientOrderId = useRef<string | null>(null);

  async function submit() {
    if (inFlight.current) return;
    setError(null);
    const pickup = props.fulfilment === 'pickup';
    if (!pickup && props.pickupOnlyInCart.length > 0) {
      return setError(
        `${props.pickupOnlyInCart.join(', ')} is pick-up only — ${
          props.canPickup ? 'switch to pick-up, or remove it' : 'remove it'
        } to order delivery.`,
      );
    }
    if (!pickup && !props.zone) {
      return setError('Choose your delivery area — we deliver in DHA and Clifton only.');
    }
    if (name.trim().length < 2) return setError('Please enter your name.');
    if (phone.trim().length < 10) return setError('Please enter your mobile number.');
    if (!pickup && address.trim().length < 5) return setError('Please enter your house and street.');
    if (props.cart.length === 0) return setError('Your order is empty.');
    if (!props.acceptingOrders) {
      return setError('We are not taking online orders right now.');
    }
    if (!clientOrderId.current) clientOrderId.current = newOrderId();
    inFlight.current = true;
    setSubmitting(true);
    try {
      const res = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientOrderId: clientOrderId.current,
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
      const json = (await res.json()) as {
        ok: boolean;
        data?: { orderId: string };
        error?: string;
        message?: string;
        details?: Record<string, string[] | undefined>;
      };
      if (!json.ok || !json.data) {
        // Say what the server said. The shop can close between loading the
        // page and pressing the button, a phone number can be malformed, an
        // item can leave the menu — each has its own message.
        const fieldError = json.details
          ? Object.values(json.details).flat().find((m): m is string => typeof m === 'string')
          : undefined;
        setError(
          json.message ??
            fieldError ??
            (json.error === 'store_closed'
              ? 'We are not taking online orders at the moment. Please order on WhatsApp.'
              : json.error === 'pickup_unavailable'
                ? 'Online pick-up is not available right now — choose delivery.'
              : json.error === 'menu_not_published' || json.error === 'item_not_on_menu'
                ? 'The menu was just updated — please refresh and try again.'
                : json.error === 'rate_limited'
                  ? 'Too many orders in a short time. Please wait a few minutes or call us.'
                  : 'Could not place the order. Please try again or order on WhatsApp.'),
        );
        inFlight.current = false;
        setSubmitting(false);
        return;
      }
      router.push(
        `/track/${json.data.orderId}?phone=${encodeURIComponent(phone.trim())}&placed=1`,
      );
    } catch {
      setError('Network problem — check your connection and tap Place order again.');
      inFlight.current = false;
      setSubmitting(false);
    }
  }

  const dha = DELIVERY_ZONES.filter((z) => z.group === 'DHA');
  const clifton = DELIVERY_ZONES.filter((z) => z.group === 'Clifton');

  return (
    <Sheet onClose={props.onClose} label="Checkout">
      <div className="flex shrink-0 items-start justify-between gap-3 bg-ink px-5 py-5 text-cream">
        <div>
          <h3 className="font-display text-3xl uppercase leading-none tracking-wide">Checkout</h3>
          <p className="mt-1.5 font-cond text-sm font-bold uppercase tracking-wide text-cheese">
            {props.fulfilment === 'pickup'
              ? `Pick-up · ${props.pickupPct}% off · pay at the counter`
              : 'Cash on delivery · pay the rider'}
          </p>
        </div>
        <CloseButton onClose={props.onClose} />
      </div>

      <div className="flex-1 overflow-y-auto px-5 pb-5">
        <ul className="mt-4 space-y-2">
          {props.cart.map((l) => (
            <CartLineRow key={l.key} line={l} unit={props.lineUnitPrice(l)} setQty={props.setQty} />
          ))}
        </ul>

        {props.canPickup && (
          <div className="mt-5">
            <FulfilmentToggle {...props} />
          </div>
        )}

        <div className="mt-5 space-y-3">
          {props.fulfilment === 'pickup' ? (
            <div className="rounded-2xl border-2 border-ink bg-white p-4">
              <p className="font-cond text-sm font-extrabold uppercase tracking-widest text-ink">
                Collect from
              </p>
              <p className="mt-1 text-sm font-semibold text-ink">
                {BUSINESS.streetAddress}, {BUSINESS.locality}
              </p>
              <p className="mt-1 text-xs text-ink-muted">
                We&rsquo;ll have it ready — follow it live after you order. Pay at the counter.
              </p>
            </div>
          ) : (
          <>
          <label className="block">
            <span className="mb-1 block font-cond text-sm font-extrabold uppercase tracking-widest text-ink">
              Delivery area
            </span>
            <select
              value={props.zoneId}
              onChange={(e) => props.onZone(e.target.value)}
              className={`w-full rounded-xl border-2 bg-white px-3 py-3 text-base font-semibold text-ink outline-none transition-colors focus:border-ink ${
                props.zone ? 'border-ink' : 'border-cheese'
              }`}
            >
              <option value="">Choose your area…</option>
              <optgroup label="DHA">
                {dha.map((z) => (
                  <option key={z.id} value={z.id}>
                    {z.name} — {formatCents(z.feeCents)}
                  </option>
                ))}
              </optgroup>
              <optgroup label="Clifton">
                {clifton.map((z) => (
                  <option key={z.id} value={z.id}>
                    {z.name} — {formatCents(z.feeCents)}
                  </option>
                ))}
              </optgroup>
            </select>
            <span className="mt-1 block text-xs text-ink-muted">
              We deliver in DHA and Clifton only. Somewhere else? We can&rsquo;t take that order online.
            </span>
          </label>
          </>
          )}
          <Field label="Your name" value={name} onChange={setName} placeholder="Ahmed Khan" autoComplete="name" />
          <Field
            label="Mobile number"
            value={phone}
            onChange={setPhone}
            placeholder="0300 1234567"
            type="tel"
            autoComplete="tel"
          />
          {props.fulfilment !== 'pickup' && (
            <Field
              label="House & street"
              value={address}
              onChange={setAddress}
              placeholder="House 12, Street 4, Khayaban-e-…"
              autoComplete="street-address"
            />
          )}
          <Field label="Notes (optional)" value={notes} onChange={setNotes} placeholder="Ring the bell twice" />
          <p className="text-xs leading-snug text-ink-muted">{ALLERGY_NOTICE}</p>
        </div>

        <Totals {...props} />

        {error && (
          <p className="mt-3 rounded-xl border-2 border-red-600/40 bg-red-50 px-3 py-2 text-sm font-semibold text-red-700">
            {error}
          </p>
        )}

        {!props.acceptingOrders && (
          <p className="mt-3 rounded-xl border-2 border-ink bg-cheese px-3 py-2 text-sm font-semibold text-ink">
            We&rsquo;re not taking online orders right now.{' '}
            <a href={WA_ORDER_URL} target="_blank" rel="noopener noreferrer" className="underline">
              Order on WhatsApp
            </a>{' '}
            instead.
          </p>
        )}
      </div>

      <div className="shrink-0 border-t border-paper-line bg-white px-5 py-4">
        <button
          onClick={() => void submit()}
          disabled={submitting || props.cart.length === 0 || !props.acceptingOrders}
          className="w-full rounded-full bg-ink py-4 font-cond text-xl font-bold uppercase tracking-wide text-cheese transition-all hover:bg-ink-soft active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-40"
        >
          {!props.acceptingOrders
            ? 'Online ordering is closed'
            : submitting
              ? 'Placing your order…'
              : props.fulfilment === 'delivery' && !props.zone
                ? 'Choose your delivery area'
                : `Place order · ${formatCents(props.total)}`}
        </button>
        <p className="mt-2 text-center text-xs text-ink-muted">
          {props.fulfilment === 'pickup'
            ? 'You pay in cash when you collect. The printed receipt from the kitchen is the final bill.'
            : 'You pay the rider in cash. The printed receipt from the kitchen is the final bill.'}
        </p>
      </div>
    </Sheet>
  );
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  type = 'text',
  autoComplete,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  autoComplete?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1 block font-cond text-sm font-extrabold uppercase tracking-widest text-ink">
        {label}
      </span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        autoComplete={autoComplete}
        className="w-full rounded-xl border-2 border-paper-line bg-white px-3.5 py-3 text-base font-medium text-ink outline-none transition-colors placeholder:text-ink/30 focus:border-ink"
      />
    </label>
  );
}
