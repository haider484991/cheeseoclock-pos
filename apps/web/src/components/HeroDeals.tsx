import { getHeroSlides } from '@/lib/site-facts';
import { HeroDealsClient } from './HeroDealsClient';

/**
 * The home hero's deals slider (the drawing and the turning:
 * HeroDealsClient). This server half reads the slides — the published
 * menu's deals by kind, with its prices and the user's photos
 * (lib/hero-deals) — on the page's own read. No deal on the menu, or the
 * menu unknown: no slider, and the hero is as it was.
 */
export async function HeroDeals() {
  const slides = await getHeroSlides();
  if (slides.length === 0) return null;
  return <HeroDealsClient slides={slides} />;
}
