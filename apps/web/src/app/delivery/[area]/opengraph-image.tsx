import { hoursRange } from '@cheeseoclock/shared-types';
import { brandOgImage, OG_SIZE } from '@/lib/og';
import { getArea, feeText } from '@/lib/areas';
import { shopOf } from '@/lib/delivery-facts';
import { getCopyFacts } from '@/lib/site-facts';

export const runtime = 'edge';
export const alt = "Cheese O'Clock delivery area";
export const size = OG_SIZE;
export const contentType = 'image/png';

export default async function Image({ params }: { params: { area: string } }) {
  const area = getArea(params.area);
  // The owner's fees (the stored settings block), else the built-in ones, and the shop's hours; rendered on request.
  const facts = await getCopyFacts();

  let fontData: ArrayBuffer | null = null;
  try {
    fontData = await fetch(
      new URL('../../BebasNeue-Regular.ttf', import.meta.url),
    ).then((res) => res.arrayBuffer());
  } catch {
    // Render with the system fallback rather than failing the route.
  }

  return brandOgImage({
    title: area ? area.name.toUpperCase() : 'DHA KARACHI',
    subtitle: area
      ? `PIZZA & BURGER DELIVERY — ${feeText(area, facts).toUpperCase()}`
      : 'PIZZA & BURGER DELIVERY',
    hours: hoursRange(shopOf(facts).hours).toUpperCase(),
    fontData,
  });
}
