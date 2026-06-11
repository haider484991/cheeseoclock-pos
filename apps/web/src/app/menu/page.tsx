import type { Metadata } from 'next';
import { SiteHeader, SiteFooter } from '@/components/SiteChrome';
import { OrderingApp } from '@/components/OrderingApp';
import { BUSINESS } from '@/lib/business';
import { sql } from '@/lib/db';
import type { PublishedMenu } from '@cheeseoclock/shared-types';

export const metadata: Metadata = {
  title: 'Menu — Order Online',
  description:
    'Browse our oven-fresh pizzas, loaded burgers and sides. Order online for cash on delivery in DHA Karachi.',
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
            <h1 className="mt-4 text-2xl font-black">Menu coming right up</h1>
            <p className="mt-2 text-stone-500">
              We&rsquo;re still loading today&rsquo;s menu. In the meantime, order
              directly on WhatsApp — we reply fast.
            </p>
            <a
              href={BUSINESS.whatsappUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-6 inline-block rounded-2xl bg-gradient-to-b from-amber-400 to-amber-500 px-8 py-4 text-lg font-bold text-stone-900 shadow-lift transition-transform hover:scale-105"
            >
              💬 Order on WhatsApp
            </a>
          </div>
        )}
      </main>
      <SiteFooter />
    </>
  );
}
