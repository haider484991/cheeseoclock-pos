/**
 * The WhatsApp ordering bot (lib/whatsapp-bot, 26 Oct 2026; fewer steps 27 Oct; simple 28 Oct; buttons 29 Oct 2026):
 * the printed deal menu as a picture with tap buttons under it (Deals, Pizza, Burger), its printed numbers picking a
 * deal when typed; then one short question at a time, its options WhatsApp's own tap buttons (three or fewer) or behind
 * one clearly named list button, each message ending with what to tap; only what must be chosen is asked (the usual
 * drink and dip are set, changed by typing their name); a pizza's flavour, then its size; the website's % off on the
 * prices; Delivery or Pick-up, the area read from the address, the WhatsApp name as the order's name — priced by the
 * website's own order route before the customer confirms, and placed once however often they confirm.
 */
import { describe, expect, it } from 'vitest';
import type { PublishedMenu, PublishedMenuItem, PublishedModifierGroup } from '@cheeseoclock/shared-types';
import { factsFromBlock, feeRangeOfFees } from './delivery-facts';
import { asksBot, isBotCommand, runBot, welcomeStep, zoneInText, type BotData, type BotDeps, type BotShop, type BotState, type BotStep, type OrderAnswer } from './whatsapp-bot';
import { payloadOf, type WaOut } from './whatsapp-send';

const mod = (id: string, name: string, deltaRs = 0, isDefault = false) => ({ posModifierId: id, name, priceDeltaCents: deltaRs * 100, isDefault, sortOrder: 0 });
function group(id: string, name: string, modifiers: ReturnType<typeof mod>[], o: { min?: number; max?: number; req?: boolean } = {}): PublishedModifierGroup {
  return {
    posGroupId: id,
    name,
    selectionType: (o.max ?? 1) === 1 ? 'single' : 'multi',
    minSelect: o.min ?? 0,
    maxSelect: o.max ?? 1,
    isRequired: o.req ?? false,
    sortOrder: 0,
    modifiers,
  };
}
function item(id: string, name: string, rs: number, groups: PublishedModifierGroup[] = [], over: Partial<PublishedMenuItem> = {}): PublishedMenuItem {
  return { posItemId: id, name, description: null, basePriceCents: rs * 100, taxRateBps: 1500, imageUrl: null, sortOrder: 0, modifierGroups: groups, ...over };
}

const DEAL = item(
  'deal-lc',
  'Large & Chilled',
  1800,
  [
    group('g-pz', 'Deal: Large pizza', [mod('pz-fajita', 'Large: Fajita'), mod('pz-tikka', 'Large: Chicken Tikka'), mod('pz-malai', 'Large: Malai Supreme')], { min: 1, req: true }),
    group('g-dr', 'Deal: 1 litre drink', [mod('dr-cola', 'Cola 1 litre'), mod('dr-lime', 'Lemon-lime 1 litre')], { min: 1, req: true }),
    group('g-dip', 'Dips on the side', [mod('dip-garlic', 'Garlic Mayo', 100)], { max: 9 }),
    group('g-fixed', 'Comes with · fries', [mod('fx-fries', 'Fries', 0, true)], { min: 1, req: true }),
  ],
  { taxIncluded: true, noDiscount: true, description: 'Large 12" regular pizza + 1 litre drink' },
);
const BURGER = item('burger', 'Classic Crispy Chicken', 700, [group('g-ex', 'Extras · Burgers', [mod('ex-cheese', 'Cheese slice', 80)])]);
const PIZZAS = Array.from({ length: 12 }, (_, i) => item(`pz-${i}`, `Pizza number ${i + 1} — Large`, 2000));

const MENU: PublishedMenu = {
  categories: [
    { posCategoryId: 'c-burgers', name: 'Burgers', displayOrder: 1, items: [BURGER] },
    { posCategoryId: 'c-deals', name: 'Value Deals', displayOrder: 2, items: [DEAL] },
    { posCategoryId: 'c-pizza', name: 'Pizza', displayOrder: 3, items: PIZZAS },
    { posCategoryId: 'c-del', name: 'Delivery Charges', displayOrder: 9, items: [item('del-200', 'Delivery Charge (Rs 200)', 200)] },
  ],
  publishedAt: '2026-10-26T00:00:00Z',
  store: { name: 'Shop', phone: null, whatsapp: null, addressLine: null, tagline: null },
};
/** The live menu's shape: the till's "Pizza" (regular, in sizes, 20% off), a signature pizza, Buy 1 Get 1, a drink. */
const B1G1 = item('b1-lm', 'Large + Free Medium', 2000, [], { taxIncluded: true, noDiscount: true, description: 'Any Large 12" regular pizza + any Medium 9" regular pizza FREE.' });
const SODA = item('dr-345', 'Soft Drink — 345 ml', 120, [group('g-fl', 'Choose a flavour · 345 ml', [mod('fl-cola', 'Cola'), mod('fl-lime', 'Lemon-lime')], { min: 1, req: true })]);
const LIVE: PublishedMenu = {
  ...MENU,
  categories: [
    { posCategoryId: 'c-deals', name: 'Value Deals', displayOrder: 1, items: [DEAL] },
    { posCategoryId: 'c-burgers', name: 'Burgers', displayOrder: 2, items: [BURGER] },
    { posCategoryId: 'c-b1g1', name: 'Buy 1 Get 1 Deals', displayOrder: 2, items: [B1G1] },
    { posCategoryId: 'c-sig', name: 'Signature Pizzas', displayOrder: 3, items: [item('sig-star', 'Cheesy Star — Large', 2200)] },
    {
      posCategoryId: 'c-pizza',
      name: 'Pizza',
      displayOrder: 5,
      items: [item('fz-m', 'Fajita Pizza — Medium', 1500), item('fz-l', 'Fajita Pizza — Large', 2000), item('tk-m', 'Chicken Tikka Pizza — Medium', 1500), item('tk-l', 'Chicken Tikka Pizza — Large', 2000)],
    },
    { posCategoryId: 'c-drinks', name: 'Drinks', displayOrder: 7, items: [SODA] },
  ],
};
const PICTURE = { url: 'https://site.test/images/whatsapp/deal-menu.jpg', deals: ['Large & Chilled'] };
/** The shop's place as the route gives it (lib/business pin, the owner's address). */
const PLACE = { name: 'Cheese O’Clock', street: 'Shop 3, 41-C, Rahat Commercial Area, DHA Phase 6', areaLine: 'Rahat Commercial Area, DHA Phase 6', lat: 24.8082972, lng: 67.0684383 };
/** As the website charges today: 10% off the food on a pick-up and on a delivery, the regular pizzas 20%. */
const LIVE_OFFERS: Partial<BotShop> = {
  menu: LIVE,
  deliveryPercent: 10,
  pickupCategoryPercents: [{ categoryId: 'c-pizza', percent: 20 }],
  deliveryCategoryPercents: [{ categoryId: 'c-pizza', percent: 20 }],
  buy1Get1Hours: '12–7 PM',
  buy1Get1Open: true,
  menuPicture: PICTURE,
  place: PLACE,
  reachKm: 8,
};

function shop(over: Partial<BotShop> = {}): BotShop {
  return {
    menu: MENU,
    zones: factsFromBlock(null).zones,
    open: true,
    pickupAvailable: true,
    pickupPercent: 10,
    closedText: 'Abhi online orders band hain (open daily · 1 pm – 1 am).',
    ...over,
  };
}

/** The website's order route, as the bot sees it: a quote, or the order placed. */
function fakeDeps(answer?: (body: Record<string, unknown>) => OrderAnswer) {
  const bodies: Array<Record<string, unknown>> = [];
  const deps: BotDeps = {
    order: async (body) => {
      bodies.push(body);
      if (answer) return answer(body);
      return {
        ok: true,
        ...(body['dryRun'] ? {} : { orderId: String(body['clientOrderId']) }),
        subtotalCents: 380_000,
        discountCents: 0,
        taxCents: 0,
        totalCents: 380_000,
        lines: [
          { posItemId: 'deal-lc', name: 'Large & Chilled', quantity: 2, unitPriceCents: 180_000, modifiers: [{ posModifierId: 'pz-tikka', name: 'Large: Chicken Tikka' }, { posModifierId: 'dr-cola', name: 'Cola 1 litre' }, { posModifierId: 'fx-fries', name: 'Fries' }] },
          { posItemId: 'del-200', name: 'Delivery Charge (Rs 200)', quantity: 1, unitPriceCents: 20_000, modifiers: [] },
        ],
      };
    },
    link: async () => 'Tok3nAbcDefG',
    newId: () => '0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000',
    trackUrl: (id, phone) => `https://site.test/track/${id}?phone=${encodeURIComponent(phone)}`,
    websiteText: (t) => `Website: https://site.test/menu?wa=${t}`,
  };
  return { deps, bodies };
}

