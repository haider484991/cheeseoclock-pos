/**
 * The WhatsApp ordering bot (lib/whatsapp-bot, 26 Oct 2026; fewer steps 27 Oct; simple 28 Oct 2026): the printed deal
 * menu as a picture first, its numbers the choices; then one short question at a time, each option on its own line
 * under a big number key; only what must be chosen is asked (the usual drink and dip are set, changed by typing their
 * name); a pizza's flavour, then its size; the website's % off on the prices; price, deal and menu words answered;
 * Delivery or Pick-up, the area read from the address, the WhatsApp name as the order's name — priced by the website's
 * own order route before the customer confirms, and placed once however often they confirm.
 */
import { describe, expect, it } from 'vitest';
import type { PublishedMenu, PublishedMenuItem, PublishedModifierGroup } from '@cheeseoclock/shared-types';
import { factsFromBlock } from './delivery-facts';
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
const FAJITA_M = item('fz-m', 'Fajita Pizza — Medium', 1500);
const FAJITA_L = item('fz-l', 'Fajita Pizza — Large', 2000);
const B1G1 = item('b1-lm', 'Large + Free Medium', 2000, [], { taxIncluded: true, noDiscount: true, description: 'Any Large 12" regular pizza + any Medium 9" regular pizza FREE.' });
const SODA = item('dr-345', 'Soft Drink — 345 ml', 120, [group('g-fl', 'Choose a flavour · 345 ml', [mod('fl-cola', 'Cola'), mod('fl-lime', 'Lemon-lime')], { min: 1, req: true })]);
const LIVE: PublishedMenu = {
  ...MENU,
  categories: [
    { posCategoryId: 'c-deals', name: 'Value Deals', displayOrder: 1, items: [DEAL] },
    { posCategoryId: 'c-burgers', name: 'Burgers', displayOrder: 2, items: [BURGER] },
    { posCategoryId: 'c-b1g1', name: 'Buy 1 Get 1 Deals', displayOrder: 2, items: [B1G1] },
    { posCategoryId: 'c-sig', name: 'Signature Pizzas', displayOrder: 3, items: [item('sig-star', 'Cheesy Star — Large', 2200)] },
    { posCategoryId: 'c-pizza', name: 'Pizza', displayOrder: 5, items: [FAJITA_M, FAJITA_L, item('tk-m', 'Chicken Tikka Pizza — Medium', 1500), item('tk-l', 'Chicken Tikka Pizza — Large', 2000)] },
    { posCategoryId: 'c-drinks', name: 'Drinks', displayOrder: 7, items: [SODA] },
  ],
};
const PICTURE = { url: 'https://site.test/images/whatsapp/deal-menu.jpg', deals: ['Large & Chilled'] };
/** As the website charges today: 10% off the food on a pick-up and on a delivery, the regular pizzas 20%. */
const LIVE_OFFERS: Partial<BotShop> = {
  menu: LIVE,
  deliveryPercent: 10,
  pickupCategoryPercents: [{ categoryId: 'c-pizza', percent: 20 }],
  deliveryCategoryPercents: [{ categoryId: 'c-pizza', percent: 20 }],
  buy1Get1Hours: '12–7 PM',
  buy1Get1Open: true,
  menuPicture: PICTURE,
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

/**
 * A conversation: each customer message runs the bot on the step the last one saved. It starts where the day's
 * welcome leaves a chat (lib/whatsapp-bot-run writes that step with the welcome): its options numbered.
 */
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
  };
}

/** A message's words (a picture's caption), the options a step numbered, everything it said, the number for an option. */
const textOf = (m: WaOut | undefined): string => (!m ? '' : m.type === 'image' ? m.caption : m.body);
const opts = (s: BotStep): string[] => s.data.choices ?? [];
const said = (s: BotStep): string => s.out.map(textOf).join('\n\n');
const no = (s: BotStep, option: string): string => String(opts(s).indexOf(option) + 1);

