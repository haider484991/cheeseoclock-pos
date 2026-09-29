'use client';

import { useState } from 'react';
import { BUSINESS } from '@/lib/business';

/**
 * Where the kitchen is, drawn by the site itself, with Google's live map one
 * tap away.
 *
 * The Google embed used to load straight away, and on a flaky connection it
 * left a grey "www.google.com unexpectedly closed the connection" box on the
 * page (partner, 27 Sep 2026, on /delivery). A cross-origin frame's failure
 * can't be detected, so the page no longer depends on it: this card always
 * renders (pin, address, hours, "Open in Google Maps"), and the embed loads
 * only when someone asks for it.
 *
 * The client half of ShopMapCard (the server half reads the shop's name,
 * street address and hours from the owner's settings and passes them in).
 */
export function ShopMapCardClient({
  title,
  zoom = 15,
  heightClass = 'h-[320px]',
  className = '',
  name,
  street,
  hoursLine,
}: {
  /** The embed's accessible title, once it is shown. */
  title: string;
  zoom?: number;
  heightClass?: string;
  className?: string;
  /** The shop's name, street address and hours line (lib/shop-facts). */
  name: string;
  street: string;
  hoursLine: string;
}) {
  const [showMap, setShowMap] = useState(false);
  const embedSrc = `https://maps.google.com/maps?q=${BUSINESS.latitude},${BUSINESS.longitude}&z=${zoom}&output=embed`;

  if (showMap) {
    return (
      <div className={`relative overflow-hidden bg-ink ${heightClass} ${className}`}>
        <iframe
          title={title}
          src={embedSrc}
          width="600"
          height="380"
          loading="lazy"
          referrerPolicy="no-referrer-when-downgrade"
          className="h-full w-full border-0"
        />
        <a
          href={BUSINESS.mapsUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="absolute bottom-3 left-3 rounded-full bg-ink/90 px-4 py-2 font-cond text-sm font-bold uppercase tracking-wide text-cheese shadow-lg transition-colors hover:bg-ink"
        >
          Map not loading? Open in Google Maps →
        </a>
      </div>
    );
  }

  return (
    <div
      className={`relative flex flex-col items-center justify-center overflow-hidden bg-ink px-6 text-center ${heightClass} ${className}`}
    >
      {/* A street grid, drawn in CSS: reads as "map" without loading one. */}
      <div
        aria-hidden
        className="absolute inset-0 opacity-[0.16] [background-image:repeating-linear-gradient(0deg,#F5B301_0_1px,transparent_1px_46px),repeating-linear-gradient(90deg,#F5B301_0_1px,transparent_1px_46px)]"
      />
      <div
        aria-hidden
        className="absolute inset-0 opacity-[0.1] [background-image:repeating-linear-gradient(35deg,#FAF5EA_0_3px,transparent_3px_160px)]"
      />
      <div
        aria-hidden
        className="absolute inset-0 bg-[radial-gradient(circle_at_50%_42%,rgba(245,179,1,0.22),transparent_55%)]"
      />

      <div className="relative">
        <span aria-hidden className="relative mx-auto flex h-14 w-14 items-center justify-center">
          <span className="absolute inset-0 animate-ping rounded-full bg-cheese/40 [animation-iteration-count:3]" />
          <svg viewBox="0 0 24 24" className="relative h-12 w-12 fill-cheese drop-shadow-[0_6px_16px_rgba(245,179,1,0.45)]">
            <path d="M12 2a7 7 0 0 0-7 7c0 5.2 7 13 7 13s7-7.8 7-13a7 7 0 0 0-7-7Zm0 9.6A2.6 2.6 0 1 1 12 6.4a2.6 2.6 0 0 1 0 5.2Z" />
          </svg>
        </span>
        <p className="mt-3 font-display text-2xl uppercase tracking-wide text-cream">{name}</p>
        <address className="mx-auto mt-1 max-w-sm text-sm not-italic leading-relaxed text-cream/70">
          {street}, {BUSINESS.locality}
        </address>
        <p className="mt-1 text-xs text-cream/50">{hoursLine}</p>
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
          <a
            href={BUSINESS.mapsUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-full bg-cheese px-5 py-2.5 font-cond text-base font-bold uppercase tracking-wide text-ink transition-colors hover:bg-cheese-hot"
          >
            Open in Google Maps →
          </a>
          <button
            type="button"
            onClick={() => setShowMap(true)}
            className="rounded-full border border-cream/25 px-5 py-2.5 font-cond text-base font-bold uppercase tracking-wide text-cream transition-colors hover:border-cheese hover:text-cheese"
          >
            Show the map here
          </button>
        </div>
      </div>
    </div>
  );
}
