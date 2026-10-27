import type { Metadata } from 'next';
import Link from 'next/link';
import { SiteHeader, SiteFooter } from '@/components/SiteChrome';
import { BUSINESS } from '@/lib/business';
import { orderLine, orderWhatsappUrl } from '@/lib/shop-facts';
import { getShopFacts, requireStoredFacts } from '@/lib/site-facts';

/**
 * The privacy policy (26 Oct 2026, the user: "Add a short privacy policy page to cheeseoclock.net"): what an order
 * collects and why, the Meta Pixel and Google Analytics (Vercel Analytics until 27 Oct 2026), and how to have it deleted (#delete, also the data deletion
 * instructions for the shop's Meta app). Built once like /_not-found: the header and footer read the shop's details.
 * Not in the sitemap, so the routes golden is unchanged.
 */
export const dynamic = 'force-static';

export const metadata: Metadata = {
  title: 'Privacy policy',
  description: 'What we collect when you order, why, who sees it, and how to have it deleted.',
  alternates: { canonical: '/privacy' },
};

const UPDATED = '27 October 2026';

export default async function PrivacyPage() {
  await requireStoredFacts();
  const shop = await getShopFacts();
  const line = orderLine(shop);
  const name = shop.profile.name;
  return (
    <>
      <SiteHeader />
      <main className="mx-auto max-w-2xl px-4 py-12 text-cream/80 [&_h2]:mt-8 [&_h2]:font-cond [&_h2]:text-xl [&_h2]:font-bold [&_h2]:uppercase [&_h2]:tracking-wide [&_h2]:text-cream [&_li]:mt-1.5 [&_p]:mt-3 [&_ul]:mt-3 [&_ul]:list-disc [&_ul]:pl-5">
        <p className="font-cond text-sm font-bold uppercase tracking-[0.24em] text-cheese">Last updated {UPDATED}</p>
        <h1 className="mt-2 font-display text-5xl uppercase leading-none tracking-wide text-cream">Privacy policy</h1>
        <p>
          {name} makes and delivers food in DHA and Clifton, Karachi, and is run by {BUSINESS.legalName}. This page says
          what we collect when you use{' '}
          <Link href="/" className="text-cheese underline underline-offset-4">cheeseoclock.net</Link> or order from us, why,
          and how to have it deleted. We don’t sell your details to anyone.
        </p>

        <h2>What we collect</h2>
        <ul>
          <li>
            <strong className="text-cream">Your order:</strong> what you ordered, your name, mobile number, and for a
            delivery your address, area, any directions and, if you choose to share it, a map pin.
          </li>
          <li>
            <strong className="text-cream">Your Instagram or Facebook name</strong>, only if you give it (for example for
            the Buy 1 Get 1 tag-us offer).
          </li>
          <li>
            <strong className="text-cream">If you message us on WhatsApp:</strong> your WhatsApp number and name, when
            you wrote, and which of our ads brought you, if one did. Not what you wrote: your messages stay in WhatsApp.
            We may reply once a day with your own order link, which fills in your name and number at checkout. If you
            order in the chat, the details you give there (address, name, a note) are kept with your order, as on the
            website, and we message you there as it is confirmed and sent out.
          </li>
          <li>
            <strong className="text-cream">On your phone only:</strong> if you tick “Remember my details”, your name,
            number and address are kept in your browser for next time. Your area choice and cart are kept there too. We
            never see these until you order.
          </li>
          <li>
            <strong className="text-cream">How the site is used:</strong> pages visited and steps like “added to cart”,
            through Google Analytics and the Meta Pixel (both below).
          </li>
        </ul>

        <h2>Why we use it</h2>
        <ul>
          <li>To make your order, deliver it, and call you about it (for example to confirm a new number or an address).</li>
          <li>To show you the order’s progress on its tracking page.</li>
          <li>To keep the shop’s sales and tax records.</li>
          <li>To see which of our ads lead to orders, so we spend less on ads that don’t work.</li>
        </ul>

        <h2>Google Analytics</h2>
        <p>
          The site uses Google Analytics to count visits, the pages seen and the steps of an order (added to cart,
          checkout opened, order placed). It never receives your name, number or address, and nothing is sent from an
          order’s tracking page. Google Analytics sets its own cookies (named _ga) to tell one visit from the next; you
          can block them in your browser or with{' '}
          <a
            href="https://tools.google.com/dlpage/gaoptout"
            className="text-cheese underline underline-offset-4"
            rel="noopener noreferrer"
            target="_blank"
          >
            Google’s opt-out add-on
          </a>
          .
        </p>

        <h2>Meta (Facebook, Instagram and WhatsApp)</h2>
        <p>
          The site uses the Meta Pixel and Meta’s Conversions API. They tell Meta when someone visits, adds to the cart,
          starts checkout or orders, so Meta can measure our ads. With an order we send your phone number and name only
          in a scrambled (hashed) form that cannot be read back, plus the order’s value. We do the same for an order you
          place at the shop, by phone or on WhatsApp when you give us your number. Meta may set its own cookies;
          you can limit this in your Facebook and Instagram ad settings or by blocking cookies in your browser.
        </p>

        <h2>Who sees it</h2>
        <ul>
          <li>Our staff and riders, to make and deliver your order.</li>
          <li>The companies that host the website and its database, only to run it for us.</li>
          <li>Google and Meta, as described above.</li>
        </ul>

        <h2>How long we keep it</h2>
        <p>
          Orders stay in our records for as long as the law needs them for sales and tax. Your saved details stay on your
          phone until you tap “Forget saved details” at checkout or clear your browser.
        </p>

        <h2 id="delete">Deleting your data</h2>
        <p>
          To see or delete what we hold about you, email{' '}
          <a href={`mailto:${BUSINESS.email}`} className="text-cheese underline underline-offset-4">{BUSINESS.email}</a>{' '}
          or send us a WhatsApp on{' '}
          <a href={orderWhatsappUrl(shop)} target="_blank" rel="noopener noreferrer" className="text-cheese underline underline-offset-4">
            {line.display}
          </a>{' '}
          with the number you ordered from. We’ll delete it within 30 days, except what the law makes us keep for tax.
          Details saved on your phone you can delete yourself with “Forget saved details” at checkout.
        </p>

        <h2>Children</h2>
        <p>The site isn’t meant for children under 13, and we don’t knowingly collect their details.</p>

        <h2>Changes</h2>
        <p>If this policy changes, this page will say so and show the new date at the top.</p>
      </main>
      <SiteFooter />
    </>
  );
}