describe('the WhatsApp ordering bot', () => {
  it('a whole delivery order in five numbers and an address: the deal, its pizza (the drink is the usual), Delivery, the address, OK', async () => {
    const { deps, bodies } = fakeDeps();
    const c = chat(shop(), deps);

    const menu = await c.send({ text: 'menu' });
    expect(menu.state).toBe('menu');
    // No picture for this menu: the deals as text, numbered, with what is in them; pizza and burger one word away.
    expect(opts(menu)).toEqual(['i:deal-lc']);
    expect(menu.out.every((m) => m.type === 'text')).toBe(true);
    expect(said(menu)).toContain('🔥 *DEALS* (tax shamil)\n1️⃣ *Large & Chilled* — Rs 1,800\n      _Large 12" regular pizza + 1 litre drink_');
    expect(said(menu)).toContain('🍕 Pizza alag se? *pizza* likhein');

    const pizza = await c.send({ text: '1' });
    expect(pizza.state).toBe('choice');
    // Only what must be chosen: the pizza (the drink is the usual cola, said on the order).
    expect(said(pizza)).toBe('🍕 *Large & Chilled* — Rs 1,800 ✅\n\nLarge pizza kaunsa? 👇\n1️⃣ Fajita\n2️⃣ Chicken Tikka\n3️⃣ Malai Supreme\n\n👉 *Number* bhejein');
    expect(opts(pizza)).toEqual(['m:pz-fajita', 'm:pz-tikka', 'm:pz-malai']);

    const cart = await c.send({ text: '2' });
    expect(cart.state).toBe('cart');
    expect(opts(cart)).toEqual(['f:delivery', 'f:pickup', 'k:add']);
    expect(said(cart)).toBe(
      [
        '✅ *Order mein add ho gaya!*',
        '',
        '🍕 *Large & Chilled* — Rs 1,800',
        '      Chicken Tikka · Cola 1 litre',
        '',
        '_Drink ya dip badalni ho to naam likh dein (jaise *7up*)_',
        '',
        'Ab batayein 👇',
        '1️⃣ 🛵 Delivery',
        '2️⃣ 🏃 Pick-up 10% off (khud lene aayenge)',
        '3️⃣ ➕ Aur kuch add karein',
      ].join('\n'),
    );
    expect(cart.data.cart).toEqual([{ posItemId: 'deal-lc', quantity: 1, modifierIds: ['dr-cola', 'fx-fries', 'pz-tikka'] }]);

    const address = await c.send({ text: '1' });
    expect(address.state).toBe('address');
    expect(said(address)).toContain('📍 Apna *address* bhejein');
    expect(address.data.choices).toBeUndefined(); // the address's numbers are not options

    // The area is read from the address, and the WhatsApp name is the order's: straight to the till's price.
    const confirm = await c.send({ text: 'House 12, Street 4, DHA Phase 6' });
    expect(confirm.state).toBe('confirm');
    expect(opts(confirm)).toEqual(['y:confirm', 'y:edit', 'y:cancel']);
    const summary = said(confirm);
    expect(summary).toContain('🧾 *Aapka order*\n\n🍕 2× Large & Chilled — Rs 3,600\n      Chicken Tikka · Cola 1 litre\n🛵 Delivery — Rs 200');
    expect(summary).toContain('💰 *Total: Rs 3,800* · cash on delivery\n📍 House 12, Street 4, DHA Phase 6\n👤 Haider Ali · 0308 8440608');
    expect(summary).toContain('1️⃣ ✅ *OK — order kar dein*\n2️⃣ ✏️ Badlein\n3️⃣ ❌ Cancel');

    // Words at the end are the order's note; "ok" confirms.
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

  it('the welcome is the printed deal menu: a picture whose numbers are the choices, a short caption; text when a pictured deal is missing', () => {
    const w = welcomeStep({ shopName: 'Cheese O’Clock', profileName: 'Haider Ali', shop: shop(LIVE_OFFERS) });
    expect(w.state).toBe('menu');
    expect(w.out).toHaveLength(1);
    expect(w.out[0]).toMatchObject({ type: 'image', link: 'https://site.test/images/whatsapp/deal-menu.jpg' });
    expect(textOf(w.out[0])).toBe(
      [
        'Assalam o Alaikum Haider! Cheese O’Clock mein khush aamdeed 🧀',
        '👆 Jo deal chahiye uska *number* bhejein (jaise *5*)',
        '',
        '🎁 *Buy 1 Get 1* (12–7 PM)',
        '*2.* Large + Free Medium — Rs 2,000',
        '',
        '🍕 Pizza alag se? *pizza* likhein (🔥 20% OFF)',
        '🍔 Burger? *burger* likhein',
        '👤 Staff se baat: *staff*',
      ].join('\n'),
    );
    // 1 = the pictured deal, then Buy 1 Get 1 while it sells.
    expect(w.data.choices).toEqual(['i:deal-lc', 'i:b1-lm']);
    // Outside its hours: its hours only, not its deals.
    const later = welcomeStep({ shopName: 'Shop', profileName: null, shop: shop({ ...LIVE_OFFERS, buy1Get1Open: false }) });
    expect(textOf(later.out[0])).toContain('🎁 Buy 1 Get 1: roz 12–7 PM');
    expect(later.data.choices).toEqual(['i:deal-lc']);
    // A deal the picture prints is not on the menu (renamed, sold out): its numbers would lie, so the deals go as text.
    const gone = welcomeStep({ shopName: 'Shop', profileName: null, shop: shop({ ...LIVE_OFFERS, menuPicture: { ...PICTURE, deals: ['Large & Chilled', 'Mega Cheese Box'] } }) });
    expect(gone.out[0]!.type).toBe('text');
    expect(textOf(gone.out[0])).toContain('1️⃣ *Large & Chilled* — Rs 1,800');
    // The picture as WhatsApp gets it.
    expect(payloadOf('923088440608', w.out[0]!)).toMatchObject({ type: 'image', image: { link: 'https://site.test/images/whatsapp/deal-menu.jpg' } });
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
    await c.send({ text: '2' }); // pick-up
    const back = await c.send({ text: 'coke' });
    expect(back.state).toBe('confirm');
    expect(back.data.notes).toBeUndefined(); // a drink named at the end is the drink, not a note
    expect(bodies.at(-1)).toMatchObject({ items: [{ posItemId: 'deal-lc', modifierIds: ['fx-fries', 'pz-fajita', 'dr-cola'] }] });
    // A drink ordered on its own: its flavour is asked (it is the drink they want).
    const soda = await chat(shop({ menu: LIVE })).send({ text: 'soft drink' });
    expect(soda.state).toBe('choice');
    expect(said(soda)).toContain('Choose a flavour kaunsa? 👇\n1️⃣ Cola\n2️⃣ Lemon-lime');
  });

  it('a pizza: "pizza" shows the regular flavours (sizes and the % off once on top), a flavour asks its size, the order shows the price after the % off', async () => {
    const c = chat(shop(LIVE_OFFERS));
    const list = await c.send({ text: 'pizza' });
    expect(said(list)).toBe(
      [
        '🍕 *Regular pizza* — 🔥 *20% OFF* (+ tax)',
        'Medium ~Rs 1,500~ *Rs 1,200* · Large ~Rs 2,000~ *Rs 1,600*',
        '',
        '1️⃣ Fajita Pizza',
        '2️⃣ Chicken Tikka Pizza',
        '',
        '⭐ Signature Pizzas bhi hain: *signature* likhein',
        '👉 *Number* bhejein (jaise *1*)',
      ].join('\n'),
    );
    expect(opts(list)).toEqual(['p:fz-m', 'p:tk-m']);
    const size = await c.send({ text: '1' });
    expect(said(size)).toBe('🍕 *Fajita Pizza* — size?\n\n1️⃣ Medium — ~Rs 1,500~ *Rs 1,200*\n2️⃣ Large — ~Rs 2,000~ *Rs 1,600*\n_(+ tax)_\n\n👉 *Number* bhejein');
    const cart = await c.send({ text: '2' });
    expect(cart.data.cart).toEqual([{ posItemId: 'fz-l', quantity: 1, modifierIds: [] }]);
    expect(said(cart)).toContain('🍕 *Fajita Pizza (Large)* — ~Rs 2,000~ *Rs 1,600*');
    // "signature": those; a flavour's name asks its size straight away; "fajita large" goes in.
    expect(opts(await c.send({ text: 'signature' }))).toEqual(['i:sig-star']);
    expect(opts(await c.send({ text: 'fajita' }))).toEqual(['i:fz-m', 'i:fz-l']);
    expect((await chat(shop(LIVE_OFFERS)).send({ text: 'fajita large' })).data.cart).toEqual([{ posItemId: 'fz-l', quantity: 1, modifierIds: [] }]);
  });

  it('price words, "deals", Buy 1 Get 1, a category or a size answer with those prices (the 28 Oct 2026 chats)', async () => {
    const c = chat(shop(LIVE_OFFERS));
    for (const ask of ['Price list', 'Price plz', 'menu ke rates?', 'how much', 'Kitne ka hai', 'Your current deals please', 'koi discount hai']) {
      const r = await c.send({ text: ask });
      expect(r.out[0]!.type).toBe('image');
      expect(opts(r)).toEqual(['i:deal-lc', 'i:b1-lm']);
    }
    const b1 = await c.send({ text: 'Buy 1 Get 1 Deals' });
    expect(said(b1)).toContain('🍕 *Buy 1 Get 1 Deals* (tax shamil) · roz 12–7 PM\n\n1️⃣ Large + Free Medium — Rs 2,000');
    expect(opts(await c.send({ text: 'bogo?' }))).toEqual(['i:b1-lm']);
    expect(said(await c.send({ text: 'burger' }))).toContain('🍔 *Burgers* — 🔥 *10% OFF* (+ tax)\n\n1️⃣ Classic Crispy Chicken — ~Rs 700~ *Rs 630*');
    expect(opts(await c.send({ text: 'Small medium aur large' }))).toEqual(['p:fz-m', 'p:tk-m']);
    expect(opts(await c.send({ text: 'coke' }))).toEqual(['i:dr-345']);
    // A price asked with an item's name: its price, not into the order; several named: each with its price.
    const asked = await c.send({ text: 'fajita large kitne ka hai' });
    expect(asked.data.cart).toEqual([]);
    expect(said(asked)).toContain('1️⃣ 🍕 Fajita Pizza (Large) — ~Rs 2,000~ *Rs 1,600* + tax');
    expect(opts(await c.send({ text: 'Tikka fajita aur malli' }))).toEqual(['i:fz-m', 'i:fz-l', 'i:tk-m', 'i:tk-l']);
    // A pickup-only % is not promised to everyone (a delivery would be charged in full).
    const pickupOnly = said(await chat(shop({ ...LIVE_OFFERS, deliveryPercent: 0, deliveryCategoryPercents: [] })).send({ text: 'pizza' }));
    expect(pickupOnly).not.toContain('~');
    expect(pickupOnly).not.toContain('% OFF');
  });

  it('numbers: one out of range is said so; several pick several items (each one’s choices in turn) or several toppings', async () => {
    const c = chat(shop({ menu: { ...MENU, categories: [{ posCategoryId: 'c-deals', name: 'Value Deals', displayOrder: 1, items: [DEAL, BURGER] }] } }));
    const out = await c.send({ text: '99' });
    expect(said(out)).toBe('🙏 Ye number list mein nahi — *1* se *2* tak bhejein.');
    expect(out.state).toBe('menu');
    // "1, 2": the deal's pizza, then the burger (nothing to ask), then the order with both.
    expect((await c.send({ text: '1, 2' })).state).toBe('choice');
    const cart = await c.send({ text: 'no 1' });
    expect(cart.state).toBe('cart');
    expect(cart.data.cart.map((l) => l.posItemId)).toEqual(['deal-lc', 'burger']);

    const veggie = item('veg', 'Veggie Lovers — Medium', 1500, [group('g-veg', 'Veggie Lovers · Choose 3 veggies', ['onion', 'pepper', 'olives', 'mushroom'].map((v) => mod(v, v)), { min: 3, max: 3, req: true })]);
    const v = chat(shop({ menu: { ...MENU, categories: [{ posCategoryId: 'c-pizza', name: 'Pizza', displayOrder: 1, items: [veggie] }] } }));
    const asks = await v.send({ text: 'veggie lovers' });
    expect(said(asks)).toContain('Veggie Lovers: koi *3* chunein (jaise *1 2 3*) 👇\n1️⃣ onion\n2️⃣ pepper');
    const done = await v.send({ text: '1 3 4' });
    expect(done.state).toBe('cart');
    expect(done.data.cart).toEqual([{ posItemId: 'veg', quantity: 1, modifierIds: ['onion', 'olives', 'mushroom'] }]);
  });

  it('a deal ad’s words go straight to that deal (its full name beats the burger sharing its words); "Price" there shows it again with the price; the day’s hello sits over the menu', async () => {
    const ccDeal = item('cc-deal', 'Classic Crispy Deal', 850, [group('g-cc-burger', 'Deal: burger', [mod('cc-classic', 'Classic'), mod('cc-zinger', 'Zinger')], { min: 1, req: true }), group('g-cc-drink', 'Choose a Drink· 345 ml', [mod('cc-cola', 'Cola'), mod('cc-lime', 'Lemon-lime')], { min: 1, req: true })], { taxIncluded: true, noDiscount: true });
    const menu: PublishedMenu = { ...MENU, categories: [{ ...MENU.categories[1]!, items: [ccDeal, DEAL] }, MENU.categories[0]!, ...MENU.categories.slice(2)] };
    const c = chat(shop({ menu }));
    const first = await c.send({ text: 'Classic Crispy Deal order karni hai' });
    expect(first.state).toBe('choice');
    expect(opts(first)).toEqual(['m:cc-classic', 'm:cc-zinger']);
    expect(said(first)).toContain('🍔 *Classic Crispy Deal* — Rs 850 ✅');
    const price = await c.send({ text: 'Price' });
    expect(price.state).toBe('choice');
    expect(said(price)).toContain('🍔 *Classic Crispy Deal* — Rs 850 ✅');
    expect(price.data.nudged).toBe(false); // asking the price is not "not understood"
    // "Menu deal send" at a choice: the deals.
    expect(opts(await c.send({ text: 'Menu deal send' }))).toEqual(['i:cc-deal', 'i:deal-lc']);
    expect((await chat(shop({ menu })).send({ text: 'I want to order the Classic Crispy Deal' })).state).toBe('choice');

    const hello = 'Assalam o Alaikum Ali! Cheese O’Clock mein khush aamdeed 🧀';
    const step = await runBot({ waId: '923088440608', profileName: 'Ali', text: 'Hello! Can I get more info on this?', reply: null, hello }, { state: 'menu', data: { cart: [] } }, shop({ menuPicture: PICTURE }), fakeDeps().deps);
    expect(textOf(step.out[0]).startsWith(hello)).toBe(true);
    expect(step.out[0]!.type).toBe('image');
    expect(opts(step)).toEqual(['i:deal-lc']);
  });

  it('taps on an older list still work: a category and its pages, more choices, a group of areas', async () => {
    const c = chat();
    const cat = await c.send({ tap: 'c:2' });
    expect(cat.state).toBe('items');
    expect(opts(cat)).toEqual(PIZZAS.map((p) => `i:${p.posItemId}`));
    expect(opts(await c.send({ tap: 'cp:2:1' }))).toHaveLength(12);
    await c.send({ tap: 'i:deal-lc' });
    expect(opts(await c.send({ tap: 'mp:1' }))).toEqual(['m:pz-fajita', 'm:pz-tikka', 'm:pz-malai']);
    const groupOf = await c.send({ tap: 'zg:0' });
    expect(groupOf.state).toBe('zones');
    expect(opts(groupOf).every((x) => x.startsWith('z:'))).toBe(true);
  });

  it('an address that names no area: the areas numbered under their groups, then the price (the address kept)', async () => {
    const { deps, bodies } = fakeDeps();
    const c = chat(shop(), deps);
    expect((await c.send({ tap: 'i:burger' })).state).toBe('cart');
    await c.send({ text: 'delivery' });
    const areas = await c.send({ text: 'Flat B102, Gardens 1, near the park' });
    expect(areas.state).toBe('zones');
    expect(said(areas)).toContain('📍 Aapka area kaunsa hai? *Number* bhejein 👇');
    expect(said(areas)).toMatch(/\*DHA\*\n\*1\.\* DHA Phase/);
    expect(opts(areas).at(-1)).toBe('z:none');
    expect(said(areas)).toContain(`*${opts(areas).length}.* ❌ Mera area list mein nahi`);
    const confirm = await c.send({ text: no(areas, 'z:dha-6') });
    expect(confirm.state).toBe('confirm');
    expect(bodies[0]).toMatchObject({ fulfilment: 'delivery', zoneId: 'dha-6', addressLine: 'Flat B102, Gardens 1, near the park' });
  });

  it('a pick-up goes straight to the price: no area, no address, no name or note steps', async () => {
    const { deps, bodies } = fakeDeps();
    const c = chat(shop(), deps);
    const cart = await c.send({ tap: 'i:burger' });
    const confirm = await c.send({ text: no(cart, 'f:pickup') });
    expect(confirm.state).toBe('confirm');
    expect(said(confirm)).toContain('🏃 Pick-up: shop se le jayein');
    expect(bodies[0]).toMatchObject({ fulfilment: 'pickup', customerName: 'Haider Ali', items: [{ posItemId: 'burger', quantity: 1, modifierIds: [] }] });
    expect(bodies[0]).not.toHaveProperty('zoneId');
    expect((await c.send({ text: '1' })).state).toBe('idle'); // "1" = OK
  });

  it('typing names instead of numbers: an item’s name with a count, a choice by name, "delivery"', async () => {
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
    expect(said(cart)).toContain('🍔 *2× Classic Crispy Chicken* — Rs 1,400');
    expect(opts(cart)).toEqual(['f:delivery', 'k:add', 'k:clear']);
    const cleared = await c.send({ text: '3' });
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
    expect(said(await d.send({ text: 'What' }))).toBe('🙏 Samajh nahi aaya.\nUpar wali list se *number* bhejein, ya *menu* likhein.\n👤 Staff se baat: *staff*');
    expect((await d.send({ text: 'Kitni der lagegi' })).out).toEqual([]);
  });

  it('a chat the bot is not in: it answers a price, deals or menu ask, and nothing else', async () => {
    const idle = { state: 'idle' as BotState, data: { cart: [] } };
    const prices = await chat(shop({ menuPicture: PICTURE }), fakeDeps().deps, 'Haider Ali', idle).send({ text: 'Price list bhej dein' });
    expect(prices.state).toBe('menu');
    expect(prices.out[0]!.type).toBe('image');
    expect((await chat(shop(), fakeDeps().deps, 'Haider Ali', idle).send({ text: 'Bhai jaldi bhej dena' })).out).toEqual([]);
    // What the route lets through to it then (lib/whatsapp-bot-run): asks, never a hello or a question for staff.
    expect(['Price list', 'price?', 'Menu send karein', 'deals', 'Buy 1 Get 1 kab hai', 'kitne ka hai', 'koi offer?'].every(asksBot)).toBe(true);
    expect(['Hello', 'Salam', 'Kitni der lagegi?', 'Bhai jaldi bhej dena', 'Order kab aayega', ''].some(asksBot)).toBe(false);
  });

  it('an area not on the list offers pick-up or staff; a WhatsApp name that is not a name is asked for', async () => {
    const c = chat(shop(), fakeDeps().deps, '🍕🍕');
    await c.send({ tap: 'i:burger' });
    await c.send({ tap: 'f:delivery' });
    const areas = await c.send({ text: 'Gulshan Block 5, House 9' });
    expect(areas.state).toBe('zones');
    const none = await c.send({ text: no(areas, 'z:none') });
    expect(opts(none)).toEqual(['f:pickup', 'o:staff']);
    expect(said(none)).toBe('😔 Hamari delivery abhi upar wale areas tak hai.\n\n1️⃣ 🏃 Pick-up karein (khud lene aayenge)\n2️⃣ 👤 Staff se baat');
    const name = await c.send({ tap: 'z:dha-6' });
    expect(name.out[0]).toEqual({ type: 'text', body: '👤 Order kis naam par? Apna *naam* bhejein' });
    expect(name.data.choices).toBeUndefined();
    expect((await c.send({ text: 'Bilal' })).state).toBe('confirm');
  });

  it('“Badlein” goes back to the order, and Delivery then asks the address afresh', async () => {
    const c = chat();
    await c.send({ tap: 'i:burger' });
    await c.send({ tap: 'f:delivery' });
    const confirm = await c.send({ text: 'House 1, Clifton Block 5' });
    const back = await c.send({ text: no(confirm, 'y:edit') });
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
    expect(opts(first)).toEqual(['m:pz-fajita', 'm:pz-tikka', 'm:pz-malai']);
    const done = await turn({ tap: 'm:pz-fajita' });
    expect(done.state).toBe('cart');
    expect(done.data.cart).toEqual([
      { posItemId: 'burger', quantity: 1, modifierIds: [] },
      { posItemId: 'deal-lc', quantity: 2, modifierIds: ['dr-cola', 'fx-fries', 'pz-fajita'] },
    ]);
    expect(textOf(done.out[0])).toBe('Cart ka ek item ab menu par nahi, use chhor diya.');
    expect(opts(done)).toEqual(['f:delivery', 'f:pickup', 'k:add']);
    expect(done.data.queue).toBeUndefined();

    const closed = await runBot({ waId: '923088440608', profileName: null, text: null, reply: null, order: [{ posItemId: 'burger', quantity: 1 }] }, null, shop({ open: false }), fakeDeps().deps);
    expect(closed.out).toEqual([{ type: 'text', body: 'Abhi online orders band hain (open daily · 1 pm – 1 am).' }]);
  });

  it('an order the old bot started (its "how many", Checkout, name and note buttons, a typed count, a drink step) still finishes', async () => {
    const { deps, bodies } = fakeDeps();
    const c = chat(shop(), deps, 'Haider Ali', { state: 'qty', data: { cart: [], pending: { posItemId: 'deal-lc', modifierIds: ['fx-fries', 'pz-tikka', 'dr-cola'], step: 2 } } });
    expect((await c.send({ tap: 'q:2' })).data.cart).toEqual([{ posItemId: 'deal-lc', quantity: 2, modifierIds: ['fx-fries', 'pz-tikka', 'dr-cola'] }]);
    expect(opts(await c.send({ tap: 'k:checkout' }))).toEqual(['f:delivery', 'f:pickup']);
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

  it('the text deals greet by name and fit WhatsApp however many deals there are', () => {
    const w = welcomeStep({ shopName: 'Cheese O’Clock', profileName: 'Haider Ali', shop: shop() });
    expect(textOf(w.out[0]).startsWith('Assalam o Alaikum Haider! Cheese O’Clock mein khush aamdeed 🧀')).toBe(true);
    expect(textOf(welcomeStep({ shopName: 'Cheese O’Clock', profileName: null, shop: shop() }).out[0]).startsWith('Assalam o Alaikum! Cheese O’Clock')).toBe(true);
    const many = Array.from({ length: 120 }, (_, i) => item(`x${i}`, `A rather long deal name number ${i + 1}`, 1000 + i, [], { description: 'with a long description of everything that comes in it' }));
    const big = welcomeStep({ shopName: 'Shop', profileName: null, shop: shop({ menu: { ...MENU, categories: [{ posCategoryId: 'c-x', name: 'Value Deals', displayOrder: 1, items: many }] } }) });
    expect(big.data.choices).toHaveLength(120);
    expect(big.out.length).toBeGreaterThan(1);
    expect(big.out.every((m) => m.type === 'text' && m.body.length <= 4096)).toBe(true);
    expect(said(big)).toContain('*120.* *A rather long deal name number 120* — Rs 1,119');
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
