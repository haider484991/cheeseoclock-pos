import type { Metadata, Viewport } from 'next';
import { Anton, Barlow, Barlow_Condensed } from 'next/font/google';
import { copyText } from '@/lib/delivery-facts';
import {
  SITE_DESCRIPTION,
  SITE_OG_DESCRIPTION,
  SITE_SHARE_TITLE,
  SITE_SHORT_DESCRIPTION,
  SITE_TITLE,
  SITE_TITLE_TEMPLATE,
} from '@/lib/page-copy';
import { JsonLd, restaurantNode, webSiteNode, SITE_URL } from '@/lib/seo';
import { MetaPixel } from '@/components/MetaPixel';
import { ShopContactProvider } from '@/components/ordering/ShopContext';
import { META_DOMAIN_VERIFICATION_METADATA } from '@/lib/meta-domain';
import { META_PIXEL_ID } from '@/lib/meta-pixel';
import { shopContactOf } from '@/lib/shop-facts';
import { getCopyFacts, getMenuFacts, getShopFacts, getSiteFacts } from '@/lib/site-facts';
import { SiteAnalytics } from '@/components/SiteAnalytics';
import { LocationGate } from '@/components/location/LocationGate';
import { BUSINESS } from '@/lib/business';
import { gateSlides } from '@/lib/gate-slides';
import './globals.css';

// The printed menu's type: Anton headlines, Barlow Condensed labels, Barlow body.
const display = Anton({
  weight: '400',
  subsets: ['latin'],
  variable: '--font-display',
  display: 'swap',
});

const cond = Barlow_Condensed({
  weight: ['600', '700', '800'],
  subsets: ['latin'],
  variable: '--font-cond',
  display: 'swap',
});

const sans = Barlow({
  weight: ['400', '500', '600', '700'],
  subsets: ['latin'],
  variable: '--font-sans',
  display: 'swap',
});

/**
 * The site's title, description and share blocks name the shop and its hours
 * from the owner's settings (lib/site-facts, one read per page shared with
 * the page itself; today's with none stored). Every page is ISR or dynamic,
 * and /_not-found is force-static, so this read never turns a static page
 * dynamic (verified with a build: pages-golden.test.ts, DEPLOY.md).
 */
export async function generateMetadata(): Promise<Metadata> {
  const facts = await getCopyFacts();
  const name = copyText('{name}', facts);
  return {
    metadataBase: new URL(SITE_URL),
    title: {
      default: copyText(SITE_TITLE, facts),
      template: copyText(SITE_TITLE_TEMPLATE, facts),
    },
    description: copyText(SITE_DESCRIPTION, facts),
    alternates: { canonical: './' },
    openGraph: {
      title: copyText(SITE_SHARE_TITLE, facts),
      description: copyText(SITE_OG_DESCRIPTION, facts),
      url: SITE_URL,
      siteName: name,
      locale: 'en_PK',
      type: 'website',
    },
    twitter: {
      card: 'summary_large_image',
      title: copyText(SITE_SHARE_TITLE, facts),
      description: copyText(SITE_SHORT_DESCRIPTION, facts),
    },
    robots: { index: true, follow: true },
    // Meta domain verification for cheeseoclock.net (lib/meta-domain): in <head> on every page.
    verification: META_DOMAIN_VERIFICATION_METADATA,
  };
}

export const viewport: Viewport = {
  themeColor: '#0C0A07',
  width: 'device-width',
  initialScale: 1,
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // The Restaurant node carries the owner's name, phone, address, hours and payments (lib/seo).
  const shop = await getShopFacts();
  // The landing location popup's areas and deals: the same one read as the page's (lib/site-facts).
  const [site, menu] = await Promise.all([getSiteFacts(), getMenuFacts()]);
  return (
    <html lang="en" className={`${display.variable} ${cond.variable} ${sans.variable}`}>
      <body className="font-sans">
        {/*
          The Meta Pixel (lib/meta-pixel), only when NEXT_PUBLIC_META_PIXEL_ID is set: with it unset
          nothing is mounted and every page is as before. First in the body, so its snippet has run
          before the page's own effects send their events.
        */}
        {META_PIXEL_ID !== null && <MetaPixel />}
        {/* The error screen (app/error.tsx, in the browser) gets the owner's name and numbers from here. */}
        <ShopContactProvider contact={shopContactOf(shop)}>{children}</ShopContactProvider>
        {/*
          The landing popup (components/location): Delivery or Pick-up and the area, under a deals banner.
          Client only and closed on the server, so no page's HTML changes; never on /track or /dashboard.
        */}
        <LocationGate
          zones={site.zones.map((z) => ({
            id: z.id,
            name: z.name,
            shortName: z.shortName,
            group: z.group,
            feeCents: z.feeCents,
            feeItemId: z.feeItemId,
            active: z.active,
          }))}
          slides={gateSlides(menu, { buy1Get1: site.buy1Get1 })}
          shop={{
            lat: BUSINESS.latitude,
            lng: BUSINESS.longitude,
            address: shop.profile.address.street,
            // "DHA Phase 6" out of the owner's "Rahat Commercial Area, DHA Phase 6, Karachi"; else that line's first part.
            pickupArea:
              shop.profile.address.areaLine.match(/DHA Phase \d+/i)?.[0] ?? shop.profile.address.areaLine.split(',')[0]!.trim(),
          }}
          pickupOffered={site.pickup?.offered ?? true}
        />
        {/* Film grain over everything — subtle, pointer-transparent. */}
        <div
          aria-hidden
          className="bg-noise pointer-events-none fixed inset-0 z-[90] opacity-[0.05] mix-blend-overlay"
        />
        <JsonLd nodes={[restaurantNode(shop), webSiteNode(shop)]} />
        {/* Google Analytics 4: page views and the ordering funnel (never the owner's /dashboard or a tracking page; lib/google-analytics). */}
        <SiteAnalytics />
      </body>
    </html>
  );
}
