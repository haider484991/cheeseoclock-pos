import type { Metadata } from 'next';
import Link from 'next/link';
import { SiteHeader, SiteFooter } from '@/components/SiteChrome';
import { OrderCtaBand } from '@/components/OrderCtaBand';
import { WhatsAppFab } from '@/components/WhatsAppFab';
import { Reveal } from '@/components/Reveal';
import { ShowcaseVisual } from '@/components/ShowcaseVisual';
import { CheeseTime } from '@/components/CheeseTime';
import { DELIVERY_AREAS, feeText } from '@/lib/areas';
import { copyText, type CopyFacts } from '@/lib/delivery-facts';
import {
  LATE_NIGHT_COVERAGE,
  LATE_NIGHT_CTA,
  LATE_NIGHT_DESCRIPTION,
  LATE_NIGHT_FAQ_AREAS,
  LATE_NIGHT_FAQ_AREAS_Q,
  LATE_NIGHT_FAQ_HOW_LATE,
  LATE_NIGHT_FAQ_PAY,
  LATE_NIGHT_FAQ_WHATSAPP,
  LATE_NIGHT_H1,
  LATE_NIGHT_INTRO,
  LATE_NIGHT_INTRO_ORDER,
  LATE_NIGHT_PAGE_DESCRIPTION,
  LATE_NIGHT_PICK_BIG,
  LATE_NIGHT_PICK_BODY,
  LATE_NIGHT_PICK_SMALL,
  LATE_NIGHT_PICK_TITLE,
  LATE_NIGHT_PICKS_HEADING,
  LATE_NIGHT_WINGS_BODY,
  LATE_NIGHT_TITLE,
  WA_LATE_NIGHT,
} from '@/lib/page-copy';
import { JsonLd, webPageNode } from '@/lib/seo';
import { getCopyFacts } from '@/lib/site-facts';

/**
 * Static, refreshed from the owner's delivery settings (lib/site-facts): at
 * build, whenever a till publishes (api/bridge/menu revalidates), and at
 * least hourly. force-static keeps the settings read (a no-store fetch) from
 * turning the page dynamic.
 */
export const dynamic = 'force-static';
export const revalidate = 3600;

/**
 * The title, the H1 and the text name the owner's closing time. The page's
 * premise ("past midnight") holds only while the shop closes after midnight
 * ({ closesAfterMidnight }): otherwise it reads without it. The slug stays.
 */
export async function generateMetadata(): Promise<Metadata> {
  const facts = await getCopyFacts();
  return {
    title: copyText(LATE_NIGHT_TITLE, facts),
    description: copyText(LATE_NIGHT_DESCRIPTION, facts),
    alternates: { canonical: '/late-night-food-delivery-dha' },
  };
}

const NIGHT_PICKS = (facts: CopyFacts) => [
  {
    img: '/images/menu/cheesy-star.webp' as string | null,
    alt: 'Cheesy Star signature pizza',
    fallback: { big: copyText(LATE_NIGHT_PICK_BIG, facts), small: copyText(LATE_NIGHT_PICK_SMALL, facts) },
    title: copyText(LATE_NIGHT_PICK_TITLE, facts),
    body: copyText(LATE_NIGHT_PICK_BODY, facts),
  },
  {
    img: null as string | null,
    alt: 'Signature Masala Fries',
    fallback: { big: 'Masala fries', small: 'Large · from Rs 480' },
    title: 'Masala fries',
    body: 'Signature Masala or Mayo Masala Fries — exam season, match nights, post-shaadi hunger, the fries show up for all of it.',
  },
  {
    img: null as string | null,
    alt: 'Six oven-baked chicken wings',
    fallback: { big: '6 wings', small: 'Oven-baked · with a dip' },
    title: 'Baked wings',
    body: copyText(LATE_NIGHT_WINGS_BODY, facts),
  },
];

const FAQS = [
  {
    q: 'How late can I actually order?',
    a: LATE_NIGHT_FAQ_HOW_LATE,
  },
  {
    q: 'Can I order on WhatsApp late at night?',
    a: LATE_NIGHT_FAQ_WHATSAPP,
  },
  {
    q: LATE_NIGHT_FAQ_AREAS_Q,
    a: LATE_NIGHT_FAQ_AREAS,
  },
  {
    q: 'How do I pay late at night?',
    a: LATE_NIGHT_FAQ_PAY,
  },
];

