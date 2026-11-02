import Link from 'next/link';
import { socialLabel } from '@cheeseoclock/shared-types';
import { BUSINESS } from '@/lib/business';
import { copyText, shopOf } from '@/lib/delivery-facts';
import { FOOTER_LATE_LINK, FOOTER_PAY_CHIP } from '@/lib/page-copy';
import { orderLine, shopHoursLine, shopTelUrl, whatsappLinesOf } from '@/lib/shop-facts';
import { getCopyFacts } from '@/lib/site-facts';
import { BrandMark } from './BrandMark';
import { LocationChip } from './location/LocationChip';
import { NavMenu } from './NavMenu';
import { RecentOrderLink } from './RecentOrderLink';

/**
 * The header and footer on every page, with the shop's details from the
 * owner's settings (lib/site-facts getCopyFacts — one read per page, shared
 * with the root layout and the page): today's with none stored.
 *
 * The header (3 Nov 2026, the user: "logo at center beautifully and order now button on right side and other nav bar
 * links on left"): three columns of one bar — the links (a phone: the menu button, NavMenu), the logo in the middle
 * whatever the two sides hold, and the area with Order now.
 */
export async function SiteHeader() {
  const facts = await getCopyFacts();
  const shop = shopOf(facts);
  const zones = facts.zones.map((z) => ({ id: z.id, shortName: z.shortName }));
  const link = 'rounded-full px-3 py-2 font-cond text-base font-bold uppercase tracking-wide text-cream/80 transition-colors hover:bg-white/5 hover:text-cheese';
  return (
    <header className="sticky top-0 z-40 border-b border-white/10 bg-night/85 backdrop-blur-md">
      <div className="mx-auto grid h-16 max-w-6xl grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-3 px-4 sm:h-[4.75rem]">
        <nav aria-label="Main" className="flex min-w-0 items-center gap-0.5 justify-self-start">
          <NavMenu whatsappUrl={orderLine(shop).url} zones={zones} />
          <Link href="/menu" className={`hidden sm:block ${link}`}>
            Menu
          </Link>
          <Link href="/delivery" className={`hidden md:block ${link}`}>
            Delivery areas
          </Link>
          <a href={orderLine(shop).url} target="_blank" rel="noopener noreferrer" className={`hidden lg:block ${link}`}>
            WhatsApp
          </a>
          <span className="hidden sm:block">
            <RecentOrderLink />
          </span>
        </nav>
        <Link href="/" aria-label={`${shop.profile.name} home`} className="justify-self-center">
          <BrandMark className="!h-11 sm:!h-[3.25rem]" />
        </Link>
        <div className="flex items-center gap-2 justify-self-end">
          {/* The landing popup's area, and the way to change it (client only: nothing in the page's HTML). */}
          <span className="hidden sm:block">
            <LocationChip zones={zones} />
          </span>
          <Link
            href="/menu"
            className="whitespace-nowrap rounded-full bg-cheese px-4 py-2.5 font-display text-base tracking-wide text-night shadow-glow transition-all hover:bg-cheese-hot hover:shadow-glow-lg active:scale-95 sm:px-6 sm:text-lg"
          >
            ORDER NOW
          </Link>
        </div>
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
            <li>
              <a href={`mailto:${BUSINESS.email}`} className="hover:text-cheese">
                Email {BUSINESS.email}
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
        {' · '}
        {/* Credit for the ordering system that runs this site (2026-10-13, with the owner's OK): a followed link. */}
        <a href="https://pixelandoak.com/pos/online-ordering-system/" target="_blank" rel="noopener" className="hover:text-cheese">
          Ordering by Pixel &amp; Oak POS
        </a>
        {/* The company that runs the shop (26 Oct 2026): Meta's business verification needs its legal name on the site. */}
        <span className="mt-1 block">{`Operated by ${BUSINESS.legalName}`}</span>
      </div>
    </footer>
  );
}
