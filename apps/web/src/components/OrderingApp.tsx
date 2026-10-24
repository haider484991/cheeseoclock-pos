'use client';

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { formatCents } from '@/lib/format';
import {
  copyText,
  deliveryChip,
  deliveryFeeRange,
  deliveryOptionNote,
  findFactZone,
  type SiteFacts,
} from '@/lib/delivery-facts';
import { feeItemIdsOf, zoneFeeItemFor } from '@/lib/delivery-zones';
import { MENU_FOOT_LINE, MENU_HEADER_HOURS, MENU_OFFER_WHERE } from '@/lib/page-copy';
import { DEFAULT_SHOP_FACTS, lineOrderUrl, orderWhatsappUrl, shopHoursInSentence, whatsappLinesOf, type ShopFacts } from '@/lib/shop-facts';
import { taxBpsOf } from '@/lib/tax-words';
import { priceOrder, type PricedLine } from '@/lib/pricing';
import {
  buildMenuView,
  cartDeals,
  dealWorthCents,
  isDealSection,
  isPickupOnly,
  cardSizeLabel,
  isTaxIncluded,
  menuHasNoDiscountItems,
  menuHasTaxIncluded,
  pickupOnlyNote,
  sectionTitle,
  sizeOrderable,
  type MenuCard,
  type MenuVariant,
} from '@/lib/menu-view';
import {
  addLine,
  cartCount as countLines,
  cartPricedLines,
  cartSubtotalCents,
  linesSummary,
  lineUnitPriceCents,
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
import { OFFER_FINE_PRINT, OFFER_FINE_PRINT_TAX_INCLUDED, cardOffer, discountOnEveryOrder, offerSectionOf, regularPizzaPrices, type OfferPrice } from '@/lib/offers';
import { pixel, type PixelLine } from '@/lib/meta-pixel';
import { trackPath } from '@/lib/order-display';
import {
  NOT_ON_VALUE_DEALS,
  buy1Get1ClosedMessage,
  buy1Get1OpenAt,
  buy1Get1WindowWords,
  isBuy1Get1Category,
  type PublishedMenuItem,
  type WebFulfilment,
  type WebsiteCategoryPercent,
} from '@cheeseoclock/shared-types';
import type { PublicMenu } from '@/lib/public-menu';
import { CartPanel, type CartProps } from './ordering/cart-ui';
import { CheckoutSheet, type PlacedOrder } from './ordering/CheckoutSheet';
import { ItemSheet } from './ordering/ItemSheet';
import { OfferStrip, OfferTeaser, type ShownOffer } from './ordering/Offers';
import { sheetOnTopOfHistory } from './ordering/Sheet';
import { ShopFactsContext, useShopFacts } from './ordering/ShopContext';

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
 * A cart as the Meta Pixel is told of it (lib/meta-pixel): item ids, quantities and unit prices.
 * Never a note, a choice's name or anything the customer typed. It cannot throw: the pixel never
 * gets in the way of an order, so a cart it cannot read is an empty one.
 */
function pixelLines(lines: ReadonlyArray<Pick<CartLine, 'item' | 'quantity' | 'modifierIds'>>): PixelLine[] {
  try {
    return lines.map((l) => ({ id: l.item.posItemId, quantity: l.quantity, unitCents: lineUnitPriceCents(l) }));
  } catch {
    return [];
  }
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
  const size = cardSizeLabel(card, v.size);
  return size ? `${card.name} · ${size}` : card.name;
}

type PickFn = (card: MenuCard, variantIndex: number) => void;

export function OrderingApp({
  menu,
  acceptingOrders,
  pickupAvailable,
  pickupDiscountPercent,
  deliveryDiscountPercent = 0,
  pickupCategoryPercents = NO_CATEGORY_PERCENTS,
  deliveryCategoryPercents = NO_CATEGORY_PERCENTS,
  deliveryFacts,
  closedNotice = null,
  shop = DEFAULT_SHOP_FACTS,
}: {
  menu: PublicMenu;
  acceptingOrders: boolean;
  /** The till can take pickup orders right now (lib/store-status). */
  pickupAvailable: boolean;
  /** The pickup discount that till bills — shown and priced here. */
  pickupDiscountPercent: number;
  /**
   * The % off a delivery's food (WEBSITE DELIVERY DISCOUNT, v0.7.37; lib/store-status): never value
   * deals, never the delivery charge. 0 = deliveries pay full price (today).
   */
  deliveryDiscountPercent?: number;
  /**
   * v0.7.50 (WEBSITE DISCOUNT BY CATEGORY; lib/store-status): categories with their own % on a pick-up and
   * on a delivery's food (Pizza 20% beside 10% off the rest). Absent or none = one %, as before.
   */
  pickupCategoryPercents?: WebsiteCategoryPercent[];
  deliveryCategoryPercents?: WebsiteCategoryPercent[];
  /** Where the owner delivers and the fees (the settings block with this menu, else the built-in areas). */
  deliveryFacts: SiteFacts;
  /**
   * The owner's words while the website is closed (v0.7.30), worked out on
   * the server for this request (shared-types closedNoticeInForce); null =
   * the page's own closed words, as before.
   */
  closedNotice?: string | null;
  /**
   * The shop's details (sweep B2 + B4: the tagline, hours, allergy notice,
   * WhatsApp lines and greeting, what the rider takes), read on the server
   * from the owner's settings; today's when not given. Never the shop
   * block's stamps.
   */
  shop?: ShopFacts;
}) {
  // The fee range as the cart says it before an area is chosen: "Rs N–M".
  const feeRange = deliveryFeeRange(deliveryFacts);
  /** An area the customer can order to now (a switched-off one is refused by the server too). */
  const openZone = useCallback(
    (id: string | null | undefined) => {
      const z = findFactZone(deliveryFacts, id);
      return z?.active ? z : undefined;
    },
    [deliveryFacts],
  );
  const router = useRouter();
  // Server-rendered starting point, then kept honest client-side: a customer
  // can sit on this page long after the shop stops taking orders. The POST is
  // the real gate (see api/orders) — this only keeps the buttons truthful.
  const [open, setOpen] = useState(acceptingOrders);
  const [canPickup, setCanPickup] = useState(pickupAvailable);
  const [pickupPct, setPickupPct] = useState(pickupDiscountPercent);
  const [deliveryPct, setDeliveryPct] = useState(deliveryDiscountPercent);
  // v0.7.50: the categories with their own %, kept as current as the %s above.
  const [pickupCats, setPickupCats] = useState<WebsiteCategoryPercent[]>(pickupCategoryPercents);
  const [deliveryCats, setDeliveryCats] = useState<WebsiteCategoryPercent[]>(deliveryCategoryPercents);
  // The owner's closed notice, kept as current as the rest: its last day ends while the page is open.
  const [notice, setNotice] = useState<string | null>(closedNotice);
  useEffect(() => {
    let cancelled = false;
    async function check() {
      try {
        const res = await fetch('/api/store-status', { cache: 'no-store' });
        const json = (await res.json()) as {
          ok: boolean;
          data?: {
            acceptingOrders: boolean;
            pickupAvailable?: boolean;
            pickupDiscountPercent?: number;
            deliveryDiscountPercent?: number;
            pickupCategoryPercents?: WebsiteCategoryPercent[];
            deliveryCategoryPercents?: WebsiteCategoryPercent[];
            closedNotice?: string | null;
          };
        };
        if (!cancelled && json.ok && json.data) {
          setOpen(json.data.acceptingOrders);
          setCanPickup(json.data.pickupAvailable === true);
          if (typeof json.data.pickupDiscountPercent === 'number') setPickupPct(json.data.pickupDiscountPercent);
          // An older website's reply has no word about it: deliveries pay full price, as it charges.
          setDeliveryPct(typeof json.data.deliveryDiscountPercent === 'number' ? json.data.deliveryDiscountPercent : 0);
          // v0.7.50: absent = no category has its own % (an older website's reply too).
          setPickupCats(Array.isArray(json.data.pickupCategoryPercents) ? json.data.pickupCategoryPercents : NO_CATEGORY_PERCENTS);
          setDeliveryCats(Array.isArray(json.data.deliveryCategoryPercents) ? json.data.deliveryCategoryPercents : NO_CATEGORY_PERCENTS);
          // An older website's reply has no word about it: keep what the page was served.
          if (json.data.closedNotice !== undefined) setNotice(json.data.closedNotice);
        }
      } catch {
        // Keep the last known state; submitting is still guarded server-side.
      }
    }
    // At once as well: the page itself is kept for up to a minute (app/menu/page.tsx), so what it was served may
    // be that old.
    void check();
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

  // The Meta Pixel hears of the menu once per page load (lib/meta-pixel; nothing without a pixel id).
  useEffect(() => {
    pixel.viewMenu();
  }, []);

  const sections = useMemo(() => buildMenuView(menu), [menu]);
  // Each item's category and each category's name as its section is titled (v0.7.50: a category with its own %).
  const categoryOfItem = useMemo(
    () => new Map(menu.categories.flatMap((c) => c.items.map((i) => [i.posItemId, c.posCategoryId] as const))),
    [menu],
  );
  const categoryNames = useMemo(
    () => new Map(menu.categories.map((c) => [c.posCategoryId, sectionTitle(c.name)] as const)),
    [menu],
  );
  // The words under the sections: the food's one tax rate from this menu (charge items left out) and
  // what the rider takes.
  const footLine = useMemo(
    () =>
      copyText(MENU_FOOT_LINE, {
        ...deliveryFacts,
        shop,
        taxBps: taxBpsOf(menu, feeItemIdsOf(menu)),
        // Some prices include their tax (0057): the line says which.
        ...(menuHasTaxIncluded(menu) ? { pricesIncludeTax: true } : {}),
      }),
    [deliveryFacts, shop, menu],
  );
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
  // The owner's Buy 1 Get 1 rules (the settings block; the poster's 1–7 PM with none): their hours in words.
  const dealRules = deliveryFacts.buy1Get1;
  const dealWindow = buy1Get1WindowWords(dealRules);
  // The offers each card shows (lib/offers, display only): Buy 1 Get 1 (in the owner's hours, none while switched
  // off) and the % off with what each size comes to — on the price buttons themselves when every online order takes
  // it. Kept per card key so the memoised cards re-render only when the percents or the menu change.
  const offersByCard = useMemo(() => {
    const m = new Map<string, ShownOffer>();
    const dealsOnMenu = sections.some((s) => isBuy1Get1Category(s.name));
    for (const s of sections) {
      // A category with its own % (v0.7.50): its cards show that % instead.
      const own = {
        pickupPct: pickupCats.find((x) => x.categoryId === s.id)?.percent ?? pickupPct,
        deliveryPct: deliveryCats.find((x) => x.categoryId === s.id)?.percent ?? deliveryPct,
        canPickup,
      };
      const onPrice = discountOnEveryOrder(own);
      const pct = onPrice ? (canPickup ? own.pickupPct : own.deliveryPct) : null;
      // With the deals on the menu their cards say each rule, so a regular pizza's card shows only the offer's tag.
      const brief = dealsOnMenu && offerSectionOf(s.name) === 'pizza';
      for (const c of s.cards) {
        m.set(c.key, { offer: cardOffer(s.name, c, own, { dealsOnMenu, buy1Get1: dealRules }), onPrice, pct, brief });
      }
    }
    return m;
  }, [sections, pickupPct, deliveryPct, pickupCats, deliveryCats, canPickup, dealRules]);
  const offerPrices = useMemo(() => regularPizzaPrices(sections), [sections]);
  // The sections of little things (the dips), set two to a row on a phone.
  const smallSections = useMemo(
    () => new Set(sections.filter((s) => !isDealSection(s.name) && isSmallSection(s.cards)).map((s) => s.id)),
    [sections],
  );
  // The Buy 1 Get 1 deals' own section, once the till has published one: the banner's button jumps there, and the
  // cards' strips say the free item comes in a deal.
  const buy1Get1Anchor = useMemo(() => sections.find((s) => isBuy1Get1Category(s.name))?.anchor ?? null, [sections]);

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
      pixel.addToCart(pixelLines(again.lines));
      if (again.lines.length === 0) flash('Those items are no longer on the menu', 3000);
      else if (again.dropped > 0) flash(`Added your order · ${again.dropped} no longer on the menu`, 3000);
      else flash('Added your last order');
    }
    if (lines.length > 0) setCart(lines);
    const details = parseDetails(readStored(STORAGE_KEYS.details));
    const savedZone = details?.zoneId || readStored(STORAGE_KEYS.zone) || '';
    // An area this phone remembers that is unknown now, or switched off, is not picked.
    if (openZone(savedZone)) setZoneId(savedZone);
    setLastOrder(parseLastOrder(readStored(STORAGE_KEYS.lastOrder), now));
    hydrated.current = true;
  }, [menu, flash, openZone]);

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
    if (openZone(id)) writeStored(STORAGE_KEYS.zone, id);
  }

  const [chosenFulfilment, setFulfilment] = useState<WebFulfilment>('delivery');
  // Pickup silently falls back to delivery if the till stops offering it.
  const fulfilment: WebFulfilment = canPickup ? chosenFulfilment : 'delivery';
  const pickup = fulfilment === 'pickup';
  const zone = pickup ? undefined : openZone(zoneId);

  // Same maths as the server and the till (lib/pricing). The delivery fee is
  // a real till item — the same one the server adds (zoneFeeItemFor) — taxed
  // like one; pickup takes its discount off every line but value deals, and a
  // delivery (v0.7.37) its own % off the food: never the fee, never value deals.
  const subtotal = cartSubtotalCents(cart);
  // Each line's category (v0.7.50): a category with its own % prices it so, as the server and the till do.
  const priced: PricedLine[] = cartPricedLines(cart).map((l, i) => ({ ...l, categoryId: categoryOfItem.get(cart[i]!.item.posItemId) ?? null }));
  const feeItem = zone ? zoneFeeItemFor(menu, zone) : undefined;
  const deliveryFee = zone && cart.length > 0 ? zone.feeCents : 0;
  if (deliveryFee > 0) priced.push({ lineTotalCents: deliveryFee, taxRateBps: feeItem?.taxRateBps ?? 0, noDiscount: true });
  const discountPct = pickup ? pickupPct : deliveryPct;
  const ownPercents = pickup ? pickupCats : deliveryCats;
  const totals = priceOrder(priced, discountPct, ownPercents);
  // "Pizza 20%": the categories whose own % took something off this cart (their part), for the discount row.
  const ownPercentWords = (totals.discountParts ?? [])
    .filter((p) => p.categoryId !== null)
    .map((p) => `${categoryNames.get(p.categoryId!) ?? 'Some items'} ${p.percent}%`)
    .join(' · ');
  const { discountCents: discount, taxCents: tax, totalCents: total } = totals;
  // The tax inside the prices of tax-included items (0057): shown under the total, never added.
  const includedTax = totals.includedTaxCents ?? 0;
  const cartCount = countLines(cart);
  const pickupOnlyInCart = cart.filter((l) => isPickupOnly(l.item)).map((l) => l.label);
  // Value deals take no pick-up discount (v0.7.34): the words say so only while the menu marks one.
  const notOnDeals = useMemo(() => menuHasNoDiscountItems(menu), [menu]);
  const { dealInCart, onlyDeals } = cartDeals(cart);
  // Buy 1 Get 1 deals (shared-types buy-1-get-1): sold only while the owner's rules say so (the settings block: on,
  // 1–7 PM until changed). The clock is read after the page mounts (the page can be served from a cache made at
  // another hour), then every 30 seconds; until then they count as on sale while switched on — the checkout and the
  // server check the hours again.
  const [clockMs, setClockMs] = useState<number | null>(null);
  useEffect(() => {
    setClockMs(Date.now());
    const t = setInterval(() => setClockMs(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  const buy1Get1Open = clockMs === null ? dealRules.on : buy1Get1OpenAt(clockMs, dealRules);
  const buy1Get1Items = useMemo(
    () => new Set(menu.categories.filter((c) => isBuy1Get1Category(c.name)).flatMap((c) => c.items.map((i) => i.posItemId))),
    [menu],
  );
  const buy1Get1InCart = cart.some((l) => buy1Get1Items.has(l.item.posItemId));

  const qtyByItem = useMemo(() => {
    const m = new Map<string, number>();
    for (const l of cart) m.set(l.item.posItemId, (m.get(l.item.posItemId) ?? 0) + l.quantity);
    return m;
  }, [cart]);

  const addToCart = useCallback(
    (item: PublishedMenuItem, label: string, modifierIds: string[], quantity = 1, notes: string | null = null) => {
      setCart((prev) => addLine(prev, { item, label, quantity, modifierIds, notes }));
      pixel.addToCart(pixelLines([{ item, quantity, modifierIds }]));
      flash(`Added ${quantity > 1 ? `${quantity} × ` : ''}${label}`);
    },
    [flash],
  );

  /** A size tap: straight into the cart unless the item has choices to make. */
  const pickVariant: PickFn = useCallback(
    (card, variantIndex) => {
      const v = card.variants[variantIndex];
      // A pick-up-only size is orderable only while online pick-up is (the whole card, or one size).
      if (!v || !sizeOrderable(v, canPickup)) return;
      if (!buy1Get1Open && buy1Get1Items.has(v.item.posItemId)) {
        flash(buy1Get1ClosedMessage(dealRules), 3200);
        return;
      }
      if (v.item.modifierGroups.length > 0) {
        pixel.viewItem({ id: v.item.posItemId, name: variantLabel(card, v), unitCents: v.item.basePriceCents });
        setSheet({ card, variantIndex });
      } else {
        addToCart(v.item, variantLabel(card, v), []);
      }
    },
    [canPickup, addToCart, buy1Get1Open, buy1Get1Items, flash, dealRules],
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
    pixel.addToCart(pixelLines(lines));
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

  function onPlaced({ orderId, phone, name, totalCents }: PlacedOrder) {
    placed.current = true;
    // The Meta Pixel hears of the sale here, once, while the page is still /menu (the tracking address
    // carries the phone, and is never sent): the server's own total, not one worked out from the cart,
    // and the customer's phone and name hashed (lib/meta-user-data). A replayed order comes back with
    // the same id, which the pixel's once-only claim covers.
    pixel.purchase(orderId, totalCents, pixelLines(cart), { phone, name: name ?? null });
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
  /** The desktop panel and the phone's bar open the checkout alike: the Meta Pixel hears of it once per open. */
  function openCheckout() {
    pixel.initiateCheckout(pixelLines(cart));
    setCheckoutOpen(true);
  }

  const cartProps: CartProps = {
    cart,
    subtotal,
    deliveryFee,
    discount,
    zone,
    tax,
    includedTax,
    total,
    setQty,
    onClear: clearCart,
    fulfilment,
    canPickup,
    pickupPct,
    deliveryPct,
    ...(ownPercentWords ? { ownPercentWords } : {}),
    onFulfilment: setFulfilment,
    pickupOnlyInCart,
    feeRange,
    deliveryNote: deliveryOptionNote(deliveryFacts),
    minDeliveryOrderCents: deliveryFacts.minDeliveryOrderCents,
    notOnDeals,
    dealInCart,
    onlyDeals,
    buy1Get1InCart,
    buy1Get1Open,
  };

  return (
    <ShopFactsContext.Provider value={shop}>
    <div className="pb-28 lg:pb-12">
      <MenuHeader
        canPickup={canPickup}
        pickupPct={pickupPct}
        deliveryPct={deliveryPct}
        notOnDeals={notOnDeals}
        deliveryChip={deliveryChip(deliveryFacts)}
        hoursChip={copyText(MENU_HEADER_HOURS, { ...deliveryFacts, shop })}
        announcement={deliveryFacts.announcement}
        offerPrices={offerPrices}
        offerWhere={copyText(MENU_OFFER_WHERE, { ...deliveryFacts, shop })}
        offerDealsAnchor={buy1Get1Anchor}
        offerWindow={dealRules.on ? dealWindow : null}
        ownPercentChips={ownPercentChips(pickupCats, deliveryCats, canPickup, categoryNames)}
      />

      {lastOrder && (
        <ReturningBanner
          menu={menu}
          lastOrder={lastOrder}
          cartEmpty={cart.length === 0}
          onOrderAgain={() => orderAgain(lastOrder)}
        />
      )}

      {!open && <ClosedBanner notice={notice} />}

      <CategoryRail sections={railSections} />

      <div className="mx-auto max-w-6xl px-4 lg:grid lg:grid-cols-[1fr_22rem] lg:gap-8">
        <div>
          {sections.map((s) => (
            <section key={s.id} id={s.anchor} className="scroll-mt-36 pt-8" aria-labelledby={`${s.anchor}-title`}>
              <SectionTitle
                id={`${s.anchor}-title`}
                name={s.name}
                note={sectionNote(s.name, dealWindow)}
                fine={
                  isBuy1Get1Category(s.name)
                    ? // Deals whose prices include their tax (0057) say so instead of "tax may apply".
                      s.cards.length > 0 && s.cards.every((c) => c.variants.every((v) => isTaxIncluded(v.item)))
                      ? OFFER_FINE_PRINT_TAX_INCLUDED
                      : OFFER_FINE_PRINT
                    : null
                }
              />
              <div className={`mt-4 grid gap-3 ${smallSections.has(s.id) ? 'grid-cols-2 sm:grid-cols-3' : 'sm:grid-cols-2'}`}>
                {s.cards.map((card, i) =>
                  isDealSection(s.name) ? (
                    <DealCard
                      key={card.key}
                      card={card}
                      n={i + 1}
                      kind={isBuy1Get1Category(s.name) ? 'buy1get1' : 'value'}
                      dealWindow={dealWindow}
                      closed={isBuy1Get1Category(s.name) && !buy1Get1Open}
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
                      offer={offersByCard.get(card.key)}
                      dealsAnchor={buy1Get1Anchor}
                    />
                  ) : (
                    <ItemCard
                      key={card.key}
                      card={card}
                      qtyByItem={qtyByItem}
                      canPickup={canPickup}
                      onPick={pickVariant}
                      offer={offersByCard.get(card.key)}
                      dealsAnchor={buy1Get1Anchor}
                      small={smallSections.has(s.id)}
                    />
                  ),
                )}
              </div>
            </section>
          ))}
          {/* The allergy words close the menu (20 Oct 2026: off the header); each item's sheet and the checkout say them too. */}
          <p className="mx-auto mt-10 max-w-2xl text-center text-sm leading-snug text-ink-muted">{shop.website.allergyNotice}</p>
          <p className="mt-3 text-center font-cond text-sm font-semibold uppercase tracking-wider text-ink-muted">
            {footLine}
          </p>
        </div>

        {/* Cart — desktop side panel */}
        <aside className="hidden pt-8 lg:block" aria-label="Your order">
          <div className="sticky top-36 rounded-3xl border border-paper-line bg-white p-5 shadow-soft-md">
            <CartPanel {...cartProps} acceptingOrders={open} onCheckout={openCheckout} />
          </div>
        </aside>
      </div>

      {/* Cart — mobile bottom bar */}
      {cartCount > 0 && (
        <div className="pb-safe fixed inset-x-0 bottom-0 z-40 border-t border-ink/10 bg-paper/95 px-3 pt-3 backdrop-blur lg:hidden">
          <button
            type="button"
            onClick={openCheckout}
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
          canPickup={canPickup}
          onClose={closeSheet}
          onConfirm={(v, ids, qty, notes) => {
            // The card's rule again at the cart: a pick-up-only size only while online pick-up is on.
            if (!sizeOrderable(v, canPickup)) return;
            if (!buy1Get1Open && buy1Get1Items.has(v.item.posItemId)) {
              flash(buy1Get1ClosedMessage(dealRules), 3200);
              return;
            }
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
          deliveryFacts={deliveryFacts}
          acceptingOrders={open}
          closedNotice={notice}
          onClose={closeCheckout}
          orderIdFor={orderIdFor}
          onPlaced={onPlaced}
        />
      )}
    </div>
    </ShopFactsContext.Provider>
  );
}

// ---------------------------------------------------------------------------

function isSignature(sectionName: string): boolean {
  return /signature/i.test(sectionName);
}

/**
 * A section of little things (the dips): every card one size with no photo, nearly all with no words either — set
 * two to a row on a phone (20 Oct 2026), so nine dips are not nine screen-wide cards. A card there with words (the
 * house dip) takes the whole row.
 */
function isSmallSection(cards: readonly MenuCard[]): boolean {
  if (cards.length < 4 || !cards.every((c) => c.variants.length === 1 && !c.image)) return false;
  return cards.filter((c) => !c.description).length / cards.length >= 0.75;
}

/**
 * `dealWindow`: the Buy 1 Get 1 deals' hours in words, as the owner set them ("1–7 PM", "all day"). Never "every
 * day": the shop's days are the owner's (the banner's where-and-when line is the claimed copy that may say it).
 */
function sectionNote(sectionName: string, dealWindow: string): string | null {
  if (isBuy1Get1Category(sectionName)) {
    return `${dealWindow === 'all day' ? 'All day' : dealWindow} · regular pizzas · post your meal, tag us & show us the post`;
  }
  if (/signature/i.test(sectionName)) return 'Large 12" only';
  if (/deal/i.test(sectionName)) return 'Choice of pizzas only from the regular menu';
  if (/^pizza|regular/i.test(sectionName)) return 'Medium 9" · Large 12"';
  return null;
}

/** No category with its own % (v0.7.50): one shared value, so the memos see no change. */
const NO_CATEGORY_PERCENTS: WebsiteCategoryPercent[] = [];

/**
 * The header's chips for the categories with their own % (v0.7.50): "20% off Pizza online" when pick-up and
 * delivery agree, else "20% off Pizza with pick-up" / "on delivery". A category no longer on the menu: no chip.
 */
export function ownPercentChips(
  pickupCats: readonly WebsiteCategoryPercent[],
  deliveryCats: readonly WebsiteCategoryPercent[],
  canPickup: boolean,
  names: ReadonlyMap<string, string>,
): string[] {
  const pick = canPickup ? pickupCats : [];
  const ids = [...new Set([...pick, ...deliveryCats].map((c) => c.categoryId))];
  const chips: string[] = [];
  for (const id of ids) {
    const name = names.get(id);
    if (!name) continue;
    const p = pick.find((c) => c.categoryId === id)?.percent ?? 0;
    const d = deliveryCats.find((c) => c.categoryId === id)?.percent ?? 0;
    if (p > 0 && p === d) chips.push(`${p}% off ${name} online`);
    else {
      if (p > 0) chips.push(`${p}% off ${name} with pick-up`);
      if (d > 0) chips.push(`${d}% off ${name} on delivery`);
    }
  }
  return chips;
}

/**
 * The menu's header, kept short so the food starts on the first screen of a phone (20 Oct 2026: "too much
 * information" in it): the title, one line of facts (hours, cash on delivery, where we deliver and what it costs),
 * the money off as gold chips, and Buy 1 Get 1 as one line that jumps to its deals. The offer's rules sit with the
 * deals, and the allergy words close the menu (each item's sheet and the checkout say them too); the shop's tagline
 * stays on the home page and in the footer.
 */
function MenuHeader({
  canPickup,
  pickupPct,
  deliveryPct = 0,
  notOnDeals,
  deliveryChip,
  hoursChip,
  announcement,
  offerPrices,
  offerWhere,
  offerDealsAnchor = null,
  offerWindow,
  ownPercentChips = [],
}: {
  canPickup: boolean;
  pickupPct: number;
  /** The % off a delivery's food (v0.7.37); 0 = none. */
  deliveryPct?: number;
  /** The menu marks value deals (lib/menu-view menuHasNoDiscountItems): the % chip says they are left out. */
  notOnDeals: boolean;
  deliveryChip: string;
  /** The hours (page-copy MENU_HEADER_HOURS): with the days unless the shop opens every day. */
  hoursChip: string;
  /** The owner's announcement while it is on (plain text, never markup), else null: nothing shows. */
  announcement: string | null;
  /** The regular pizzas' Medium and Large prices, for the Buy 1 Get 1 rules (lib/offers). */
  offerPrices: { mediumCents: number | null; largeCents: number | null };
  /** The offer's where-and-when line (page-copy MENU_OFFER_WHERE). */
  offerWhere: string;
  /** The Buy 1 Get 1 deals' section anchor, once the menu has them; null = the line opens to the rules. */
  offerDealsAnchor?: string | null;
  /** The offer's hours in words (the owner's rules); null = the owner switched it off: no line. */
  offerWindow: string | null;
  /** v0.7.50: one chip per category with its own % ("20% off Pizza online"). */
  ownPercentChips?: string[];
}) {
  const chip = 'rounded-full bg-cheese px-3 py-1 text-ink';
  const chips: string[] = [];
  // The same % off a delivery's food as off a pick-up (v0.7.37): one chip for every online order.
  if (deliveryPct > 0 && (!canPickup || deliveryPct === pickupPct)) {
    chips.push(notOnDeals ? `${deliveryPct}% off online orders · ${NOT_ON_VALUE_DEALS}` : `${deliveryPct}% off every online order`);
  } else {
    // With value deals marked: shorter words, so the chip stays one line on a 375 px phone.
    if (canPickup) chips.push(notOnDeals ? `${pickupPct}% off online pick-up · ${NOT_ON_VALUE_DEALS}` : `${pickupPct}% off when you order online & pick up`);
    if (deliveryPct > 0) chips.push(`${deliveryPct}% off online delivery food${notOnDeals ? ` · ${NOT_ON_VALUE_DEALS}` : ''}`);
  }
  chips.push(...ownPercentChips);
  return (
    <div className="bg-ink text-cream">
      <div className="mx-auto max-w-6xl px-4 pb-5 pt-6 md:pb-7 md:pt-8">
        <div className="md:flex md:items-end md:justify-between md:gap-8">
          <h1 className="font-display text-5xl uppercase leading-none tracking-wide md:text-6xl">The Menu</h1>
          <ul
            aria-label="Hours, payment and delivery"
            className="mt-3 flex flex-wrap gap-x-4 gap-y-1 font-cond text-[0.95rem] font-semibold leading-snug text-cream/80 md:mt-0 md:justify-end md:pb-1"
          >
            <HeaderFact icon="clock">{hoursChip}</HeaderFact>
            <HeaderFact icon="cash">Cash on delivery</HeaderFact>
            {/* The till's area names as places ("Brooks Churangi"), as the old all-capitals chip showed them. */}
            <HeaderFact icon="pin" className="capitalize">
              {deliveryChip}
            </HeaderFact>
          </ul>
        </div>
        {announcement && (
          <p className="mt-4 flex w-fit max-w-2xl items-start gap-2 rounded-2xl border border-cheese/50 bg-cheese/10 px-4 py-2.5 font-cond text-lg font-bold leading-snug text-cheese">
            <span aria-hidden>★</span>
            <span>{announcement}</span>
          </p>
        )}
        {(chips.length > 0 || offerWindow !== null) && (
          <div className="mt-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            {chips.length > 0 && (
              <ul aria-label="Money off online" className="flex flex-wrap gap-2 font-cond text-sm font-bold uppercase tracking-wide">
                {chips.map((words) => (
                  <li key={words} className={chip}>
                    {words}
                  </li>
                ))}
              </ul>
            )}
            {offerWindow !== null && (
              <div className="lg:w-[26rem] lg:shrink-0">
                <OfferTeaser prices={offerPrices} where={offerWhere} window={offerWindow} dealsAnchor={offerDealsAnchor} />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/** One fact in the header's line, after a small gold icon (drawn here: no icon font, nothing to load). */
function HeaderFact({
  icon,
  className = '',
  children,
}: {
  icon: 'clock' | 'cash' | 'pin';
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <li className="flex items-start gap-1.5">
      <svg
        aria-hidden
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        className="mt-[0.2em] h-4 w-4 shrink-0 text-cheese"
      >
        {icon === 'clock' && (
          <>
            <circle cx="12" cy="12" r="9" />
            <path d="M12 7v5l3 2" />
          </>
        )}
        {icon === 'cash' && (
          <>
            <rect x="2.5" y="6" width="19" height="12" rx="2" />
            <circle cx="12" cy="12" r="2.5" />
          </>
        )}
        {icon === 'pin' && (
          <>
            <path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z" />
            <circle cx="12" cy="10" r="2.5" />
          </>
        )}
      </svg>
      <span className={className || undefined}>{children}</span>
    </li>
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
  menu: PublicMenu;
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

function SectionTitle({
  id,
  name,
  note,
  fine = null,
}: {
  id: string;
  name: string;
  note: string | null;
  /** Words the section must say plainly, in solid gold under its title (Buy 1 Get 1: "Delivery charges & tax may apply"). */
  fine?: string | null;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-1 border-b-[3px] border-ink pb-2">
      <h2 id={id} className="font-display text-4xl uppercase leading-none tracking-wide text-ink md:text-5xl">
        {name}
      </h2>
      {note && <p className="font-cond text-sm font-bold uppercase tracking-wider text-ink-muted">{note}</p>}
      {fine && (
        <p className="basis-full pt-1">
          <span className="inline-block rounded-md bg-cheese px-2 py-1 font-cond text-xs font-extrabold uppercase tracking-wide text-ink">
            {fine}
          </span>
        </p>
      )}
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
  const shop = useShopFacts();
  return (
    <a
      href={orderWhatsappUrl(shop)}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center rounded-full border-2 border-dashed border-ink/25 px-3 py-1.5 font-cond text-sm font-bold uppercase tracking-wide text-ink-muted hover:border-ink/50"
    >
      Pick-up only · ask on WhatsApp
    </a>
  );
}

/**
 * Size buttons: each shows its size and price and adds that exact item. With `cut` (every online order takes a %
 * off: lib/offers discountOnEveryOrder) the price is the one after it, the menu price struck out beside it — display
 * only, as before: the cart, the server and the till work the % out (lib/pricing).
 */
function VariantButtons({
  card,
  qtyByItem,
  canPickup,
  onPick,
  dark = false,
  onGold = false,
  cut = null,
}: {
  card: MenuCard;
  qtyByItem: Map<string, number>;
  canPickup: boolean;
  onPick: PickFn;
  dark?: boolean;
  /** On a gold deal card: a solid ink button. */
  onGold?: boolean;
  /** Each size's price before and after the % off, in the card's own order (lib/offers); null = the menu prices. */
  cut?: readonly OfferPrice[] | null;
}) {
  // Pick-up-only food is orderable only while online pick-up is: the whole card, or one size of it.
  if (card.pickupOnly && !canPickup) return <PickupOnly />;
  const sized = card.variants.length > 1;
  const note = pickupOnlyNote(card);
  const cuts = cut && cut.length === card.variants.length ? cut : null;
  return (
    <div className={sized ? 'grid grid-cols-2 gap-2' : 'flex flex-wrap items-center gap-2'}>
      {card.variants.map((v, i) => {
        const inCart = qtyByItem.get(v.item.posItemId) ?? 0;
        const hasChoices = v.item.modifierGroups.length > 0;
        const was = v.item.basePriceCents;
        // A size the till marked "no discount" keeps its menu price.
        const now = v.item.noDiscount === true ? was : (cuts?.[i]?.nowCents ?? was);
        const struck = now < was ? (
          <s className={`whitespace-nowrap text-[0.72rem] font-semibold ${dark ? 'opacity-60' : 'opacity-55'}`}>{formatCents(was)}</s>
        ) : null;
        // A size's name over its price (a lone size too: "Large 12""), so the button stays narrow on a phone.
        const sizeName = cardSizeLabel(card, v.size);
        const stacked = sized || sizeName !== '';
        if (!sizeOrderable(v, canPickup)) {
          // This size only: the card's other sizes still deliver.
          return (
            <span
              key={v.item.posItemId}
              className={`flex min-h-[2.75rem] flex-col justify-center rounded-2xl border-2 border-dashed px-3 py-1.5 font-cond text-xs font-bold uppercase leading-tight tracking-wide ${
                dark ? 'border-cream/30 text-cream/60' : 'border-ink/25 text-ink-muted'
              }`}
            >
              <span>{cardSizeLabel(card, v.size) || variantLabel(card, v)}</span>
              <span>Pick-up only</span>
            </span>
          );
        }
        return (
          <button
            type="button"
            key={v.item.posItemId}
            onClick={() => onPick(card, i)}
            aria-label={`${hasChoices ? 'Choose options for' : 'Add'} ${variantLabel(card, v)}, ${formatCents(now)}${
              now < was ? ` (was ${formatCents(was)})` : ''
            }${inCart > 0 ? ` (${inCart} in your order)` : ''}`}
            className={`group/btn relative flex min-h-[2.75rem] items-center gap-2 py-1.5 pr-1.5 font-cond font-bold uppercase tracking-wide transition-all active:scale-95 ${
              stacked ? 'justify-between rounded-2xl pl-3 text-left' : 'rounded-full pl-3.5'
            } ${
              onGold
                ? 'bg-ink py-2 text-lg text-cheese hover:bg-ink-soft'
                : dark
                  ? 'bg-cheese text-ink hover:bg-cheese-hot'
                  : 'border-2 border-ink bg-white text-ink hover:bg-ink hover:text-cheese'
            }`}
          >
            {stacked ? (
              <span className="leading-tight">
                <span className="block whitespace-nowrap text-[0.7rem] opacity-75">{sizeName}</span>
                <span className="flex flex-wrap items-baseline gap-x-1.5 tabular-nums">
                  <span className="whitespace-nowrap">{formatCents(now)}</span>
                  {struck}
                </span>
              </span>
            ) : (
              <>
                <span className="whitespace-nowrap tabular-nums">{formatCents(now)}</span>
                {struck}
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
      {note && (!sized || card.pickupOnly || canPickup) && (
        <span className="font-cond text-xs font-bold uppercase tracking-wider opacity-70">{note}</span>
      )}
    </div>
  );
}

interface CardProps {
  card: MenuCard;
  qtyByItem: Map<string, number>;
  canPickup: boolean;
  onPick: PickFn;
  /** What the card says of the offers (lib/offers, as the menu shows them); none on a value deal. */
  offer?: ShownOffer;
  /** The Buy 1 Get 1 deals' section, once the menu has them: the card's Buy 1 Get 1 tag jumps there. */
  dealsAnchor?: string | null;
}

/** The prices the card's buttons show after its % off, when every online order takes it; else none (the menu prices). */
function cutPrices(shown: ShownOffer | undefined): readonly OfferPrice[] | null {
  return shown?.onPrice ? (shown.offer.discount?.prices ?? null) : null;
}

function countFor(card: MenuCard, qtyByItem: Map<string, number>): number {
  return card.variants.reduce((s, v) => s + (qtyByItem.get(v.item.posItemId) ?? 0), 0);
}

/** Signature pizzas and anything photographed: the food leads. */
const PhotoCard = memo(function PhotoCard({ card, qtyByItem, canPickup, onPick, offer, dealsAnchor = null }: CardProps) {
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
        {offer && <OfferStrip shown={offer} dark dealsAnchor={dealsAnchor} />}
        <div className="mt-auto pt-3">
          <VariantButtons card={card} qtyByItem={qtyByItem} canPickup={canPickup} onPick={onPick} dark cut={cutPrices(offer)} />
        </div>
      </div>
    </article>
  );
});

/**
 * Everything else: set like a line on the printed menu. `small`: in a section of little things (isSmallSection), two
 * to a row on a phone — a card with words there takes the whole row.
 */
const ItemCard = memo(function ItemCard({
  card,
  qtyByItem,
  canPickup,
  onPick,
  offer,
  dealsAnchor = null,
  small = false,
}: CardProps & { small?: boolean }) {
  const count = countFor(card, qtyByItem);
  const single = card.variants.length === 1 ? card.variants[0] : undefined;
  const wide = small && Boolean(card.description);
  return (
    <article
      className={`flex flex-col rounded-2xl border border-paper-line bg-white ${small ? 'p-3.5' : 'p-4'} shadow-soft-sm transition-shadow hover:shadow-soft-md${
        wide ? ' col-span-2 sm:col-span-3' : ''
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <h3
          className={`font-cond ${small && !wide ? 'text-lg' : 'text-xl'} font-extrabold uppercase leading-tight tracking-wide text-ink`}
        >
          {card.name}
          {single && cardSizeLabel(card, single.size) && (
            <span className="ml-2 align-middle text-xs font-bold tracking-widest text-ink-muted">
              {cardSizeLabel(card, single.size)}
            </span>
          )}
        </h3>
        <InCartBadge count={count} />
      </div>
      {card.description && <p className="mt-1 text-sm leading-snug text-ink-muted">{card.description}</p>}
      {offer && <OfferStrip shown={offer} dealsAnchor={dealsAnchor} />}
      <div className="mt-auto pt-3">
        <VariantButtons card={card} qtyByItem={qtyByItem} canPickup={canPickup} onPick={onPick} cut={cutPrices(offer)} />
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
  kind = 'value',
  dealWindow = '',
  closed = false,
  worthCents,
  qtyByItem,
  canPickup,
  onPick,
}: CardProps & {
  n: number;
  /** A value deal, or a Buy 1 Get 1 deal (its own label; sold in the owner's hours only). */
  kind?: 'value' | 'buy1get1';
  /** A Buy 1 Get 1 deal's hours in words ("1–7 PM"). */
  dealWindow?: string;
  /** A Buy 1 Get 1 deal outside its hours: it says when, and has no add buttons. */
  closed?: boolean;
  worthCents: number | null;
}) {
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
          <p className="font-cond text-xs font-extrabold uppercase tracking-[0.22em] text-ink/70">
            {kind === 'buy1get1' ? `Buy 1 Get 1 · ${dealWindow}` : `Value deal ${num}`}
            {/* Its price includes the tax (0057; the deal menu: "the price you see is the price you pay"). */}
            {card.variants.every((v) => isTaxIncluded(v.item)) && card.variants.length > 0 ? ' · Tax included' : ''}
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
      {card.description && <p className="relative mt-2 font-cond text-lg font-bold leading-snug">{card.description}</p>}
      {save > 0 && worthCents !== null && (
        <p className="relative mt-0.5 text-sm font-medium text-ink/70">
          <s className="tabular-nums">{formatCents(worthCents)}</s> if bought separately
        </p>
      )}
      <div className="relative mt-auto flex flex-wrap items-center gap-3 pt-4">
        {closed ? (
          <span className="rounded-full border-2 border-ink px-4 py-2 font-cond text-sm font-extrabold uppercase tracking-wide text-ink">
            Available {dealWindow}
          </span>
        ) : (
          <VariantButtons card={card} qtyByItem={qtyByItem} canPickup={canPickup} onPick={onPick} onGold />
        )}
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
 * so an interested customer is redirected rather than turned away. The
 * owner's closed notice (v0.7.30), while there is one, replaces the
 * explanation; the heading and the WhatsApp buttons stay.
 */
function ClosedBanner({ notice }: { notice: string | null }) {
  const shop = useShopFacts();
  return (
    <div className="mx-auto mt-5 max-w-6xl px-4">
      <div className="rounded-2xl border-2 border-ink bg-cheese p-4 text-ink">
        <p className="font-display text-2xl uppercase tracking-wide">We&rsquo;re not taking online orders right now</p>
        {notice ? (
          <p className="mt-1 text-sm font-medium">{notice}</p>
        ) : (
          <p className="mt-1 text-sm font-medium">
            The kitchen isn&rsquo;t accepting website orders at the moment ({shopHoursInSentence(shop)}). You can
            still build your order here and send it to us on WhatsApp from &ldquo;View order&rdquo; — we reply fast.
          </p>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          {whatsappLinesOf(shop).map((l) => (
            <a
              key={l.url}
              href={lineOrderUrl(shop, l)}
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
