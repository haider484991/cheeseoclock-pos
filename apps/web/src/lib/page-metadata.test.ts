/**
 * The pages that print fees, as Next sees them: static and refreshed from the
 * owner's settings (ISR), and — with no settings block — the same titles,
 * descriptions and canonicals as v0.7.26 (the golden copy).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import golden from './__fixtures__/site-copy-v0.7.26.json';

beforeAll(() => {
  // No database: the pages read the built-in areas and fees, as at a build without one.
  delete process.env['DATABASE_URL'];
});

describe('the fee pages', () => {
  it('are static, refreshed at least hourly (ISR)', async () => {
    const pages = await Promise.all([
      import('@/app/page'),
      import('@/app/delivery/page'),
      import('@/app/delivery/[area]/page'),
      import('@/app/late-night-food-delivery-dha/page'),
      import('@/app/pizza-delivery-dha-karachi/page'),
      import('@/app/burger-delivery-dha-karachi/page'),
    ]);
    for (const p of pages) {
      expect(p.dynamic).toBe('force-static');
      expect(p.revalidate).toBe(3600);
    }
  });

  it('keep every area page’s slug, title, description and canonical', async () => {
    const area = await import('@/app/delivery/[area]/page');
    expect(area.generateStaticParams()).toEqual(golden.areas.map((a) => ({ area: a.slug })));
    expect(area.dynamicParams).toBe(false);
    for (const g of golden.areas) {
      expect(await area.generateMetadata({ params: { area: g.slug } })).toEqual({
        title: g.title,
        description: g.description,
        alternates: { canonical: `/delivery/${g.slug}` },
        openGraph: {
          title: `${g.title} · Cheese O'Clock`,
          description: g.description,
          url: `/delivery/${g.slug}`,
          type: 'website',
        },
      });
    }
  });

  it('keeps the delivery hub’s title, description and canonical', async () => {
    const hub = await import('@/app/delivery/page');
    expect(await hub.generateMetadata()).toEqual({
      title: 'Food Delivery Areas in DHA & Clifton, Karachi',
      description: golden.pages.deliveryHubDescription,
      alternates: { canonical: '/delivery' },
    });
  });
});
