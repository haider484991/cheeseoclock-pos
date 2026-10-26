import { v7 as uuidv7 } from 'uuid';
import type { PublishedMenu } from '@cheeseoclock/shared-types';
import { sql } from './db';
import { factsFromBlock } from './delivery-facts';
import { menuWithoutDrinkBrand } from './menu-view';
import { trackPath } from './order-display';
import { withDealsForSale } from './public-menu';
import { SITE_URL } from './seo';
import { shopHoursInSentence, shopNameProse } from './shop-facts';
import { getShopFacts, parseStoredSettings } from './site-facts';
import { getStoreStatus } from './store-status';
import { isBotCommand, runBot, welcomeMessage, type BotData, type BotShop, type BotState, type OrderAnswer } from './whatsapp-bot';
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
  const tap = m.reply !== null;
  const command = !tap && m.text !== null && isBotCommand(m.text);

  if (!tap && !command) {
    if (!live) {
      // Not in an order: the day's first message gets the welcome (closed: the hours and the link); the rest are staff's.
      if (!(await claimAutoReply(m.waId, now))) return;
      const [shop, store] = await Promise.all([getShopFacts(), getStoreStatus()]);
      const welcome: WaOut = store.acceptingOrders
        ? welcomeMessage({ shopName: shopNameProse(shop), profileName: m.profileName })
        : { type: 'text', body: autoReplyText({ shop, open: false, link: orderLinkUrl(await createLink(m.waId)), profileName: m.profileName }) };
      if (!(await send(welcome))) await releaseAutoReply(m.waId, now);
      return;
    }
    // Staff wrote to them in the last hour: the words are for staff, not the bot.
    if (await staffWroteSince(m.waId, new Date(now.getTime() - STAFF_QUIET_MS))) return;
  }

  const step = await runBot(
    { waId: m.waId, profileName: m.profileName, text: m.text, reply: m.reply },
    fresh ? { state: fresh.state as BotState, data: fresh.data as unknown as BotData } : null,
    await botShop(),
    {
      order,
      link: () => createLink(m.waId),
      newId: () => uuidv7(),
      trackUrl: (orderId, phone) => `${SITE_URL}${trackPath(orderId, phone)}`,
      websiteText: (t) => `🌐 Website par order karein — aapka naam aur number pehle se bhara hoga:\n${orderLinkUrl(t)}`,
    },
  );
  // Another message for this customer saved first (two taps at once): its answer stands, this one is dropped.
  if (!(await writeSession(m.waId, step.state, step.data as unknown as Record<string, unknown>, session ? session.version : null))) return;
  for (const message of step.out) await send(message);
}
