import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  metadataBase: new URL('https://cheeseoclock.net'),
  title: {
    default: "Cheese O'Clock — Gourmet Pizza & Fast Food in DHA Karachi",
    template: "%s · Cheese O'Clock",
  },
  description:
    "Oven-fresh signature pizzas, loaded gourmet burgers and premium fast food in Phase 6, DHA Karachi. Order online for cash-on-delivery — it's always Cheese O'Clock.",
  keywords: [
    'pizza DHA Karachi',
    'fast food Phase 6',
    'pizza delivery Karachi',
    'Cheese O Clock',
    'burgers DHA',
  ],
  openGraph: {
    title: "Cheese O'Clock — Gourmet Pizza & Fast Food",
    description:
      'Order oven-fresh pizza and loaded burgers online. Cash on delivery in DHA, Karachi.',
    url: 'https://cheeseoclock.net',
    siteName: "Cheese O'Clock",
    locale: 'en_PK',
    type: 'website',
  },
};

export const viewport: Viewport = {
  themeColor: '#f59e0b',
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
