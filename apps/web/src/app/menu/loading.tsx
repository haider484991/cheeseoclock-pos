import { SiteHeader } from '@/components/SiteChrome';

/**
 * Shown the moment "Order now" is tapped, while the server reads today's menu
 * and whether the till is taking orders. Shaped like the page it becomes, so
 * nothing jumps when it arrives.
 */
export default function MenuLoading() {
  return (
    <>
      <SiteHeader />
      <main className="min-h-screen bg-paper text-ink" aria-busy="true">
        <div className="bg-ink text-cream">
          <div className="mx-auto max-w-6xl px-4 pb-7 pt-8 md:pb-9 md:pt-10">
            <p className="font-cond text-sm font-bold uppercase tracking-[0.22em] text-cheese">Order online</p>
            <h1 className="mt-1 font-display text-6xl uppercase leading-none tracking-wide md:text-7xl">The Menu</h1>
            <div className="mt-5 flex flex-wrap gap-2">
              {[40, 32, 24, 28].map((w) => (
                <span key={w} className="h-8 animate-pulse rounded-full bg-cream/10" style={{ width: `${w * 0.25}rem` }} />
              ))}
            </div>
          </div>
        </div>
        <div className="border-b border-ink/10 bg-paper">
          <div className="mx-auto flex max-w-6xl gap-2 overflow-hidden px-4 py-3">
            {[28, 36, 24, 26, 30].map((w, i) => (
              <span key={i} className="h-9 shrink-0 animate-pulse rounded-full bg-ink/10" style={{ width: `${w * 0.25}rem` }} />
            ))}
          </div>
        </div>
        <div className="mx-auto max-w-6xl px-4 pt-8">
          <div className="h-10 w-56 animate-pulse rounded bg-ink/10" />
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="h-40 animate-pulse rounded-3xl bg-ink/[0.07]" />
            ))}
          </div>
          <p className="sr-only" role="status">
            Loading the menu…
          </p>
        </div>
      </main>
    </>
  );
}
