'use client';

import { createContext, useContext, type ReactNode } from 'react';
import { DEFAULT_SHOP_FACTS, shopContactOf, type ShopContact, type ShopFacts } from '@/lib/shop-facts';

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

/**
 * How to reach the shop, for every page's error screen (app/error.tsx runs in
 * the browser, inside the root layout, and can't read the database). The
 * root layout provides the owner's; without it: today's.
 */
const ShopContactContext = createContext<ShopContact>(shopContactOf(DEFAULT_SHOP_FACTS));

export function ShopContactProvider({ contact, children }: { contact: ShopContact; children: ReactNode }) {
  return <ShopContactContext.Provider value={contact}>{children}</ShopContactContext.Provider>;
}

export function useShopContact(): ShopContact {
  return useContext(ShopContactContext);
}
