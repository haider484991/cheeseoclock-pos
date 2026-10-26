import { hoursRange } from '@cheeseoclock/shared-types';
import { copyText, shopOf } from '@/lib/delivery-facts';
import { brandOgImage, OG_SIZE } from '@/lib/og';
import { bebasNeueFont } from '@/lib/og-font';
import { OG_TITLE } from '@/lib/page-copy';
import { getCopyFacts } from '@/lib/site-facts';

// Node, as every other route (27 Oct 2026): the database client is TCP now, and Cloudflare's adapter takes no Edge routes.
export const alt =
  "Cheese O'Clock — Pizza & Burger Delivery in DHA Karachi";
export const size = OG_SIZE;
export const contentType = 'image/png';

export default async function Image() {
  // The shop's name and hours (the owner's settings; today's with none stored), read on request like
  // the area images'.
  const facts = await getCopyFacts();

  return brandOgImage({
    title: copyText(OG_TITLE, facts).toUpperCase(),
    subtitle: 'PIZZA & BURGER DELIVERY — DHA KARACHI',
    hours: hoursRange(shopOf(facts).hours).toUpperCase(),
    fontData: bebasNeueFont(),
  });
}
