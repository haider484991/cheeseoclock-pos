import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { shopPhotoFor } from './menu-view';
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
