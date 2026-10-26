/**
 * The WhatsApp ordering bot (lib/whatsapp-bot, 26 Oct 2026): a whole order in the chat — category, item, the deal's
 * choices (its fixed parts come with it), how many, delivery, area, address, name, note — priced by the website's own
 * order route before the customer confirms, and placed once however many times they tap Confirm.
 */
import { describe, expect, it } from 'vitest';
import type { PublishedMenu, PublishedMenuItem, PublishedModifierGroup } from '@cheeseoclock/shared-types';
import { factsFromBlock } from './delivery-facts';
import { isBotCommand, runBot, welcomeMessage, type BotData, type BotDeps, type BotShop, type BotState, type OrderAnswer } from './whatsapp-bot';
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
    group('g-pz', 'Deal: Large pizza', [mod('pz-fajita', 'Fajita'), mod('pz-tikka', 'Chicken Tikka'), mod('pz-malai', 'Malai Supreme')], { min: 1, req: true }),
    group('g-dr', 'Deal: 1 litre drink', [mod('dr-cola', 'Cola'), mod('dr-lemon', 'Lemon-up')], { min: 1, req: true }),
    group('g-dip', 'Dips on the side', [mod('dip-garlic', 'Garlic Mayo', 100)], { max: 9 }),
    group('g-fixed', 'Comes with · fries', [mod('fx-fries', 'Fries', 0, true)], { min: 1, req: true }),
  ],
  { taxIncluded: true },
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
          { posItemId: 'deal-lc', name: 'Large & Chilled', quantity: 2, unitPriceCents: 180_000, modifiers: [{ posModifierId: 'pz-tikka', name: 'Chicken Tikka' }, { posModifierId: 'dr-cola', name: 'Cola' }, { posModifierId: 'fx-fries', name: 'Fries' }] },
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

