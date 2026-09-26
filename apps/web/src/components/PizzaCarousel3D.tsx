'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { formatCents } from '@/lib/format';
import { menuImageSrcSet } from '@/lib/images';
import { SIGNATURE_PIZZAS } from '@/lib/signatures';

/**
 * The home hero: the five signature pizzas on a turntable in 3D.
 *
 * Plain CSS 3D + one requestAnimationFrame loop — no WebGL, no library. Each
 * pizza sits on a ring (x = R·sin, z = R·cos) inside a perspective stage,
 * lies tilted like it is on the counter, and spins on its own axis. The ring
 * eases one pizza to the front every few seconds; drag, the arrows, the dots,
 * the keyboard or a tap on a pizza take over, and it resumes when left alone.
 *
 * Styles are written straight to the DOM from the loop (no React render per
 * frame); React only re-renders when the front pizza changes, for the label.
 * prefers-reduced-motion: no spinning and no auto-advance.
 */

const N = SIGNATURE_PIZZAS.length;
const STEP = 360 / N;
const AUTO_EVERY_S = 3.4;
const IDLE_AFTER_MS = 6000;
const SPIN_DEG_PER_S = 16;

interface Pose {
  transform: string;
  opacity: string;
  zIndex: string;
  filter: string;
  shadow: string;
}

/** Pure: where pizza i sits for a ring angle, self-spin and stage radius. */
function pose(i: number, ringDeg: number, spinDeg: number, radius: number): Pose {
  const a = ((i * STEP + ringDeg) * Math.PI) / 180;
  const x = Math.sin(a) * radius * 1.05;
  const z = Math.cos(a) * radius * 1.25;
  const t = (Math.cos(a) + 1) / 2; // 1 = front, 0 = back
  // Camera above the counter: the far side of the turntable sits higher.
  const y = -(1 - t) * radius * 0.5 + t * radius * 0.06;
  const tilt = 70 - 42 * t; // the front pizza turns its face to you
  const r = (x: number) => Math.round(x * 100) / 100;
  return {
    transform: `translate3d(${r(x)}px, ${r(y)}px, ${r(z)}px) scale(${r(0.9 + 0.22 * t)}) rotateX(${r(tilt)}deg) rotateZ(${r(spinDeg + i * 47)}deg)`,
    opacity: String(r(0.35 + 0.65 * t)),
    zIndex: String(Math.round(t * 100)),
    filter: `brightness(${r(0.45 + 0.55 * t)}) saturate(${r(0.7 + 0.3 * t)})`,
    shadow: `translate3d(${r(x)}px, ${r(y + radius * 0.34)}px, ${r(z - 1)}px) scale(${r(0.55 + 0.45 * t)})`,
  };
}

function frontIndex(ringDeg: number): number {
  let best = 0;
  let bestCos = -2;
  for (let i = 0; i < N; i++) {
    const c = Math.cos(((i * STEP + ringDeg) * Math.PI) / 180);
    if (c > bestCos) {
      bestCos = c;
      best = i;
    }
  }
  return best;
}

