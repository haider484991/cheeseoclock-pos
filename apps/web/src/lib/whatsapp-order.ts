import { POST as placeOrder } from '@/app/api/orders/route';
import type { OrderAnswer } from './whatsapp-bot';

/**
 * The bot's orders go through the website's own checkout route (api/orders) in this process: the same checks, the
 * same prices, the same row for the till. Its answer as the bot reads it. Used by the WhatsApp webhook (a customer's
 * message) and the till's order pull (lib/whatsapp-bot-run remindWaitingOrders).
 */
export async function orderInProcess(body: Record<string, unknown>): Promise<OrderAnswer> {
  const res = await placeOrder(
    new Request('https://www.cheeseoclock.net/api/orders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
  const json = (await res.json().catch(() => null)) as {
    ok?: boolean;
    error?: string;
    message?: string;
    details?: Record<string, string[] | undefined>;
    data?: Extract<OrderAnswer, { ok: true }>;
  } | null;
  if (json?.ok && json.data) return { ...json.data, ok: true };
  const detail = json?.details ? Object.values(json.details).flat().filter(Boolean)[0] : undefined;
  return { ok: false, error: json?.error ?? `http_${res.status}`, ...(json?.message || detail ? { message: json?.message ?? detail } : {}) };
}
