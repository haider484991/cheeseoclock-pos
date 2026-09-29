/**
 * The one change sweep B2 makes to a page with NOTHING new stored, spelled
 * out against the goldens taken before it (pages-v0.7.30.json,
 * home-page-v0.7.29.json): with the menu UNKNOWN — no database (a build or a
 * preview without DATABASE_URL), or none published — the prices the home and
 * landing pages printed from a hand-typed copy are gone (there is no price
 * typed anywhere to fall back on), and their sentences say it without one.
 * Every other byte stays. With a menu published at today's prices every page
 * is the golden exactly (pages-golden.test.ts states b and c).
 *
 * Each replacement names the exact markup it removes and must find it (an
 * edit that stops matching fails the test instead of passing quietly).
 */

type Swap = readonly [find: RegExp | string, replace: string, times: number];

const PRICE = 'Rs [\\d,]+';

/** The home page: the price badges, the deals' saving, worth and price, the hero's "from" chip. */
const HOME: readonly Swap[] = [
  // The signatures grid's price badge (5 pizzas + the burger).
  [new RegExp(`<span class="absolute left-4 top-4 rounded-full bg-cheese px-3 py-1 font-cond text-sm font-extrabold text-ink">${PRICE}</span>`, 'g'), '', 6],
  // The deals' Save badge, struck-through worth and price (3 deals).
  [
    new RegExp(
      `<span class="absolute right-4 top-4 -rotate-6 [^"]*"><span class="block text-\\[0\\.65rem\\] tracking-widest">Save</span><span class="mt-0\\.5 block text-lg">${PRICE}</span></span>`,
      'g',
    ),
    '',
    3,
  ],
  [new RegExp(`<span class="block text-sm text-cream/45 line-through">${PRICE}</span>`, 'g'), '', 3],
  [new RegExp(`<span class="block font-display text-4xl tracking-wide text-cheese">${PRICE}</span>`, 'g'), '', 3],
  // The hero's chip: still there (the deals are), without a price.
  [new RegExp(`Value deals from ${PRICE} →`, 'g'), 'Value deals →', 1],
  // The 3D carousel's price badge for the front pizza.
  [new RegExp(`<span class="rounded-full bg-cheese px-4 py-1\\.5 font-cond text-lg font-extrabold text-ink">${PRICE}</span>`, 'g'), '', 1],
];

/** Each landing page's price lines, as their `otherwise` words. */
const LANDING: Readonly<Record<string, readonly Swap[]>> = {
  '/pizza-delivery-dha-karachi': [
    [new RegExp(`>From ${PRICE}<`, 'g'), '>Value deals<', 1],
    ['>Value deals · 1 litre soft drink<', '>1 litre soft drink<', 1],
    [new RegExp(`dips are ${PRICE} each\\.`, 'g'), 'dips cost extra.', 1],
  ],
  '/burger-delivery-dha-karachi': [
    [new RegExp(`>${PRICE} – ${PRICE}<`, 'g'), '>Mild to Nashville hot<', 1],
    [new RegExp(`Add cheese to any burger for ${PRICE}\\.`, 'g'), 'Add cheese to any burger.', 1],
    [new RegExp(`>From ${PRICE}<`, 'g'), '>Fries, nuggets &amp; wings<', 1],
    [new RegExp(`Add cheese to any of them for ${PRICE}\\.`, 'g'), 'Add cheese to any of them.', 1],
  ],
  '/late-night-food-delivery-dha': [[new RegExp(`>Large · from ${PRICE}<`, 'g'), '>Masala · Mayo Masala<', 1]],
};

function apply(html: string, swaps: readonly Swap[], where: string): string {
  let out = html;
  for (const [find, replace, times] of swaps) {
    const re = typeof find === 'string' ? new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g') : find;
    const found = out.match(re)?.length ?? 0;
    if (found !== times) throw new Error(`${where}: expected ${times} of ${re} in the golden, found ${found}`);
    out = out.replace(re, replace);
  }
  return out;
}

/** The routes whose HTML the menu being unknown changes. */
export const MENU_PRICED_ROUTES: readonly string[] = ['/', ...Object.keys(LANDING)];

/** A golden page's HTML as B2 serves it with the menu unknown (unchanged for every other route). */
export function htmlWithMenuUnknown(route: string, html: string): string {
  if (route === '/') return apply(html, HOME, route);
  const swaps = LANDING[route];
  return swaps ? apply(html, swaps, route) : html;
}

// ---------------------------------------------------------------------------
// The home page's element tree (website-messages.test.ts `tree`)
// ---------------------------------------------------------------------------

interface TreeEl {
  type: string;
  key: unknown;
  props: Record<string, unknown>;
}
const isEl = (n: unknown): n is TreeEl => !!n && typeof n === 'object' && 'type' in n && 'props' in n;

/** Price markup the menu being unknown removes (className → what it is). */
const GONE_CLASSES = new Set([
  'absolute left-4 top-4 rounded-full bg-cheese px-3 py-1 font-cond text-sm font-extrabold text-ink',
  'block text-sm text-cream/45 line-through',
  'block font-display text-4xl tracking-wide text-cheese',
]);
const isGone = (n: unknown): boolean =>
  isEl(n) &&
  typeof n.props['className'] === 'string' &&
  (GONE_CLASSES.has(n.props['className']) || (n.props['className'] as string).startsWith('absolute right-4 top-4 -rotate-6 '));

/**
 * The v0.7.29 home page's element tree as B2 renders it with the menu
 * unknown: the same removals as the HTML above (the carousel is a component
 * there, its insides not part of the tree). Counts how many it made.
 */
export function homeTreeWithMenuUnknown(tree: unknown): { tree: unknown; removed: number; chips: number } {
  let removed = 0;
  let chips = 0;
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) {
      const kept = node.filter((c) => {
        if (isGone(c)) removed += 1;
        return !isGone(c);
      });
      return kept.map(walk);
    }
    if (!isEl(node)) return node;
    const props: Record<string, unknown> = { ...node.props };
    const children = props['children'];
    if (
      Array.isArray(children) &&
      children.length === 3 &&
      children[0] === 'Value deals from ' &&
      typeof children[1] === 'string' &&
      /^Rs [\d,]+$/.test(children[1]) &&
      children[2] === ' →'
    ) {
      chips += 1;
      props['children'] = 'Value deals →';
    } else if ('children' in props) {
      if (isGone(children)) {
        removed += 1;
        delete props['children'];
      } else props['children'] = walk(children);
    }
    return { ...node, props };
  };
  return { tree: walk(tree), removed, chips };
}
