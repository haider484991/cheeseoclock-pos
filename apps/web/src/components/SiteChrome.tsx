import Link from 'next/link';
import { socialLabel } from '@cheeseoclock/shared-types';
import { BUSINESS } from '@/lib/business';
import { copyText, shopOf } from '@/lib/delivery-facts';
import { FOOTER_LATE_LINK, FOOTER_PAY_CHIP } from '@/lib/page-copy';
import { orderLine, shopHoursLine, shopTelUrl, whatsappLinesOf } from '@/lib/shop-facts';
import { getCopyFacts } from '@/lib/site-facts';
import { BrandMark } from './BrandMark';
import { RecentOrderLink } from './RecentOrderLink';

/**
 * The header and footer on every page, with the shop's details from the
 * owner's settings (lib/site-facts getCopyFacts — one read per page, shared
 * with the root layout and the page): today's with none stored.
 */
export async function SiteHeader() {
  const shop = shopOf(await getCopyFacts());
  return (
    <header className="sticky top-0 z-40 border-b border-white/10 bg-night/85 backdrop-blur-md">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-2 px-4 sm:h-[4.5rem]">
        <Link href="/" aria-label={`${shop.profile.name} home`} className="shrink-0">
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
            href={orderLine(shop).url}
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

export async function SiteFooter() {
  const facts = await getCopyFacts();
  const shop = shopOf(facts);
  const { profile } = shop;
  return (
    <footer className="border-t border-white/10 bg-night-soft">
      <div className="mx-auto grid max-w-6xl gap-10 px-4 py-12 sm:grid-cols-2 lg:grid-cols-4">
        <div>
          <BrandMark className="!h-11" />
          {profile.tagline && (
            <p className="mt-4 max-w-xs font-cond text-lg font-semibold italic text-cream/85">
              {profile.tagline}
            </p>
          )}
          <p className="mt-2 max-w-xs text-sm leading-relaxed text-smoke">
            Signature pizzas, crispy chicken burgers and fries, made to order in
            DHA Phase 6 and delivered all over DHA &amp; Clifton.
          </p>
          <p className="mt-4 inline-flex items-center gap-2 rounded-full border border-cheese/30 bg-cheese/10 px-3 py-1.5 font-cond text-sm font-bold uppercase tracking-wide text-cheese">
            {copyText(FOOTER_PAY_CHIP, facts)}
          </p>
        </div>

        <div className="text-sm">
          <h3 className="mb-3 font-display text-lg tracking-wide text-cheese">
            FIND US
          </h3>
          <address className="not-italic leading-relaxed text-cream/80">
            {profile.name}
            <br />
            {profile.address.street},
            <br />
            {BUSINESS.locality} {profile.address.postalCode}, {BUSINESS.region}, Pakistan
          </address>
          <p className="mt-2 text-cream/80">{shopHoursLine(shop)}</p>
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
            {whatsappLinesOf(shop).map((l) => (
              <li key={l.url}>
                <a href={l.url} target="_blank" rel="noopener noreferrer" className="hover:text-cheese">
                  WhatsApp {l.display}
                </a>
              </li>
            ))}
            <li>
              <a href={shopTelUrl(shop)} className="hover:text-cheese">
                Call {profile.phone.display}
              </a>
            </li>
          </ul>
          {/* The owner's live profiles (Settings), only when there are some: JSON-LD sameAs names the same ones. */}
          {profile.socialLinks.length > 0 && (
            <ul aria-label="Follow us" className="mt-4 flex flex-wrap gap-x-4 gap-y-2 text-cream/80">
              {profile.socialLinks.map((url) => (
                <li key={url}>
                  <a href={url} target="_blank" rel="noopener noreferrer me" className="font-semibold text-cheese hover:text-cheese-hot">
                    {socialLabel(url)} →
                  </a>
                </li>
              ))}
            </ul>
          )}
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
                {copyText(FOOTER_LATE_LINK, facts)}
              </Link>
            </li>
          </ul>
        </div>
      </div>
      <div className="border-t border-white/5 py-4 text-center text-xs text-smoke">
        © {new Date().getFullYear()} {profile.name} · {profile.address.areaLine} ·{' '}
        {profile.phone.display} ·{' '}
        {/* The owner's and managers' phone dashboard: a plain link (a whole page load) that crawlers don't follow. */}
        <a href="/dashboard" rel="nofollow" className="hover:text-cheese">
          Staff login
        </a>
      </div>
    </footer>
  );
}
