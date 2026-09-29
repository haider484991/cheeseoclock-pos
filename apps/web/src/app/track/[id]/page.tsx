import type { Metadata } from 'next';
import { SiteHeader, SiteFooter } from '@/components/SiteChrome';
import { OrderTracker } from '@/components/OrderTracker';
import { getShopFacts } from '@/lib/site-facts';

export const metadata: Metadata = {
  title: 'Track your order',
  robots: { index: false, follow: false },
};

/** The tracker (client) gets the shop's details from the server: its name, address and numbers. */
export default async function TrackPage({ params }: { params: { id: string } }) {
  const shop = await getShopFacts();
  return (
    <>
      <SiteHeader />
      <main className="mx-auto max-w-lg px-4 py-10">
        <OrderTracker orderId={params.id} shop={shop} />
      </main>
      <SiteFooter />
    </>
  );
}
