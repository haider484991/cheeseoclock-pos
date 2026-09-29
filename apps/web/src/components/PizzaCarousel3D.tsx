import { getHomeView, getShopFacts } from '@/lib/site-facts';
import { PizzaCarousel3DClient } from './PizzaCarousel3DClient';

/**
 * The home hero's 3D turntable (the drawing and the turning:
 * PizzaCarousel3DClient). This server half reads the featured pizzas (the
 * owner's lineup on the published menu, with its prices: lib/home-lineup,
 * sweep B2) and the shop's name; its props are the hero's, as before. No
 * featured pizza on the menu: no turntable.
 */
export async function PizzaCarousel3D({ className = '' }: { className?: string }) {
  const [view, shop] = await Promise.all([getHomeView(), getShopFacts()]);
  if (view.pizzas.length === 0) return null;
  const pizzas = view.pizzas.map(({ key, name, size, kind, href, hook, image, shopPhoto, priceCents, pickupOnly }) => ({
    key,
    name,
    size,
    kind,
    href,
    hook,
    image,
    shopPhoto,
    priceCents,
    pickupOnly,
  }));
  return <PizzaCarousel3DClient className={className} pizzas={pizzas} shopName={shop.profile.name} />;
}
