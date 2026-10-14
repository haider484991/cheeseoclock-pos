/**
 * The home hero gained one thing after the golden copies were taken (14 Oct
 * 2026, the user: "on the home page in hero section there should be
 * beautiful slider of our deals"): the deals slider
 * (components/HeroDealsClient), first in the hero, straight after its two
 * drawn layers and before its grid. The home page as served today is the
 * golden with exactly that inserted — its slides worked out from the same
 * menu by lib/hero-deals — and nothing else; with no deal on the menu, or
 * the menu unknown, nothing is inserted and the page is the golden.
 */
import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  DEFAULT_BUY_1_GET_1_RULES,
  type Buy1Get1Rules,
  type PublishedMenu,
} from '@cheeseoclock/shared-types';
import { HeroDealsClient } from '@/components/HeroDealsClient';
import { heroSlides } from '@/lib/hero-deals';

/** Where the hero begins: its section and its two drawn layers (the slider goes straight after them). */
export const HERO_OPEN =
  '<section class="relative overflow-hidden bg-ink"><div aria-hidden="true" class="absolute inset-0 bg-[radial-gradient(ellipse_at_72%_45%,rgba(245,179,1,0.16),transparent_58%)]"></div><div aria-hidden="true" class="absolute inset-0 opacity-[0.07] [background-image:repeating-linear-gradient(90deg,#F5B301_0_1px,transparent_1px_90px)]"></div>';

/** The slider as the home page renders it for this menu ('' = none: the menu unknown, or no deal on it). */
export function heroDealsHtml(
  menu: Pick<PublishedMenu, 'categories'> | null,
  buy1Get1: Pick<Buy1Get1Rules, 'on' | 'opensMinute' | 'closesMinute'> = DEFAULT_BUY_1_GET_1_RULES,
): string {
  const slides = heroSlides(menu, { buy1Get1 });
  return slides.length === 0
    ? ''
    : renderToStaticMarkup(React.createElement(HeroDealsClient, { slides }));
}

/** The golden home page with this slider inserted first in the hero (its start must be found exactly once). */
export function withHeroDeals(html: string, sliderHtml: string): string {
  if (sliderHtml === '') return html;
  const found = html.split(HERO_OPEN).length - 1;
  if (found !== 1) throw new Error(`the hero's start is in the page ${found} times, not once`);
  return html.replace(HERO_OPEN, () => HERO_OPEN + sliderHtml);
}

/**
 * The same as a home page ELEMENT tree (website-messages.test.ts compares the
 * page's own elements, not their HTML): one element more, <HeroDeals />, first
 * in the hero's children after its two drawn layers — always there (it renders
 * nothing without deals). The hero must be found exactly once.
 */
export function homeTreeWithHeroDeals(tree: unknown): unknown {
  const copy = structuredClone(tree);
  let found = 0;
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    const el = node as { type?: unknown; props?: { className?: unknown; children?: unknown } };
    if (
      el.type === 'section' &&
      el.props?.className === 'relative overflow-hidden bg-ink' &&
      Array.isArray(el.props.children)
    ) {
      found += 1;
      el.props.children.splice(2, 0, { type: 'HeroDeals', key: null, props: {} });
      return;
    }
    for (const value of Object.values(node as Record<string, unknown>)) visit(value);
  };
  visit(copy);
  if (found !== 1) throw new Error(`the hero is in the tree ${found} times, not once`);
  return copy;
}
