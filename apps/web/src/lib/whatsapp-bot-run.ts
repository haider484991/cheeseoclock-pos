import { v7 as uuidv7 } from 'uuid';
import { buy1Get1WindowWords, type PublishedMenu } from '@cheeseoclock/shared-types';
import { sql } from './db';
import { factsFromBlock } from './delivery-facts';
import { menuWithoutDrinkBrand } from './menu-view';
import { trackPath } from './order-display';
import { withDealsForSale } from './public-menu';
import { SITE_URL } from './seo';
import { shopHoursInSentence, shopNameProse } from './shop-facts';
import { getShopFacts, parseStoredSettings } from './site-facts';
import { getStoreStatus } from './store-status';
import { asksBot, helloLine, isBotCommand, runBot, welcomeStep, type BotData, type BotShop, type BotState, type OrderAnswer } from './whatsapp-bot';
import { sendBotOrderToMeta } from './whatsapp-conversions';
import { autoReplyText, orderLinkUrl, sendMessage, type WaOut } from './whatsapp-send';
import {
  STAFF_QUIET_MS,
  claimAutoReply,
  createLink,
  readSession,
  recordBotMessage,
  releaseAutoReply,
  staffWroteSince,
  writeSession,
  type WaInbound,
} from './whatsapp-store';
import type { WaSaid } from './whatsapp-webhook';

/**
 * The ordering bot at work (lib/whatsapp-bot) for one customer message: whether it answers at all, its saved step,
 * the shop as it stands, and sending what it says.
 *
 * WHATSAPP_ORDER_BOT decides who gets it: "on" every customer, "test" only the numbers in WHATSAPP_BOT_TESTERS (the
 * owner tries it on their own phone first), anything else nobody (the day's link reply, as before).
 */
export function botFor(waId: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!env['WHATSAPP_ACCESS_TOKEN']) return false;
  const mode = env['WHATSAPP_ORDER_BOT'];
  if (mode === 'on') return true;
  if (mode !== 'test') return false;
  return (env['WHATSAPP_BOT_TESTERS'] ?? '')
    .split(',')
    .map((s) => s.replace(/\D/g, ''))
    .includes(waId);
}

/** An order half-built longer ago than this starts over. */
export const SESSION_TTL_MS = 3 * 60 * 60_000;

/** The shop for the bot: the menu customers can order from, the areas, open or not. */
async function botShop(): Promise<BotShop> {
  const [rows, store, shop] = await Promise.all([
    sql()`SELECT menu_json FROM site_menu WHERE id = 1`,
    getStoreStatus(),
    getShopFacts(),
  ]);
  const stored = (rows as Array<{ menu_json: PublishedMenu }>)[0]?.menu_json;
  const facts = factsFromBlock(parseStoredSettings(stored?.settings ?? null));
  const menu = stored ? withDealsForSale(menuWithoutDrinkBrand(stored), facts.buy1Get1) : { categories: [], publishedAt: '', store: { name: '', phone: null, whatsapp: null, addressLine: null, tagline: null } };
  return {
    menu: menu as PublishedMenu,
    zones: facts.zones,
    open: store.acceptingOrders,
    pickupAvailable: store.pickupAvailable,
    pickupPercent: store.pickupDiscountPercent,
    // The website's % off as it charges it (the regular pizzas' 20%, 10% on the rest of the food): the prices shown match.
    deliveryPercent: store.deliveryDiscountPercent,
    pickupCategoryPercents: store.pickupCategoryPercents ?? [],
    deliveryCategoryPercents: store.deliveryCategoryPercents ?? [],
    buy1Get1Hours: facts.buy1Get1.on ? buy1Get1WindowWords(facts.buy1Get1) : null,
    closedText: `Abhi online orders band hain (${shopHoursInSentence(shop)}). Khulte hi yahin *menu* likh kar order karein 🧀`,
  };
}

/**
 * One customer message for the bot. `order` places (or, with dryRun, prices) an order exactly as the website's
 * checkout does (api/orders).
 */
