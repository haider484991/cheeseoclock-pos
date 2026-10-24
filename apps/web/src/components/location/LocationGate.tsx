'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { usePathname } from 'next/navigation';
import type { WebFulfilment } from '@cheeseoclock/shared-types';
import { parsePin, type LocationPin } from '@/lib/checkout-extras';
import { zoneOptionGroups, type FactZone } from '@/lib/delivery-facts';
import { formatCents } from '@/lib/format';
import type { GateLang, GateSlide, Words } from '@/lib/gate-slides';
import {
  LOCATION_OPEN_EVENT,
  dismissForThisVisit,
  freshPin,
  kmBetween,
  readLocationChoice,
  saveLocationChoice,
  shouldAsk,
  wasDismissedThisVisit,
} from '@/lib/location-choice';
import { LOCATION_EVENT_NAME, pixel } from '@/lib/meta-pixel';

/**
 * The landing popup (the user, 24 Oct 2026: "location selection when user landed on the website,
 * and the first thing should pop up that select location and confirm … the more serious buyers will
 * convert"), as Karachi customers know it from foodpanda and the big pizza chains: a deals banner on
 * top ("highly conversion and emotional attacking deals banner"), then Delivery or Pick-up, the area
 * (the owner's own, with its fee) or the phone's location, and Confirm.
 *
 * Never a wall: closing it ("Just browsing") leaves every page as it was, and it stays shut for this
 * visit; the checkout still asks. The choice is remembered (lib/location-choice), the menu opens on it
 * and the header's chip (LocationChip) reopens this to change it. Confirming sends Meta a
 * LocationConfirmed, from the browser and from the server with the same id (api/meta/event).
 *
 * Renders nothing on the server, so no page's HTML changes; it opens a moment after the page has
 * loaded, never on a tracking page or the owner's dashboard.
 */

export interface GateZone {
  id: string;
  name: string;
  shortName: string;
  group: string;
  feeCents: number;
  feeItemId: string | null;
  active: boolean;
}

export interface GateShop {
  lat: number;
  lng: number;
  /** The pick-up line: the owner's street address. */
  address: string;
}

/** Farther than this from the shop, the phone's location is "outside our areas". */
const NEAR_KM = 10;
/** The page settles first: the popup opens this long after it has loaded. */
const OPEN_DELAY_MS = 700;
/** Each deal slide stays this long. */
const SLIDE_MS = 3600;
const LANG_KEY = 'coc.lang';

const T = {
  title: { en: 'Where should we bring it?', ur: 'Order kahan chahiye?' },
  sub: { en: 'Choose once, we’ll remember it.', ur: 'Ek dafa chunein, hum yaad rakhenge.' },
  delivery: { en: 'Delivery', ur: 'Delivery' },
  pickup: { en: 'Pick-up', ur: 'Pick-up' },
  area: { en: 'Your area', ur: 'Aap ka area' },
  choose: { en: 'Choose your area…', ur: 'Apna area chunein…' },
  locate: { en: 'Use my current location', ur: 'Meri current location lein' },
  locating: { en: 'Finding you…', ur: 'Location dhoond rahe hain…' },
  confirm: { en: 'Confirm & see deals', ur: 'Confirm karein, deals dekhein' },
  browse: { en: 'Just browsing', ur: 'Abhi sirf dekh raha hoon' },
  collect: { en: 'Collect from', ur: 'Yahan se uthayein' },
  noPickup: { en: 'Pick-up isn’t available right now.', ur: 'Pick-up abhi available nahi.' },
  closed: { en: 'We’re closed right now: choose your area and browse the deals.', ur: 'Abhi band hain: area chun kar deals dekh lein.' },
  limited: { en: 'Limited time', ur: 'Limited time' },
  taxIn: { en: 'Tax included', ur: 'Tax shamil' },
  from: { en: 'from', ur: 'sirf' },
} satisfies Record<string, Words>;

