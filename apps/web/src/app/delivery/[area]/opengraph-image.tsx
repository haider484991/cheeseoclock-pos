import { brandOgImage, OG_SIZE } from '@/lib/og';
import { getArea, etaText } from '@/lib/areas';

export const runtime = 'edge';
export const alt = "Cheese O'Clock delivery area";
export const size = OG_SIZE;
export const contentType = 'image/png';

export default async function Image({ params }: { params: { area: string } }) {
  const area = getArea(params.area);

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
      ? `PIZZA & BURGER DELIVERY — HOT IN ${etaText(area).toUpperCase()}`
      : 'PIZZA & BURGER DELIVERY',
    fontData,
  });
}
