import { SITE_URL } from './seo';
import { sendText } from './whatsapp-send';
import { claimOrderUpdate, recordBotMessage, whatsappOrderOf } from './whatsapp-store';

/**
 * WhatsApp order updates (26 Oct 2026, the user picked "WhatsApp order updates"): a customer who ordered from
 * WhatsApp — through the bot or their personal link — hears on WhatsApp when the till takes the order, when it is
 * ready to collect or on its way, and when it is delivered or cancelled. Each status once (the till may push one twice).
 *
 * Only inside the 24 hours after the customer last wrote: a reply there is free and needs no template. Outside it the
 * update is skipped (a business-started message needs an approved template and a payment method; the shop has
 * neither). It needs WHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID; it never holds up or fails the till's call.
 */

export type UpdateStatus = 'accepted' | 'preparing' | 'ready' | 'out_for_delivery' | 'delivered' | 'cancelled';

/** WhatsApp's free reply window, less a margin for the message's own trip. */
const WINDOW_MS = 24 * 60 * 60_000 - 10 * 60_000;

/** The words for a status, or null for one the customer is not told of ("preparing"; "ready" on a delivery). */
export function updateWords(status: UpdateStatus, o: { fulfilment: string; number?: string | null }): string | null {
  const no = o.number ? ` #${o.number}` : '';
  switch (status) {
    case 'accepted':
      return `✅ The kitchen has your order${no} — it’s being made now 🍕`;
    case 'ready':
      return o.fulfilment === 'pickup' ? `🛍️ Your order${no} is ready — please collect it from the shop.` : null;
    case 'out_for_delivery':
      return `🛵 Your order${no} is on its way with our rider — it’ll be with you shortly.`;
    case 'delivered':
      // The Google review ask (26 Oct 2026, the user: "Google reviews after delivery"): the site's /review short link
      // opens the listing's "write a review" page (next.config.mjs).
      return [
        'Thank you! We hope you enjoyed it 🧀',
        `Got a minute? A Google review helps us a lot ⭐ ${SITE_URL}/review`,
        'Next time, just type *menu* here to order.',
      ].join('\n');
    case 'cancelled':
      return `Sorry, your order${no} was cancelled. Any questions? Message us here.`;
    default:
      return null;
  }
}

/** Tells the order's WhatsApp customer of its new status. Never throws. */
export async function tellWhatsappCustomer(
  orderId: string,
  status: UpdateStatus,
  extra: { number?: string | null } = {},
  now: Date = new Date(),
): Promise<'sent' | 'skipped' | 'failed'> {
  const token = process.env['WHATSAPP_ACCESS_TOKEN'];
  const phoneNumberId = process.env['WHATSAPP_PHONE_NUMBER_ID'];
  if (!token || !phoneNumberId) return 'skipped';
  try {
    const order = await whatsappOrderOf(orderId);
    if (!order || now.getTime() - order.lastInAt.getTime() > WINDOW_MS) return 'skipped';
    const words = updateWords(status, { fulfilment: order.fulfilment, number: extra.number ?? null });
    if (!words || !(await claimOrderUpdate(orderId, status))) return 'skipped';
    const sent = await sendText({ phoneNumberId, to: order.waId, body: words, token });
    if (!sent.ok) {
      console.error('whatsapp order update not sent', status, sent.error);
      return 'failed';
    }
    await recordBotMessage({ messageId: sent.messageId, waId: order.waId, at: new Date() });
    return 'sent';
  } catch (e) {
    console.error('whatsapp order update failed', e);
    return 'failed';
  }
}
