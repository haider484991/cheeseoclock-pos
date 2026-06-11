import type { Metadata, Viewport } from 'next';
import { Bebas_Neue, Inter } from 'next/font/google';
import { JsonLd, restaurantNode, webSiteNode, SITE_URL } from '@/lib/seo';
import './globals.css';

const display = Bebas_Neue({
  weight: '400',
  subsets: ['latin'],
  variable: '--font-display',
  display: 'swap',
});

const sans = Inter({
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
    'Oven-fresh signature pizzas & loaded smash burgers delivered across DHA Phases 1–8, Clifton & Gizri. Cash on delivery, open daily till 2am. Order online or on WhatsApp.',
  alternates: { canonical: './' },
  openGraph: {
    title: "Cheese O'Clock — Pizza & Burger Delivery in DHA Karachi",
    description:
      'Signature cheese-pull pizzas and smash burgers, hot at your door in 30–45 minutes. Cash on delivery across DHA & Clifton, open till 2am.',
    url: SITE_URL,
    siteName: "Cheese O'Clock",
    locale: 'en_PK',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: "Cheese O'Clock — Pizza & Burger Delivery in DHA Karachi",
    description:
      'Signature cheese-pull pizzas and smash burgers, hot at your door. Cash on delivery, open till 2am.',
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
    <html lang="en" className={`${display.variable} ${sans.variable}`}>
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
