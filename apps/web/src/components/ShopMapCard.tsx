import { shopHoursLine } from '@/lib/shop-facts';
import { getShopFacts } from '@/lib/site-facts';
import { ShopMapCardClient } from './ShopMapCardClient';

/**
 * Where the kitchen is, with Google's live map one tap away (the drawing and
 * the map: ShopMapCardClient). This server half reads the shop's name,
 * street address and hours from the owner's settings (lib/shop-facts;
 * today's with none stored); its props are the card's, as before.
 */
export async function ShopMapCard(props: {
  /** The embed's accessible title, once it is shown. */
  title: string;
  zoom?: number;
  heightClass?: string;
  className?: string;
}) {
  const shop = await getShopFacts();
  return (
    <ShopMapCardClient
      {...props}
      name={shop.profile.name}
      street={shop.profile.address.street}
      hoursLine={shopHoursLine(shop)}
    />
  );
}
