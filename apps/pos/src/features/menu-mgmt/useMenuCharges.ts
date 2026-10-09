import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { DELIVERY_CHARGE_TAX_NAME, deliveryZoneFeeItemIds, isDeliveryChargeMenuItem } from '@cheeseoclock/shared-types';
import { ipc } from '../../ipc/client';
import { useDeliveryAreas } from '../settings/shop-rules/useShopSetting';
import { menuWithoutCharges } from './menuLists';

/**
 * Menu's lists without the delivery charges (the owner, 10 Oct 2026: "i want
 * to remove menu delivery charges only"; menuLists menuWithoutCharges): the
 * items Menu shows, the categories that hold nothing but charges, and how
 * many charges were left out. The same cache as the Items and Categories
 * tabs.
 */
export function useMenuWithoutCharges() {
  const itemsQ = useQuery({ queryKey: ['menu', 'items', 'all'], queryFn: () => ipc.menu.listItems() });
  const areas = useDeliveryAreas();
  const shown = useMemo(() => {
    const feeIds = deliveryZoneFeeItemIds(areas.zones);
    return menuWithoutCharges(itemsQ.data ?? [], (i) => isDeliveryChargeMenuItem(i, feeIds));
  }, [itemsQ.data, areas]);
  return { itemsQ, ...shown };
}

/**
 * A food item's tax choices: every tax but "Delivery charge tax" (Settings →
 * Tax on the delivery charge keeps the charges on it, and re-rates it), unless
 * the item is on it already. It also never becomes a new item's first pick.
 */
export function foodTaxChoices<T extends { id: string; name: string }>(taxes: readonly T[], current?: string | null): T[] {
  return taxes.filter((t) => t.name.trim().toLowerCase() !== DELIVERY_CHARGE_TAX_NAME.toLowerCase() || t.id === current);
}
