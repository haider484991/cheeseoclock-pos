import Link from 'next/link';
import { SiteHeader, SiteFooter } from '@/components/SiteChrome';
import { Marquee } from '@/components/Marquee';
import { Reveal } from '@/components/Reveal';
import { CheeseTime } from '@/components/CheeseTime';
import { WhatsAppFab } from '@/components/WhatsAppFab';
import { PizzaCarousel3D } from '@/components/PizzaCarousel3D';
import { BUSINESS, WA_ORDER_URL } from '@/lib/business';
import { DELIVERY_AREAS, feeText } from '@/lib/areas';
import { FEE_SUMMARY } from '@/lib/delivery-zones';
import { formatCents } from '@/lib/format';
import { SIGNATURE_BURGER, SIGNATURE_PIZZAS, VALUE_DEALS } from '@/lib/signatures';

const LINEUP = [...SIGNATURE_PIZZAS, SIGNATURE_BURGER];

const STEPS = [
  {
    n: '01',
    title: 'Order in under a minute',
    body: 'Pick from the menu here, or send your order on WhatsApp — both land in the same kitchen queue.',
  },
  {
    n: '02',
    title: 'Fired when your ticket prints',
    body: 'Every pizza and burger is made to order in our DHA Phase 6 kitchen and sent out hot.',
  },
  {
    n: '03',
    title: 'Pay cash at your door',
    body: 'Follow your order live from kitchen to doorstep, then pay the rider exactly what the printed receipt says.',
  },
];

const FAQS = [
  {
    q: 'Which areas do you deliver to?',
    a: `DHA Phases 1–8 and Clifton Blocks 1–9, including Emaar Crescent Bay and Creek Vista. Delivery is Rs 200 for DHA Phases 1–8 and Clifton Blocks 3–9, and Rs 250 for Clifton Blocks 1 & 2, Emaar and Creek Vista. We don't deliver outside DHA and Clifton.`,
  },
  {
    q: 'What are your hours?',
    a: 'Every day from 12 noon to 1 am.',
  },
  {
    q: 'How do I pay?',
    a: 'Cash on delivery. 15% tax is added on the bill, and the printed receipt from the kitchen is the final amount.',
  },
  {
    q: 'What sizes do the pizzas come in?',
    a: 'Regular pizzas come in Medium 9" and Large 12". The five signature pizzas are Large 12".',
  },
  {
    q: 'Can I order on WhatsApp instead?',
    a: `Yes — message ${BUSINESS.whatsappLines.map((l) => l.display).join(' or ')} with your order and address, and we'll confirm the total. Same kitchen, same prices.`,
  },
];

function WhatsAppGlyph({ className = '' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={className} fill="currentColor">
      <path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2Zm0 18.2a8.2 8.2 0 0 1-4.2-1.1l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2Zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8-.2-.1-.4-.1-.6.1l-.8 1c-.1.2-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.3-.4.2-.4.8-1.4.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.2 5.2 5.2 0 0 0 1.1 2.8 11.9 11.9 0 0 0 4.6 4c1.7.7 2.3.8 3.2.6.5-.1 1.5-.6 1.7-1.2.2-.6.2-1.1.1-1.2l-.4-.4Z" />
    </svg>
  );
}