/** A conversation: each customer message runs the bot on the step the last one saved, from the day's welcome. */
function chat(s: BotShop = shop(), deps: BotDeps = fakeDeps().deps, profileName: string | null = 'Haider Ali', from: { state: BotState; data: BotData } | null = null) {
  let saved: { state: BotState; data: BotData } | null = from ?? (({ state, data }) => ({ state, data }))(welcomeStep({ shopName: 'Shop', profileName, shop: s }));
  return {
    async send(said: { tap?: string; text?: string }) {
      const step = await runBot(
        { waId: '923088440608', profileName, text: said.text ?? null, reply: said.tap ? { id: said.tap, title: '' } : null },
        saved,
        s,
        deps,
      );
      saved = { state: step.state, data: step.data };
      return step;
    },
    /** The step saved now (to run the bot on a turn `send` can't make: a shared location). */
    saved: () => saved,
    /** A turn run outside `send`, kept as the step it saved. */
    async step(run: Promise<BotStep>) {
      const step = await run;
      saved = { state: step.state, data: step.data };
      return step;
    },
  };
}

/** A message's words (a picture's caption); the options it offers to tap, their words; what a step said and offered. */
const textOf = (m: WaOut | undefined): string => (!m ? '' : m.type === 'image' ? m.caption : m.type === 'location' ? `[pin ${m.lat},${m.lng} ${m.name}: ${m.address}]` : m.body);
const ids = (m: WaOut | undefined): string[] => (m?.type === 'buttons' ? m.buttons.map((b) => b.id) : m?.type === 'list' ? m.sections.flatMap((s) => s.rows.map((r) => r.id)) : []);
const titles = (m: WaOut | undefined): string[] => (m?.type === 'buttons' ? m.buttons.map((b) => b.title) : m?.type === 'list' ? m.sections.flatMap((s) => s.rows.map((r) => r.title)) : []);
const opts = (s: BotStep): string[] => s.data.choices ?? [];
const said = (s: BotStep): string => s.out.map(textOf).join('\n\n');
const last = (s: BotStep): WaOut | undefined => s.out.at(-1);
const TAP = '👇 *Neeche button dabayein*';
/** Where the default areas deliver (delivery-facts' defaults: DHA and Clifton). */
const DELIVERY_LINE = `🛵 Delivery: DHA aur Clifton (${feeRangeOfFees(factsFromBlock(null).zones.filter((z) => z.active).map((z) => z.feeCents))}) · 🏃 Pick-up bhi`;

