import { brandOgImage, OG_SIZE } from '@/lib/og';

export const runtime = 'edge';
export const alt =
  "Cheese O'Clock — Pizza & Burger Delivery in DHA Karachi";
export const size = OG_SIZE;
export const contentType = 'image/png';

export default async function Image() {
  let fontData: ArrayBuffer | null = null;
  try {
    fontData = await fetch(
      new URL('./BebasNeue-Regular.ttf', import.meta.url),
    ).then((res) => res.arrayBuffer());
  } catch {
    // Render with the system fallback rather than failing the route.
  }

  return brandOgImage({
    title: "IT'S ALWAYS CHEESE O'CLOCK.",
    subtitle: 'PIZZA & BURGER DELIVERY — DHA KARACHI',
    fontData,
  });
}
