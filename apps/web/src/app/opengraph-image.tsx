import { hoursRange } from '@cheeseoclock/shared-types';
import { copyText, shopOf } from '@/lib/delivery-facts';
import { brandOgImage, OG_SIZE } from '@/lib/og';
import { OG_TITLE } from '@/lib/page-copy';
import { getCopyFacts } from '@/lib/site-facts';

export const runtime = 'edge';
export const alt =
  "Cheese O'Clock — Pizza & Burger Delivery in DHA Karachi";
export const size = OG_SIZE;
export const contentType = 'image/png';

export default async function Image() {
  // The shop's name and hours (the owner's settings; today's with none stored), read on request like
  // the area images'.
  const facts = await getCopyFacts();
  let fontData: ArrayBuffer | null = null;
  try {
    fontData = await fetch(
      new URL('./BebasNeue-Regular.ttf', import.meta.url),
    ).then((res) => res.arrayBuffer());
  } catch {
    // Render with the system fallback rather than failing the route.
  }

  return brandOgImage({
    title: copyText(OG_TITLE, facts).toUpperCase(),
    subtitle: 'PIZZA & BURGER DELIVERY — DHA KARACHI',
    hours: hoursRange(shopOf(facts).hours).toUpperCase(),
    fontData,
  });
}
