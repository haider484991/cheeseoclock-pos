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
import { getCopyFacts, getShopFacts } from '@/lib/site-facts';
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
  return (
    <html lang="en" className={`${display.variable} ${cond.variable} ${sans.variable}`}>
      <body className="font-sans">
        {children}
        {/* Film grain over everything — subtle, pointer-transparent. */}
        <div
          aria-hidden
          className="bg-noise pointer-events-none fixed inset-0 z-[90] opacity-[0.05] mix-blend-overlay"
        />
        <JsonLd nodes={[restaurantNode(shop), webSiteNode(shop)]} />
      </body>
    </html>
  );
}