/** A conversation: each customer message runs the bot on the step the last one saved. */
function chat(s: BotShop = shop(), deps: BotDeps = fakeDeps().deps, profileName: string | null = 'Haider Ali') {
  let saved: { state: BotState; data: BotData } | null = null;
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

describe('the WhatsApp ordering bot', () => {
  it('a whole delivery order: the deal’s choices, its fries without asking, two of them, DHA Phase 6, then the till’s total', async () => {
    const { deps, bodies } = fakeDeps();
    const c = chat(shop(), deps);

    const menu = await c.send({ tap: 'o:start' });
    expect(menu.state).toBe('menu');
    expect(ids(menu.out[0])).toEqual(['c:0', 'c:1', 'c:2']); // no Delivery Charges

    const items = await c.send({ tap: 'c:0' });
    expect(ids(items.out[0])).toEqual(['i:deal-lc']);

    const pizza = await c.send({ tap: 'i:deal-lc' });
    expect(pizza.state).toBe('choice');
    expect(body(pizza.out[0])).toContain('Large pizza chunein — 1/2');
    expect(ids(pizza.out[0])).toEqual(['m:pz-fajita', 'm:pz-tikka', 'm:pz-malai']);

    const drink = await c.send({ tap: 'm:pz-tikka' });
    expect(body(drink.out[0])).toContain('1 litre drink chunein — 2/2');

    const qty = await c.send({ tap: 'm:dr-cola' });
    expect(qty.state).toBe('qty');
    expect(ids(qty.out[0])).toEqual(['q:1', 'q:2', 'q:3']);

    const cart = await c.send({ tap: 'q:2' });
    expect(cart.state).toBe('cart');
    expect(body(cart.out[0])).toContain('2× Large & Chilled — Rs 3,600');
    expect(body(cart.out[0])).toContain('Large pizza: Chicken Tikka · 1 litre drink: Cola');
    expect(cart.data.cart).toEqual([{ posItemId: 'deal-lc', quantity: 2, modifierIds: ['fx-fries', 'pz-tikka', 'dr-cola'] }]);

    const how = await c.send({ tap: 'k:checkout' });
    expect(ids(how.out[0])).toEqual(['f:delivery', 'f:pickup']);

    const areas = await c.send({ tap: 'f:delivery' });
    expect(areas.state).toBe('zones');
    expect(ids(areas.out[0])).toContain('z:none');
    const dha = ids(areas.out[0]).find((x) => x.startsWith('zg:'))!;
    const phases = await c.send({ tap: dha });
    expect(ids(phases.out[0]).length).toBeLessThanOrEqual(10);

    const address = await c.send({ tap: 'z:dha-6' });
    expect(address.state).toBe('address');
    expect(body(address.out[0])).toContain('DHA Phase 6');

    const name = await c.send({ text: 'House 12, Street 4, Rahat Lane' });
    expect(name.state).toBe('name');
    expect(ids(name.out[0])).toEqual(['n:ok', 'n:edit']);

    const notes = await c.send({ tap: 'n:ok' });
    expect(notes.state).toBe('notes');

    const confirm = await c.send({ text: 'Ghanti mat bajayein' });
    expect(confirm.state).toBe('confirm');
    expect(ids(confirm.out[0])).toEqual(['y:confirm', 'y:edit', 'y:cancel']);
    const summary = body(confirm.out[0]);
    expect(summary).toContain('2× Large & Chilled — Rs 3,600');
    expect(summary).toContain('*Total Rs 3,800* · cash on delivery');
    expect(summary).toContain('DHA Phase 6 · House 12, Street 4, Rahat Lane');
    expect(summary).toContain('Haider Ali · 0308 8440608');
    expect(summary).toContain('📝 Ghanti mat bajayein');

    const placed = await c.send({ tap: 'y:confirm' });
    expect(placed.state).toBe('idle');
    expect(body(placed.out[0])).toContain('Shukriya Haider! Aapka order place ho gaya.');
    expect(body(placed.out[0])).toContain('https://site.test/track/0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000?phone=0308%208440608');
    expect(placed.data.cart).toEqual([]);

    // The quote and the order are the same order: one id, the WhatsApp number, the link token.
    const [quote, order] = bodies;
    expect(quote).toMatchObject({ dryRun: true, customerName: 'Haider Ali', customerPhone: '+923088440608', fulfilment: 'delivery', zoneId: 'dha-6', addressLine: 'House 12, Street 4, Rahat Lane', notes: 'Ghanti mat bajayein', waToken: 'Tok3nAbcDefG' });
    expect(order).toMatchObject({ clientOrderId: '0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000', items: [{ posItemId: 'deal-lc', quantity: 2, modifierIds: ['fx-fries', 'pz-tikka', 'dr-cola'] }] });
    expect(order).not.toHaveProperty('dryRun');
  });

  it('a pick-up skips the area and the address; an item with nothing to choose goes straight to how many', async () => {
    const { deps, bodies } = fakeDeps();
    const c = chat(shop(), deps);
    await c.send({ tap: 'o:start' });
    await c.send({ tap: 'c:1' });
    expect(ids((await c.send({ tap: 'i:burger' })).out[0])).toEqual(['q:1', 'q:2', 'q:3']);
    await c.send({ tap: 'q:1' });
    await c.send({ tap: 'k:checkout' });
    expect((await c.send({ tap: 'f:pickup' })).state).toBe('name');
    await c.send({ tap: 'n:ok' });
    const confirm = await c.send({ tap: 'x:none' });
    expect(body(confirm.out[0])).toContain('Pick-up: shop se le jayein');
    expect(bodies[0]).toMatchObject({ fulfilment: 'pickup', items: [{ posItemId: 'burger', quantity: 1, modifierIds: [] }] });
    expect(bodies[0]).not.toHaveProperty('zoneId');
  });

  it('a category of twelve comes in pages of nine with a “More” row', async () => {
    const c = chat();
    await c.send({ tap: 'o:start' });
    const first = await c.send({ tap: 'c:2' });
    expect(ids(first.out[0])).toHaveLength(10);
    expect(ids(first.out[0]).at(-1)).toBe('cp:2:1');
    expect(ids((await c.send({ tap: 'cp:2:1' })).out[0])).toEqual(['i:pz-9', 'i:pz-10', 'i:pz-11']);
  });

  it('the same item twice with the same choices adds up; Clear empties the order', async () => {
    const c = chat();
    for (let i = 0; i < 2; i++) {
      await c.send({ tap: 'c:1' });
      await c.send({ tap: 'i:burger' });
      await c.send({ tap: 'q:2' });
    }
    expect(c.saved?.data.cart).toEqual([{ posItemId: 'burger', quantity: 4, modifierIds: [] }]);
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
    await c.send({ tap: 'c:1' });
    await c.send({ tap: 'i:burger' });
    await c.send({ tap: 'q:1' });
    await c.send({ tap: 'k:checkout' });
    await c.send({ tap: 'f:pickup' });
    await c.send({ tap: 'n:ok' });
    const social = await c.send({ tap: 'x:none' });
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
    await c.send({ tap: 'c:1' });
    await c.send({ tap: 'i:burger' });
    await c.send({ tap: 'q:1' });
    await c.send({ tap: 'k:checkout' });
    await c.send({ tap: 'f:pickup' });
    await c.send({ tap: 'n:ok' });
    await c.send({ tap: 'x:none' });
    const refused = await c.send({ tap: 'y:confirm' });
    expect(body(refused.out[0])).toBe('We are not taking online orders at the moment.');
    expect(refused.data.cart).toHaveLength(1);
  });

  it('“staff”, “cancel” and “menu” work at any step; a question mid-order gets one pointer, then the chat is staff’s', async () => {
    const c = chat();
    await c.send({ tap: 'c:1' });
    const q1 = await c.send({ text: 'Delivery kitni der mein?' });
    expect(body(q1.out[0])).toContain('Upar di gayi list ya buttons se chunein');
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
    await c.send({ tap: 'c:1' });
    await c.send({ tap: 'i:burger' });
    await c.send({ tap: 'q:1' });
    await c.send({ tap: 'k:checkout' });
    await c.send({ tap: 'f:delivery' });
    expect(ids((await c.send({ tap: 'z:none' })).out[0])).toEqual(['f:pickup', 'o:staff']);
    await c.send({ tap: 'z:dha-6' });
    const name = await c.send({ text: 'House 12, Street 4' });
    expect(name.out[0]).toEqual({ type: 'text', body: '👤 Order kis naam par? Apna naam likhein:' });
    expect((await c.send({ text: 'Bilal' })).state).toBe('notes');
  });

  it('the welcome and every message fit WhatsApp’s limits', () => {
    const w = welcomeMessage({ shopName: 'Cheese O’Clock', profileName: 'Haider Ali' });
    expect(body(w)).toContain('Assalam o Alaikum Haider! Cheese O’Clock mein khush aamdeed');
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
