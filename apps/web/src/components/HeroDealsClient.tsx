'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { formatCents } from '@/lib/format';
import { PICKUP_ONLY_WORDS } from '@/lib/menu-view';
import type { HeroSlide } from '@/lib/hero-deals';

/**
 * The home hero's deals and offers slider (the drawing and the turning; the
 * slides are lib/hero-deals, read by the server half HeroDeals). One wide
 * card per slide — a photo beside the menu's names and prices — on a
 * scroll-snap track, so a phone swipes it natively. The tabs under it name
 * every kind of deal and offer (one tab for the slides of one kind: each
 * burger deal has a slide, "Burger deals" one tab with a line per slide) and
 * pick one.
 *
 * The active slide's line fills while it shows (SLIDE_MS), and its
 * animation's end turns to the next slide: pausing the animation pauses the
 * turning. It waits while a mouse is over the slider, while anything in it
 * has focus, while it is off screen or the tab hidden, and after the pause
 * button; prefers-reduced-motion: it never turns by itself and never glides.
 * Nothing turns before the page is live (the server's HTML shows slide 1).
 * Tabs follow the WAI-ARIA tabbed carousel: arrow keys move between them.
 */

const SLIDE_MS = 6500;
/** A swipe has settled once the track has been still this long. */
const SETTLE_MS = 90;

/** The slides of one kind: one tab. */
interface TabGroup {
  group: string;
  tab: string;
  /** Its first slide, and how many it has. */
  start: number;
  count: number;
  /** Its slides' element ids (aria-controls). */
  ids: string;
}

const slideId = (s: HeroSlide) => `hero-deal-${s.key}`;

function PauseGlyph({ paused }: { paused: boolean }) {
  return paused ? (
    <svg viewBox="0 0 16 16" aria-hidden className="h-3.5 w-3.5" fill="currentColor">
      <path d="M4 2.5v11l9-5.5z" />
    </svg>
  ) : (
    <svg viewBox="0 0 16 16" aria-hidden className="h-3.5 w-3.5" fill="currentColor">
      <path d="M4 2.5h3v11H4zM9 2.5h3v11H9z" />
    </svg>
  );
}

function PickupOnly({ ink }: { ink: boolean }) {
  return (
    <span
      className={`inline-block rounded-full border border-dashed px-2 py-px align-middle font-cond text-xs font-bold uppercase tracking-wide ${ink ? 'border-cream/40 text-cream/70' : 'border-ink/40 text-ink/70'}`}
    >
      {PICKUP_ONLY_WORDS}
    </span>
  );
}

