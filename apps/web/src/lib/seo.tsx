import type { PublishedMenu } from '@cheeseoclock/shared-types';
import { BUSINESS } from './business';
import { DELIVERY_AREAS } from './areas';

/**
 * JSON-LD builders for the local-SEO entity graph.
 *
 * Design notes (current Google policy, mid-2026):
 * - No `aggregateRating` on our own Restaurant node — self-serving review
 *   markup is ineligible for stars and can be flagged as abuse.
 * - No `FAQPage` markup — FAQ rich results were retired; FAQs stay as
 *   visible content where they still earn long-tail + AI-answer value.
 * - `OrderAction` is kept: harmless, and machine-readable ordering hints are
 *   increasingly read by AI assistants even though Order-with-Google is gone.
 * - JSON-LD must mirror VISIBLE page content only.
 */

export const SITE_URL = 'https://cheeseoclock.net';
const RESTAURANT_ID = `${SITE_URL}/#restaurant`;
const WEBSITE_ID = `${SITE_URL}/#website`;
const MENU_ID = `${SITE_URL}/menu#menu`;

const DAYS = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
];

export function restaurantNode(): Record<string, unknown> {
  return {
    '@type': 'Restaurant',
    '@id': RESTAURANT_ID,
    name: BUSINESS.name,
    url: SITE_URL,
    logo: `${SITE_URL}/logo.png`,
    image: [
      `${SITE_URL}/images/hero-cheese-pull.jpg`,
      `${SITE_URL}/images/pizza-cheesy.jpg`,
      `${SITE_URL}/images/burger-stack.jpg`,
    ],
    telephone: BUSINESS.phoneE164,
    servesCuisine: [...BUSINESS.servesCuisine],
    priceRange: BUSINESS.priceRange,
    currenciesAccepted: 'PKR',
    paymentAccepted: 'Cash on Delivery',
    acceptsReservations: false,
    address: {
      '@type': 'PostalAddress',
      streetAddress: BUSINESS.streetAddress,
      addressLocality: BUSINESS.locality,
      addressRegion: BUSINESS.region,
      postalCode: BUSINESS.postalCode,
      addressCountry: BUSINESS.country,
    },
    geo: {
      '@type': 'GeoCoordinates',
      latitude: BUSINESS.latitude,
      longitude: BUSINESS.longitude,
    },
    hasMap: BUSINESS.gbpCid
      ? `https://maps.google.com/?cid=${BUSINESS.gbpCid}`
      : BUSINESS.mapsUrl,
    openingHoursSpecification: [
      {
        '@type': 'OpeningHoursSpecification',
        dayOfWeek: DAYS,
        opens: BUSINESS.openingHours.opens,
        closes: BUSINESS.openingHours.closes,
      },
    ],
    ...(BUSINESS.sameAs.length > 0 ? { sameAs: [...BUSINESS.sameAs] } : {}),
    areaServed: DELIVERY_AREAS.map((a) => ({
      '@type': 'Place',
      name: `${a.name}, Karachi`,
    })),
    menu: `${SITE_URL}/menu`,
    hasMenu: { '@id': MENU_ID },
    potentialAction: {
      '@type': 'OrderAction',
      target: {
        '@type': 'EntryPoint',
        urlTemplate: `${SITE_URL}/menu`,
        actionPlatform: [
          'https://schema.org/DesktopWebPlatform',
          'https://schema.org/MobileWebPlatform',
        ],
      },
      deliveryMethod: ['http://purl.org/goodrelations/v1#DeliveryModeOwnFleet'],
    },
  };
}

export function webSiteNode(): Record<string, unknown> {
  return {
    '@type': 'WebSite',
    '@id': WEBSITE_ID,
    name: BUSINESS.name,
    url: SITE_URL,
    publisher: { '@id': RESTAURANT_ID },
  };
}

/** Menu → MenuSection → MenuItem chain from the POS-published menu. */
export function menuNode(menu: PublishedMenu): Record<string, unknown> {
  const sections = [...menu.categories]
    .sort((a, b) => a.displayOrder - b.displayOrder)
    .filter((c) => c.items.length > 0)
    .map((c) => ({
      '@type': 'MenuSection',
      name: c.name,
      hasMenuItem: [...c.items]
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((item) => ({
          '@type': 'MenuItem',
          name: item.name,
          ...(item.description ? { description: item.description } : {}),
          // Data-URL images from the POS publish are skipped — schema images
          // must be fetchable URLs.
          ...(item.imageUrl && /^https?:\/\//.test(item.imageUrl)
            ? { image: item.imageUrl }
            : {}),
          offers: {
            '@type': 'Offer',
            price: (item.basePriceCents / 100).toFixed(
              item.basePriceCents % 100 === 0 ? 0 : 2,
            ),
            priceCurrency: 'PKR',
            availability: 'https://schema.org/InStock',
          },
        })),
    }));

  return {
    '@type': 'Menu',
    '@id': MENU_ID,
    name: `${BUSINESS.name} Menu`,
    inLanguage: 'en',
    hasMenuSection: sections,
  };
}

export function breadcrumbNode(
  items: Array<{ name: string; path: string }>,
): Record<string, unknown> {
  return {
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: item.name,
      item: `${SITE_URL}${item.path}`,
    })),
  };
}

export function webPageNode(opts: {
  path: string;
  name: string;
  description: string;
  breadcrumb?: Array<{ name: string; path: string }>;
}): Record<string, unknown>[] {
  const pageId = `${SITE_URL}${opts.path}#webpage`;
  const nodes: Record<string, unknown>[] = [
    {
      '@type': 'WebPage',
      '@id': pageId,
      url: `${SITE_URL}${opts.path}`,
      name: opts.name,
      description: opts.description,
      isPartOf: { '@id': WEBSITE_ID },
      about: { '@id': RESTAURANT_ID },
    },
  ];
  if (opts.breadcrumb) nodes.push(breadcrumbNode(opts.breadcrumb));
  return nodes;
}

/** Render nodes as a single `@graph` script tag (server component). */
export function JsonLd({ nodes }: { nodes: Array<Record<string, unknown>> }) {
  const json = JSON.stringify(
    { '@context': 'https://schema.org', '@graph': nodes },
    null,
    0,
  ).replace(/</g, '\\u003c');
  return (
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: json }} />
  );
}