export default async function LateNightPage() {
  const facts = await getCopyFacts();
  const faqs = FAQS.map((f) => ({ q: copyText(f.q, facts), a: copyText(f.a, facts) }));
  return (
    <>
      <SiteHeader />
      <main>
        <section className="mx-auto max-w-4xl px-4 pb-4 pt-12">
          <nav aria-label="Breadcrumb" className="text-sm text-smoke">
            <Link href="/" className="hover:text-cheese">
              Home
            </Link>{' '}
            / <span className="text-cream/80">Late-night delivery</span>
          </nav>
          <h1 className="mt-4 font-display text-4xl leading-[0.95] tracking-wide text-cream md:text-6xl">
            {copyText(LATE_NIGHT_H1, facts).toUpperCase()}
          </h1>
          <CheeseTime className="mt-4 text-sm text-smoke" />
          <p className="mt-4 leading-relaxed text-cream/80">{copyText(LATE_NIGHT_INTRO, facts)}</p>
          <p className="mt-4 leading-relaxed text-cream/80">{copyText(LATE_NIGHT_INTRO_ORDER, facts)}</p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link
              href="/menu"
              className="rounded-full bg-cheese px-8 py-3.5 font-display text-xl tracking-wide text-night shadow-glow transition-all hover:bg-cheese-hot hover:shadow-glow-lg active:scale-95"
            >
              ORDER NOW →
            </Link>
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-4 py-12">
          <Reveal>
            <h2 className="font-display text-3xl tracking-wide text-cream">
              {copyText(LATE_NIGHT_PICKS_HEADING, facts)}
            </h2>
          </Reveal>
          <div className="mt-5 grid gap-5 md:grid-cols-3">
            {NIGHT_PICKS(facts).map((w, i) => (
              <Reveal key={w.title} delay={i * 80}>
                <div className="h-full overflow-hidden rounded-2xl border border-white/10 bg-night-card">
                  <ShowcaseVisual img={w.img} alt={w.alt} fallback={w.fallback} />
                  <div className="p-5">
                    <h3 className="text-lg font-bold text-cream">{w.title}</h3>
                    <p className="mt-1 text-sm leading-relaxed text-smoke">{w.body}</p>
                  </div>
                </div>
              </Reveal>
            ))}
          </div>
        </section>

        <section className="mx-auto max-w-4xl px-4 py-8">
          <Reveal>
            <h2 className="font-display text-3xl tracking-wide text-cream">
              LATE-NIGHT COVERAGE
            </h2>
            <p className="mt-3 text-smoke">
              {copyText(LATE_NIGHT_COVERAGE, facts)}
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              {DELIVERY_AREAS.map((a) => (
                <Link
                  key={a.slug}
                  href={`/delivery/${a.slug}`}
                  className="rounded-full border border-white/15 px-4 py-2 text-sm font-semibold text-cream/80 transition-colors hover:border-cheese/60 hover:text-cheese"
                >
                  {a.name} · {feeText(a, facts)}
                </Link>
              ))}
            </div>
          </Reveal>

          <Reveal>
            <div className="mt-12">
              <h2 className="font-display text-3xl tracking-wide text-cream">
                LATE-NIGHT FAQS
              </h2>
              <div className="mt-4 space-y-3">
                {faqs.map((f) => (
                  <details
                    key={f.q}
                    className="group rounded-2xl border border-white/10 bg-night-card open:border-cheese/40"
                  >
                    <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 font-bold text-cream [&::-webkit-details-marker]:hidden">
                      {f.q}
                      <span className="text-cheese transition-transform group-open:rotate-45">+</span>
                    </summary>
                    <p className="px-5 pb-5 text-sm leading-relaxed text-smoke">{f.a}</p>
                  </details>
                ))}
              </div>
            </div>
          </Reveal>
        </section>

        <OrderCtaBand heading={copyText(LATE_NIGHT_CTA, facts).toUpperCase()} waMessage={copyText(WA_LATE_NIGHT, facts)} />
      </main>
      <SiteFooter />
      <WhatsAppFab />
      <JsonLd
        nodes={webPageNode({
          path: '/late-night-food-delivery-dha',
          name: 'Late-Night Food Delivery in DHA Karachi',
          description: copyText(LATE_NIGHT_PAGE_DESCRIPTION, facts),
          breadcrumb: [
            { name: 'Home', path: '/' },
            { name: 'Late-night delivery', path: '/late-night-food-delivery-dha' },
          ],
        })}
      />
    </>
  );
}
