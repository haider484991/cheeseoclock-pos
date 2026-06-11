import type { Metadata } from 'next';
import { SiteHeader, SiteFooter } from '@/components/SiteChrome';
import { OrderTracker } from '@/components/OrderTracker';

export const metadata: Metadata = {
  title: 'Track your order',
  robots: { index: false, follow: false },
};

export default function TrackPage({ params }: { params: { id: string } }) {
  return (
    <>
      <SiteHeader />
      <main className="mx-auto max-w-lg px-4 py-10">
        <OrderTracker orderId={params.id} />
      </main>
      <SiteFooter />
    </>
  );
}