export async function handleBotMessage(
  m: WaInbound & WaSaid & { phoneNumberId: string },
  order: (body: Record<string, unknown>) => Promise<OrderAnswer>,
  now: Date = new Date(),
): Promise<void> {
  const token = process.env['WHATSAPP_ACCESS_TOKEN']!;
  const send = async (message: WaOut): Promise<boolean> => {
    const r = await sendMessage({ phoneNumberId: m.phoneNumberId, to: m.waId, message, token });
    if (r.ok) await recordBotMessage({ messageId: r.messageId, waId: m.waId, at: new Date() });
    else console.error('whatsapp bot message not sent', r.error);
    return r.ok;
  };

  const session = await readSession(m.waId);
  const fresh = session !== null && now.getTime() - session.updatedAt.getTime() < SESSION_TTL_MS ? session : null;
  const live = fresh !== null && fresh.state !== 'idle';
  // A tapped button or list row, or a cart from the catalog: the customer is talking to the bot.
  const tap = m.reply !== null || (m.order?.length ?? 0) > 0;
  // A Facebook or Instagram ad (or post) tapped: the customer sends the ad's pre-filled words — Meta's "Hello! Can I get
  // more info on this?", or a deal ad's own, like "Classic Crispy Deal order karni hai" (28 Oct 2026). They are the
  // bot's whenever they come (a second tap later the same day too: 27 Oct 2026 it went unanswered once the day's welcome
  // was used): a deal named goes straight to that deal, anything else gets the menu — unless staff are in the chat.
  const fromAd = !tap && m.ad !== null;
  const command = !tap && m.text !== null && isBotCommand(m.text);
  let shopNow: BotShop | null = null;
  const bot = async (): Promise<BotShop> => (shopNow ??= await botShop());
  let hello: string | null = null;

  if (!tap && !command) {
    if (fromAd) {
      const since = live ? Math.max(now.getTime() - STAFF_QUIET_MS, fresh!.updatedAt.getTime()) : now.getTime() - STAFF_QUIET_MS;
      if (await staffWroteSince(m.waId, new Date(since))) return;
      const first = await claimAutoReply(m.waId, now);
      const [shop, open] = await Promise.all([getShopFacts(), bot().then((b) => b.open)]);
      if (!open) {
        const closed: WaOut = { type: 'text', body: autoReplyText({ shop, open: false, link: orderLinkUrl(await createLink(m.waId)), profileName: m.profileName }) };
        if (!(await send(closed)) && first) await releaseAutoReply(m.waId, now);
        return;
      }
      if (first) hello = helloLine({ shopName: shopNameProse(shop), profileName: m.profileName });
    } else if (!live && !(await claimAutoReply(m.waId, now))) {
      // The day's welcome is used: the words are staff's — unless they ask for the prices, the deals or the menu while
      // staff are not in the chat (the user, 28 Oct 2026: staff could not keep up, "bot should reply every deals and
      // menu prices according to keyword").
      if (!asksBot(m.text ?? '') || (await staffWroteSince(m.waId, new Date(now.getTime() - STAFF_QUIET_MS)))) return;
    } else if (!live) {
      // Not in an order, and the day's first message: the welcome (closed: the hours and the link).
      const shop = await getShopFacts();
      const shopFor = await bot();
      if (!shopFor.open) {
        const closed: WaOut = { type: 'text', body: autoReplyText({ shop, open: false, link: orderLinkUrl(await createLink(m.waId)), profileName: m.profileName }) };
        if (!(await send(closed))) await releaseAutoReply(m.waId, now);
        return;
      }
      // The welcome is the whole menu, numbered (27 Oct 2026; as text 28 Oct), and the chat is in it from now: what they
      // type next — a number, an item's name, a hello — is the bot's to answer, not left for staff.
      const step = welcomeStep({ shopName: shopNameProse(shop), profileName: m.profileName, shop: shopFor });
      if (!(await writeSession(m.waId, step.state, step.data as unknown as Record<string, unknown>, session ? session.version : null))) return;
      for (const [k, message] of step.out.entries()) {
        if (await send(message)) continue;
        if (k === 0) await releaseAutoReply(m.waId, now);
        return;
      }
      return;
    } else {
      // Staff wrote to them in the last hour, after the bot's last step: staff took the chat over and the words are
      // theirs. A message from the phone before that step does not stop the order the customer is answering now (the
      // user, 26 Oct 2026: the bot asked for the address, then went quiet when it came).
      const since = Math.max(now.getTime() - STAFF_QUIET_MS, fresh!.updatedAt.getTime());
      if (await staffWroteSince(m.waId, new Date(since))) return;
    }
  }

  const placed: { order?: { orderId: string; totalCents: number } } = {};
  // An ad's words start from the menu, whatever step the chat was at (the order so far is kept).
  const saved = fromAd
    ? { state: 'menu' as BotState, data: fresh ? (fresh.data as unknown as BotData) : { cart: [] } }
    : fresh
      ? { state: fresh.state as BotState, data: fresh.data as unknown as BotData }
      : null;
  const step = await runBot(
    { waId: m.waId, profileName: m.profileName, text: m.text, reply: m.reply, order: m.order, hello },
    saved,
    await bot(),
    {
      order,
      link: () => createLink(m.waId),
      newId: () => uuidv7(),
      trackUrl: (orderId, phone) => `${SITE_URL}${trackPath(orderId, phone)}`,
      websiteText: (t) => `🌐 Website par order karein — aapka naam aur number pehle se bhara hoga:\n${orderLinkUrl(t)}`,
      placed: (o) => {
        placed.order = o;
      },
    },
  );
  // Another message for this customer saved first (two taps at once): its answer stands, this one is dropped.
  if (!(await writeSession(m.waId, step.state, step.data as unknown as Record<string, unknown>, session ? session.version : null))) return;
  for (const message of step.out) await send(message);
  // An order went through, and the customer has its confirmation: Meta hears of it when an ad brought the chat.
  if (placed.order) await sendBotOrderToMeta({ waId: m.waId, orderId: placed.order.orderId, totalCents: placed.order.totalCents, at: now });
}
