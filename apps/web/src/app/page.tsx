import Link from 'next/link';
import { SiteHeader, SiteFooter } from '@/components/SiteChrome';
import { Marquee } from '@/components/Marquee';
import { Reveal } from '@/components/Reveal';
import { CheeseTime } from '@/components/CheeseTime';
import { WhatsAppFab } from '@/components/WhatsAppFab';
import { ClockMark } from '@/components/Logo';
import { BUSINESS, WA_ORDER_URL } from '@/lib/business';
import { DELIVERY_AREAS, etaText } from '@/lib/areas';

const LINEUP = [
  {
    name: 'Signature cheese-pull pizzas',
    blurb: 'Daily-proofed dough, a triple-cheese blend, and the pull the name promises.',
    img: '/images/pizza-cheesy.jpg',
  },
  {
    name: 'Smoky BBQ chicken pizza',
    blurb: 'Charred edges, smoky sauce, properly loaded — never a sad slice.',
    img: '/images/pizza-bbq.jpg',
  },
  {
    name: 'Double-smash burgers',
    blurb: 'Smashed to order on the hot plate. Crispy lace edges, molten cheese.',
    img: '/images/burger-stack.jpg',
  },
  {
    name: 'Loaded fries',
    blurb: 'Crispy fries buried under cheese and house sauces. Midnight fuel.',
    img: '/images/fries-loaded.jpg',
  },
  {
    name: 'Sticky glazed wings',
    blurb: 'Tossed hot in the pan, glazed, and gone in minutes. Order extra.',
    img: '/images/wings-bbq.jpg',
  },
  {
    name: 'Thick shakes',
    blurb: 'Properly thick, properly cold — the right way to end the order.',
    img: '/images/shake-chocolate.jpg',
  },
];

const STEPS = [
  {
    n: '01',
    title: 'Order in under a minute',
    body: 'Browse the menu and order on the website, or send your order straight on WhatsApp — both land in the same kitchen queue.',
  },
  {
    n: '02',
    title: 'We fire it fresh',
    body: 'Nothing waits under a heat lamp. Dough proofed daily, burgers smashed when your ticket prints, packed sealed and hot.',
  },
  {
    n: '03',
    title: 'Pay cash at your door',
    body: 'Track your order live from kitchen to doorstep. The rider arrives in 30–45 minutes — pay exactly what the receipt says.',
  },
];

const FAQS = [
  {
    q: 'Which areas of Karachi do you deliver to?',
    a: 'We deliver across DHA Phases 1–8, Clifton and Gizri from our Phase 6 kitchen. See the full list with delivery times on the delivery areas page — and if you are on a boundary street, WhatsApp us and we will confirm in a minute.',
  },
  {
    q: 'How long does delivery take?',
    a: 'Phase 6 orders usually arrive in 20–35 minutes since the kitchen is in the phase. Nearby phases run 25–45 minutes, and Clifton or Phase 1 & 2 up to 50. We quote honest ETAs rather than promising 30 and arriving late.',
  },
  {
    q: 'How do I pay?',
    a: 'Cash on delivery, every order. No card, no wallet, no app — the rider carries change and your printed receipt is the bill.',
  },
  {
    q: 'How late are you open?',
    a: 'Every day from 12pm to 2am. Late-night orders are our specialty — the kitchen fires until the last ticket at 2am.',
  },
  {
    q: 'Can I order on WhatsApp instead?',
    a: `Yes — message ${BUSINESS.phoneDisplay} on WhatsApp with what you want and your address, and we will confirm the total and ETA right away. Same kitchen, same prices.`,
  },
];

