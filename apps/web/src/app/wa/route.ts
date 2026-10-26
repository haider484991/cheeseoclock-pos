import { whatsappUrlWith } from '@/lib/shop-facts';
import { getShopFacts } from '@/lib/site-facts';

export const dynamic = 'force-dynamic';

/**
 * /wa — the printed QR codes' short link (26 Oct 2026, the user: "WhatsApp everywhere + QR"): WhatsApp to the shop's
 * order line with "menu" already typed, so one tap on Send starts the ordering bot (lib/whatsapp-bot). A short address
 * makes a coarser, easier-to-scan code, and the destination can change without reprinting (the /review pattern).
 */
export async function GET(): Promise<Response> {
  return Response.redirect(whatsappUrlWith(await getShopFacts(), 'menu'), 307);
}
