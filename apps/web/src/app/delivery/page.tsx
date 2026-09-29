import type { Metadata } from 'next';
import Link from 'next/link';
import { SiteHeader, SiteFooter } from '@/components/SiteChrome';
import { OrderCtaBand } from '@/components/OrderCtaBand';
import { WhatsAppFab } from '@/components/WhatsAppFab';
import { ShopMapCard } from '@/components/ShopMapCard';
import { Reveal } from '@/components/Reveal';
import { BUSINESS } from '@/lib/business';
import { DELIVERY_AREAS, coveredLandmarks, feeText } from '@/lib/areas';
import { copyText, shopOf } from '@/lib/delivery-facts';
import {
  DELIVERY_HUB_DESCRIPTION,
  DELIVERY_HUB_INTRO,
  HUB_LATE_LINK,
  HUB_MAP_TITLE,
  HUB_PAGE_DESCRIPTION,
  WA_HUB,
} from '@/lib/page-copy';
import { shopHoursLine } from '@/lib/shop-facts';
import { JsonLd, webPageNode } from '@/lib/seo';
import { getCopyFacts, requireStoredFacts } from '@/lib/site-facts';

/**
 * Static, refreshed from the owner's delivery settings (lib/site-facts): at
 * build, whenever a till publishes (api/bridge/menu revalidates), and at
 * least hourly. force-static keeps the settings read (a no-store fetch) from
 * turning the page dynamic.
 */
export const dynamic = 'force-static';
export const revalidate = 3600;

export async function generateMetadata(): Promise<Metadata> {
  const facts = await getCopyFacts();
  return {
    title: 'Food Delivery Areas in DHA & Clifton, Karachi',
    description: copyText(DELIVERY_HUB_DESCRIPTION, facts),
    alternates: { canonical: '/delivery' },
  };
}

export default async function DeliveryHubPage() {
  await requireStoredFacts();
  const facts = await getCopyFacts();
  const shop = shopOf(facts);
  return (
      <>
        <SiteHeader />
        <main>
          <section className="mx-auto max-w-6xl px-4 pb-16 pt-12">
            <nav aria-label="Breadcrumb" className="text-sm text-smoke">
              <Link href="/" className="hover:text-cheese">
                Home
              </Link>{' '}
              / <span className="text-cream/80">Delivery areas</span>
            </nav>
            <h1 className="mt-4 max-w-3xl font-display text-5xl tracking-wide text-cream md:text-7xl">
              FOOD DELIVERY AREAS IN DHA &amp; CLIFTON, KARACHI
            </h1>
            <p className="mt-5 max-w-2xl leading-relaxed text-smoke">
              {copyText(DELIVERY_HUB_INTRO, facts)}
            </p>

            <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {DELIVERY_AREAS.map((area, i) => {
                // A place the owner switched off is never listed as covered (areas.ts coveredLandmarks).
                const places = coveredLandmarks(area, facts).slice(0, 4);
                return (
                <Reveal key={area.slug} delay={(i % 3) * 60}>
                  <Link
                    href={`/delivery/${area.slug}`}
                    className="group block h-full rounded-2xl border border-white/10 bg-night-card p-5 transition-colors hover:border-cheese/50"
                  >
                    <div className="flex items-center justify-between gap-3">
                      <h2 className="text-lg font-bold text-cream">{area.name}</h2>
                      <span className="whitespace-nowrap rounded-full bg-cheese/15 px-3 py-1 text-xs font-bold text-cheese group-hover:bg-cheese group-hover:text-night">
                        🛵 {feeText(area, facts)}
                      </span>
                    </div>
                    {places.length > 0 && (
                      <p className="mt-2 line-clamp-2 text-sm text-smoke">{places.join(' · ')}</p>
                    )}
                    <p className="mt-3 text-sm font-bold text-cheese opacity-0 transition-opacity group-hover:opacity-100">
                      Delivery details →
                    </p>
                  </Link>
                </Reveal>
              );
            })}
          </div>

          <Reveal delay={100}>
            <div className="mt-12 grid gap-8 rounded-3xl border border-white/10 bg-night-soft p-6 md:grid-cols-2 md:p-8">
              <div>
                <h2 className="font-display text-3xl tracking-wide text-cream">
                  LOOKING FOR SOMETHING SPECIFIC?
                </h2>
                <ul className="mt-4 space-y-2 text-cream/80">
                  <li>
                    <Link href="/pizza-delivery-dha-karachi" className="font-semibold text-cheese hover:text-cheese-hot">
                      Pizza delivery in DHA Karachi →
                    </Link>
                  </li>
                  <li>
                    <Link href="/burger-delivery-dha-karachi" className="font-semibold text-cheese hover:text-cheese-hot">
                      Burger delivery in DHA Karachi →
                    </Link>
                  </li>
                  <li>
                    <Link href="/late-night-food-delivery-dha" className="font-semibold text-cheese hover:text-cheese-hot">
                      {copyText(HUB_LATE_LINK, facts)}
                    </Link>
                  </li>
                </ul>
                <p className="mt-6 text-sm leading-relaxed text-smoke">
                  {shop.profile.name} · {shop.profile.address.street}, {BUSINESS.locality}{' '}
                  · {shop.profile.phone.display} · {shopHoursLine(shop)}
                </p>
              </div>
              <ShopMapCard
                title={copyText(HUB_MAP_TITLE, facts)}
                zoom={12}
                heightClass="h-[320px]"
                className="rounded-2xl border border-white/10"
              />
            </div>
          </Reveal>
        </section>

        <OrderCtaBand
          heading="YOUR AREA'S ON THE LIST. ORDER UP."
          waMessage={copyText(WA_HUB, facts)}
        />
      </main>
      <SiteFooter />
      <WhatsAppFab />
      <JsonLd
        nodes={webPageNode({
          path: '/delivery',
          name: 'Food Delivery Areas in DHA & Clifton, Karachi',
          description: copyText(HUB_PAGE_DESCRIPTION, facts),
          breadcrumb: [
            { name: 'Home', path: '/' },
            { name: 'Delivery areas', path: '/delivery' },
          ],
        })}
      />
    </>
  );
}