describe('the WhatsApp ordering bot', () => {
  it('a whole delivery order in taps: the deal, its pizza (the drink is the usual), Delivery, the address, OK', async () => {
    const { deps, bodies } = fakeDeps();
    const c = chat(shop(), deps);

    const menu = await c.send({ text: 'menu' });
    expect(menu.state).toBe('menu');
    // No picture for this menu: the deals to tap (one deal here, so three buttons with the pizzas and burgers), the
    // deal written out with what comes in it, and where the shop delivers on top.
    expect(menu.out).toHaveLength(1);
    expect(menu.out[0]).toMatchObject({ type: 'buttons' });
    expect(textOf(menu.out[0])).toBe(
      `${DELIVERY_LINE}\n\n🔥 *Hamari deals* (tax shamil)\n\n1️⃣ *Large & Chilled* — Rs 1,800\n      _Large 12" regular pizza + 1 litre drink_\n\n${TAP}`,
    );
    expect(ids(menu.out[0])).toEqual(['i:deal-lc', 'o:pizza', 'o:burger']);
    expect(titles(menu.out[0])).toEqual(['1. Large & Chilled', '🍕 Pizza', '🍔 Burger']);

    const pizza = await c.send({ tap: 'i:deal-lc' });
    expect(pizza.state).toBe('choice');
    // Only what must be chosen: the pizza, three short choices = three tap buttons.
    expect(pizza.out[0]).toMatchObject({ type: 'buttons' });
    expect(textOf(pizza.out[0])).toBe(`🍕 *Large & Chilled* — Rs 1,800 ✅\n\nLarge pizza kaunsa?\n\n${TAP}`);
    expect(ids(pizza.out[0])).toEqual(['m:pz-fajita', 'm:pz-tikka', 'm:pz-malai']);
    expect(titles(pizza.out[0])).toEqual(['Fajita', 'Chicken Tikka', 'Malai Supreme']);

    const cart = await c.send({ tap: 'm:pz-tikka' });
    expect(cart.state).toBe('cart');
    expect(ids(cart.out[0])).toEqual(['f:delivery', 'f:pickup', 'k:add']);
    expect(titles(cart.out[0])).toEqual(['🛵 Delivery', '🏃 Pick-up 10% off', '➕ Aur add karein']);
    expect(textOf(cart.out[0])).toBe(`✅ *Order mein add ho gaya!*\n\n🍕 *Large & Chilled* — Rs 1,800\n      Chicken Tikka · Cola 1 litre\n\n*Delivery ya pick-up?*\n\n${TAP}`);
    expect(cart.data.cart).toEqual([{ posItemId: 'deal-lc', quantity: 1, modifierIds: ['dr-cola', 'fx-fries', 'pz-tikka'] }]);

    const address = await c.send({ tap: 'f:delivery' });
    expect(address.state).toBe('address');
    expect(said(address)).toContain('📍 Apna *address* likh kar bhejein');
    expect(address.data.choices).toBeUndefined(); // the address's numbers are not options

    // The area is read from the address, and the WhatsApp name is the order's: straight to the till's price.
    const confirm = await c.send({ text: 'House 12, Street 4, DHA Phase 6' });
    expect(confirm.state).toBe('confirm');
    expect(ids(confirm.out[0])).toEqual(['y:confirm', 'y:edit', 'y:cancel']);
    expect(titles(confirm.out[0])).toEqual(['✅ Order kar dein', '✏️ Badlein', '❌ Cancel']);
    const summary = said(confirm);
    expect(summary).toContain('🧾 *Aapka order*\n\n🍕 2× Large & Chilled — Rs 3,600\n      Chicken Tikka · Cola 1 litre\n🛵 Delivery — Rs 200');
    expect(summary).toContain(`💰 *Total: Rs 3,800* · cash on delivery\n📍 House 12, Street 4, DHA Phase 6\n👤 Haider Ali · 0308 8440608\n\n${TAP}`);

    // Words at the end are the order's note; "ok" (or the button) confirms.
    const noted = await c.send({ text: 'Ghanti mat bajayein' });
    expect(noted.state).toBe('confirm');
    expect(said(noted)).toContain('📝 Ghanti mat bajayein');

    const placed = await c.send({ text: 'ok' });
    expect(placed.state).toBe('idle');
    expect(said(placed)).toBe(
      '✅ *Order ho gaya!* Shukriya Haider 🙏\n\n💰 Rs 3,800 · cash on delivery\n🍕 Kitchen confirm karte hi yahin batayenge.\n📦 Order dekhein: https://site.test/track/0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000?phone=0308%208440608',
    );
    expect(placed.data.cart).toEqual([]);

    // The quotes and the order are the same order: one id, the WhatsApp number, the link token, the note.
    expect(bodies).toHaveLength(3);
    expect(bodies[1]).toMatchObject({ dryRun: true, customerName: 'Haider Ali', customerPhone: '+923088440608', fulfilment: 'delivery', zoneId: 'dha-6', addressLine: 'House 12, Street 4, DHA Phase 6', notes: 'Ghanti mat bajayein', waToken: 'Tok3nAbcDefG' });
    expect(bodies[2]).toMatchObject({ clientOrderId: '0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000', notes: 'Ghanti mat bajayein', items: [{ posItemId: 'deal-lc', quantity: 1, modifierIds: ['dr-cola', 'fx-fries', 'pz-tikka'] }] });
    expect(bodies[2]).not.toHaveProperty('dryRun');
  });

  it('the welcome is the printed deal menu with tap buttons under it; its printed numbers pick a deal; a list when a pictured deal is missing', async () => {
    const w = welcomeStep({ shopName: 'Cheese O’Clock', profileName: 'Haider Ali', shop: shop(LIVE_OFFERS) });
    expect(w.state).toBe('menu');
    expect(w.out).toHaveLength(1);
    expect(w.out[0]).toMatchObject({ type: 'buttons', image: 'https://site.test/images/whatsapp/deal-menu.jpg' });
    // Where the shop is and where it delivers, under the deals (30 Oct 2026: ad chats asked, and came from too far).
    expect(textOf(w.out[0])).toBe(
      `Assalam o Alaikum Haider! Cheese O’Clock mein khush aamdeed 🧀\n👆 Picture mein hamari deals hain — deal ka *number* bhejein (jaise *5*)\n🎁 Buy 1 Get 1 abhi chal raha hai (12–7 PM)\n\n📍 Shop: Rahat Commercial Area, DHA Phase 6\n${DELIVERY_LINE}\n\n${TAP}`,
    );
    // While Buy 1 Get 1 sells it has a button; a number typed is a printed deal (then Buy 1 Get 1).
    expect(ids(w.out[0])).toEqual(['o:deals', 'o:b1g1', 'o:pizza']);
    expect(w.data.choices).toEqual(['i:deal-lc', 'i:b1-lm']);
    expect((await chat(shop(LIVE_OFFERS)).send({ text: '1' })).state).toBe('choice');
    // Outside its hours: its hours in words, and the burgers' button.
    const later = welcomeStep({ shopName: 'Shop', profileName: null, shop: shop({ ...LIVE_OFFERS, buy1Get1Open: false }) });
    expect(textOf(later.out[0])).toContain('🎁 Buy 1 Get 1: roz 12–7 PM');
    expect(ids(later.out[0])).toEqual(['o:deals', 'o:pizza', 'o:burger']);
    expect(later.data.choices).toEqual(['i:deal-lc']);
    // A deal the picture prints is not on the menu (renamed, sold out): its numbers would lie, so the deals list instead.
    const gone = welcomeStep({ shopName: 'Shop', profileName: null, shop: shop({ ...LIVE_OFFERS, menuPicture: { ...PICTURE, deals: ['Large & Chilled', 'Mega Cheese Box'] } }) });
    expect(gone.out[0]).toMatchObject({ type: 'list', button: 'Deal chunein' });
    // The picture as WhatsApp gets it: on top of the buttons.
    expect(payloadOf('923088440608', w.out[0]!)).toMatchObject({ type: 'interactive', interactive: { type: 'button', header: { type: 'image', image: { link: 'https://site.test/images/whatsapp/deal-menu.jpg' } } } });
  });

  it('the start’s buttons: Deals behind a list button (with Buy 1 Get 1 while it sells), Buy 1 Get 1, Pizza, Burger — each one written out too', async () => {
    const c = chat(shop(LIVE_OFFERS));
    const deals = await c.send({ tap: 'o:deals' });
    expect(deals.out[0]).toMatchObject({ type: 'list', button: 'Deal chunein' });
    expect(ids(deals.out[0])).toEqual(['i:deal-lc', 'i:b1-lm', 'o:pizza', 'o:burger']);
    expect(titles(deals.out[0])).toEqual(['1. Large & Chilled', '🎁 Large + Free Medium', '🍕 Pizza', '🍔 Burger']);
    // The rows are hidden until the list's button is tapped: the deals are in the message as well (30 Oct 2026).
    expect(textOf(deals.out[0])).toBe(
      '🔥 *Hamari deals* (tax shamil)\n\n1️⃣ *Large & Chilled* — Rs 1,800\n      _Large 12" regular pizza + 1 litre drink_\n2️⃣ 🎁 *Large + Free Medium* — Rs 2,000\n      _Any Large 12" regular pizza + any Medium 9" regular pizza FREE._\n\n👇 Neeche *Deal chunein* button dabayein',
    );
    const b1 = await c.send({ tap: 'o:b1g1' });
    expect(textOf(b1.out[0])).toBe(`🎁 *Buy 1 Get 1* · roz 12–7 PM (tax shamil)\n\n1️⃣ *Large + Free Medium* — Rs 2,000\n      _Any Large 12" regular pizza + any Medium 9" regular pizza FREE._\n\n${TAP}`);
    expect(ids(b1.out[0])).toEqual(['i:b1-lm']);
    expect(ids((await c.send({ tap: 'o:pizza' })).out[0])).toEqual(['p:fz-m', 'p:tk-m', 'o:sig']);
    expect(ids((await c.send({ tap: 'o:sig' })).out[0])).toEqual(['i:sig-star']);
    const burgers = await c.send({ tap: 'o:burger' });
    expect(burgers.out[0]).toMatchObject({ type: 'list', button: 'Burger chunein' });
    expect(textOf(burgers.out[0])).toBe('🍔 *Burgers* — 🔥 *10% OFF* (+ tax)\n\n1️⃣ *Classic Crispy Chicken* — ~Rs 700~ *Rs 630*\n\n👇 Neeche *Burger chunein* button dabayein');
    expect(burgers.out[0]!.type === 'list' && burgers.out[0]!.sections[0]!.rows[0]).toEqual({ id: 'i:burger', title: 'Classic Crispy Chicken', description: 'Rs 630 (pehle Rs 700)' });
  });

  it('a list too long for one message: every option written out first as a text, then the list button, numbers still picking', async () => {
    const deals = Array.from({ length: 10 }, (_, i) =>
      item(`d${i}`, `Family Deal number ${i + 1}`, 2000 + i * 100, [], { taxIncluded: true, noDiscount: true, description: `${i + 2} large pizzas, a 1.5 litre drink, two portions of fries and four dips on the side` }),
    );
    const c = chat(shop({ menu: { ...MENU, categories: [{ posCategoryId: 'c-x', name: 'Value Deals', displayOrder: 1, items: deals }] } }));
    const list = await c.send({ tap: 'o:deals' });
    expect(list.out.map((m) => m.type)).toEqual(['text', 'list']);
    const all = textOf(list.out[0]);
    expect(all.startsWith('🔥 *Hamari deals* (tax shamil)\n\n1️⃣ *Family Deal number 1* — Rs 2,000\n')).toBe(true);
    expect(all).toContain('🔟 *Family Deal number 10* — Rs 2,900');
    expect(textOf(list.out[1])).toBe('👆 Upar wali list mein se chunein\n👇 Neeche *Deal chunein* button dabayein\n(ya uska *number* bhejein)');
    expect(ids(list.out[1])).toHaveLength(10);
    expect((await c.send({ text: '10' })).data.cart).toEqual([{ posItemId: 'd9', quantity: 1, modifierIds: [] }]);
    // Every list is written out, an area's or a choice's too (the plain titles and their second lines).
    const areas = await chat(shop(), fakeDeps().deps, 'Haider Ali', { state: 'zones', data: { cart: [{ posItemId: 'burger', quantity: 1, modifierIds: [] }], fulfilment: 'delivery' } }).send({ tap: 'zg:0' });
    expect(textOf(areas.out[0])).toMatch(/^📍 DHA mein kahan\?\n\n1️⃣ DHA Phase 1 — /);
  });

  it('the usual drink and dip are set, and changed by typing their name at the order (or at its end)', async () => {
    const { deps, bodies } = fakeDeps();
    const c = chat(shop({ menuPicture: PICTURE }), deps);
    await c.send({ text: '1' });
    const cart = await c.send({ text: 'fajita' });
    expect(cart.data.cart[0]!.modifierIds).toContain('dr-cola');
    const changed = await c.send({ text: 'sprite' });
    expect(said(changed)).toContain('✅ Badal diya');
    expect(said(changed)).toContain('Fajita · Lemon-lime 1 litre');
    expect(changed.data.cart[0]!.modifierIds).toEqual(['fx-fries', 'pz-fajita', 'dr-lime']);
    await c.send({ tap: 'f:pickup' });
    const back = await c.send({ text: 'coke' });
    expect(back.state).toBe('confirm');
    expect(back.data.notes).toBeUndefined(); // a drink named at the end is the drink, not a note
    expect(bodies.at(-1)).toMatchObject({ items: [{ posItemId: 'deal-lc', modifierIds: ['fx-fries', 'pz-fajita', 'dr-cola'] }] });
    // A drink ordered on its own: its flavour is asked (it is the drink they want).
    const soda = await chat(shop({ menu: LIVE })).send({ text: 'soft drink' });
    expect(soda.state).toBe('choice');
    expect(textOf(soda.out[0])).toContain('Choose a flavour kaunsa?');
    expect(ids(soda.out[0])).toEqual(['m:fl-cola', 'm:fl-lime']);
  });

  it('a pizza: the regular flavours behind "Pizza chunein" (sizes and the % off on top), then its size as two buttons, the price after the % off', async () => {
    // four flavours, like the live menu's eight: more than three, so a list button
    const more = [item('ml-m', 'Malai Supreme — Medium', 1500), item('ml-l', 'Malai Supreme — Large', 2000), item('ch-m', 'Cheesalious — Medium', 1500), item('ch-l', 'Cheesalious — Large', 2000)];
    const menu: PublishedMenu = { ...LIVE, categories: LIVE.categories.map((cat) => (cat.posCategoryId === 'c-pizza' ? { ...cat, items: [...cat.items, ...more] } : cat)) };
    const c = chat(shop({ ...LIVE_OFFERS, menu }));
    const list = await c.send({ text: 'pizza' });
    expect(list.out[0]).toMatchObject({ type: 'list', button: 'Pizza chunein' });
    expect(textOf(list.out[0])).toBe(
      '🍕 *Regular pizza* — 🔥 *20% OFF* (+ tax)\nMedium ~Rs 1,500~ *Rs 1,200* · Large ~Rs 2,000~ *Rs 1,600*\n\n1️⃣ *Fajita Pizza*\n2️⃣ *Chicken Tikka Pizza*\n3️⃣ *Malai Supreme*\n4️⃣ *Cheesalious*\n5️⃣ ⭐ Signature pizza — Cheesy Star\n\n👇 Neeche *Pizza chunein* button dabayein',
    );
    expect(list.out[0]!.type === 'list' && list.out[0]!.sections[0]!.rows).toEqual([
      { id: 'p:fz-m', title: 'Fajita Pizza', description: 'Medium Rs 1,200 · Large Rs 1,600' },
      { id: 'p:tk-m', title: 'Chicken Tikka Pizza', description: 'Medium Rs 1,200 · Large Rs 1,600' },
      { id: 'p:ml-m', title: 'Malai Supreme', description: 'Medium Rs 1,200 · Large Rs 1,600' },
      { id: 'p:ch-m', title: 'Cheesalious', description: 'Medium Rs 1,200 · Large Rs 1,600' },
      { id: 'o:sig', title: '⭐ Signature pizza', description: 'Cheesy Star' },
    ]);
    // two flavours: three buttons (the signature ones the third)
    expect(ids((await chat(shop(LIVE_OFFERS)).send({ text: 'pizza' })).out[0])).toEqual(['p:fz-m', 'p:tk-m', 'o:sig']);
    const size = await c.send({ tap: 'p:fz-m' });
    expect(textOf(size.out[0])).toBe(`🍕 *Fajita Pizza* — kaunsa size?\n🔥 20% OFF laga hua (+ tax)\n\n${TAP}`);
    expect(ids(size.out[0])).toEqual(['i:fz-m', 'i:fz-l']);
    expect(titles(size.out[0])).toEqual(['Medium · Rs 1,200', 'Large · Rs 1,600']);
    const cart = await c.send({ tap: 'i:fz-l' });
    expect(cart.data.cart).toEqual([{ posItemId: 'fz-l', quantity: 1, modifierIds: [] }]);
    expect(said(cart)).toContain('🍕 *Fajita Pizza (Large)* — ~Rs 2,000~ *Rs 1,600*');
    // A flavour's name asks its size straight away; "fajita large" goes in.
    expect(ids((await c.send({ text: 'fajita' })).out[0])).toEqual(['i:fz-m', 'i:fz-l']);
    expect((await chat(shop(LIVE_OFFERS)).send({ text: 'fajita large' })).data.cart).toEqual([{ posItemId: 'fz-l', quantity: 1, modifierIds: [] }]);
  });

  it('price words get the start; "deals", Buy 1 Get 1, a category or a size get those (the 28 Oct 2026 chats)', async () => {
    const c = chat(shop(LIVE_OFFERS));
    for (const ask of ['Price list', 'Price plz', 'menu ke rates?', 'how much', 'Kitne ka hai']) {
      const r = await c.send({ text: ask });
      expect(r.out[0]).toMatchObject({ type: 'buttons', image: PICTURE.url });
      expect(opts(r)).toEqual(['i:deal-lc', 'i:b1-lm']);
    }
    for (const ask of ['Your current deals please', 'koi discount hai', 'Menu deal send']) expect(ids((await c.send({ text: ask })).out[0])).toEqual(['i:deal-lc', 'i:b1-lm', 'o:pizza', 'o:burger']);
    expect(ids((await c.send({ text: 'Buy 1 Get 1 Deals' })).out[0])).toEqual(['i:b1-lm']);
    expect(ids((await c.send({ text: 'bogo?' })).out[0])).toEqual(['i:b1-lm']);
    expect(ids((await c.send({ text: 'burger' })).out[0])).toEqual(['i:burger']);
    expect(ids((await c.send({ text: 'Small medium aur large' })).out[0])).toEqual(['p:fz-m', 'p:tk-m', 'o:sig']);
    expect(ids((await c.send({ text: 'coke' })).out[0])).toEqual(['i:dr-345']);
    // A price asked with an item's name: its price, not into the order; several named: each with its price.
    const asked = await c.send({ text: 'fajita large kitne ka hai' });
    expect(asked.data.cart).toEqual([]);
    expect(titles(asked.out[0])).toEqual(['Fajita Pizza (Large)']);
    expect(ids((await c.send({ text: 'Tikka fajita aur malli' })).out[0])).toEqual(['i:fz-m', 'i:fz-l', 'i:tk-m', 'i:tk-l']);
    // A pickup-only % is not promised to everyone (a delivery would be charged in full).
    const pickupOnly = await chat(shop({ ...LIVE_OFFERS, deliveryPercent: 0, deliveryCategoryPercents: [] })).send({ text: 'pizza' });
    expect(textOf(pickupOnly.out[0])).not.toContain('% OFF');
    expect(JSON.stringify(pickupOnly.out)).not.toContain('pehle');
  });

  it('numbers still pick: one out of range is said so; several pick several items (each one’s choices in turn) or several toppings', async () => {
    const c = chat(shop({ menu: { ...MENU, categories: [{ posCategoryId: 'c-deals', name: 'Value Deals', displayOrder: 1, items: [DEAL, BURGER] }] } }));
    const out = await c.send({ text: '99' });
    expect(said(out)).toBe('🙏 Ye number list mein nahi — *1* se *4* tak bhejein.');
    expect(out.state).toBe('menu');
    // "1, 2": the deal's pizza, then the burger (nothing to ask), then the order with both.
    expect((await c.send({ text: '1, 2' })).state).toBe('choice');
    const cart = await c.send({ text: 'no 1' });
    expect(cart.state).toBe('cart');
    expect(cart.data.cart.map((l) => l.posItemId)).toEqual(['deal-lc', 'burger']);

    const veggie = item('veg', 'Veggie Lovers — Medium', 1500, [group('g-veg', 'Veggie Lovers · Choose 3 veggies', ['onion', 'pepper', 'olives', 'mushroom'].map((v) => mod(v, v)), { min: 3, max: 3, req: true })]);
    const v = chat(shop({ menu: { ...MENU, categories: [{ posCategoryId: 'c-pizza', name: 'Pizza', displayOrder: 1, items: [veggie] }] } }));
    const asks = await v.send({ text: 'veggie lovers' });
    expect(textOf(asks.out[0])).toContain('Veggie Lovers: koi *3* chunein (ek ek kar ke)');
    expect(ids(asks.out[0])).toEqual(['m:onion', 'm:pepper', 'm:olives', 'm:mushroom']);
    const one = await v.send({ tap: 'm:onion' });
    expect(ids(one.out[0])).toEqual(['m:pepper', 'm:olives', 'm:mushroom']); // the rest, until three are picked
    const done = await v.send({ text: '2 3' });
    expect(done.state).toBe('cart');
    expect(done.data.cart).toEqual([{ posItemId: 'veg', quantity: 1, modifierIds: ['onion', 'olives', 'mushroom'] }]);
  });

  it('a deal ad’s words go straight to that deal (its full name beats the burger sharing its words); "Price" there shows it again; the day’s hello sits over the menu', async () => {
    const ccDeal = item('cc-deal', 'Classic Crispy Deal', 850, [group('g-cc-burger', 'Deal: burger', [mod('cc-classic', 'Classic'), mod('cc-zinger', 'Zinger')], { min: 1, req: true }), group('g-cc-drink', 'Choose a Drink· 345 ml', [mod('cc-cola', 'Cola'), mod('cc-lime', 'Lemon-lime')], { min: 1, req: true })], { taxIncluded: true, noDiscount: true });
    const menu: PublishedMenu = { ...MENU, categories: [{ ...MENU.categories[1]!, items: [ccDeal, DEAL] }, MENU.categories[0]!, ...MENU.categories.slice(2)] };
    const c = chat(shop({ menu }));
    const first = await c.send({ text: 'Classic Crispy Deal order karni hai' });
    expect(first.state).toBe('choice');
    expect(ids(first.out[0])).toEqual(['m:cc-classic', 'm:cc-zinger']);
    expect(textOf(first.out[0])).toContain('🍔 *Classic Crispy Deal* — Rs 850 ✅');
    const price = await c.send({ text: 'Price' });
    expect(price.state).toBe('choice');
    expect(textOf(price.out[0])).toContain('🍔 *Classic Crispy Deal* — Rs 850 ✅');
    expect(price.data.nudged).toBe(false); // asking the price is not "not understood"
    expect(ids((await c.send({ text: 'Menu deal send' })).out[0])).toEqual(['i:cc-deal', 'i:deal-lc', 'o:pizza', 'o:burger']);
    expect((await chat(shop({ menu })).send({ text: 'I want to order the Classic Crispy Deal' })).state).toBe('choice');

    const hello = 'Assalam o Alaikum Ali! Cheese O’Clock mein khush aamdeed 🧀';
    const step = await runBot({ waId: '923088440608', profileName: 'Ali', text: 'Hello! Can I get more info on this?', reply: null, hello }, { state: 'menu', data: { cart: [] } }, shop({ menuPicture: PICTURE }), fakeDeps().deps);
    expect(textOf(step.out[0]).startsWith(hello)).toBe(true);
    expect(step.out[0]).toMatchObject({ type: 'buttons', image: PICTURE.url });
    expect(opts(step)).toEqual(['i:deal-lc']);
  });

  it('taps on an older list still work: a category and its pages, more choices, a group of areas', async () => {
    const c = chat();
    const cat = await c.send({ tap: 'c:2' });
    expect(cat.state).toBe('items');
    expect(opts(cat)).toEqual(PIZZAS.map((p) => `i:${p.posItemId}`)); // twelve: more than a list, so numbered text
    expect(cat.out[0]!.type).toBe('text');
    expect(opts(await c.send({ tap: 'cp:2:1' }))).toHaveLength(12);
    await c.send({ tap: 'i:deal-lc' });
    expect(ids((await c.send({ tap: 'mp:1' })).out[0])).toEqual(['m:pz-fajita', 'm:pz-tikka', 'm:pz-malai']);
    const groupOf = await c.send({ tap: 'zg:0' });
    expect(groupOf.state).toBe('zones');
    expect(ids(last(groupOf)).every((x) => x.startsWith('z:') || x.startsWith('zp:'))).toBe(true);
  });

  it('an address that names no area: the areas’ groups as buttons, a group’s areas behind "Area chunein", then the price', async () => {
    const { deps, bodies } = fakeDeps();
    const c = chat(shop(), deps);
    expect((await c.send({ tap: 'i:burger' })).state).toBe('cart');
    await c.send({ text: 'delivery' });
    const areas = await c.send({ text: 'Flat B102, Gardens 1, near the park' });
    expect(areas.state).toBe('zones');
    expect(textOf(areas.out[0])).toBe(`📍 Aapka area kaunsa hai?\n\n${TAP}`);
    expect(titles(areas.out[0])).toEqual(['DHA', 'Clifton', '❌ Mera area nahi hai']);
    const dha = await c.send({ tap: ids(areas.out[0])[0]! });
    expect(dha.out[0]).toMatchObject({ type: 'list', button: 'Area chunein' });
    expect(ids(dha.out[0])).toContain('z:dha-6');
    const confirm = await c.send({ tap: 'z:dha-6' });
    expect(confirm.state).toBe('confirm');
    expect(bodies[0]).toMatchObject({ fulfilment: 'delivery', zoneId: 'dha-6', addressLine: 'Flat B102, Gardens 1, near the park' });
  });

  it('a pick-up goes straight to the price: no area, no address, no name or note steps; "1" is OK', async () => {
    const { deps, bodies } = fakeDeps();
    const c = chat(shop(), deps);
    await c.send({ tap: 'i:burger' });
    const confirm = await c.send({ tap: 'f:pickup' });
    expect(confirm.state).toBe('confirm');
    expect(said(confirm)).toContain('🏃 Pick-up: shop se le jayein');
    expect(bodies[0]).toMatchObject({ fulfilment: 'pickup', customerName: 'Haider Ali', items: [{ posItemId: 'burger', quantity: 1, modifierIds: [] }] });
    expect(bodies[0]).not.toHaveProperty('zoneId');
    expect((await c.send({ text: '1' })).state).toBe('idle');
  });

  it('typing names instead of tapping: an item’s name with a count, a choice by name, "delivery"', async () => {
    const c = chat();
    expect((await c.send({ text: '2 large and chilled please' })).state).toBe('choice');
    const cart = await c.send({ text: 'tikka' });
    expect(cart.state).toBe('cart');
    expect(cart.data.cart).toEqual([{ posItemId: 'deal-lc', quantity: 2, modifierIds: ['dr-cola', 'fx-fries', 'pz-tikka'] }]);
    expect((await c.send({ text: 'delivery' })).state).toBe('address');
  });

  it('the same item twice with the same choices adds up; without pick-up the order offers to empty it, which it does', async () => {
    const c = chat(shop({ pickupAvailable: false }));
    await c.send({ tap: 'i:burger' });
    const cart = await c.send({ tap: 'i:burger' });
    expect(cart.data.cart).toEqual([{ posItemId: 'burger', quantity: 2, modifierIds: [] }]);
    expect(textOf(cart.out[0])).toContain('🍔 *2× Classic Crispy Chicken* — Rs 1,400');
    expect(ids(cart.out[0])).toEqual(['f:delivery', 'k:add', 'k:clear']);
    const cleared = await c.send({ tap: 'k:clear' });
    expect(cleared.data.cart).toEqual([]);
    expect(cleared.state).toBe('menu');
  });

  it('when the website refuses (Buy 1 Get 1 needs their Instagram name) it asks for it and prices again', async () => {
    let asked = 0;
    const { deps, bodies } = fakeDeps((b) =>
      b['social'] ? { ok: true, subtotalCents: 200_000, discountCents: 0, taxCents: 0, totalCents: 200_000, lines: [] } : (asked++, { ok: false, error: 'buy1get1_social', message: 'Buy 1 Get 1 needs your Instagram or Facebook name.' }),
    );
    const c = chat(shop(), deps);
    await c.send({ tap: 'i:burger' });
    const social = await c.send({ tap: 'f:pickup' });
    expect(social.state).toBe('social');
    expect(said(social)).toContain('Buy 1 Get 1 needs your Instagram or Facebook name.');
    expect(social.data.choices).toBeUndefined();
    const confirm = await c.send({ text: '@haider' });
    expect(confirm.state).toBe('confirm');
    expect(asked).toBe(1);
    expect(bodies.at(-1)).toMatchObject({ social: '@haider', dryRun: true });
  });

  it('a closed shop answers with its hours; the till’s refusal at Confirm is said in its words and the order stays', async () => {
    const closedText = 'Abhi online orders band hain (open daily · 1 pm – 1 am).';
    expect((await chat(shop({ open: false })).send({ tap: 'o:start' })).out).toEqual([{ type: 'text', body: closedText }]);
    expect((await chat(shop({ open: false })).send({ text: '1' })).out).toEqual([{ type: 'text', body: closedText }]);

    const { deps } = fakeDeps((b) =>
      b['dryRun'] ? { ok: true, subtotalCents: 70_000, discountCents: 0, taxCents: 10_500, totalCents: 80_500, lines: [] } : { ok: false, error: 'store_closed', message: 'We are not taking online orders at the moment.' },
    );
    const c = chat(shop(), deps);
    await c.send({ tap: 'i:burger' });
    await c.send({ tap: 'f:pickup' });
    const refused = await c.send({ tap: 'y:confirm' });
    expect(said(refused)).toBe('We are not taking online orders at the moment.');
    expect(refused.data.cart).toHaveLength(1);
  });

  it('“staff”, “cancel”, “menu”, “website” and “cart” work at any step; words a choice can’t use get its question again once, then the chat is staff’s', async () => {
    const c = chat();
    await c.send({ tap: 'i:deal-lc' });
    const q1 = await c.send({ text: 'Delivery kitni der mein?' });
    expect(said(q1)).toContain('Large pizza kaunsa?');
    expect((await c.send({ text: 'Hello?' })).out).toEqual([]);
    expect((await c.send({ text: 'menu' })).state).toBe('menu');
    expect(said(await c.send({ text: 'website' }))).toBe('Website: https://site.test/menu?wa=Tok3nAbcDefG');
    await c.send({ tap: 'i:burger' });
    expect((await c.send({ text: 'cart' })).state).toBe('cart');
    const staff = await c.send({ text: 'staff' });
    expect(staff.state).toBe('idle');
    expect(said(staff)).toContain('Hamara staff jaldi yahin jawab dega');
    expect((await c.send({ text: 'Cancel' })).data.cart).toEqual([]);
    expect(['menu', 'Order', 'STAFF', 'cancel'].every(isBotCommand)).toBe(true);
    expect(isBotCommand('menu pe kya hai')).toBe(false);
    // Anything else after the menu: help once, then staff's.
    const d = chat();
    expect(said(await d.send({ text: 'What' }))).toBe('🙏 Samajh nahi aaya.\nUpar wale *button* dabayein, ya *menu* likhein.\n👤 Staff se baat: *staff*');
    expect((await d.send({ text: 'Kitni der lagegi' })).out).toEqual([]);
  });

  it('a chat the bot is not in: it answers a price, deals or menu ask, and nothing else', async () => {
    const idle = { state: 'idle' as BotState, data: { cart: [] } };
    const prices = await chat(shop({ menuPicture: PICTURE }), fakeDeps().deps, 'Haider Ali', idle).send({ text: 'Price list bhej dein' });
    expect(prices.state).toBe('menu');
    expect(prices.out[0]).toMatchObject({ type: 'buttons', image: PICTURE.url });
    expect((await chat(shop(), fakeDeps().deps, 'Haider Ali', idle).send({ text: 'Bhai jaldi bhej dena' })).out).toEqual([]);
    // What the route lets through to it then (lib/whatsapp-bot-run): asks, never a hello or a question for staff.
    expect(['Price list', 'price?', 'Menu send karein', 'deals', 'Buy 1 Get 1 kab hai', 'kitne ka hai', 'koi offer?'].every(asksBot)).toBe(true);
    expect(['Hello', 'Salam', 'Kitni der lagegi?', 'Bhai jaldi bhej dena', 'Order kab aayega', ''].some(asksBot)).toBe(false);
  });

  it('an area not on the list: the areas that are, the shop’s pin and address for a pick-up, Pick-up or staff; a WhatsApp name that is not a name is asked for', async () => {
    const c = chat(shop({ place: PLACE }), fakeDeps().deps, '🍕🍕');
    await c.send({ tap: 'i:burger' });
    await c.send({ tap: 'f:delivery' });
    expect((await c.send({ text: 'Gulshan Block 5, House 9' })).state).toBe('zones');
    const none = await c.send({ tap: 'z:none' });
    expect(none.out[0]).toEqual({ type: 'location', lat: PLACE.lat, lng: PLACE.lng, name: PLACE.name, address: PLACE.street });
    expect(ids(none.out[1])).toEqual(['f:pickup', 'o:staff']);
    expect(textOf(none.out[1])).toBe(`😔 Hamari delivery abhi in areas tak hai: *DHA aur Clifton*\n\n🏃 Pick-up kar sakte hain — shop yahan hai 👆\n${PLACE.street}\n\n${TAP}`);
    expect(payloadOf('923088440608', none.out[0]!)).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '923088440608',
      type: 'location',
      location: { latitude: PLACE.lat, longitude: PLACE.lng, name: PLACE.name, address: PLACE.street },
    });
    // Without the shop's place: the areas, and the buttons.
    const bare = chat(shop(), fakeDeps().deps);
    await bare.send({ tap: 'i:burger' });
    expect(textOf((await bare.send({ tap: 'z:none' })).out[0])).toBe(`😔 Hamari delivery abhi in areas tak hai: *DHA aur Clifton*\n\n${TAP}`);
    const name = await c.send({ tap: 'z:dha-6' });
    expect(name.out[0]).toEqual({ type: 'text', body: '👤 Order kis naam par? Apna *naam* bhejein' });
    expect(name.data.choices).toBeUndefined();
    expect((await c.send({ text: 'Bilal' })).state).toBe('confirm');
  });

  it('“where are you?” at any step (the 29 Oct 2026 chat …063): the shop’s pin, its address, the areas and their charge — never a note, never an address being typed', async () => {
    const { deps, bodies } = fakeDeps();
    const s = shop(LIVE_OFFERS);
    const c = chat(s, deps);
    const where = `📍 *Cheese O’Clock*: ${PLACE.street}\n🛵 Delivery sirf DHA aur Clifton mein — charges ${feeRangeOfFees(s.zones.filter((z) => z.active).map((z) => z.feeCents))}\n🏃 Pick-up: shop se khud le ja sakte hain`;
    const asked = await c.send({ text: 'Adress to bta den pickup kr bhe skte he k nhi' });
    expect(asked.out[0]).toMatchObject({ type: 'location', lat: PLACE.lat, lng: PLACE.lng });
    expect(textOf(asked.out[1])).toBe(where);
    expect(asked.state).toBe('menu');
    // What else they asked with it is answered too: the pizzas.
    const both = await c.send({ text: 'Large pizza and adress' });
    expect(both.out.map((m) => m.type)).toEqual(['location', 'text', 'buttons']);
    expect(ids(both.out[2])).toEqual(['p:fz-m', 'p:tk-m', 'o:sig']);
    // At the end, it is a question, not the order's note; an address typed at the address step is the address.
    await c.send({ tap: 'p:tk-m' });
    await c.send({ tap: 'i:tk-l' });
    const confirm = await c.send({ tap: 'f:pickup' });
    expect(said(confirm)).toContain(`🏃 Pick-up: shop se le jayein — ${PLACE.street}`);
    const begged = await c.send({ text: 'Allah k wasten aria bta den k hm Le bhe skte he k nhi' });
    expect(begged.state).toBe('confirm');
    expect(begged.data.notes).toBeUndefined();
    expect(textOf(begged.out[1])).toBe(where);
    expect(bodies.every((b) => !b['notes'])).toBe(true);
    // The order placed: where to come, as a pin.
    const placed = await c.send({ tap: 'y:confirm' });
    expect(placed.out.map((m) => m.type)).toEqual(['text', 'location']);

    const d = chat(s, deps);
    await d.send({ tap: 'i:burger' });
    expect((await d.send({ tap: 'f:delivery' })).state).toBe('address');
    expect((await d.send({ text: 'House 12, near the main location, Street 4, DHA Phase 6' })).state).toBe('confirm');
    // The words people used; and what is not a where-ask (a delivery's time, a hello, "mera area").
    for (const ask of ['Delivery charges include h', 'Button nhi smgh aa rha price aria location. Btaen plz chiken Tikka barbeque flaovour', 'Address?', 'shop kahan hai', 'Aap adress bta den plz', 'location send karein']) {
      expect(asksBot(ask)).toBe(true);
    }
    for (const not of ['Delivery kitni der mein?', 'Hello', 'mera area', 'Ghanti mat bajayein', 'House 5, Street 2, Phase 6']) expect(asksBot(not)).toBe(false);
  });

  it('the areas it names are the ones set (DHA, Clifton and Emaar), their charges only; the areas’ list still has every open area', async () => {
    const base = factsFromBlock(null).zones;
    const far = { ...base[0]!, id: 'abys', name: 'Abysinya lines', aliases: [], group: 'Abysinya', feeCents: 40_000 };
    const s = shop({ ...LIVE_OFFERS, zones: [...base, far], namedAreas: { words: 'DHA, Clifton aur Emaar', groups: ['DHA', 'Clifton'] } });
    const charge = feeRangeOfFees(base.filter((z) => z.active).map((z) => z.feeCents));
    const w = welcomeStep({ shopName: 'Cheese O’Clock', profileName: null, shop: s });
    expect(textOf(w.out[0])).toContain(`🛵 Delivery: DHA, Clifton aur Emaar (${charge}) · 🏃 Pick-up bhi`);
    const c = chat(s);
    expect(textOf((await c.send({ text: 'address?' })).out[1])).toContain(`🛵 Delivery sirf DHA, Clifton aur Emaar mein — charges ${charge}`);
    await c.send({ tap: 'i:burger' });
    await c.send({ tap: 'f:delivery' });
    expect(titles((await c.send({ text: 'Flat 2, Gardens' })).out[0])).toEqual(['DHA', 'Clifton', 'Abysinya', '❌ Mera area nahi hai']);
    // Named areas the till has none of: every open area's group instead.
    expect(textOf(welcomeStep({ shopName: 'Shop', profileName: null, shop: shop({ ...s, namedAreas: { words: 'Gulshan', groups: ['Gulshan'] } }) }).out[0])).toContain('🛵 Delivery: DHA, Clifton aur Abysinya (');
  });

  it('a shared location: too far is said plainly with a pick-up; near, it is the address and the area is asked; before ordering it is kept for the delivery', async () => {
    const { deps, bodies } = fakeDeps();
    const s = shop(LIVE_OFFERS);
    const turn = (c: ReturnType<typeof chat>, lat: number, lng: number, name: string | null = null, address: string | null = null) =>
      runBot({ waId: '923088440608', profileName: 'Haider Ali', text: null, reply: null, location: { lat, lng, name, address } }, c.saved(), s, deps);

    // Lyari (29 Oct 2026, chat …206): 9.5 km — not delivered, said so, with the shop for a pick-up.
    const far = chat(s, deps);
    await far.send({ tap: 'i:burger' });
    await far.send({ tap: 'f:delivery' });
    const lyari = await far.step(turn(far, 24.8654712, 66.9986116));
    expect(lyari.out[0]).toMatchObject({ type: 'location', lat: PLACE.lat });
    expect(textOf(lyari.out[1])).toBe(
      `😔 Aapki location shop se ~9 km door hai — wahan delivery nahi hoti.\n🛵 Hamari delivery in areas tak hai: *DHA aur Clifton*\n\n🏃 Pick-up kar sakte hain — shop yahan hai 👆\n${PLACE.street}\n\n${TAP}`,
    );
    expect(ids(lyari.out[1])).toEqual(['f:pickup', 'o:staff']);
    expect(lyari.data.pin).toBeUndefined();

    // Near (Phase 5): the pin is the address, the area is asked, and the order carries the pin as a map link.
    const near = chat(s, deps);
    await near.send({ tap: 'i:burger' });
    await near.send({ tap: 'f:delivery' });
    const areas = await near.step(turn(near, 24.8155, 67.0570));
    expect(areas.state).toBe('zones');
    expect(textOf(areas.out[0]).startsWith('📍 Location mil gayi ✅ — aapka area kaunsa hai?')).toBe(true);
    const confirm = await near.send({ tap: 'z:dha-5' });
    expect(confirm.state).toBe('confirm');
    expect(bodies.at(-1)).toMatchObject({ fulfilment: 'delivery', zoneId: 'dha-5', addressLine: 'Location pin (map)', locationPin: { lat: 24.8155, lng: 67.057 } });
    expect(said(confirm)).toContain('📍 Location pin (map) (DHA Phase 5)');

    // A place picked on the map names its area: straight to the price, its name the address.
    const named = chat(s, deps);
    await named.send({ tap: 'i:burger' });
    const priced = await named.step(turn(named, 24.8001, 67.0640, 'Sunset Lane', 'Khayaban-e-Shamsheer, DHA Phase 6, Karachi'));
    expect(priced.state).toBe('confirm');
    expect(bodies.at(-1)).toMatchObject({ zoneId: 'dha-6', addressLine: 'Sunset Lane, Khayaban-e-Shamsheer, DHA Phase 6, Karachi' });

    // Before any order: kept; Delivery later asks only the area.
    const early = chat(s, deps);
    const kept = await early.step(turn(early, 24.8155, 67.0570));
    expect(said(kept)).toBe('✅ Location mil gayi! Pehle apni deal chunein — phir *Delivery* dabayein 👆');
    expect(kept.state).toBe('menu');
    await early.send({ tap: 'i:burger' });
    expect((await early.send({ tap: 'f:delivery' })).state).toBe('zones');
  });

  it('“Badlein” goes back to the order, and Delivery then asks the address afresh', async () => {
    const c = chat();
    await c.send({ tap: 'i:burger' });
    await c.send({ tap: 'f:delivery' });
    await c.send({ text: 'House 1, Clifton Block 5' });
    const back = await c.send({ tap: 'y:edit' });
    expect(back.state).toBe('cart');
    expect(back.data.address).toBeUndefined();
    expect((await c.send({ tap: 'f:delivery' })).state).toBe('address');
  });

  it('a cart from the WhatsApp catalog: each deal’s choices asked, an item with none added straight away, then the order', async () => {
    let saved: { state: BotState; data: BotData } | null = null;
    const turn = async (s: { tap?: string; order?: Array<{ posItemId: string; quantity: number }> }) => {
      const step = await runBot({ waId: '923088440608', profileName: 'Haider', text: null, reply: s.tap ? { id: s.tap, title: '' } : null, order: s.order ?? null }, saved, shop(), fakeDeps().deps);
      saved = { state: step.state, data: step.data };
      return step;
    };
    const first = await turn({ order: [{ posItemId: 'burger', quantity: 1 }, { posItemId: 'deal-lc', quantity: 2 }, { posItemId: 'gone', quantity: 1 }] });
    expect(first.state).toBe('choice');
    expect(first.data.cart).toEqual([{ posItemId: 'burger', quantity: 1, modifierIds: [] }]);
    expect(ids(first.out[0])).toEqual(['m:pz-fajita', 'm:pz-tikka', 'm:pz-malai']);
    const done = await turn({ tap: 'm:pz-fajita' });
    expect(done.state).toBe('cart');
    expect(done.data.cart).toEqual([
      { posItemId: 'burger', quantity: 1, modifierIds: [] },
      { posItemId: 'deal-lc', quantity: 2, modifierIds: ['dr-cola', 'fx-fries', 'pz-fajita'] },
    ]);
    expect(textOf(done.out[0])).toBe('Cart ka ek item ab menu par nahi, use chhor diya.');
    expect(ids(done.out[1])).toEqual(['f:delivery', 'f:pickup', 'k:add']);
    expect(done.data.queue).toBeUndefined();

    const closed = await runBot({ waId: '923088440608', profileName: null, text: null, reply: null, order: [{ posItemId: 'burger', quantity: 1 }] }, null, shop({ open: false }), fakeDeps().deps);
    expect(closed.out).toEqual([{ type: 'text', body: 'Abhi online orders band hain (open daily · 1 pm – 1 am).' }]);
  });

  it('an order the old bot started (its "how many", Checkout, name and note buttons, a typed count, a drink step) still finishes', async () => {
    const { deps, bodies } = fakeDeps();
    const c = chat(shop(), deps, 'Haider Ali', { state: 'qty', data: { cart: [], pending: { posItemId: 'deal-lc', modifierIds: ['fx-fries', 'pz-tikka', 'dr-cola'], step: 2 } } });
    expect((await c.send({ tap: 'q:2' })).data.cart).toEqual([{ posItemId: 'deal-lc', quantity: 2, modifierIds: ['fx-fries', 'pz-tikka', 'dr-cola'] }]);
    expect(ids((await c.send({ tap: 'k:checkout' })).out[0])).toEqual(['f:delivery', 'f:pickup']);
    expect((await c.send({ tap: 'f:pickup' })).state).toBe('confirm');

    // A cart saved before numbered options: a bare number is still its count.
    const old = chat(shop(), deps, 'Haider Ali', { state: 'cart', data: { cart: [{ posItemId: 'burger', quantity: 1, modifierIds: [] }] } });
    expect((await old.send({ text: '3' })).data.cart).toEqual([{ posItemId: 'burger', quantity: 3, modifierIds: [] }]);
    // An item started when its drink was still asked: the drink becomes the usual one.
    const started = chat(shop(), deps, 'Haider Ali', { state: 'choice', data: { cart: [], pending: { posItemId: 'deal-lc', modifierIds: ['fx-fries'], step: 0 } } });
    expect((await started.send({ tap: 'm:pz-malai' })).data.cart).toEqual([{ posItemId: 'deal-lc', quantity: 1, modifierIds: ['fx-fries', 'pz-malai', 'dr-cola'] }]);

    const named = chat(shop(), deps, 'Haider Ali', { state: 'name', data: { cart: [{ posItemId: 'burger', quantity: 1, modifierIds: [] }], fulfilment: 'pickup' } });
    expect((await named.send({ tap: 'n:ok' })).state).toBe('confirm');
    const noted = chat(shop(), deps, 'Haider Ali', { state: 'notes', data: { cart: [{ posItemId: 'burger', quantity: 1, modifierIds: [] }], fulfilment: 'pickup', name: 'Haider Ali' } });
    expect((await noted.send({ tap: 'x:none' })).state).toBe('confirm');
    expect(bodies.every((b) => b['customerName'] === 'Haider Ali')).toBe(true);
  });

  it('tells the route once an order went through (for Meta), never when the till refuses it', async () => {
    const seen: Array<{ orderId: string; totalCents: number }> = [];
    const { deps } = fakeDeps();
    const c = chat(shop(), { ...deps, placed: (o) => seen.push(o) });
    await c.send({ tap: 'i:burger' });
    await c.send({ tap: 'f:pickup' });
    await c.send({ tap: 'y:confirm' });
    expect(seen).toEqual([{ orderId: '0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000', totalCents: 380_000 }]);

    const refusedSeen: unknown[] = [];
    const closing = fakeDeps((b) => (b['dryRun'] ? { ok: true, subtotalCents: 70_000, discountCents: 0, taxCents: 0, totalCents: 70_000, lines: [] } : { ok: false, error: 'store_closed' }));
    const d = chat(shop(), { ...closing.deps, placed: (o) => refusedSeen.push(o) });
    await d.send({ tap: 'i:burger' });
    await d.send({ tap: 'f:pickup' });
    await d.send({ tap: 'y:confirm' });
    expect(refusedSeen).toEqual([]);
  });

  it('a second Confirm after the order went through places nothing and shows the menu', async () => {
    const { deps, bodies } = fakeDeps();
    const c = chat(shop(), deps);
    await c.send({ tap: 'i:burger' });
    await c.send({ tap: 'f:pickup' });
    await c.send({ tap: 'y:confirm' });
    const again = await c.send({ tap: 'y:confirm' });
    expect(again.state).toBe('menu');
    expect(bodies.filter((b) => !b['dryRun'])).toHaveLength(1);
  });

  it('the deals list greets by name, and keeps to WhatsApp’s ten rows however many deals there are', () => {
    const w = welcomeStep({ shopName: 'Cheese O’Clock', profileName: 'Haider Ali', shop: shop() });
    expect(textOf(w.out[0]).startsWith(`Assalam o Alaikum Haider! Cheese O’Clock mein khush aamdeed 🧀\n\n${DELIVERY_LINE}\n\n🔥 *Hamari deals*`)).toBe(true);
    expect(textOf(welcomeStep({ shopName: 'Cheese O’Clock', profileName: null, shop: shop() }).out[0]).startsWith('Assalam o Alaikum! Cheese O’Clock')).toBe(true);
    const many = Array.from({ length: 12 }, (_, i) => item(`x${i}`, `Deal number ${i + 1}`, 1000 + i, [], { taxIncluded: true, noDiscount: true }));
    const big = welcomeStep({ shopName: 'Shop', profileName: null, shop: shop({ menu: { ...MENU, categories: [{ posCategoryId: 'c-x', name: 'Value Deals', displayOrder: 1, items: many }, { posCategoryId: 'c-b', name: 'Buy 1 Get 1 Deals', displayOrder: 2, items: [B1G1] }] }, buy1Get1Open: true }) });
    expect(ids(big.out[0])).toHaveLength(10);
    expect(textOf(big.out[0])).toContain('🎁 Buy 1 Get 1 abhi chal raha hai — *buy 1 get 1* likhein');
  });

  it('reads the area from an address in the till’s own spellings — never from "Block 5" alone, nor when two areas are named', () => {
    const zones = factsFromBlock(null).zones;
    expect(zoneInText(zones, 'House 12, Street 4, DHA Phase 6')?.id).toBe('dha-6');
    expect(zoneInText(zones, 'flat 3, ph6, bukhari')?.id).toBe('dha-6');
    expect(zoneInText(zones, 'Phase 2 Ext, street 5')?.id).toBe('dha-2-ext');
    expect(zoneInText(zones, 'House 7, Clifton Block 5')?.id).toBe('clifton-5');
    expect(zoneInText(zones, 'Emaar Pearl Towers, flat 1201')?.id).toBe('emaar');
    expect(zoneInText(zones, 'Block 5, Gulshan')).toBeNull();
    expect(zoneInText(zones, 'near Clifton Block 5 and DHA Phase 1')).toBeNull();
    expect(zoneInText(zones.map((z) => (z.id === 'dha-6' ? { ...z, active: false } : z)), 'DHA Phase 6')).toBeNull();
  });

  it('every message fits WhatsApp’s limits', () => {
    const p = payloadOf('923088440608', {
      type: 'list',
      body: 'x'.repeat(2000),
      button: 'A very long button label',
      sections: [{ title: 'Section with a very long title', rows: Array.from({ length: 14 }, (_, i) => ({ id: `r${i}`, title: `Row title that is far too long ${i}`, description: 'd'.repeat(100) })) }],
    }) as { interactive: { body: { text: string }; action: { button: string; sections: Array<{ title: string; rows: Array<{ title: string; description: string }> }> } } };
    expect(p.interactive.body.text).toHaveLength(1024);
    expect(p.interactive.action.button.length).toBeLessThanOrEqual(20);
    expect(p.interactive.action.sections[0]!.title.length).toBeLessThanOrEqual(24);
    expect(p.interactive.action.sections[0]!.rows).toHaveLength(10);
    expect(p.interactive.action.sections[0]!.rows.every((r) => r.title.length <= 24 && r.description.length <= 72)).toBe(true);
    expect((payloadOf('923088440608', { type: 'text', body: 'y'.repeat(5000) }) as { text: { body: string } }).text.body.length).toBeLessThanOrEqual(4096);
    expect((payloadOf('923088440608', { type: 'image', link: 'https://x.test/a.jpg', caption: 'z'.repeat(2000) }) as { image: { caption: string } }).image.caption).toHaveLength(1024);
  });
});
