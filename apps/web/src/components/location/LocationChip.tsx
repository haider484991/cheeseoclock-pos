'use client';

import { useEffect, useState } from 'react';
import { onLocationChoice, openLocationPicker, readLocationChoice, type LocationChoice } from '@/lib/location-choice';

/**
 * The header's "📍 Phase 6" (or "Pick-up"): the area the landing popup remembered
 * (components/location/LocationGate), and the way to change it. Nothing on the server or before the
 * page has mounted, so no page's HTML changes; "Set area" until a choice is made.
 */
export function LocationChip({ zones }: { zones: ReadonlyArray<{ id: string; shortName: string }> }) {
  const [mounted, setMounted] = useState(false);
  const [choice, setChoice] = useState<LocationChoice | null>(null);

  useEffect(() => {
    setMounted(true);
    setChoice(readLocationChoice());
    return onLocationChoice(setChoice);
  }, []);

  if (!mounted) return null;
  const label =
    choice?.fulfilment === 'pickup'
      ? 'Pick-up'
      : (zones.find((z) => z.id === choice?.zoneId)?.shortName ?? (choice ? 'Delivery' : 'Set area'));

  return (
    <button
      type="button"
      onClick={openLocationPicker}
      title="Change where we bring your order"
      className="flex max-w-[7.5rem] items-center gap-1 rounded-full border border-white/15 px-2.5 py-1.5 text-xs font-semibold text-cream/85 transition-colors hover:border-cheese hover:text-cheese"
    >
      <span aria-hidden>{choice?.fulfilment === 'pickup' ? '🛍️' : '📍'}</span>
      <span className="truncate">{label}</span>
    </button>
  );
}
