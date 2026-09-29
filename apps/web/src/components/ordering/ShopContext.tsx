'use client';

import { createContext, useContext } from 'react';
import { DEFAULT_SHOP_FACTS, type ShopFacts } from '@/lib/shop-facts';

/**
 * The shop's details (lib/shop-facts) for the ordering page's deep parts —
 * the "ask on WhatsApp" link on a pick-up-only card, the checkout's pick-up
 * address, allergy notice and WhatsApp links. OrderingApp provides the ones
 * the server read; without a provider (a component rendered on its own):
 * today's details.
 */
export const ShopFactsContext = createContext<ShopFacts>(DEFAULT_SHOP_FACTS);

export function useShopFacts(): ShopFacts {
  return useContext(ShopFactsContext);
}