export function PizzaCarousel3D({ className = '' }: { className?: string }) {
  const stageRef = useRef<HTMLDivElement>(null);
  const pizzaRefs = useRef<Array<HTMLDivElement | null>>([]);
  const shadowRefs = useRef<Array<HTMLDivElement | null>>([]);
  const ring = useRef(0);
  const target = useRef(0);
  const spin = useRef(0);
  const radius = useRef(170);
  const lastTouch = useRef(-Infinity);
  const drag = useRef<{ x: number; startRing: number; moved: boolean; hit: number | null } | null>(
    null,
  );
  const [front, setFront] = useState(0);
  const frontRef = useRef(0);

  const layout = useCallback(() => {
    for (let i = 0; i < N; i++) {
      const p = pose(i, ring.current, spin.current, radius.current);
      const el = pizzaRefs.current[i];
      if (el) {
        el.style.transform = p.transform;
        el.style.opacity = p.opacity;
        el.style.zIndex = p.zIndex;
        el.style.filter = p.filter;
      }
      const sh = shadowRefs.current[i];
      if (sh) {
        sh.style.transform = p.shadow;
        sh.style.opacity = p.opacity;
      }
    }
    const f = frontIndex(ring.current);
    if (f !== frontRef.current) {
      frontRef.current = f;
      setFront(f);
    }
  }, []);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const measure = () => {
      radius.current = Math.min(stage.clientWidth * 0.33, 230);
    };
    measure();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(stage);

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let raf = 0;
    let last = performance.now();
    let held = 0;
    // The loop only runs while the stage is on screen and the tab is visible:
    // scrolled past the hero, a phone was still repainting five pizzas every
    // frame for as long as the page stayed open.
    let onScreen = true;
    const running = () => onScreen && document.visibilityState === 'visible';
    const start = () => {
      if (raf || !running()) return;
      last = performance.now();
      raf = requestAnimationFrame(tick);
    };
    const io =
      typeof IntersectionObserver !== 'undefined'
        ? new IntersectionObserver((entries) => {
            onScreen = entries.some((e) => e.isIntersecting);
            start();
          })
        : null;
    io?.observe(stage);
    const onVisibility = () => start();
    document.addEventListener('visibilitychange', onVisibility);
    const tick = (now: number) => {
      raf = 0;
      if (!running()) return;
      const dt = Math.min(0.064, (now - last) / 1000);
      last = now;
      if (!reduced) spin.current = (spin.current + dt * SPIN_DEG_PER_S) % 360;
      const idle = !drag.current && now - lastTouch.current > IDLE_AFTER_MS;
      if (idle && !reduced && document.visibilityState === 'visible') {
        held += dt;
        if (held > AUTO_EVERY_S) {
          held = 0;
          target.current -= STEP;
        }
      } else {
        held = 0;
      }
      if (!drag.current) {
        ring.current += (target.current - ring.current) * Math.min(1, dt * 4.5);
      }
      layout();
      raf = requestAnimationFrame(tick);
    };
    start();
    return () => {
      cancelAnimationFrame(raf);
      raf = 0;
      ro?.disconnect();
      io?.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [layout]);

  function touch() {
    lastTouch.current = performance.now();
  }

  function bringToFront(i: number) {
    touch();
    const want = -i * STEP;
    target.current = want + 360 * Math.round((ring.current - want) / 360);
  }

  function step(dir: 1 | -1) {
    touch();
    // Snap first so repeated taps land exactly on a pizza.
    target.current = Math.round(target.current / STEP) * STEP - dir * STEP;
  }

  function onPointerDown(e: React.PointerEvent) {
    touch();
    // Pointer capture sends the release to the stage, so a tap on a pizza is
    // recognised here rather than by a click handler on the pizza itself.
    const hitAttr = (e.target as HTMLElement).closest?.('[data-pizza]')?.getAttribute('data-pizza');
    drag.current = {
      x: e.clientX,
      startRing: ring.current,
      moved: false,
      hit: hitAttr == null ? null : Number(hitAttr),
    };
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  }
  function onPointerMove(e: React.PointerEvent) {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    if (Math.abs(dx) > 4) d.moved = true;
    ring.current = d.startRing + dx * 0.4;
    target.current = ring.current;
  }
  function onPointerUp() {
    const d = drag.current;
    drag.current = null;
    touch();
    if (!d) return;
    if (!d.moved && d.hit !== null) {
      bringToFront(d.hit);
      return;
    }
    target.current = Math.round(ring.current / STEP) * STEP;
  }

  const current = SIGNATURE_PIZZAS[front] ?? SIGNATURE_PIZZAS[0]!;

  return (
    <div className={className}>
      <div
        ref={stageRef}
        role="group"
        aria-roledescription="carousel"
        aria-label="Signature pizzas"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft') step(-1);
          if (e.key === 'ArrowRight') step(1);
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        className="relative mx-auto aspect-[1.25] w-full max-w-[40rem] cursor-grab touch-pan-y select-none outline-none active:cursor-grabbing [perspective:1100px]"
      >
        {/* counter-top glow the pizzas stand on */}
        <div
          aria-hidden
          className="absolute inset-x-[6%] bottom-[8%] h-[34%] rounded-[50%] bg-[radial-gradient(ellipse_at_center,rgba(245,179,1,0.32),rgba(245,179,1,0.06)_55%,transparent_72%)]"
        />
        <div className="absolute inset-0 [transform-style:preserve-3d]">
          {SIGNATURE_PIZZAS.map((p, i) => {
            const initial = pose(i, 0, 0, 170);
            return (
              <div key={p.name}>
                <div
                  ref={(el) => {
                    shadowRefs.current[i] = el;
                  }}
                  aria-hidden
                  style={{ transform: initial.shadow, opacity: initial.opacity }}
                  className="pointer-events-none absolute left-1/2 top-[46%] -ml-[18%] h-[9%] w-[36%] rounded-[50%] bg-black/75 blur-xl"
                />
                <div
                  ref={(el) => {
                    pizzaRefs.current[i] = el;
                  }}
                  style={{
                    transform: initial.transform,
                    opacity: initial.opacity,
                    zIndex: initial.zIndex,
                    filter: initial.filter,
                  }}
                  data-pizza={i}
                  className="absolute left-1/2 top-[50%] -ml-[23%] -mt-[23%] aspect-square w-[46%] will-change-transform md:-ml-[20%] md:-mt-[20%] md:w-[40%]"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={p.image}
                    srcSet={menuImageSrcSet(p.image)}
                    sizes="(min-width: 768px) 260px, 46vw"
                    width={400}
                    height={400}
                    alt={`${p.name} pizza from Cheese O'Clock`}
                    draggable={false}
                    decoding="async"
                    fetchPriority={i === 0 ? 'high' : 'auto'}
                    className="h-full w-full object-contain"
                  />
                </div>
              </div>
            );
          })}
        </div>

        <button
          type="button"
          onClick={() => step(-1)}
          onPointerDown={(e) => e.stopPropagation()}
          aria-label="Previous pizza"
          className="absolute left-1 top-[50%] z-[200] grid h-11 w-11 -translate-y-1/2 place-items-center rounded-full border border-cream/20 bg-ink/70 text-xl text-cream backdrop-blur transition-colors hover:border-cheese hover:text-cheese sm:left-3"
        >
          ‹
        </button>
        <button
          type="button"
          onClick={() => step(1)}
          onPointerDown={(e) => e.stopPropagation()}
          aria-label="Next pizza"
          className="absolute right-1 top-[50%] z-[200] grid h-11 w-11 -translate-y-1/2 place-items-center rounded-full border border-cream/20 bg-ink/70 text-xl text-cream backdrop-blur transition-colors hover:border-cheese hover:text-cheese sm:right-3"
        >
          ›
        </button>
      </div>

      {/* Front pizza's label */}
      <div className="-mt-4 text-center sm:-mt-8" aria-live="polite">
        <p className="font-cond text-xs font-bold uppercase tracking-[0.3em] text-cheese">
          Signature · {current.size}
        </p>
        <h2 key={current.name} className="animate-pop-in font-display text-4xl uppercase tracking-wide text-cream md:text-5xl">
          {current.name}
        </h2>
        <p className="mt-1 font-cond text-base font-semibold uppercase tracking-wide text-cream/65">
          {current.hook}
        </p>
        <div className="mt-3 flex items-center justify-center gap-3">
          <span className="rounded-full bg-cheese px-4 py-1.5 font-cond text-lg font-extrabold text-ink">
            {formatCents(current.priceRs * 100)}
          </span>
          <Link
            href="/menu#signature-pizzas"
            className="font-cond text-lg font-bold uppercase tracking-wide text-cream underline decoration-cheese decoration-2 underline-offset-4 hover:text-cheese"
          >
            Order this →
          </Link>
        </div>
        <div className="mt-4 flex justify-center gap-2">
          {SIGNATURE_PIZZAS.map((p, i) => (
            <button
              key={p.name}
              type="button"
              onClick={() => bringToFront(i)}
              aria-label={`Show ${p.name}`}
              aria-current={i === front}
              className={`h-2.5 rounded-full transition-all ${
                i === front ? 'w-8 bg-cheese' : 'w-2.5 bg-cream/25 hover:bg-cream/50'
              }`}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
