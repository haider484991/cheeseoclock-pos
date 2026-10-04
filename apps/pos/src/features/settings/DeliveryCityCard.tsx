import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button, Card } from '@cheeseoclock/ui';
import { DEFAULT_DELIVERY_CITY, DELIVERY_CITY_MAX_CHARS } from '@cheeseoclock/shared-types';
import { MapPin } from 'lucide-react';
import { useTillSetting } from './shop-rules/useTillSetting';
import { DELIVERY_CITY_QUERY } from '../checkout/useDeliveryCity';

/**
 * The city on this till's delivery addresses ('delivery.city', this till
 * only). The area picker names the area; this names the city, once.
 */
export function DeliveryCityCard() {
  const s = useTillSetting('delivery.city');
  const qc = useQueryClient();
  const saved = s.q.data?.value ?? null;
  const [city, setCity] = useState('');
  useEffect(() => {
    if (saved !== null) setCity(saved);
  }, [saved]);
  const dirty = saved !== null && city.trim() !== saved;
  const refreshCounter = () => void qc.invalidateQueries({ queryKey: DELIVERY_CITY_QUERY });

  return (
    <Card>
      <div className="mb-2 flex items-center gap-2">
        <MapPin className="h-5 w-5" />
        <h2 className="text-lg font-semibold">City on delivery addresses</h2>
      </div>
      <p className="text-sm text-stone-600 dark:text-stone-300">
        Written on every delivery address this till saves, under the area. One city per till; set it on each till.
      </p>
      <div className="mt-3 flex flex-wrap items-end gap-2">
        <label className="block text-sm">
          <span className="mb-1 block text-xs font-medium text-stone-500">City</span>
          <input
            value={city}
            onChange={(e) => setCity(e.target.value)}
            maxLength={DELIVERY_CITY_MAX_CHARS}
            placeholder={DEFAULT_DELIVERY_CITY}
            disabled={saved === null}
            className="w-56 rounded-xl border border-stone-300 px-3 py-2 dark:border-stone-700 dark:bg-stone-800"
          />
        </label>
        <Button
          onClick={() => s.save.mutate(city.trim(), { onSuccess: refreshCounter })}
          disabled={!dirty || !city.trim() || s.save.isPending}
        >
          {s.save.isPending ? 'Saving…' : 'Save'}
        </Button>
        {saved !== null && saved !== DEFAULT_DELIVERY_CITY && (
          <button
            type="button"
            onClick={() => s.putBack.mutate(undefined, { onSuccess: refreshCounter })}
            className="text-sm text-stone-500 underline-offset-2 hover:underline"
          >
            Put back {DEFAULT_DELIVERY_CITY}
          </button>
        )}
      </div>
      {s.q.isError && <p className="mt-2 text-xs text-red-700">Could not load the city.</p>}
    </Card>
  );
}
