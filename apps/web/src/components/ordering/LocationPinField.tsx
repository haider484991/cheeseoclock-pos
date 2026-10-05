'use client';

import { useRef, useState } from 'react';
import { parsePin, pinUrl, type LocationPin } from '@/lib/checkout-extras';

/**
 * "Pin my location" for a delivery (5 Oct 2026, lib/checkout-extras): one tap asks the phone where it is, and the
 * order carries a Google Maps link for the rider. Optional — the typed address is still what is required — and
 * nothing is remembered on the phone (a pin from last time would send the rider to the wrong place).
 *
 * The browser asks the customer first; a refusal, no GPS or a timeout just says so, and the order goes on
 * without a pin.
 */
export function LocationPinField({
  pin,
  onPin,
}: {
  pin: LocationPin | null;
  onPin: (pin: LocationPin | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  // A second tap while the phone is still looking is ignored; a late answer after "Remove" is dropped.
  const asking = useRef(0);

  function locate() {
    if (busy) return;
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setProblem('This browser can’t share a location — just type your address.');
      return;
    }
    const ask = ++asking.current;
    setBusy(true);
    setProblem(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (ask !== asking.current) return;
        setBusy(false);
        const p = parsePin({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracyM: pos.coords.accuracy });
        if (p) onPin(p);
        else setProblem('Your phone sent a location we can’t use — please type your address.');
      },
      (err) => {
        if (ask !== asking.current) return;
        setBusy(false);
        setProblem(
          err.code === err.PERMISSION_DENIED
            ? 'Location is blocked for this site. Allow it in your browser settings, or just type your address.'
            : 'Couldn’t find your location — try again, or just type your address.',
        );
      },
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 60_000 },
    );
  }

  function remove() {
    asking.current++;
    setBusy(false);
    setProblem(null);
    onPin(null);
  }

  return (
    <div>
      <p className="mb-1 block font-cond text-sm font-extrabold uppercase tracking-widest text-ink">
        Location pin <span className="font-semibold normal-case tracking-normal text-ink-muted">(optional)</span>
      </p>
      {pin ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border-2 border-ink bg-cheese/20 px-3.5 py-3">
          <span className="font-cond text-base font-extrabold uppercase tracking-wide text-ink">
            <span aria-hidden>📍 </span>Location pinned{pin.accuracyM ? ` · about ${pin.accuracyM} m` : ''}
          </span>
          <a
            href={pinUrl(pin)}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm font-semibold text-ink underline underline-offset-2"
          >
            Check it on the map
          </a>
          <button type="button" onClick={remove} className="text-sm font-semibold text-ink-muted underline underline-offset-2 hover:text-ink">
            Remove
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={locate}
          disabled={busy}
          aria-busy={busy}
          className="flex min-h-[3rem] w-full items-center justify-center gap-2 rounded-xl border-2 border-dashed border-ink/40 bg-white px-3.5 py-3 font-cond text-base font-bold uppercase tracking-wide text-ink transition-colors hover:border-ink disabled:cursor-wait disabled:opacity-70"
        >
          {busy ? (
            <>
              <span aria-hidden className="h-4 w-4 animate-spin rounded-full border-2 border-ink border-t-transparent" />
              Finding you…
            </>
          ) : (
            <>
              <span aria-hidden>📍</span> Pin my location for the rider
            </>
          )}
        </button>
      )}
      <span className={`mt-1 block text-xs leading-snug ${problem ? 'font-semibold text-red-700' : 'text-ink-muted'}`} role={problem ? 'alert' : undefined}>
        {problem ?? 'Stand where we should deliver and tap: the rider gets a map link. Your house & street are still needed.'}
      </span>
    </div>
  );
}
