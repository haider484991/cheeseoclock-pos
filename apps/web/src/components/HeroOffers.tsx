import Link from 'next/link';
import { heroOffers } from '@/lib/hero-deals';
import { getHeroSlides } from '@/lib/site-facts';

/**
 * The home hero's offers in a line (3 Nov 2026: everything in the hero, compact): one per kind of deal the deals
 * slider shows ("Burger deals from …", "20% off pizzas", "Buy 1 Get 1, 12–7 PM only"), each one tap from its place on
 * /menu (lib/hero-deals heroOffers). It reads the slides on the page's own read; none on the menu: nothing here.
 */
export async function HeroOffers({ className = '' }: { className?: string }) {
  const offers = heroOffers(await getHeroSlides());
  if (offers.length === 0) return null;
  return (
    <ul aria-label="Offers" className={`scrollbar-hide -mx-4 mt-5 flex w-[calc(100%+2rem)] gap-2 overflow-x-auto px-4 md:mx-0 md:w-full md:flex-wrap md:px-0 ${className}`}>
      {offers.map((o) => (
        <li key={o.key} className="shrink-0">
          <Link
            href={o.href}
            className="block whitespace-nowrap rounded-full border border-cheese/45 bg-cheese/10 px-3.5 py-2 font-cond text-sm font-bold uppercase tracking-wide text-cheese transition-colors hover:bg-cheese hover:text-ink"
          >
            {o.label}
          </Link>
        </li>
      ))}
    </ul>
  );
}