export function HeroDealsClient({ slides }: { slides: HeroSlide[] }) {
  const root = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  const settle = useRef<number | undefined>(undefined);
  const [index, setIndex] = useState(0);
  // After hydration only: the timer may run, and reduced motion is known.
  const [live, setLive] = useState(false);
  const [still, setStill] = useState(false);
  const [stopped, setStopped] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [seen, setSeen] = useState(true);
  const many = slides.length > 1;
  // The slides turn by themselves (the active slide's line is the timer) unless the reader asked for less motion…
  const timed = live && many && !still;
  // …and the timer runs only while nobody is reading or using the slider, and it is in view.
  const running = timed && !stopped && !hovered && !focused && seen;

  const groups = useMemo(() => {
    const out: TabGroup[] = [];
    slides.forEach((s, i) => {
      const last = out[out.length - 1];
      if (last && last.group === s.group) {
        last.count += 1;
        last.ids += ` ${slideId(s)}`;
      } else out.push({ group: s.group, tab: s.tab, start: i, count: 1, ids: slideId(s) });
    });
    return out;
  }, [slides]);
  const groupAt = (i: number) => groups.findIndex((g) => i >= g.start && i < g.start + g.count);
  const activeGroup = groupAt(index);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const onMq = () => setStill(mq.matches);
    setStill(mq.matches);
    setLive(true);
    mq.addEventListener('change', onMq);
    // Off screen or in a hidden tab: wait.
    let onScreen = true;
    const update = () => setSeen(onScreen && document.visibilityState === 'visible');
    const io = new IntersectionObserver(([e]) => {
      onScreen = e?.isIntersecting ?? true;
      update();
    });
    if (root.current) io.observe(root.current);
    document.addEventListener('visibilitychange', update);
    return () => {
      mq.removeEventListener('change', onMq);
      io.disconnect();
      document.removeEventListener('visibilitychange', update);
      window.clearTimeout(settle.current);
    };
  }, []);

  /** Slide i's left edge on the track. */
  const leftOf = useCallback((i: number) => {
    const t = track.current;
    const el = t?.children[i] as HTMLElement | undefined;
    return t && el ? el.offsetLeft - (t.children[0] as HTMLElement).offsetLeft : 0;
  }, []);

  const go = useCallback(
    (i: number) => {
      const n = slides.length;
      const to = ((i % n) + n) % n;
      setIndex(to);
      track.current?.scrollTo({ left: leftOf(to), behavior: still ? 'auto' : 'smooth' });
    },
    [slides.length, leftOf, still],
  );

  // A swipe (or a focus that scrolled the track) picks the slide it settles on.
  const onScroll = () => {
    window.clearTimeout(settle.current);
    settle.current = window.setTimeout(() => {
      const t = track.current;
      if (!t) return;
      let best = 0;
      for (let i = 1; i < slides.length; i++)
        if (Math.abs(leftOf(i) - t.scrollLeft) < Math.abs(leftOf(best) - t.scrollLeft)) best = i;
      setIndex(best);
    }, SETTLE_MS);
  };

  // Arrow keys, Home and End move between the tabs (a kind's first slide).
  const onTabKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const n = groups.length;
    const to =
      e.key === 'ArrowRight'
        ? (activeGroup + 1) % n
        : e.key === 'ArrowLeft'
          ? (activeGroup - 1 + n) % n
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? n - 1
              : -1;
    if (to < 0) return;
    e.preventDefault();
    go(groups[to]!.start);
    tabs.current[to]?.focus();
  };

  if (slides.length === 0) return null;
  return (
    <div
      ref={root}
      className="relative mx-auto max-w-6xl px-4 pt-5 md:pt-8"
      role="region"
      aria-roledescription="carousel"
      aria-label="Deals and offers"
      onPointerEnter={(e) => e.pointerType === 'mouse' && setHovered(true)}
      onPointerLeave={(e) => e.pointerType === 'mouse' && setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false);
      }}
    >
      {/* One pause button, over the photo's top corner (a phone: the photo is on top; wide: on the right);
          first in the tab order, as the WAI-ARIA carousel puts its rotation control. */}
      {many && !still && (
        <button
          type="button"
          onClick={() => setStopped((v) => !v)}
          aria-label={stopped ? 'Play the deals' : 'Pause the deals'}
          className="absolute right-7 top-8 z-10 grid h-9 w-9 place-items-center rounded-full bg-ink/60 text-cream backdrop-blur transition-colors hover:bg-ink/80 hover:text-cheese md:top-11"
        >
          <PauseGlyph paused={stopped} />
        </button>
      )}
      <div
        ref={track}
        onScroll={onScroll}
        aria-live={running ? 'off' : 'polite'}
        className="scrollbar-hide flex snap-x snap-mandatory gap-4 overflow-x-auto overscroll-x-contain"
      >
        {slides.map((s, i) => {
          const ink = s.tone === 'ink';
          return (
            <div
              key={s.key}
              id={slideId(s)}
              role={many ? 'tabpanel' : 'group'}
              aria-roledescription="slide"
              aria-label={`${i + 1} of ${slides.length}: ${s.title}`}
              className="flex w-full shrink-0 snap-start"
            >
              {/* Every card as tall as the tallest (the track does not jump as it turns); the words fill the rest. */}
              <div className="grid w-full grid-rows-[auto_1fr] overflow-hidden rounded-[28px] ring-1 ring-inset ring-cream/10 md:h-[440px] md:grid-cols-[minmax(0,46fr)_minmax(0,54fr)] md:grid-rows-1">
                {/* The photo: on top on a phone, right on a wide screen. */}
                <div className="relative aspect-[4/3] overflow-hidden bg-night-card md:order-2 md:aspect-auto">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={s.photo.src}
                    srcSet={s.photo.srcSet}
                    sizes="(min-width: 1152px) 605px, (min-width: 768px) 54vw, 100vw"
                    width={s.photo.width}
                    height={s.photo.height}
                    alt={s.photo.alt}
                    // The slide showing and the next one load now; the rest as the slider gets near them.
                    loading={i <= index + 1 ? 'eager' : 'lazy'}
                    fetchPriority={i === 0 ? 'high' : undefined}
                    decoding="async"
                    className="absolute inset-0 h-full w-full object-cover"
                    style={{ objectPosition: s.photo.position }}
                  />
                </div>
                {/* The words: the menu's names and prices, as the printed menu sets them. */}
                <div
                  className={`flex flex-col justify-center p-6 md:p-9 ${ink ? 'bg-night-card text-cream' : 'bg-cheese text-ink'}`}
                >
                  <p className="font-display text-[clamp(2.5rem,5vw,3.75rem)] uppercase leading-[0.92] tracking-wide">
                    {s.title}
                  </p>
                  {s.line && (
                    <p
                      className={`mt-2 max-w-sm text-base leading-snug ${ink ? 'text-cream/70' : 'text-ink/75'}`}
                    >
                      {s.line}
                    </p>
                  )}
                  {/* One deal: its price, big. */}
                  {s.price && (
                    <p className="mt-5 flex flex-wrap items-center gap-3 md:mt-6">
                      <span
                        className={`font-display text-5xl leading-none tracking-wide md:text-6xl ${ink ? 'text-cheese' : 'text-ink'}`}
                      >
                        {formatCents(s.price.cents)}
                      </span>
                      {s.price.pickupOnly && <PickupOnly ink={ink} />}
                    </p>
                  )}
                  {s.rows.length > 0 && (
                    <ul className="mt-5 space-y-2 font-cond md:mt-6">
                      {s.rows.map((r) => (
                        <li key={r.name} className="flex items-baseline gap-2">
                          <span className="min-w-0">
                            <span className="text-xl font-bold leading-tight md:text-[1.375rem]">
                              {r.name}
                            </span>
                            {r.pickupOnly && (
                              <span className="ml-2">
                                <PickupOnly ink={ink} />
                              </span>
                            )}
                            {r.what && (
                              <span
                                className={`block text-sm font-semibold ${ink ? 'text-cream/55' : 'text-ink/65'}`}
                              >
                                {r.what}
                              </span>
                            )}
                          </span>
                          <span
                            aria-hidden
                            className={`mb-1 min-w-6 flex-1 border-b-2 border-dotted ${ink ? 'border-cream/25' : 'border-ink/30'}`}
                          />
                          <span className="whitespace-nowrap">
                            {r.from && (
                              <span
                                className={`mr-1 text-sm font-semibold ${ink ? 'text-cream/60' : 'text-ink/65'}`}
                              >
                                from
                              </span>
                            )}
                            {r.wasCents !== null && (
                              <s
                                className={`mr-1.5 text-base font-semibold ${ink ? 'text-cream/45' : 'text-ink/50'}`}
                              >
                                {formatCents(r.wasCents)}
                              </s>
                            )}
                            <span
                              className={`text-xl font-extrabold md:text-[1.375rem] ${ink ? 'text-cheese' : 'text-ink'}`}
                            >
                              {formatCents(r.priceCents)}
                            </span>
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {s.more > 0 && (
                    <p
                      className={`mt-2 font-cond text-sm font-bold ${ink ? 'text-cream/55' : 'text-ink/65'}`}
                    >
                      and {s.more} more on the menu
                    </p>
                  )}
                  <div className="pt-6 md:pt-8">
                    <Link
                      href={s.href}
                      className={`inline-block rounded-full px-7 py-3 font-display text-xl uppercase tracking-wide transition-colors active:scale-95 ${ink ? 'bg-cheese text-ink hover:bg-cheese-hot' : 'bg-ink text-cheese hover:bg-ink-soft'}`}
                    >
                      {s.cta}
                    </Link>
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {many && (
        <div
          role="tablist"
          aria-label="Deals and offers"
          onKeyDown={onTabKey}
          className="mt-4 grid gap-2 md:gap-3"
          style={{ gridTemplateColumns: `repeat(${groups.length}, minmax(0, 1fr))` }}
        >
          {groups.map((g, gi) => {
            const on = gi === activeGroup;
            return (
              <button
                key={g.group}
                ref={(el) => {
                  tabs.current[gi] = el;
                }}
                type="button"
                role="tab"
                id={`hero-deal-tab-${g.group}`}
                aria-controls={g.ids}
                aria-selected={on}
                tabIndex={on ? 0 : -1}
                onClick={() => go(g.start)}
                className="group py-1 text-left"
              >
                {/* A line per slide of this kind: the ones shown full, the one showing filling. */}
                <span className="flex gap-1">
                  {Array.from({ length: g.count }, (_, j) => {
                    const i = g.start + j;
                    const now = i === index;
                    return (
                      <span
                        key={i}
                        className="block h-1 flex-1 overflow-hidden rounded-full bg-cream/15"
                      >
                        <span
                          key={now ? `on-${index}` : 'off'}
                          onAnimationEnd={now && timed ? () => go(index + 1) : undefined}
                          className="block h-full origin-left rounded-full bg-cheese"
                          style={
                            now && timed
                              ? {
                                  animation: `hero-deal-fill ${SLIDE_MS}ms linear forwards`,
                                  animationPlayState: running ? 'running' : 'paused',
                                }
                              : {
                                  transform:
                                    (now && live) || (on && i < index) ? 'scaleX(1)' : 'scaleX(0)',
                                }
                          }
                        />
                      </span>
                    );
                  })}
                </span>
                <span
                  className={`mt-2 block font-cond text-xs font-bold uppercase leading-tight tracking-[0.06em] transition-colors md:text-sm md:tracking-[0.12em] ${on ? 'text-cream' : 'text-cream/50 group-hover:text-cream/80'}`}
                >
                  {g.tab}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
