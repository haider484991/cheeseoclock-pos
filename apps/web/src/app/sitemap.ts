import type { MetadataRoute } from 'next';
import { DELIVERY_AREAS } from '@/lib/areas';
import { SITE_URL } from '@/lib/seo';

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();

  const statics: MetadataRoute.Sitemap = [
    { url: `${SITE_URL}/`, lastModified: now, changeFrequency: 'weekly', priority: 1 },
    { url: `${SITE_URL}/menu`, lastModified: now, changeFrequency: 'daily', priority: 0.9 },
    { url: `${SITE_URL}/delivery`, lastModified: now, changeFrequency: 'monthly', priority: 0.8 },
    { url: `${SITE_URL}/pizza-delivery-dha-karachi`, lastModified: now, changeFrequency: 'monthly', priority: 0.8 },
    { url: `${SITE_URL}/burger-delivery-dha-karachi`, lastModified: now, changeFrequency: 'monthly', priority: 0.8 },
    { url: `${SITE_URL}/late-night-food-delivery-dha`, lastModified: now, changeFrequency: 'monthly', priority: 0.8 },
  ];

  const areas: MetadataRoute.Sitemap = DELIVERY_AREAS.map((a) => ({
    url: `${SITE_URL}/delivery/${a.slug}`,
    lastModified: now,
    changeFrequency: 'monthly',
    priority: 0.7,
  }));

  return [...statics, ...areas];
}
