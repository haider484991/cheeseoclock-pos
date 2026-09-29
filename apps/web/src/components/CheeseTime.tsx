import { nameIsDefault, shopNameProse } from '@/lib/shop-facts';
import { getShopFacts } from '@/lib/site-facts';
import { CheeseTimeClient } from './CheeseTimeClient';

/**
 * The time-aware brand line (CheeseTimeClient). This server half reads the
 * owner's opening hours and the shop's name (lib/shop-facts; today's with
 * none stored); its props are the line's, as before.
 */
export async function CheeseTime({ className = '' }: { className?: string }) {
  const shop = await getShopFacts();
  return (
    <CheeseTimeClient
      className={className}
      hours={{ opens: shop.hours.opens, closes: shop.hours.closes, days: [...shop.hours.days] }}
      nameIsDefault={nameIsDefault(shop)}
      nameProse={shopNameProse(shop)}
    />
  );
}
