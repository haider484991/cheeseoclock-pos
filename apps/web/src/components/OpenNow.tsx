import { shopHoursLine } from '@/lib/shop-facts';
import { getShopFacts } from '@/lib/site-facts';
import { OpenNowClient } from './OpenNowClient';

/**
 * Whether the kitchen takes orders right now (OpenNowClient). This server half reads the owner's opening hours
 * (lib/shop-facts; today's with none stored): the line the page is served with, and the hours the client half
 * works the closed wording out from.
 */
export async function OpenNow({ className = '' }: { className?: string }) {
  const shop = await getShopFacts();
  return (
    <OpenNowClient
      className={className}
      fallback={shopHoursLine(shop)}
      hours={{ opens: shop.hours.opens, closes: shop.hours.closes, days: [...shop.hours.days] }}
    />
  );
}