export default function HomePage() {
  return (
    <>
      <SiteHeader />
      <main>
        {/* ============================== HERO ============================== */}
        <section className="relative overflow-hidden bg-ink">
          <div
            aria-hidden
            className="absolute inset-0 bg-[radial-gradient(ellipse_at_72%_45%,rgba(245,179,1,0.16),transparent_58%)]"
          />
          <div
            aria-hidden
            className="absolute inset-0 opacity-[0.07] [background-image:repeating-linear-gradient(90deg,#F5B301_0_1px,transparent_1px_90px)]"
          />
          {/* Phones: headline → pizzas → the rest, so the food is above the
              fold. Desktop: text left, pizzas right. */}
          <div className="relative mx-auto grid max-w-6xl gap-x-4 px-4 pb-14 pt-8 [grid-template-areas:'head'_'wheel'_'rest'] md:grid-cols-[0.95fr_1.05fr] md:items-center md:pb-20 md:pt-14 md:[grid-template-areas:'head_wheel'_'rest_wheel']">
            <div className="animate-fade-up [grid-area:head] md:self-end md:pr-4">
              <p className="inline-flex items-center gap-2 rounded-full border border-cheese/40 bg-cheese/10 px-4 py-1.5 font-cond text-sm font-bold uppercase tracking-[0.16em] text-cheese">
                <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-400" />
                We deliver all over DHA &amp; Clifton
              </p>
              <h1 className="mt-5 font-display text-[clamp(3rem,8.2vw,6.4rem)] uppercase leading-[0.92] tracking-wide text-cream">
                It&rsquo;s always
                <span className="block text-cheese">Cheese O&rsquo;Clock.</span>
              </h1>
            </div>

            <PizzaCarousel3D className="-mt-6 [grid-area:wheel] md:-mr-6 md:mt-0" />

            <div className="animate-fade-up [grid-area:rest] md:self-start md:pr-4">
              <p className="mt-6 font-cond text-2xl font-semibold italic text-cream/85 md:mt-4">
                {BUSINESS.tagline}
              </p>
              <p className="mt-3 max-w-md text-lg leading-relaxed text-cream/65">
                Five signature pizzas, crispy chicken burgers and fries — made to
                order in DHA Phase 6. Pay cash at your door.
              </p>
              <div className="mt-7 flex flex-wrap items-center gap-3">
                <Link
                  href="/menu"
                  className="rounded-full bg-cheese px-9 py-4 font-display text-2xl uppercase tracking-wide text-ink shadow-glow transition-all animate-tick-glow hover:bg-cheese-hot hover:shadow-glow-lg active:scale-95"
                >
                  Order now →
                </Link>
                <a
                  href={WA_ORDER_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 rounded-full border border-cream/25 px-6 py-4 font-cond text-lg font-bold uppercase tracking-wide text-cream transition-all hover:border-cheese hover:text-cheese active:scale-95"
                >
                  <WhatsAppGlyph className="h-5 w-5" /> WhatsApp
                </a>
              </div>
              <ul className="mt-6 flex flex-wrap gap-2 font-cond text-sm font-bold uppercase tracking-wide text-cream/80">
                <li className="rounded-full border border-cream/15 px-3 py-1.5">Delivery from Rs 200</li>
                <li className="rounded-full border border-cream/15 px-3 py-1.5">12 noon – 1 am daily</li>
                <li className="rounded-full border border-cream/15 px-3 py-1.5">Cash on delivery</li>
              </ul>
              <CheeseTime className="mt-4 text-sm text-cream/55" />
            </div>
          </div>
        </section>

        {/* ============================ MARQUEE ============================ */}
        <Marquee
          tilted
          items={[
            'HYGIENICALLY MADE. DELICIOUSLY UNFORGETTABLE.',
            'WE DELIVER ALL OVER DHA & CLIFTON',
            'OPEN 12 NOON – 1 AM',
            'CASH ON DELIVERY',
            'FIVE SIGNATURE PIZZAS',
            "IT'S ALWAYS CHEESE O'CLOCK",
          ]}
        />

        {/* ======================== THE SIGNATURES ========================= */}
        <section className="bg-paper text-ink">
          <div className="mx-auto max-w-6xl px-4 py-20 md:py-24">
            <Reveal>
              <p className="font-cond text-sm font-bold uppercase tracking-[0.24em] text-cheese-deep">
                From our kitchen, not a stock library
              </p>
              <div className="mt-2 flex flex-wrap items-end justify-between gap-4 border-b-[3px] border-ink pb-3">
                <h2 className="font-display text-5xl uppercase tracking-wide md:text-6xl">
                  The signatures
                </h2>
                <Link
                  href="/menu"
                  className="font-cond text-lg font-bold uppercase tracking-wide text-ink underline decoration-cheese decoration-[3px] underline-offset-4 hover:text-cheese-deep"
                >
                  Full menu &amp; prices →
                </Link>
              </div>
            </Reveal>
            <div className="mt-10 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
              {LINEUP.map((item, i) => (
                <Reveal key={item.name} delay={(i % 3) * 80}>
                  <Link
                    href={item.size === 'Burger' ? '/menu#burgers' : '/menu#signature-pizzas'}
                    className="group flex h-full flex-col overflow-hidden rounded-3xl bg-ink text-cream shadow-soft-md transition-transform hover:-translate-y-1"
                  >
                    <div className="relative grid aspect-[4/3] place-items-center overflow-hidden bg-[radial-gradient(circle_at_50%_58%,rgba(245,179,1,0.3),transparent_66%)]">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={item.image}
                        alt={`${item.name} from Cheese O'Clock`}
                        width={720}
                        height={720}
                        loading="lazy"
                        className="w-[78%] drop-shadow-[0_22px_26px_rgba(0,0,0,0.55)] transition-transform duration-700 group-hover:rotate-[18deg] group-hover:scale-105"
                      />
                      <span className="absolute left-4 top-4 rounded-full bg-cheese px-3 py-1 font-cond text-sm font-extrabold text-ink">
                        {formatCents(item.priceRs * 100)}
                      </span>
                    </div>
                    <div className="flex flex-1 flex-col p-5">
                      <p className="font-cond text-xs font-bold uppercase tracking-[0.24em] text-cheese">
                        {item.size === 'Burger' ? 'Signature burger' : `Signature · ${item.size}`}
                      </p>
                      <h3 className="mt-1 font-display text-3xl uppercase tracking-wide">{item.name}</h3>
                      <p className="mt-2 text-sm leading-relaxed text-cream/65">{item.description}</p>
                      <p className="mt-auto pt-4 font-cond text-base font-bold uppercase tracking-wide text-cheese">
                        Order it →
                      </p>
                    </div>
                  </Link>
                </Reveal>
              ))}
            </div>
          </div>
        </section>

        {/* ========================== VALUE DEALS ========================== */}
        <section className="bg-cheese text-ink">
          <div className="mx-auto grid max-w-6xl gap-8 px-4 py-16 md:grid-cols-[0.8fr_1.2fr] md:items-center md:py-20">
            <Reveal>
              <h2 className="font-display text-5xl uppercase leading-none tracking-wide md:text-6xl">
                Value deals
              </h2>
              <p className="mt-3 max-w-sm font-cond text-lg font-semibold">
                Choice of pizzas only from the regular menu — every deal comes with a
                1 litre Pepsi.
              </p>
            </Reveal>
            <div className="grid gap-3">
              {VALUE_DEALS.map((d, i) => (
                <Reveal key={d.name} delay={i * 70}>
                  <Link
                    href="/menu#value-deals"
                    className="flex items-center gap-4 rounded-2xl bg-ink px-5 py-4 text-cream transition-transform hover:scale-[1.01]"
                  >
                    <span className="font-display text-3xl text-cheese/50">0{i + 1}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block font-display text-2xl uppercase tracking-wide">{d.name}</span>
                      <span className="block font-cond text-sm font-semibold uppercase tracking-wide text-cream/65">
                        {d.what}
                      </span>
                    </span>
                    <span className="rounded-full bg-cheese px-4 py-1.5 font-cond text-lg font-extrabold text-ink">
                      {formatCents(d.priceRs * 100)}
                    </span>
                  </Link>
                </Reveal>
              ))}
            </div>
          </div>
        </section>

        {/* ============================ DELIVERY =========================== */}
        <section className="bg-paper text-ink">
          <div className="mx-auto max-w-6xl px-4 py-20 md:py-24">
            <Reveal>
              <p className="font-cond text-sm font-bold uppercase tracking-[0.24em] text-cheese-deep">
                Delivery
              </p>
              <h2 className="mt-2 max-w-3xl font-display text-5xl uppercase tracking-wide md:text-6xl">
                All over DHA &amp; Clifton
              </h2>
              <p className="mt-4 max-w-2xl leading-relaxed text-ink/70">
                Our kitchen is in Rahat Commercial Area, DHA Phase 6. Pick your area at
                checkout and the delivery charge is added for you — we don&rsquo;t take
                online orders outside DHA and Clifton.
              </p>
            </Reveal>
            <div className="mt-10 grid gap-10 lg:grid-cols-[1.15fr_0.85fr]">
              <div>
                <div className="grid gap-3 sm:grid-cols-2">
                  {FEE_SUMMARY.map((f, i) => (
                    <Reveal key={f.feeCents} delay={i * 60}>
                      <div className="h-full rounded-3xl border-2 border-ink bg-white p-5">
                        <div className="font-display text-5xl tracking-wide">{formatCents(f.feeCents)}</div>
                        <div className="mt-2 font-cond text-lg font-bold uppercase leading-snug">{f.places}</div>
                      </div>
                    </Reveal>
                  ))}
                </div>
                <div className="mt-6 flex flex-wrap gap-2">
                  {DELIVERY_AREAS.map((area) => (
                    <Link
                      key={area.slug}
                      href={`/delivery/${area.slug}`}
                      className="rounded-full border border-ink/15 bg-white px-4 py-2 font-cond text-base font-bold uppercase tracking-wide transition-colors hover:border-ink hover:bg-ink hover:text-cheese"
                    >
                      {area.name} <span className="font-semibold text-ink/50">· {feeText(area)}</span>
                    </Link>
                  ))}
                </div>
              </div>
              <Reveal delay={100}>
                <div className="overflow-hidden rounded-3xl border-2 border-ink">
                  <iframe
                    title="Cheese O'Clock, Rahat Commercial Area, DHA Phase 6, Karachi on Google Maps"
                    src={`https://maps.google.com/maps?q=${BUSINESS.latitude},${BUSINESS.longitude}&z=15&output=embed`}
                    width="600"
                    height="380"
                    loading="lazy"
                    referrerPolicy="no-referrer-when-downgrade"
                    className="h-[380px] w-full border-0"
                  />
                </div>
                <address className="mt-3 text-center text-sm not-italic text-ink/65">
                  {BUSINESS.streetAddress}, {BUSINESS.locality} · {BUSINESS.hours}
                </address>
              </Reveal>
            </div>
          </div>
        </section>

        {/* =========================== HOW IT WORKS ======================== */}
        <section className="bg-ink">
          <div className="mx-auto max-w-6xl px-4 py-20 md:py-24">
            <Reveal>
              <p className="font-cond text-sm font-bold uppercase tracking-[0.24em] text-cheese">
                How it works
              </p>
              <h2 className="mt-2 font-display text-5xl uppercase tracking-wide text-cream md:text-6xl">
                Oven to door in three steps
              </h2>
            </Reveal>
            <div className="mt-10 grid gap-5 md:grid-cols-3">
              {STEPS.map((s, i) => (
                <Reveal key={s.n} delay={i * 80}>
                  <div className="h-full rounded-3xl border border-cream/10 bg-night-card p-6 transition-colors hover:border-cheese/40">
                    <div className="font-display text-5xl text-cheese/40">{s.n}</div>
                    <h3 className="mt-3 font-cond text-2xl font-bold uppercase tracking-wide text-cream">
                      {s.title}
                    </h3>
                    <p className="mt-2 text-sm leading-relaxed text-cream/60">{s.body}</p>
                  </div>
                </Reveal>
              ))}
            </div>
            <Reveal delay={120}>
              <div className="mt-12 grid gap-px overflow-hidden rounded-3xl border border-cream/10 bg-cream/10 sm:grid-cols-3">
                {[
                  ['12 noon – 1 am', 'open every day'],
                  ['From Rs 200', 'delivery in DHA & Clifton'],
                  ['Cash on delivery', 'pay the rider at your door'],
                ].map(([big, small]) => (
                  <div key={big} className="bg-night-soft px-6 py-8 text-center">
                    <div className="font-display text-4xl uppercase tracking-wide text-cheese">{big}</div>
                    <div className="mt-1 font-cond text-base font-semibold uppercase tracking-wide text-cream/55">
                      {small}
                    </div>
                  </div>
                ))}
              </div>
            </Reveal>
          </div>
        </section>

        {/* =============================== FAQ ============================= */}
        <section className="bg-ink">
          <div className="mx-auto max-w-3xl px-4 pb-20 md:pb-24">
            <Reveal>
              <h2 className="font-display text-5xl uppercase tracking-wide text-cream">
                Questions, answered
              </h2>
            </Reveal>
            <div className="mt-8 space-y-3">
              {FAQS.map((f, i) => (
                <Reveal key={f.q} delay={i * 50}>
                  <details className="group rounded-2xl border border-cream/10 bg-night-card open:border-cheese/40">
                    <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 font-cond text-xl font-bold uppercase tracking-wide text-cream [&::-webkit-details-marker]:hidden">
                      {f.q}
                      <span className="text-2xl text-cheese transition-transform group-open:rotate-45">+</span>
                    </summary>
                    <p className="px-5 pb-5 leading-relaxed text-cream/65">{f.a}</p>
                  </details>
                </Reveal>
              ))}
            </div>
          </div>
        </section>

        {/* ============================ FINAL CTA ========================== */}
        <section className="bg-cheese">
          <div className="mx-auto flex max-w-6xl flex-col items-center gap-6 px-4 py-16 text-center md:py-20">
            <h2 className="font-display text-[clamp(3rem,8vw,6rem)] uppercase leading-[0.92] tracking-wide text-ink">
              Hungry? It&rsquo;s Cheese O&rsquo;Clock.
            </h2>
            <div className="flex flex-wrap justify-center gap-3">
              <Link
                href="/menu"
                className="rounded-full bg-ink px-9 py-4 font-display text-2xl uppercase tracking-wide text-cheese shadow-soft-lg transition-transform hover:scale-105 active:scale-95"
              >
                Order now →
              </Link>
              {BUSINESS.whatsappLines.map((l) => (
                <a
                  key={l.url}
                  href={`${l.url}?text=${encodeURIComponent("Hi Cheese O'Clock! I'd like to place an order: ")}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-2 rounded-full border-2 border-ink/30 px-6 py-4 font-cond text-lg font-bold uppercase tracking-wide text-ink transition-colors hover:border-ink active:scale-95"
                >
                  <WhatsAppGlyph className="h-5 w-5" /> {l.display}
                </a>
              ))}
            </div>
            <p className="font-cond text-base font-bold uppercase tracking-wide text-ink/70">
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
