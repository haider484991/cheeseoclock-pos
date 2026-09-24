import type { Metadata, Viewport } from 'next';
import { Anton, Barlow, Barlow_Condensed } from 'next/font/google';
import { JsonLd, restaurantNode, webSiteNode, SITE_URL } from '@/lib/seo';
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

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "Pizza & Burger Delivery in DHA Karachi | Cheese O'Clock",
    template: "%s · Cheese O'Clock",
  },
  description:
    'Signature pizzas, crispy chicken burgers and fries delivered across DHA Phases 1–8 and Clifton. Cash on delivery, open daily 12 noon – 1 am. Order online or on WhatsApp.',
  alternates: { canonical: './' },
  openGraph: {
    title: "Cheese O'Clock — Pizza & Burger Delivery in DHA Karachi",
    description:
      'Five signature pizzas, crispy chicken burgers and fries, fired to order in DHA Phase 6. Cash on delivery across DHA & Clifton, open 12 noon – 1 am.',
    url: SITE_URL,
    siteName: "Cheese O'Clock",
    locale: 'en_PK',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: "Cheese O'Clock — Pizza & Burger Delivery in DHA Karachi",
    description:
      'Signature pizzas, crispy chicken burgers and fries delivered across DHA & Clifton. Cash on delivery, open 12 noon – 1 am.',
  },
  robots: { index: true, follow: true },
};

export const viewport: Viewport = {
  themeColor: '#0C0A07',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${cond.variable} ${sans.variable}`}>
      <body className="font-sans">
        {children}
        {/* Film grain over everything — subtle, pointer-transparent. */}
        <div
          aria-hidden
          className="bg-noise pointer-events-none fixed inset-0 z-[90] opacity-[0.05] mix-blend-overlay"
        />
        <JsonLd nodes={[restaurantNode(), webSiteNode()]} />
      </body>
    </html>
  );
}
