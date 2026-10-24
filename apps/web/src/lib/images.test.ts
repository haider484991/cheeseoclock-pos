import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { dealPhotoFor, shopPhotoFor } from './menu-view';
import { menuImageSrcSet } from './images';
import { CURATED_DISH_NAMES } from './signatures';

describe('menuImageSrcSet', () => {
  it('offers the 400px copy of a shop photo', () => {
    expect(menuImageSrcSet('/images/menu/cheesy-star.webp')).toBe(
      '/images/menu/sm/cheesy-star.webp 400w, /images/menu/cheesy-star.webp 720w',
    );
  });

  it('leaves till photos and anything else alone', () => {
    expect(menuImageSrcSet('data:image/png;base64,AAAA')).toBeUndefined();
    expect(menuImageSrcSet('https://example.com/x.webp')).toBeUndefined();
    expect(menuImageSrcSet(null)).toBeUndefined();
  });

  it('offers the 400px copy of a deal photo', () => {
    expect(menuImageSrcSet('/images/deals/burger-duo.webp')).toBe(
      '/images/deals/sm/burger-duo.webp 400w, /images/deals/burger-duo.webp 720w',
    );
  });

  it('has both sizes on disk for every deal photo, under the till names old and new', () => {
    const names = [
      'Mega Cheese Box', 'Double Large', 'Pizzas & Nuggets', 'Loaded Combo', 'Large & Chilled', 'Cheese Partners',
      'Burger Duo', 'Classic Crispy Deal', 'Signature Cripsy Deal', 'Cheese Dipped Deal', 'Large + Free Medium',
      'Large + Free Burger or Side', 'Medium + Free Side', 'Big Two', 'Family Feast', 'Perfect Pair',
    ];
    for (const name of names) {
      const src = dealPhotoFor(name);
      expect(src, name).not.toBeNull();
      for (const file of [src!, menuImageSrcSet(src)!.split(' ')[0]!]) {
        expect(existsSync(new URL(`../../public${file}`, import.meta.url)), file).toBe(true);
      }
    }
    expect(dealPhotoFor('Margherita')).toBeNull();
  });

  it('has a small copy on disk for every photo the site shows', () => {
    // Every dish the home page has curated words for has a shop photo (the home page's lineup).
    const photos = [
      ...CURATED_DISH_NAMES.map((name) => shopPhotoFor(name)),
      shopPhotoFor('shawarma pizza'),
      shopPhotoFor('signature cheese dipped'),
    ];
    for (const src of photos) {
      const set = menuImageSrcSet(src);
      expect(set, src ?? 'null').toBeDefined();
      const small = set!.split(' ')[0]!;
      expect(existsSync(new URL(`../../public${small}`, import.meta.url)), small).toBe(true);
    }
  });
});
