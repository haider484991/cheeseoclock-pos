import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { SiteHeader, SiteFooter } from '@/components/SiteChrome';
import { OrderCtaBand } from '@/components/OrderCtaBand';
import { WhatsAppFab } from '@/components/WhatsAppFab';
import { Reveal } from '@/components/Reveal';
import { BUSINESS, waLink } from '@/lib/business';
import { DELIVERY_AREAS, getArea, etaText } from '@/lib/areas';
import { JsonLd, webPageNode } from '@/lib/seo';

export const dynamicParams = false;

export function generateStaticParams() {
  return DELIVERY_AREAS.map((a) => ({ area: a.slug }));
}

export function generateMetadata({
  params,
}: {
  params: { area: string };
}): Metadata {
  const area = getArea(params.area);
  if (!area) return {};
  return {
    title: area.title,
    description: area.description,
    alternates: { canonical: `/delivery/${area.slug}` },
    openGraph: {
      title: `${area.title} · ${BUSINESS.name}`,
      description: area.description,
      url: `/delivery/${area.slug}`,
      type: 'website',
    },
  };
}

export default function AreaPage({ params }: { params: { area: string } }) {
  const area = getArea(params.area);
  if (!area) notFound();

  const adjacent = area.adjacent
    .map((slug) => getArea(slug))
    .filter((a): a is NonNullable<typeof a> => Boolean(a));

  const waMessage = `Hi Cheese O'Clock! I'd like to order in ${area.name}. `;

  return (
    <>
      <SiteHeader />
      <main>
        <article className="mx-auto max-w-4xl px-4 pb-16 pt-12">
          <nav aria-label="Breadcrumb" className="text-sm text-smoke">
            <Link href="/" className="hover:text-cheese">
              Home
            </Link>{' '}
            /{' '}
            <Link href="/delivery" className="hover:text-cheese">
              Delivery areas
            </Link>{' '}
            / <span className="text-cream/80">{area.name}</span>
          </nav>

          <h1 className="mt-4 font-display text-4xl leading-[0.95] tracking-wide text-cream md:text-6xl">
            {area.h1.toUpperCase()}
          </h1>

          <ul className="mt-6 flex flex-wrap gap-2 text-sm font-bold">
            <li className="rounded-full bg-cheese px-4 py-2 text-night">
              🛵 {etaText(area)} to your door
            </li>
            <li className="rounded-full border border-white/15 px-4 py-2 text-cream/80">
              💵 Cash on delivery
            </li>
            <li className="rounded-full border border-white/15 px-4 py-2 text-cream/80">
              🌙 Daily 12pm – 2am
            </li>
          </ul>

          {area.intro.map((p) => (
            <p key={p.slice(0, 24)} className="mt-5 leading-relaxed text-cream/80">
              {p}
            </p>
          ))}

          <div className="mt-8 flex flex-wrap gap-3">
            <Link
              href="/menu"
              className="rounded-full bg-cheese px-8 py-3.5 font-display text-xl tracking-wide text-night shadow-glow transition-all hover:bg-cheese-hot hover:shadow-glow-lg active:scale-95"
            >
              ORDER NOW →
            </Link>
            <a
              href={waLink(waMessage)}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-full border border-white/20 px-7 py-3.5 font-bold text-cream transition-colors hover:border-cheese/60 hover:text-cheese"
            >
              💬 WhatsApp your order
            </a>
          </div>

          {/* Coverage */}
          <Reveal>
            <section className="mt-12">
              <h2 className="font-display text-3xl tracking-wide text-cream">
                STREETS &amp; SPOTS WE COVER IN {area.name.toUpperCase()}
              </h2>
              <ul className="mt-4 flex flex-wrap gap-2">
                {area.landmarks.map((l) => (
                  <li
                    key={l}
                    className="rounded-full border border-white/10 bg-night-card px-4 py-2 text-sm font-semibold text-cream/80"
                  >
                    📍 {l}
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-sm text-smoke">
                Not sure about your street?{' '}
                <a
                  href={waLink(`Hi! Do you deliver to my address in ${area.name}? `)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-semibold text-cheese hover:text-cheese-hot"
                >
                  Ask on WhatsApp
                </a>{' '}
                — we answer in a minute.
              </p>
            </section>
          </Reveal>

          {/* Popular */}
          <Reveal>
            <section className="mt-12">
              <h2 className="font-display text-3xl tracking-wide text-cream">
                WHAT {area.name.toUpperCase()} ORDERS MOST
              </h2>
              <div className="mt-4 grid gap-3 sm:grid-cols-3">
                {area.popular.map((p) => (
                  <Link
                    key={p.name}
                    href="/menu"
                    className="group rounded-2xl border border-white/10 bg-night-card p-5 transition-colors hover:border-cheese/50"
                  >
                    <h3 className="font-bold text-cream">{p.name}</h3>
                    <p className="mt-1 text-sm leading-relaxed text-smoke">{p.blurb}</p>
                    <p className="mt-3 text-sm font-bold text-cheese opacity-0 transition-opacity group-hover:opacity-100">
                      See it on the menu →
                    </p>
                  </Link>
                ))}
              </div>
            </section>
          </Reveal>

          {/* FAQ */}
          <Reveal>
            <section className="mt-12">
              <h2 className="font-display text-3xl tracking-wide text-cream">
                {area.name.toUpperCase()} DELIVERY — QUESTIONS, ANSWERED
              </h2>
              <div className="mt-4 space-y-3">
                {area.faqs.map((f) => (
                  <details
                    key={f.q}
                    className="group rounded-2xl border border-white/10 bg-night-card open:border-cheese/40"
                  >
                    <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 font-bold text-cream [&::-webkit-details-marker]:hidden">
                      {f.q}
                      <span className="text-cheese transition-transform group-open:rotate-45">
                        +
                      </span>
                    </summary>
                    <p className="px-5 pb-5 text-sm leading-relaxed text-smoke">{f.a}</p>
                  </details>
                ))}
              </div>
            </section>
          </Reveal>

          {/* Adjacent areas */}
          {adjacent.length > 0 && (
            <Reveal>
              <section className="mt-12">
                <h2 className="text-sm font-bold uppercase tracking-[0.2em] text-smoke">
                  Nearby delivery areas
                </h2>
                <div className="mt-3 flex flex-wrap gap-2">
                  {adjacent.map((a) => (
                    <Link
                      key={a.slug}
                      href={`/delivery/${a.slug}`}
                      className="rounded-full border border-white/15 px-4 py-2 text-sm font-semibold text-cream/80 transition-colors hover:border-cheese/60 hover:text-cheese"
                    >
                      {a.name} · {etaText(a)}
                    </Link>
                  ))}
                  <Link
                    href="/delivery"
                    className="rounded-full border border-white/15 px-4 py-2 text-sm font-semibold text-cream/80 transition-colors hover:border-cheese/60 hover:text-cheese"
                  >
                    All areas →
                  </Link>
                </div>
              </section>
            </Reveal>
          )}
        </article>

        <OrderCtaBand
          heading={`HUNGRY IN ${area.name.toUpperCase()}? IT'S CHEESE O'CLOCK.`}
          waMessage={waMessage}
        />
      </main>
      <SiteFooter />
      <WhatsAppFab />
      <JsonLd
        nodes={webPageNode({
          path: `/delivery/${area.slug}`,
          name: area.title,
          description: area.description,
          breadcrumb: [
            { name: 'Home', path: '/' },
            { name: 'Delivery areas', path: '/delivery' },
            { name: area.name, path: `/delivery/${area.slug}` },
          ],
        })}
      />
    </>
  );
}
