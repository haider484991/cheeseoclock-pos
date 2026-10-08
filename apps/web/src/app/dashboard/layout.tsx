import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

/**
 * The owner's phone dashboard (shared-types dashboard.ts): private pages
 * behind their own sign-in. Never in a search engine (noindex here, and the
 * X-Robots-Tag header next.config sets for /dashboard), never cached, no
 * Meta Pixel and no page views counted (lib/meta-pixel, SiteAnalytics). Its
 * own home-screen app: "Add to Home Screen" from any dashboard page opens it.
 */
export const metadata: Metadata = {
  title: { default: 'Dashboard', template: '%s · Dashboard' },
  robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } },
  manifest: '/dashboard/manifest.webmanifest',
  appleWebApp: { capable: true, title: 'Dashboard', statusBarStyle: 'black-translucent' },
  alternates: { canonical: null },
  openGraph: null,
  twitter: null,
};

export const viewport: Viewport = {
  themeColor: '#151412',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return <div className="dash min-h-dvh bg-dash-page font-sans text-[15px] text-dash-ink antialiased">{children}</div>;
}
