import { getHeroSlides } from '@/lib/site-facts';
import { HeroDeals } from './HeroDeals';

/**
 * The home page's deals, straight under its hero (3 Nov 2026; the user, 14 Oct 2026: a slider of every deal): the
 * slider (HeroDeals) under its heading. No deal on the menu, or the menu unknown: no section.
 */
export async function TodaysDeals({ heading }: { heading: string }) {
  if ((await getHeroSlides()).length === 0) return null;
  return (
    <section className="border-t border-white/5 bg-night pb-14 pt-12 md:pb-20 md:pt-16">
      <div className="mx-auto max-w-6xl px-4">
        <h2 className={heading}>Today&rsquo;s deals</h2>
      </div>
      <HeroDeals />
    </section>
  );
}
