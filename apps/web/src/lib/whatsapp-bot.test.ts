/**
 * The WhatsApp ordering bot (lib/whatsapp-bot, 26 Oct 2026; fewer steps 27 Oct 2026): the menu as the first reply, an
 * item and the choices it needs straight into the order, Delivery or Pick-up on the order's own message, the area read
 * from the address, the WhatsApp name as the order's name — priced by the website's own order route before the
 * customer confirms, and placed once however many times they tap Confirm. Typing works where tapping does.
 */
import { describe, expect, it } from 'vitest';
import type { PublishedMenu, PublishedMenuItem, PublishedModifierGroup } from '@cheeseoclock/shared-types';
import { factsFromBlock } from './delivery-facts';
import { isBotCommand, runBot, welcomeMessage, zoneInText, type BotData, type BotDeps, type BotShop, type BotState, type OrderAnswer } from './whatsapp-bot';
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
  { taxIncluded: true, description: 'Large 12" regular pizza + 1 litre drink' },
);
const BURGER = item('burger', 'Classic Crispy Chicken', 700, [group('g-ex', 'Extras · Burgers', [mod('ex-cheese', 'Cheese slice', 80)])]);
const PIZZAS = Array.from({ length: 12 }, (_, i) => item(`pz-${i}`, `Pizza number ${i + 1} — Large`, 2000));

const MENU: PublishedMenu = {
  categories: [
    { posCategoryId: 'c-deals', name: 'Value Deals', displayOrder: 1, items: [DEAL] },
    { posCategoryId: 'c-burgers', name: 'Burgers', displayOrder: 2, items: [BURGER] },
    { posCategoryId: 'c-pizza', name: 'Pizza', displayOrder: 3, items: PIZZAS },
    { posCategoryId: 'c-del', name: 'Delivery Charges', displayOrder: 9, items: [item('del-200', 'Delivery Charge (Rs 200)', 200)] },
  ],
  publishedAt: '2026-10-26T00:00:00Z',
  store: { name: 'Shop', phone: null, whatsapp: null, addressLine: null, tagline: null },
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
 * welcome leaves a chat — on the menu (lib/whatsapp-bot-run writes that step with the welcome).
 */
function chat(s: BotShop = shop(), deps: BotDeps = fakeDeps().deps, profileName: string | null = 'Haider Ali', from: { state: BotState; data: BotData } | null = { state: 'menu', data: { cart: [] } }) {
  let saved: { state: BotState; data: BotData } | null = from;
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
    get saved() {
      return saved;
    },
  };
}

const ids = (m: WaOut | undefined): string[] =>
  !m ? [] : m.type === 'buttons' ? m.buttons.map((b) => b.id) : m.type === 'list' ? m.sections.flatMap((s) => s.rows.map((r) => r.id)) : [];
const body = (m: WaOut | undefined) => (m && m.type !== 'text' ? m.body : (m?.body ?? ''));
const titles = (m: WaOut | undefined): string[] => (m?.type === 'buttons' ? m.buttons.map((b) => b.title) : m?.type === 'list' ? m.sections.flatMap((s) => s.rows.map((r) => r.title)) : []);