export default function HomePage() {
  return (
    <>
      <SiteHeader />
      <main>
        {/* ============================== HERO ============================== */}
        <section className="relative overflow-hidden">
          {/* radial gold glow behind the food */}
          <div
            aria-hidden
            className="absolute right-[-10%] top-1/2 h-[44rem] w-[44rem] -translate-y-1/2 rounded-full bg-[radial-gradient(ellipse_at_center,rgba(245,179,1,0.18),transparent_62%)]"
          />
          <div className="mx-auto grid max-w-6xl items-center gap-12 px-4 pb-20 pt-14 md:grid-cols-[1.1fr_0.9fr] md:pb-28 md:pt-20">
            <div className="animate-fade-up">
              <p className="inline-flex items-center gap-2 rounded-full border border-cheese/40 bg-cheese/10 px-4 py-1.5 text-xs font-bold uppercase tracking-[0.18em] text-cheese">
                <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-400" />
                Delivering across DHA &amp; Clifton, Karachi
              </p>
              <h1 className="mt-6 font-display text-[clamp(3.8rem,9vw,7.5rem)] leading-[0.88] tracking-wide text-cream">
                IT&rsquo;S ALWAYS
                <span className="block text-cheese">CHEESE O&rsquo;CLOCK.</span>
              </h1>
              <p className="mt-5 max-w-md text-lg leading-relaxed text-smoke">
                Signature cheese-pull pizzas, double-smash burgers, loaded fries
                and shakes — fired fresh in Phase 6 and delivered hot across DHA
                Karachi. No apps, no cards. Pay cash at your door.
              </p>
              <div className="mt-8 flex flex-wrap items-center gap-3">
                <Link
                  href="/menu"
                  className="rounded-full bg-cheese px-9 py-4 font-display text-2xl tracking-wide text-night shadow-glow transition-all animate-tick-glow hover:bg-cheese-hot hover:shadow-glow-lg active:scale-95"
                >
                  ORDER NOW →
                </Link>
                <a
                  href={WA_ORDER_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="rounded-full border border-white/20 px-8 py-4 text-lg font-bold text-cream transition-all hover:border-cheese/60 hover:text-cheese active:scale-95"
                >
                  💬 Order on WhatsApp
                </a>
              </div>
              <ul className="mt-7 flex flex-wrap gap-x-6 gap-y-2 text-sm font-semibold text-cream/70">
                <li className="flex items-center gap-2">
                  <span aria-hidden>🕐</span> 30–45 min delivery
                </li>
                <li className="flex items-center gap-2">
                  <span aria-hidden>💵</span> Cash on delivery
                </li>
                <li className="flex items-center gap-2">
                  <span aria-hidden>🌙</span> Open daily till 2am
                </li>
              </ul>
              <CheeseTime className="mt-4 text-sm text-smoke" />
            </div>

            {/* Hero food shot */}
            <div className="relative mx-auto hidden w-full max-w-sm select-none md:block">
              <div className="overflow-hidden rounded-[2rem] border border-white/10 shadow-[0_24px_80px_rgba(0,0,0,0.6)]">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src="/images/hero-cheese-pull.jpg"
                  alt="Pepperoni pizza slice with a long cheese pull, fresh from the Cheese O'Clock oven"
                  width={1400}
                  height={2097}
                  fetchPriority="high"
                  className="aspect-[3/4] w-full object-cover"
                />
              </div>
              <div className="absolute -left-8 top-10 animate-float rounded-2xl border border-white/10 bg-night-card/95 px-4 py-3 text-sm font-bold text-cream shadow-glow backdrop-blur">
                🧀 Extra cheesy, always
              </div>
              <div className="absolute -right-5 top-1/2 flex animate-float-slow items-center gap-2 rounded-2xl bg-cheese px-4 py-3 text-sm font-black text-night shadow-glow-lg">
                <ClockMark className="h-6 w-6 text-night" /> 30–45 MIN
              </div>
              <div className="absolute -left-4 bottom-12 animate-float rounded-2xl border border-white/10 bg-night-card/95 px-4 py-3 text-sm font-bold text-cream shadow-glow backdrop-blur [animation-delay:1.2s]">
                🔥 Straight from the oven
              </div>
            </div>
          </div>
        </section>

        {/* ============================ MARQUEE ============================ */}
        <Marquee
          tilted
          items={[
            'HOT IN 30–45 MIN',
            'CASH ON DELIVERY',
            'OPEN TILL 2AM',
            'DHA & CLIFTON KARACHI',
            'ORDER ON WHATSAPP',
            "IT'S ALWAYS CHEESE O'CLOCK",
          ]}
        />

        {/* ========================= FAN FAVOURITES ======================== */}
        <section className="mx-auto max-w-6xl px-4 py-20 md:py-24">
          <Reveal>
            <p className="text-xs font-bold uppercase tracking-[0.22em] text-cheese">
              The lineup
            </p>
            <div className="mt-2 flex flex-wrap items-end justify-between gap-4">
              <h2 className="font-display text-5xl tracking-wide text-cream md:text-6xl">
                FAN FAVOURITES
              </h2>
              <Link
                href="/menu"
                className="font-bold text-cheese transition-colors hover:text-cheese-hot"
              >
                Full menu with prices →
              </Link>
            </div>
          </Reveal>
          <div className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {LINEUP.map((item, i) => (
              <Reveal key={item.name} delay={(i % 3) * 80}>
                <Link
                  href="/menu"
                  className="group block overflow-hidden rounded-2xl border border-white/10 bg-night-card transition-colors hover:border-cheese/50"
                >
                  <div className="overflow-hidden">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={item.img}
                      alt={item.name}
                      width={1200}
                      height={900}
                      loading="lazy"
                      className="aspect-[4/3] w-full object-cover transition-transform duration-300 group-hover:scale-105"
                    />
                  </div>
                  <div className="p-5">
                    <h3 className="text-lg font-bold text-cream">{item.name}</h3>
                    <p className="mt-1 text-sm leading-relaxed text-smoke">
                      {item.blurb}
                    </p>
                    <p className="mt-3 text-sm font-bold text-cheese opacity-0 transition-opacity group-hover:opacity-100">
                      Order it →
                    </p>
                  </div>
                </Link>
              </Reveal>
            ))}
          </div>
        </section>

        {/* ===================== COVERAGE (cream breather) ================== */}
        <section className="bg-cream text-ink">
          <div className="mx-auto max-w-6xl px-4 py-20 md:py-24">
            <Reveal>
              <p className="text-xs font-bold uppercase tracking-[0.22em] text-cheese-deep">
                Delivery coverage
              </p>
              <h2 className="mt-2 max-w-2xl font-display text-5xl tracking-wide md:text-6xl">
                PIZZA &amp; BURGER DELIVERY ACROSS DHA KARACHI
              </h2>
              <p className="mt-4 max-w-2xl leading-relaxed text-ink/70">
                Our kitchen sits in DHA Phase 6 and our riders run every phase
                around it, plus Clifton and Gizri — every day from 12pm to 2am.
                Find your area for honest delivery times, covered streets and
                what your neighbours order.
              </p>
            </Reveal>
            <div className="mt-10 grid gap-10 lg:grid-cols-[1.2fr_0.8fr]">
              <div className="grid gap-3 sm:grid-cols-2">
                {DELIVERY_AREAS.map((area, i) => (
                  <Reveal key={area.slug} delay={(i % 2) * 60}>
                    <Link
                      href={`/delivery/${area.slug}`}
                      className="group flex items-center justify-between gap-3 rounded-2xl border border-ink/10 bg-white px-5 py-4 shadow-soft-sm transition-all hover:border-cheese hover:shadow-soft-md"
                    >
                      <span className="font-bold">{area.name}</span>
                      <span className="whitespace-nowrap rounded-full bg-cheese/15 px-3 py-1 text-xs font-bold text-cheese-deep group-hover:bg-cheese group-hover:text-night">
                        🛵 {etaText(area)}
                      </span>
                    </Link>
                  </Reveal>
                ))}
                <Reveal delay={120} className="sm:col-span-2">
                  <a
                    href={WA_ORDER_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block rounded-2xl border-2 border-dashed border-ink/15 px-5 py-4 text-center text-sm font-semibold text-ink/60 transition-colors hover:border-cheese hover:text-ink"
                  >
                    On a boundary street? WhatsApp us — we&rsquo;ll confirm your
                    address in a minute.
                  </a>
                </Reveal>
              </div>
              <Reveal delay={100}>
                <div className="overflow-hidden rounded-2xl border border-ink/10 shadow-soft-md">
                  <iframe
                    title="Cheese O'Clock — DHA Phase 6, Karachi on Google Maps"
                    src="https://maps.google.com/maps?q=DHA%20Phase%206%20Karachi&z=13&output=embed"
                    width="600"
                    height="420"
                    loading="lazy"
                    referrerPolicy="no-referrer-when-downgrade"
                    className="h-[420px] w-full border-0"
                  />
                </div>
                <p className="mt-3 text-center text-sm text-ink/60">
                  {BUSINESS.name} · {BUSINESS.addressLine} · {BUSINESS.hours}
                </p>
              </Reveal>
            </div>
          </div>
        </section>

        {/* =========================== HOW IT WORKS ======================== */}
        <section className="mx-auto max-w-6xl px-4 py-20 md:py-24">
          <Reveal>
            <p className="text-xs font-bold uppercase tracking-[0.22em] text-cheese">
              How it works
            </p>
            <h2 className="mt-2 font-display text-5xl tracking-wide text-cream md:text-6xl">
              OVEN → DOOR IN THREE STEPS
            </h2>
          </Reveal>
          <div className="mt-10 grid gap-5 md:grid-cols-3">
            {STEPS.map((s, i) => (
              <Reveal key={s.n} delay={i * 80}>
                <div className="h-full rounded-2xl border border-white/10 bg-night-card p-6 transition-colors hover:border-cheese/40">
                  <div className="font-display text-5xl text-cheese/40">{s.n}</div>
                  <h3 className="mt-3 text-lg font-bold text-cream">{s.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-smoke">{s.body}</p>
                </div>
              </Reveal>
            ))}
          </div>
          {/* Brand promises — swap for real Google review cards once the GBP
              listing has a steady review base. Never fabricate testimonials. */}
          <Reveal delay={120}>
            <div className="mt-12 grid gap-px overflow-hidden rounded-2xl border border-white/10 bg-white/10 sm:grid-cols-3">
              {[
                ['12pm – 2am', 'open every single day'],
                ['30–45 min', 'honest average delivery'],
                ['100% COD', 'pay cash when it arrives'],
              ].map(([big, small]) => (
                <div key={big} className="bg-night-soft px-6 py-8 text-center">
                  <div className="font-display text-4xl tracking-wide text-cheese">
                    {big}
                  </div>
                  <div className="mt-1 text-sm text-smoke">{small}</div>
                </div>
              ))}
            </div>
          </Reveal>
        </section>

        {/* =============================== FAQ ============================= */}
        <section className="mx-auto max-w-3xl px-4 pb-20 md:pb-24">
          <Reveal>
            <h2 className="font-display text-5xl tracking-wide text-cream">
              QUESTIONS, ANSWERED
            </h2>
          </Reveal>
          <div className="mt-8 space-y-3">
            {FAQS.map((f, i) => (
              <Reveal key={f.q} delay={i * 50}>
                <details className="group rounded-2xl border border-white/10 bg-night-card open:border-cheese/40">
                  <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 font-bold text-cream [&::-webkit-details-marker]:hidden">
                    {f.q}
                    <span className="text-cheese transition-transform group-open:rotate-45">
                      +
                    </span>
                  </summary>
                  <p className="px-5 pb-5 text-sm leading-relaxed text-smoke">
                    {f.a}
                  </p>
                </details>
              </Reveal>
            ))}
          </div>
        </section>

        {/* ============================ FINAL CTA ========================== */}
        <section className="bg-cheese">
          <div className="mx-auto flex max-w-6xl flex-col items-center gap-6 px-4 py-16 text-center md:py-20">
            <h2 className="font-display text-[clamp(3rem,8vw,6rem)] leading-[0.9] tracking-wide text-night">
              HUNGRY? IT&rsquo;S CHEESE O&rsquo;CLOCK.
            </h2>
            <div className="flex flex-wrap justify-center gap-3">
              <Link
                href="/menu"
                className="rounded-full bg-night px-9 py-4 font-display text-2xl tracking-wide text-cheese shadow-soft-lg transition-transform hover:scale-105 active:scale-95"
              >
                ORDER NOW →
              </Link>
              <a
                href={WA_ORDER_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-full border-2 border-night/30 px-8 py-4 text-lg font-bold text-night transition-colors hover:border-night active:scale-95"
              >
                💬 WhatsApp {BUSINESS.phoneDisplay}
              </a>
            </div>
            <p className="text-sm font-semibold text-night/70">
              {BUSINESS.hours} · Cash on delivery across DHA &amp; Clifton
            </p>
          </div>
        </section>
      </main>
      <SiteFooter />
      <WhatsAppFab />
    </>
  );
}
