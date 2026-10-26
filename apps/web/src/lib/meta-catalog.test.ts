/** The shop's Meta catalog feed (lib/meta-catalog, 26 Oct 2026): the items with a shop photo, priced as published. */
import { describe, expect, it } from 'vitest';
import type { PublishedMenu, PublishedMenuItem } from '@cheeseoclock/shared-types';
import { catalogCsv, catalogPhotoFor, catalogRows, rowPriceWords } from './meta-catalog';

const item = (id: string, name: string, rs: number, over: Partial<PublishedMenuItem> = {}): PublishedMenuItem => ({
  posItemId: id, name, description: null, basePriceCents: rs * 100, taxRateBps: 1500, imageUrl: null, sortOrder: 0, modifierGroups: [], ...over,
});
const MENU: Pick<PublishedMenu, 'categories'> = {
  categories: [
    { posCategoryId: 'd', name: 'Value Deals', displayOrder: 1, items: [item('mega', 'Mega Cheese Box', 4800, { taxIncluded: true, description: 'Large + Medium, 2 burgers, "fries", drink' }), item('sig', 'Signature Cripsy Deal', 950, { taxIncluded: true })] },
    { posCategoryId: 's', name: 'Signature Pizzas', displayOrder: 2, items: [item('sh-l', 'Shawarma Pizza — Large', 2200)] },
    { posCategoryId: 'p', name: 'Pizza', displayOrder: 3, items: [item('faj-l', 'Fajita Pizza — Large', 2000)] },
    { posCategoryId: 'x', name: 'Delivery Charges', displayOrder: 9, items: [item('del', 'Delivery Charge (Rs 200)', 200)] },
  ],
};

describe('Meta catalog feed', () => {
  it('lists the items with a photo — the website’s, the till’s old deal spelling too, then the catalog’s own', () => {
    const rows = catalogRows(MENU, 'Cheese O’Clock');
    expect(rows.map((r) => [r.id, r.image_link])).toEqual([
      ['mega', 'https://www.cheeseoclock.net/images/catalog/mega-cheese-box.jpg'],
      ['sig', 'https://www.cheeseoclock.net/images/catalog/signature-crispy.jpg'],
      ['sh-l', 'https://www.cheeseoclock.net/images/catalog/shawarma-pizza.jpg'],
      ['faj-l', 'https://www.cheeseoclock.net/images/catalog/fajita-pizza.jpg'],
    ]);
    expect(rows[0]).toMatchObject({ price: '4800.00 PKR', availability: 'in stock', condition: 'new', brand: 'Cheese O’Clock', link: 'https://www.cheeseoclock.net/menu?deal=mega-cheese-box' });
    expect(rows[0]!.description).toContain('Tax included.');
    expect(rows[2]!.description).toContain('Plus tax.');
    expect(rowPriceWords(rows[0]!)).toBe('Rs 4,800');
    expect(catalogPhotoFor('Soft Drink — 345 ml')).toBe('https://www.cheeseoclock.net/images/catalog/soft-drink-345-ml.jpg');
    expect(catalogPhotoFor('Veggie Lovers — Large')).toBe('https://www.cheeseoclock.net/images/catalog/veggie-lovers.jpg');
    expect(catalogPhotoFor('Mystery Special — Large')).toBeNull();
  });

  it('writes CSV Meta reads: a header, and a cell with a comma or quote quoted', () => {
    const csv = catalogCsv(catalogRows(MENU, 'Shop'));
    const lines = csv.trim().split('\n');
    expect(lines[0]).toBe('id,title,description,availability,condition,price,link,image_link,brand');
    expect(lines[1]).toContain('"Large + Medium, 2 burgers, ""fries"", drink Value Deals. Tax included. Order on WhatsApp: send ""menu""."');
    expect(lines).toHaveLength(5);
  });
});