describe('the WhatsApp ordering bot', () => {
  it('a whole delivery order in a few taps: the deal, its two choices, Delivery, the address (area read from it), Confirm', async () => {
    const { deps, bodies } = fakeDeps();
    const c = chat(shop(), deps);

    const menu = await c.send({ text: 'menu' });
    expect(menu.state).toBe('menu');
    // The deals themselves, one pick away (no Delivery Charges), then the full menu, the website, staff.
    expect(ids(menu.out[0])).toEqual(['i:deal-lc', 'o:menu', 'o:web', 'o:staff']);

    const pizza = await c.send({ tap: 'i:deal-lc' });
    expect(pizza.state).toBe('choice');
    expect(body(pizza.out[0])).toContain('Large pizza chunein — 1/2');
    // Three short choices are buttons (one tap), without the till's "Large:" in front.
    expect(pizza.out[0]!.type).toBe('buttons');
    expect(ids(pizza.out[0])).toEqual(['m:pz-fajita', 'm:pz-tikka', 'm:pz-malai']);
    expect(titles(pizza.out[0])).toEqual(['Fajita', 'Chicken Tikka', 'Malai Supreme']);

    const drink = await c.send({ tap: 'm:pz-tikka' });
    expect(body(drink.out[0])).toContain('1 litre drink chunein — 2/2');

    // Straight into the order — no "how many" step — and the order's message asks Delivery or Pick-up.
    const cart = await c.send({ tap: 'm:dr-cola' });
    expect(cart.state).toBe('cart');
    expect(ids(cart.out[0])).toEqual(['f:delivery', 'f:pickup', 'k:add']);
    expect(titles(cart.out[0])).toEqual(['🛵 Delivery', '🏃 Pick-up 10% off', '➕ Aur add karein']);
    expect(body(cart.out[0])).toContain('✅ Order mein add ho gaya!');
    expect(body(cart.out[0])).toContain('1× Large & Chilled — Rs 1,800');
    expect(body(cart.out[0])).toContain('↳ Large pizza: Chicken Tikka · 1 litre drink: Cola 1 litre');

    // A number typed changes how many.
    const two = await c.send({ text: '2' });
    expect(body(two.out[0])).toContain('2× Large & Chilled — Rs 3,600');
    expect(two.data.cart).toEqual([{ posItemId: 'deal-lc', quantity: 2, modifierIds: ['fx-fries', 'pz-tikka', 'dr-cola'] }]);

    const address = await c.send({ tap: 'f:delivery' });
    expect(address.state).toBe('address');
    expect(body(address.out[0])).toContain('Delivery address likh dein');

    // The area is read from the address, and the WhatsApp name is the order's: straight to the till's price.
    const confirm = await c.send({ text: 'House 12, Street 4, DHA Phase 6' });
    expect(confirm.state).toBe('confirm');
    expect(ids(confirm.out[0])).toEqual(['y:confirm', 'y:edit', 'y:cancel']);
    const summary = body(confirm.out[0]);
    expect(summary).toContain('2× Large & Chilled — Rs 3,600');
    expect(summary).toContain('↳ Large pizza: Chicken Tikka · 1 litre drink: Cola 1 litre');
    expect(summary).toContain('*Total Rs 3,800* · cash on delivery');
    expect(summary).toContain('🛵 DHA Phase 6 · House 12, Street 4, DHA Phase 6');
    expect(summary).toContain('Haider Ali · 0308 8440608');

    // Words at the end are the order's note; "ok" confirms.
    const noted = await c.send({ text: 'Ghanti mat bajayein' });
    expect(noted.state).toBe('confirm');
    expect(body(noted.out[0])).toContain('📝 Ghanti mat bajayein');

    const placed = await c.send({ text: 'ok' });
    expect(placed.state).toBe('idle');
    expect(body(placed.out[0])).toContain('Shukriya Haider! Aapka order place ho gaya.');
    expect(body(placed.out[0])).toContain('https://site.test/track/0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000?phone=0308%208440608');
    expect(placed.data.cart).toEqual([]);

    // The quotes and the order are the same order: one id, the WhatsApp number, the link token, the note.
    expect(bodies).toHaveLength(3);
    expect(bodies[1]).toMatchObject({ dryRun: true, customerName: 'Haider Ali', customerPhone: '+923088440608', fulfilment: 'delivery', zoneId: 'dha-6', addressLine: 'House 12, Street 4, DHA Phase 6', notes: 'Ghanti mat bajayein', waToken: 'Tok3nAbcDefG' });
    expect(bodies[2]).toMatchObject({ clientOrderId: '0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000', notes: 'Ghanti mat bajayein', items: [{ posItemId: 'deal-lc', quantity: 2, modifierIds: ['fx-fries', 'pz-tikka', 'dr-cola'] }] });
    expect(bodies[2]).not.toHaveProperty('dryRun');
  });

  it('an address that names no area: the area list once, then the price (the address kept)', async () => {
    const { deps, bodies } = fakeDeps();
    const c = chat(shop(), deps);
    expect((await c.send({ tap: 'i:burger' })).state).toBe('cart'); // nothing to choose: straight in
    await c.send({ tap: 'f:delivery' });
    const areas = await c.send({ text: 'Flat B102, Gardens 1, near the park' });
    expect(areas.state).toBe('zones');
    expect(body(areas.out[0])).toContain('Aapka area kaunsa hai?');
    expect(ids(areas.out[0])).toContain('z:none');
    const phases = await c.send({ tap: ids(areas.out[0]).find((x) => x.startsWith('zg:'))! });
    expect(ids(phases.out[0]).length).toBeLessThanOrEqual(10);
    const confirm = await c.send({ tap: 'z:dha-6' });
    expect(confirm.state).toBe('confirm');
    expect(bodies[0]).toMatchObject({ fulfilment: 'delivery', zoneId: 'dha-6', addressLine: 'Flat B102, Gardens 1, near the park' });
  });

  it('a pick-up goes straight to the price: no area, no address, no name or note steps', async () => {
    const { deps, bodies } = fakeDeps();
    const c = chat(shop(), deps);
    await c.send({ tap: 'i:burger' });
    const confirm = await c.send({ tap: 'f:pickup' });
    expect(confirm.state).toBe('confirm');
    expect(body(confirm.out[0])).toContain('Pick-up: shop se le jayein');
    expect(bodies[0]).toMatchObject({ fulfilment: 'pickup', customerName: 'Haider Ali', items: [{ posItemId: 'burger', quantity: 1, modifierIds: [] }] });
    expect(bodies[0]).not.toHaveProperty('zoneId');
  });

  it('typing instead of tapping: an item’s name with a count, then each choice by name ("coke" is the cola, "sprite" the lemon-lime)', async () => {
    const c = chat();
    const pizza = await c.send({ text: '2 large and chilled please' });
    expect(pizza.state).toBe('choice');
    expect((await c.send({ text: 'tikka' })).state).toBe('choice');
    const cart = await c.send({ text: 'Coke' });
    expect(cart.state).toBe('cart');
    expect(cart.data.cart).toEqual([{ posItemId: 'deal-lc', quantity: 2, modifierIds: ['fx-fries', 'pz-tikka', 'dr-cola'] }]);
    // "delivery" typed at the order is the button.
    expect((await c.send({ text: 'delivery' })).state).toBe('address');

    const d = chat();
    await d.send({ text: 'Large & Chilled' });
    await d.send({ text: 'fajita' });
    expect((await d.send({ text: 'sprite' })).data.cart).toEqual([{ posItemId: 'deal-lc', quantity: 1, modifierIds: ['fx-fries', 'pz-fajita', 'dr-lime'] }]);
  });

  it('typed words that name several items, a category or a hello get the right list; anything else is helped once, then left to staff', async () => {
    const menu: PublishedMenu = {
      ...MENU,
      categories: [
        MENU.categories[0]!,
        { posCategoryId: 'c-pz', name: 'Pizza', displayOrder: 2, items: [item('fz-m', 'Fajita Pizza — Medium', 1500), item('fz-l', 'Fajita Pizza — Large', 2000)] },
        { posCategoryId: 'c-burgers', name: 'Burgers', displayOrder: 3, items: [BURGER] },
      ],
    };
    const c = chat(shop({ menu }));
    const both = await c.send({ text: 'fajita' });
    expect(ids(both.out[0])).toEqual(['i:fz-m', 'i:fz-l']);
    const large = await c.send({ text: 'fajita large' });
    expect(large.data.cart).toEqual([{ posItemId: 'fz-l', quantity: 1, modifierIds: [] }]);

    const d = chat(shop({ menu }));
    expect(ids((await d.send({ text: 'zinger burger' })).out[0])).toEqual(['i:burger']);
    expect(ids((await d.send({ text: 'Assalam o alaikum' })).out[0])).toContain('o:menu');
    // Meta's words when an ad is tapped: the menu, not "not understood".
    const info = await d.send({ text: 'Hello! Can I get more info on this?' });
    expect(ids(info.out[0])).toContain('o:menu');
    expect(body(info.out[0])).not.toContain('samajh nahi aaya');
    const help = await d.send({ text: 'Delivery kitni der mein?' });
    expect(body(help.out[0])).toContain('Ye samajh nahi aaya');
    expect(ids(help.out[0])).toContain('o:staff');
    expect((await d.send({ text: 'Kitni der lagegi' })).out).toEqual([]);
  });

  it('a deal ad’s words go straight to that deal (its full name beats the burger sharing its words); the day’s hello sits over the menu', async () => {
    const ccDeal = item('cc-deal', 'Classic Crispy Deal', 850, [group('g-cc-drink', 'Choose a Drink· 345 ml', [mod('cc-cola', 'Cola'), mod('cc-lime', 'Lemon-lime')], { min: 1, req: true })], { taxIncluded: true });
    const menu: PublishedMenu = { ...MENU, categories: [{ ...MENU.categories[0]!, items: [ccDeal, DEAL] }, ...MENU.categories.slice(1)] };
    const c = chat(shop({ menu }));
    const first = await c.send({ text: 'Classic Crispy Deal order karni hai' });
    expect(first.state).toBe('choice');
    expect(ids(first.out[0])).toEqual(['m:cc-cola', 'm:cc-lime']);
    expect((await chat(shop({ menu })).send({ text: 'I want to order the Classic Crispy Deal' })).state).toBe('choice');

    const hello = 'Assalam o Alaikum Ali! Cheese O’Clock mein khush aamdeed 🧀';
    const step = await runBot({ waId: '923088440608', profileName: 'Ali', text: 'Hello! Can I get more info on this?', reply: null, hello }, { state: 'menu', data: { cart: [] } }, shop(), fakeDeps().deps);
    expect(body(step.out[0]).startsWith(hello)).toBe(true);
    expect(ids(step.out[0])).toContain('o:menu');
  });

  it('a category of twelve comes in pages of nine with a “More” row', async () => {
    const c = chat();
    await c.send({ tap: 'o:menu' });
    const first = await c.send({ tap: 'c:2' });
    expect(ids(first.out[0])).toHaveLength(10);
    expect(ids(first.out[0]).at(-1)).toBe('cp:2:1');
    expect(ids((await c.send({ tap: 'cp:2:1' })).out[0])).toEqual(['i:pz-9', 'i:pz-10', 'i:pz-11']);
  });

  it('the same item twice with the same choices adds up; without pick-up the order offers Clear, which empties it', async () => {
    const c = chat(shop({ pickupAvailable: false }));
    await c.send({ tap: 'i:burger' });
    const cart = await c.send({ tap: 'i:burger' });
    expect(cart.data.cart).toEqual([{ posItemId: 'burger', quantity: 2, modifierIds: [] }]);
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
    expect(body(social.out[0])).toContain('Buy 1 Get 1 needs your Instagram or Facebook name.');
    const confirm = await c.send({ text: '@haider' });
    expect(confirm.state).toBe('confirm');
    expect(asked).toBe(1);
    expect(bodies.at(-1)).toMatchObject({ social: '@haider', dryRun: true });
  });

  it('a closed shop answers with its hours; the till’s refusal at Confirm is said in its words and the order stays', async () => {
    const closed = chat(shop({ open: false }));
    const r = await closed.send({ tap: 'o:start' });
    expect(r.out).toEqual([{ type: 'text', body: 'Abhi online orders band hain (open daily · 1 pm – 1 am).' }]);

    const { deps } = fakeDeps((b) =>
      b['dryRun'] ? { ok: true, subtotalCents: 70_000, discountCents: 0, taxCents: 10_500, totalCents: 80_500, lines: [] } : { ok: false, error: 'store_closed', message: 'We are not taking online orders at the moment.' },
    );
    const c = chat(shop(), deps);
    await c.send({ tap: 'i:burger' });
    await c.send({ tap: 'f:pickup' });
    const refused = await c.send({ tap: 'y:confirm' });
    expect(body(refused.out[0])).toBe('We are not taking online orders at the moment.');
    expect(refused.data.cart).toHaveLength(1);
  });

  it('“staff”, “cancel” and “menu” work at any step; words a choice can’t use get its question again once, then the chat is staff’s', async () => {
    const c = chat();
    await c.send({ tap: 'i:deal-lc' });
    const q1 = await c.send({ text: 'Delivery kitni der mein?' });
    expect(body(q1.out[0])).toContain('Large pizza chunein');
    expect((await c.send({ text: 'Hello?' })).out).toEqual([]);
    expect((await c.send({ text: 'menu' })).state).toBe('menu');
    const staff = await c.send({ text: 'staff' });
    expect(staff.state).toBe('idle');
    expect(body(staff.out[0])).toContain('Hamara staff jaldi yahin jawab dega');
    expect((await c.send({ text: 'Cancel' })).data.cart).toEqual([]);
    expect(['menu', 'Order', 'STAFF', 'cancel'].every(isBotCommand)).toBe(true);
    expect(isBotCommand('menu pe kya hai')).toBe(false);
  });

  it('an area not on the list offers pick-up or staff; a WhatsApp name that is not a name is asked for', async () => {
    const c = chat(shop(), fakeDeps().deps, '🍕🍕');
    await c.send({ tap: 'i:burger' });
    await c.send({ tap: 'f:delivery' });
    expect((await c.send({ text: 'Gulshan Block 5, House 9' })).state).toBe('zones');
    expect(ids((await c.send({ tap: 'z:none' })).out[0])).toEqual(['f:pickup', 'o:staff']);
    const name = await c.send({ tap: 'z:dha-6' });
    expect(name.out[0]).toEqual({ type: 'text', body: '👤 Order kis naam par? Apna naam likhein:' });
    expect((await c.send({ text: 'Bilal' })).state).toBe('confirm');
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
    const turn = async (said: { tap?: string; order?: Array<{ posItemId: string; quantity: number }> }) => {
      const step = await runBot({ waId: '923088440608', profileName: 'Haider', text: null, reply: said.tap ? { id: said.tap, title: '' } : null, order: said.order ?? null }, saved, shop(), fakeDeps().deps);
      saved = { state: step.state, data: step.data };
      return step;
    };
    const first = await turn({ order: [{ posItemId: 'burger', quantity: 1 }, { posItemId: 'deal-lc', quantity: 2 }, { posItemId: 'gone', quantity: 1 }] });
    expect(first.state).toBe('choice');
    expect(first.data.cart).toEqual([{ posItemId: 'burger', quantity: 1, modifierIds: [] }]);
    expect(ids(first.out[0])).toEqual(['m:pz-fajita', 'm:pz-tikka', 'm:pz-malai']);
    await turn({ tap: 'm:pz-fajita' });
    const done = await turn({ tap: 'm:dr-lime' });
    expect(done.state).toBe('cart');
    expect(done.data.cart).toEqual([
      { posItemId: 'burger', quantity: 1, modifierIds: [] },
      { posItemId: 'deal-lc', quantity: 2, modifierIds: ['fx-fries', 'pz-fajita', 'dr-lime'] },
    ]);
    expect(body(done.out[0])).toBe('Cart ka ek item ab menu par nahi, use chhor diya.');
    expect(ids(done.out[1])).toEqual(['f:delivery', 'f:pickup', 'k:add']);
    expect(done.data.queue).toBeUndefined();

    const closed = await runBot({ waId: '923088440608', profileName: null, text: null, reply: null, order: [{ posItemId: 'burger', quantity: 1 }] }, null, shop({ open: false }), fakeDeps().deps);
    expect(closed.out).toEqual([{ type: 'text', body: 'Abhi online orders band hain (open daily · 1 pm – 1 am).' }]);
  });

  it('an order the old bot started (its "how many", Checkout, name and note buttons) still finishes', async () => {
    const { deps, bodies } = fakeDeps();
    const c = chat(shop(), deps, 'Haider Ali', { state: 'qty', data: { cart: [], pending: { posItemId: 'deal-lc', modifierIds: ['fx-fries', 'pz-tikka', 'dr-cola'], step: 2 } } });
    expect((await c.send({ tap: 'q:2' })).data.cart).toEqual([{ posItemId: 'deal-lc', quantity: 2, modifierIds: ['fx-fries', 'pz-tikka', 'dr-cola'] }]);
    expect(ids((await c.send({ tap: 'k:checkout' })).out[0])).toEqual(['f:delivery', 'f:pickup']);
    expect((await c.send({ tap: 'f:pickup' })).state).toBe('confirm');

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

  it('the welcome is the menu: the deals, then the full menu, the website and staff, in WhatsApp’s ten rows', () => {
    const w = welcomeMessage({ shopName: 'Cheese O’Clock', profileName: 'Haider Ali', shop: shop() });
    expect(body(w)).toContain('Assalam o Alaikum Haider! Cheese O’Clock mein khush aamdeed');
    expect(body(w)).toContain('jaise _Large & Chilled_');
    expect(ids(w)).toEqual(['i:deal-lc', 'o:menu', 'o:web', 'o:staff']);
    expect(w.type === 'list' && w.sections[0]!.rows[0]!.description).toBe('Rs 1,800 · tax shamil · Large 12" regular pizza + 1 litre drink');

    const nine = Array.from({ length: 9 }, (_, i) => item(`d${i}`, `Deal ${i + 1}`, 1000 + i));
    const many = shop({ menu: { ...MENU, categories: [{ ...MENU.categories[0]!, items: nine }, ...MENU.categories.slice(1)] } });
    const w9 = welcomeMessage({ shopName: 'Cheese O’Clock', profileName: null, shop: many });
    expect(body(w9)).toContain('Assalam o Alaikum! Cheese O’Clock');
    expect(ids(w9)).toEqual(['i:d0', 'i:d1', 'i:d2', 'i:d3', 'i:d4', 'i:d5', 'c:0', 'o:menu', 'o:web', 'o:staff']);
    const p = payloadOf('923088440608', w9) as { interactive: { action: { button: string; sections: Array<{ rows: unknown[] }> } } };
    expect(p.interactive.action.sections.flatMap((s) => s.rows)).toHaveLength(10);
    expect(p.interactive.action.button).toBe('📋 Menu');
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
  });
});