const BRAND_LINES = 'Home-crafted premium sauces · Soft & crispy dough · Zero-leftover crust';

function newEventId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function readLang(): GateLang {
  try {
    return window.localStorage.getItem(LANG_KEY) === 'en' ? 'en' : 'ur';
  } catch {
    return 'ur';
  }
}

export function LocationGate({
  zones,
  slides,
  shop,
  pickupOffered,
}: {
  zones: readonly GateZone[];
  slides: readonly GateSlide[];
  shop: GateShop;
  /** The owner's settings offer pick-up at all; the till's live status decides the rest. */
  pickupOffered: boolean;
}) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [lang, setLang] = useState<GateLang>('ur');
  const [fulfilment, setFulfilment] = useState<WebFulfilment>('delivery');
  const [zoneId, setZoneId] = useState('');
  const [pin, setPin] = useState<{ pin: LocationPin; at: number } | null>(null);
  const [locating, setLocating] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [status, setStatus] = useState<{ accepting: boolean; pickup: boolean } | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const asking = useRef(0);
  const t = (w: Words) => w[lang];

  const begin = useCallback(() => {
    const saved = readLocationChoice();
    setFulfilment(saved?.fulfilment ?? 'delivery');
    setZoneId(saved?.zoneId ?? '');
    const p = freshPin(saved);
    setPin(p && saved?.pinAt ? { pin: p, at: saved.pinAt } : null);
    setProblem(null);
    setLang(readLang());
    setOpen(true);
  }, []);

  // By itself, once per visit, a moment after the page has loaded.
  useEffect(() => {
    if (!shouldAsk(pathname, readLocationChoice(), wasDismissedThisVisit())) return;
    const timer = window.setTimeout(begin, OPEN_DELAY_MS);
    return () => window.clearTimeout(timer);
    // Only the first page of a visit asks: a later page has the dismissal or the choice stored.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The header chip asks to change it.
  useEffect(() => {
    window.addEventListener(LOCATION_OPEN_EVENT, begin);
    return () => window.removeEventListener(LOCATION_OPEN_EVENT, begin);
  }, [begin]);

  // Open: the till's live status (pick-up on? taking orders?), the page held still, Escape closes.
  useEffect(() => {
    if (!open) return;
    let live = true;
    fetch('/api/store-status', { cache: 'no-store' })
      .then((r) => r.json())
      .then((j: { data?: { acceptingOrders?: unknown; pickupAvailable?: unknown } }) => {
        if (live && j?.data) setStatus({ accepting: j.data.acceptingOrders === true, pickup: j.data.pickupAvailable === true });
      })
      .catch(() => {});
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialogRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      live = false;
      document.body.style.overflow = overflow;
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!open) return null;

  const canPickup = pickupOffered && (status === null || status.pickup);
  const chosen: WebFulfilment = fulfilment === 'pickup' && canPickup ? 'pickup' : 'delivery';
  const zone = zones.find((z) => z.id === zoneId && z.active);
  const far = pin ? kmBetween(pin.pin, shop) : null;
  const ready = chosen === 'pickup' || zone !== undefined;

  function close() {
    dismissForThisVisit();
    setOpen(false);
  }

  function chooseLang(next: GateLang) {
    setLang(next);
    try {
      window.localStorage.setItem(LANG_KEY, next);
    } catch {
      // Not remembered: this visit only.
    }
  }

  function locate() {
    if (locating) return;
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setProblem(lang === 'en' ? 'This browser can’t share a location: choose your area.' : 'Yeh browser location nahi deta: area chun lein.');
      return;
    }
    const ask = ++asking.current;
    setLocating(true);
    setProblem(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (ask !== asking.current) return;
        setLocating(false);
        const p = parsePin({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracyM: pos.coords.accuracy });
        if (p) setPin({ pin: p, at: Date.now() });
        else setProblem(lang === 'en' ? 'We couldn’t use that location: choose your area.' : 'Yeh location kaam nahi aayi: area chun lein.');
      },
      (err) => {
        if (ask !== asking.current) return;
        setLocating(false);
        setProblem(
          err.code === err.PERMISSION_DENIED
            ? lang === 'en'
              ? 'Location is blocked for this site: choose your area instead.'
              : 'Location band hai: area list se chun lein.'
            : lang === 'en'
              ? 'Couldn’t find you: try again, or choose your area.'
              : 'Location nahi mili: dobara try karein ya area chunein.',
        );
      },
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 60_000 },
    );
  }

  function confirm() {
    if (!ready) return;
    const at = Date.now();
    saveLocationChoice({
      fulfilment: chosen,
      zoneId: chosen === 'delivery' ? (zone?.id ?? null) : null,
      pin: chosen === 'delivery' && pin ? pin.pin : null,
      pinAt: chosen === 'delivery' && pin ? pin.at : null,
      at,
    });
    if (pixel.enabled) {
      const eventId = newEventId();
      pixel.locationConfirmed({ fulfilment: chosen, zoneName: chosen === 'delivery' ? (zone?.name ?? null) : null }, eventId);
      fetch('/api/meta/event', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ event: LOCATION_EVENT_NAME, eventId, fulfilment: chosen, zoneId: chosen === 'delivery' ? zone?.id : null }),
        keepalive: true,
      }).catch(() => {});
    }
    setOpen(false);
  }

  const groups = zoneOptionGroups(zones as unknown as readonly FactZone[]);

  return (
    <div className="fixed inset-0 z-[80] flex items-end justify-center bg-black/70 backdrop-blur-[2px] sm:items-center" onClick={close}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="relative max-h-[96svh] w-full max-w-md overflow-y-auto rounded-t-3xl border border-night-edge bg-night-soft p-3 pb-4 text-cream shadow-2xl outline-none sm:rounded-3xl sm:p-4"
      >
        <div className="mb-2 flex items-center justify-between gap-2">
          <div className="flex overflow-hidden rounded-full border border-night-edge text-[11px] font-bold" role="group" aria-label="Language">
            {(['ur', 'en'] as const).map((l) => (
              <button
                key={l}
                type="button"
                onClick={() => chooseLang(l)}
                aria-pressed={lang === l}
                className={`px-2.5 py-1 ${lang === l ? 'bg-cheese text-night' : 'text-cream/70'}`}
              >
                {l === 'ur' ? 'Roman Urdu' : 'English'}
              </button>
            ))}
          </div>
          <button type="button" onClick={close} aria-label={t(T.browse)} className="rounded-full px-2 py-1 text-lg leading-none text-cream/60 hover:text-cream">
            ✕
          </button>
        </div>

        {slides.length > 0 && <DealSlides slides={slides} lang={lang} t={t} />}

        <p className="mt-1.5 truncate text-center font-cond text-[10.5px] font-bold uppercase tracking-[0.12em] text-cheese/80">{BRAND_LINES}</p>

        <h2 id={titleId} className="mt-3 font-display text-[26px] leading-none tracking-wide text-cream">
          {t(T.title)}
        </h2>
        <p className="mt-1 text-[13px] text-cream/60">{t(T.sub)}</p>

        <div className="mt-3 grid grid-cols-2 gap-1 rounded-2xl bg-night p-1" role="radiogroup" aria-label={`${t(T.delivery)} / ${t(T.pickup)}`}>
          {(['delivery', 'pickup'] as const).map((f) => {
            const off = f === 'pickup' && !canPickup;
            return (
              <button
                key={f}
                type="button"
                role="radio"
                aria-checked={chosen === f}
                disabled={off}
                onClick={() => setFulfilment(f)}
                className={`rounded-xl py-2.5 font-cond text-[15px] font-extrabold uppercase tracking-wide transition-colors ${
                  chosen === f ? 'bg-cheese text-night' : off ? 'text-cream/30' : 'text-cream/80 hover:bg-white/5'
                }`}
              >
                {f === 'delivery' ? `🛵 ${t(T.delivery)}` : `🛍️ ${t(T.pickup)}`}
              </button>
            );
          })}
        </div>
        {fulfilment === 'pickup' && !canPickup && <p className="mt-1.5 text-[12px] text-cream/60">{t(T.noPickup)}</p>}

        {chosen === 'delivery' ? (
          <div className="mt-3">
            <label className="sr-only" htmlFor={`${titleId}-area`}>
              {t(T.area)}
            </label>
            <select
              id={`${titleId}-area`}
              value={zone ? zone.id : ''}
              onChange={(e) => setZoneId(e.target.value)}
              className="w-full rounded-xl border border-night-edge bg-night px-3 py-3 text-[15px] font-semibold text-cream focus:border-cheese focus:outline-none"
            >
              <option value="">{t(T.choose)}</option>
              {groups.map((g) => (
                <optgroup key={g.group} label={g.group}>
                  {g.options.map((o) => (
                    <option key={o.id} value={o.id} disabled={o.disabled}>
                      {o.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
            <div className="mt-2 flex min-h-[22px] flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[13px]">
              <button type="button" onClick={locate} disabled={locating} className="font-semibold text-cheese underline-offset-2 hover:underline">
                📍 {locating ? t(T.locating) : t(T.locate)}
              </button>
              {zone && (
                <span className="font-semibold text-emerald-300">
                  ✓ {zone.feeCents > 0 ? `${lang === 'en' ? 'Delivery' : 'Delivery charges'} ${formatCents(zone.feeCents)}` : lang === 'en' ? 'Free delivery' : 'Delivery free'}
                </span>
              )}
            </div>
            {far !== null && (
              <p className="mt-1 text-[12.5px] text-cream/75">
                {far <= NEAR_KM
                  ? lang === 'en'
                    ? `You’re about ${far.toFixed(1)} km from us: we deliver here. Pick your area above.`
                    : `Aap hum se ${far.toFixed(1)} km door hain: hum yahan deliver karte hain. Upar area chunein.`
                  : lang === 'en'
                    ? `You’re about ${Math.round(far)} km away, outside our delivery areas.`
                    : `Aap ${Math.round(far)} km door hain, hamare delivery areas se bahar.`}
                {far > NEAR_KM && canPickup && (
                  <button type="button" onClick={() => setFulfilment('pickup')} className="ml-1 font-semibold text-cheese underline">
                    {lang === 'en' ? 'Choose pick-up?' : 'Pick-up karein?'}
                  </button>
                )}
              </p>
            )}
            {problem && <p className="mt-1 text-[12.5px] text-cream/75">{problem}</p>}
          </div>
        ) : (
          <p className="mt-3 rounded-xl border border-night-edge bg-night px-3 py-3 text-[13.5px] text-cream/85">
            <span className="font-semibold text-cheese">{t(T.collect)}:</span> {shop.address}
          </p>
        )}

        {status && !status.accepting && <p className="mt-2 text-[12.5px] text-cream/60">{t(T.closed)}</p>}

        <button
          type="button"
          onClick={confirm}
          disabled={!ready}
          className="mt-3 w-full rounded-2xl bg-cheese py-3.5 font-display text-[19px] tracking-wide text-night shadow-glow transition-all enabled:hover:bg-cheese-hot enabled:active:scale-[0.99] disabled:opacity-40"
        >
          {t(T.confirm)}
        </button>
        <button type="button" onClick={close} className="mt-1.5 w-full py-1.5 text-[13px] font-semibold text-cream/55 hover:text-cream">
          {t(T.browse)}
        </button>
      </div>
    </div>
  );
}

/** The deals banner: one deal at a time, turning by itself (not with reduced motion), swipe or tap a dot. */
function DealSlides({ slides, lang, t }: { slides: readonly GateSlide[]; lang: GateLang; t: (w: Words) => string }) {
  const [at, setAt] = useState(0);
  const [paused, setPaused] = useState(false);
  const startX = useRef<number | null>(null);
  const count = slides.length;

  useEffect(() => {
    if (paused || count < 2) return;
    if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const timer = window.setInterval(() => setAt((i) => (i + 1) % count), SLIDE_MS);
    return () => window.clearInterval(timer);
  }, [paused, count]);

  const slide = slides[at % count]!;
  const price = `${slide.from ? `${t(T.from)} ` : ''}${formatCents(slide.priceCents)}`;

  return (
    <div
      className="relative h-[188px] select-none overflow-hidden rounded-2xl bg-night-card"
      aria-roledescription="carousel"
      aria-label={lang === 'en' ? 'Deals' : 'Deals'}
      onPointerDown={(e) => {
        startX.current = e.clientX;
        setPaused(true);
      }}
      onPointerUp={(e) => {
        const dx = startX.current === null ? 0 : e.clientX - startX.current;
        startX.current = null;
        if (Math.abs(dx) > 40) setAt((i) => (i + (dx < 0 ? 1 : count - 1)) % count);
      }}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      {/* The warm spotlight behind the food (solid rings, as the printed deal menu). */}
      <div aria-hidden className="absolute -right-10 top-1/2 h-[260px] w-[260px] -translate-y-1/2 rounded-full bg-[#33271B]" />
      <div aria-hidden className="absolute -right-2 top-1/2 h-[200px] w-[200px] -translate-y-1/2 rounded-full bg-[#281F16]" />
      <div key={slide.key} aria-hidden className="absolute right-0 top-0 h-full w-[48%] animate-fade-in">
        {slide.cutouts.map((c, i) => (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={`${c.src}-${i}`}
            src={c.src}
            alt=""
            loading={at === 0 ? 'eager' : 'lazy'}
            decoding="async"
            className="absolute drop-shadow-[0_8px_14px_rgba(0,0,0,0.55)]"
            style={{ left: `${c.left}%`, top: `${c.top}%`, width: `${c.width}%`, transform: `rotate(${c.rotate}deg)` }}
          />
        ))}
      </div>
      <div key={`${slide.key}-words`} className="relative flex h-full w-[60%] flex-col justify-between p-3.5 animate-fade-in" aria-live="polite">
        <div>
          <p className="font-display text-[23px] leading-[1.02] tracking-wide text-cream">{t(slide.hook)}</p>
          <p className="mt-1.5 line-clamp-2 text-[11.5px] leading-snug text-cream/70">{t(slide.line)}</p>
        </div>
        <div>
          <p className="truncate font-cond text-[12px] font-extrabold uppercase tracking-wide text-cheese">{slide.name}</p>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <span className="rounded-full bg-cheese px-2.5 py-0.5 font-display text-[17px] leading-tight text-night">{price}</span>
            <span className="-rotate-3 rounded bg-[#E23B2E] px-1.5 py-0.5 font-cond text-[10px] font-extrabold uppercase tracking-widest text-white">
              {slide.when ? t(slide.when) : t(T.limited)}
            </span>
          </div>
          {slide.taxIncluded && <p className="mt-0.5 text-[10px] font-semibold uppercase tracking-wider text-cream/55">{t(T.taxIn)}</p>}
        </div>
      </div>
      {count > 1 && (
        <div className="absolute bottom-2 right-3 flex gap-1">
          {slides.map((s, i) => (
            <button
              key={s.key}
              type="button"
              aria-label={`${i + 1} / ${count}`}
              aria-current={i === at % count}
              onClick={() => {
                setAt(i);
                setPaused(true);
              }}
              className={`h-1.5 rounded-full transition-all ${i === at % count ? 'w-4 bg-cheese' : 'w-1.5 bg-cream/30'}`}
            />
          ))}
        </div>
      )}
    </div>
  );
}
