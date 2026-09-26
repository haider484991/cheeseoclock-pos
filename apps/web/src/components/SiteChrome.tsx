import Link from 'next/link';
import { BUSINESS } from '@/lib/business';
import { BrandMark } from './BrandMark';
import { RecentOrderLink } from './RecentOrderLink';

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-b border-white/10 bg-night/85 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-2 px-4 sm:h-[4.5rem]">
        <Link href="/" aria-label="Cheese O'Clock home" className="shrink-0">
          <BrandMark className="!h-9 sm:!h-10" />
        </Link>
        <nav aria-label="Main" className="flex items-center gap-0.5 text-sm font-semibold sm:gap-1">
          <RecentOrderLink />
          <Link
            href="/menu"
            className="rounded-lg px-2.5 py-2 text-cream/80 transition-colors hover:bg-white/5 hover:text-cheese max-[359px]:hidden sm:px-3"
          >
            Menu
          </Link>
          <Link
            href="/delivery"
            className="hidden rounded-lg px-3 py-2 text-cream/80 transition-colors hover:bg-white/5 hover:text-cheese sm:block"
          >
            Delivery areas
          </Link>
          <a
            href={BUSINESS.whatsappUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="hidden rounded-lg px-3 py-2 text-cream/80 transition-colors hover:bg-white/5 hover:text-cheese md:block"
          >
            WhatsApp
          </a>
          <Link
            href="/menu"
            className="ml-1 whitespace-nowrap rounded-full bg-cheese px-4 py-2.5 font-display text-base tracking-wide text-night shadow-glow transition-all hover:bg-cheese-hot hover:shadow-glow-lg active:scale-95 sm:ml-2 sm:px-5"
          >
            ORDER NOW
          </Link>
        </nav>
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="border-t border-white/10 bg-night-soft">
      <div className="mx-auto grid max-w-6xl gap-10 px-4 py-12 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <BrandMark className="!h-11" />
          <p className="mt-4 max-w-xs font-cond text-lg font-semibold italic text-cream/85">
            {BUSINESS.tagline}
          </p>
          <p className="mt-2 max-w-xs text-sm leading-relaxed text-smoke">
            Signature pizzas, crispy chicken burgers and fries, made to order in
            DHA Phase 6 and delivered all over DHA &amp; Clifton.
          </p>
          <p className="mt-4 inline-flex items-center gap-2 rounded-full border border-cheese/30 bg-cheese/10 px-3 py-1.5 font-cond text-sm font-bold uppercase tracking-wide text-cheese">
            Cash on delivery · 15% tax on the bill
          </p>
        </div>

        <div className="text-sm">
          <h3 className="mb-3 font-display text-lg tracking-wide text-cheese">
            FIND US
          </h3>
          <address className="not-italic leading-relaxed text-cream/80">
            {BUSINESS.name}
            <br />
            {BUSINESS.streetAddress},
            <br />
            {BUSINESS.locality} {BUSINESS.postalCode}, {BUSINESS.region}, Pakistan
          </address>
          <p className="mt-2 text-cream/80">{BUSINESS.hours}</p>
          <a
            href={BUSINESS.mapsUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 inline-block font-semibold text-cheese hover:text-cheese-hot"
          >
            Open in Google Maps →
          </a>
        </div>

        <div className="text-sm">
          <h3 className="mb-3 font-display text-lg tracking-wide text-cheese">
            ORDER &amp; CONTACT
          </h3>
          <ul className="space-y-2 text-cream/80">
            <li>
              <Link href="/menu" className="hover:text-cheese">
                Order online — full menu
              </Link>
            </li>
            {BUSINESS.whatsappLines.map((l) => (
              <li key={l.url}>
                <a href={l.url} target="_blank" rel="noopener noreferrer" className="hover:text-cheese">
                  WhatsApp {l.display}
                </a>
              </li>
            ))}
            <li>
              <a href={`tel:${BUSINESS.phoneE164}`} className="hover:text-cheese">
                Call {BUSINESS.phoneDisplay}
              </a>
            </li>
          </ul>
        </div>

        <div className="text-sm">
          <h3 className="mb-3 font-display text-lg tracking-wide text-cheese">
            DELIVERY
          </h3>
          <ul className="space-y-2 text-cream/80">
            <li>
              <Link href="/delivery" className="hover:text-cheese">
                All delivery areas
              </Link>
            </li>
            <li>
              <Link href="/pizza-delivery-dha-karachi" className="hover:text-cheese">
                Pizza delivery in DHA
              </Link>
            </li>
            <li>
              <Link href="/burger-delivery-dha-karachi" className="hover:text-cheese">
                Burger delivery in DHA
              </Link>
            </li>
            <li>
              <Link href="/late-night-food-delivery-dha" className="hover:text-cheese">
                Late-night delivery (till 1 am)
              </Link>
            </li>
          </ul>
        </div>
      </div>
      <div className="border-t border-white/5 py-4 text-center text-xs text-smoke">
        © {new Date().getFullYear()} {BUSINESS.name} · {BUSINESS.addressLine} ·{' '}
        {BUSINESS.phoneDisplay}
      </div>
    </footer>
  );
}
