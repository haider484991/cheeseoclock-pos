import type { Metadata } from 'next';
import Link from 'next/link';
import { SiteHeader, SiteFooter } from '@/components/SiteChrome';
import { orderLine, orderWhatsappUrl } from '@/lib/shop-facts';
import { getShopFacts } from '@/lib/site-facts';

/**
 * Static (/_not-found is built once and served for every unknown URL). The
 * root layout, the header and the footer read the shop's details from the
 * database like every page: force-static keeps that read from turning this
 * page dynamic — it takes the details at build (and again when a publish
 * revalidates the site).
 */
export const dynamic = 'force-static';

export const metadata: Metadata = {
  title: 'Page not found',
  robots: { index: false, follow: true },
};

/** Any unknown URL: say so plainly and put the menu one tap away. */
export default async function NotFound() {
  const shop = await getShopFacts();
  return (
    <>
      <SiteHeader />
      <main className="mx-auto flex min-h-[60vh] max-w-xl flex-col items-center justify-center px-4 py-16 text-center">
        <p className="font-cond text-sm font-bold uppercase tracking-[0.24em] text-cheese">404</p>
        <h1 className="mt-2 font-display text-5xl uppercase leading-none tracking-wide text-cream md:text-6xl">
          This page went cold
        </h1>
        <p className="mt-4 text-cream/70">
          The link may be old or mistyped. The menu is still hot — order online, or send us a message.
        </p>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <Link
            href="/menu"
            className="rounded-full bg-cheese px-8 py-3.5 font-display text-xl uppercase tracking-wide text-night shadow-glow transition-all hover:bg-cheese-hot active:scale-95"
          >
            See the menu →
          </Link>
          <a
            href={orderWhatsappUrl(shop)}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-full border border-cream/25 px-6 py-3.5 font-cond text-lg font-bold uppercase tracking-wide text-cream transition-colors hover:border-cheese hover:text-cheese"
          >
            WhatsApp {orderLine(shop).display}
          </a>
        </div>
        <Link href="/" className="mt-6 text-sm font-semibold text-smoke underline underline-offset-4 hover:text-cheese">
          Back to the home page
        </Link>
      </main>
      <SiteFooter />
    </>
  );
}
