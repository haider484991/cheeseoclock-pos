import type { Metadata } from 'next';
import { SiteHeader, SiteFooter } from '@/components/SiteChrome';
import { OrderingApp } from '@/components/OrderingApp';
import { BUSINESS, WA_ORDER_URL } from '@/lib/business';
import { sql } from '@/lib/db';
import { JsonLd, menuNode, webPageNode } from '@/lib/seo';
import type { PublishedMenu } from '@cheeseoclock/shared-types';

export const metadata: Metadata = {
  title: 'Menu & Prices — Pizza, Burgers, Sides',
  description:
    "Full Cheese O'Clock menu with prices in PKR — signature pizzas, smash burgers, wings, fries & shakes. Order online for cash-on-delivery across DHA Karachi.",
  alternates: { canonical: '/menu' },
};

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';
export const revalidate = 0;

async function loadMenu(): Promise<PublishedMenu | null> {
  try {
    const rows = (await sql()`
      SELECT menu_json FROM site_menu WHERE id = 1
    `) as Array<{ menu_json: PublishedMenu }>;
    return rows[0]?.menu_json ?? null;
  } catch (e) {
    console.error('menu load failed', e);
    return null;
  }
}

export default async function MenuPage() {
  const menu = await loadMenu();

  return (
    <>
      <SiteHeader />
      <main className="mx-auto max-w-6xl px-4 py-8">
        {menu ? (
          <OrderingApp menu={menu} />
        ) : (
          <div className="mx-auto max-w-md py-24 text-center">
            <div className="text-6xl">🧀</div>
            <h1 className="mt-4 font-display text-4xl tracking-wide text-cream">
              MENU COMING RIGHT UP
            </h1>
            <p className="mt-2 text-smoke">
              We&rsquo;re still loading today&rsquo;s menu. In the meantime,
              order directly on WhatsApp — we reply fast.
            </p>
            <a
              href={WA_ORDER_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-6 inline-block rounded-full bg-cheese px-8 py-4 font-display text-xl tracking-wide text-night shadow-glow transition-transform hover:scale-105"
            >
              💬 ORDER ON WHATSAPP
            </a>
            <p className="mt-4 text-sm text-smoke">
              {BUSINESS.hours} · {BUSINESS.phoneDisplay}
            </p>
          </div>
        )}
      </main>
      <SiteFooter />
      <JsonLd
        nodes={[
          ...webPageNode({
            path: '/menu',
            name: "Cheese O'Clock Menu & Prices",
            description:
              'Full menu with prices in PKR — pizzas, burgers, wings, fries and shakes, delivered across DHA Karachi.',
            breadcrumb: [
              { name: 'Home', path: '/' },
              { name: 'Menu', path: '/menu' },
            ],
          }),
          ...(menu ? [menuNode(menu)] : []),
        ]}
      />
    </>
  );
}
