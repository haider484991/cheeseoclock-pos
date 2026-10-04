import { useQuery } from '@tanstack/react-query';
import { DEFAULT_DELIVERY_CITY } from '@cheeseoclock/shared-types';
import { ipc } from '../../ipc/client';

export const DELIVERY_CITY_QUERY = ['system', 'deliveryCity'] as const;

/**
 * The city this till writes on every delivery address (Settings → Delivery
 * areas → City; 'delivery.city'). Until it has loaded, the default — the
 * same city tills from before v0.8 always wrote.
 */
export function useDeliveryCity(): string {
  const q = useQuery({
    queryKey: DELIVERY_CITY_QUERY,
    queryFn: () => ipc.system.getDeliveryCity(),
    staleTime: 5 * 60_000,
  });
  return q.data?.city ?? DEFAULT_DELIVERY_CITY;
}
