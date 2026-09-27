/**
 * The price screens (costing spec Phase 4) render what they are given: a
 * smoke render (react-dom/server, no browser) of the "Set price" boxes, the
 * source chip and change mark, and the small price line. Nothing calls the
 * till. Every price is made up.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PriceFields, WorkedOutFromRecipe } from './SetPriceDialog';
import { ChangeMark, SourceChip } from './PriceHistoryDrawer';
import { PriceLineChart } from '../reports/charts';
import type { Ingredient, UUID } from '@cheeseoclock/shared-types';
import { SheetCell } from './IngredientsTab';
import { COSTING_FILE_NOTE, SHEET_SAYS_NOTE } from './costing-file';

const noop = () => {};

describe('"Set price" boxes', () => {
  it('a weighed ingredient: per kg or per pack, and what the price works out to', () => {
    const html = renderToStaticMarkup(
      <PriceFields unit="g" entry={{ per: 'thousand', rupees: '375', packSize: '', guess: false, free: false }} onChange={noop} idPrefix="t" />,
    );
    expect(html).toContain('Per kg');
    expect(html).toContain('Per pack');
    expect(html).not.toContain('Per piece');
    expect(html).toContain('Price (Rs) per kg');
    expect(html).toContain('= Rs 375 / kg');
  });

  it('a pack: how much one pack holds, and a guess says it stays on Missing costs', () => {
    const html = renderToStaticMarkup(
      <PriceFields unit="g" entry={{ per: 'pack', rupees: '2250', packSize: '6000', guess: true, free: false }} onChange={noop} idPrefix="t" />,
    );
    expect(html).toContain('One pack holds (g)');
    expect(html).toContain('= Rs 375 / kg (a guess');
  });

  it('pieces; a problem in plain words; nothing typed on "Add ingredient" is "no price yet"', () => {
    const piece = renderToStaticMarkup(
      <PriceFields unit="pcs" entry={{ per: 'piece', rupees: '0', packSize: '', guess: false, free: false }} onChange={noop} idPrefix="t" />,
    );
    expect(piece).toContain('Per piece');
    expect(piece).toContain('Rs 0 is no price: tick &quot;Free&quot; if it costs nothing.');
    const empty = renderToStaticMarkup(
      <PriceFields unit="pcs" entry={{ per: 'piece', rupees: '', packSize: '', guess: false, free: false }} onChange={noop} idPrefix="t" optional />,
    );
    expect(empty).toContain('No price yet');
  });
});

describe('"Set price" on a batch costed from its recipe', () => {
  it('no price boxes: it says the price is worked out from the batch recipe, and how to change it', () => {
    const html = renderToStaticMarkup(<WorkedOutFromRecipe name="Test cheese mix" />);
    expect(html).toContain('<strong>Test cheese mix</strong> is made here, so its price is worked out from its batch recipe');
    expect(html).toContain('set the price of what goes into it, or change its recipe');
    expect(html).not.toContain('<input');
  });
});

describe('where a price came from, and its change', () => {
  it('chips in the owner’s words; dearer is ▲, cheaper ▼', () => {
    expect(renderToStaticMarkup(<SourceChip source="delivery" />)).toContain('>Bill<');
    expect(renderToStaticMarkup(<SourceChip source="import" />)).toContain('>Sheet<');
    expect(renderToStaticMarkup(<SourceChip source="seed" />)).toContain('>Starting price<');
    expect(renderToStaticMarkup(<ChangeMark prevUnitCostMc={37_500} unitCostMc={41_250} priceKind="set" />)).toContain('▲ 10%');
    expect(renderToStaticMarkup(<ChangeMark prevUnitCostMc={40_000} unitCostMc={30_000} priceKind="set" />)).toContain('▼ 25%');
    expect(renderToStaticMarkup(<ChangeMark prevUnitCostMc={null} unitCostMc={30_000} priceKind="set" />)).toBe('');
  });

  it('the price line: one step per change, the latest price at the end', () => {
    const html = renderToStaticMarkup(
      <PriceLineChart
        ariaLabel="Test cheese: price over time"
        now={Date.parse('2026-09-27T00:00:00.000Z')}
        points={[
          { at: Date.parse('2026-09-01T00:00:00.000Z'), value: 120_000, label: 'Rs 1,200 / kg' },
          { at: Date.parse('2026-09-15T00:00:00.000Z'), value: 132_000, label: 'Rs 1,320 / kg' },
        ]}
      />,
    );
    expect(html).toContain('aria-label="Test cheese: price over time"');
    expect((html.match(/<circle/g) ?? []).length).toBe(2);
    expect(html).toContain('Rs 1,320 / kg');
    expect(html).toContain('today');
  });
});

describe('"Sheet says" (costing spec Phase 6)', () => {
  const ing = (p: Partial<Ingredient> = {}): Ingredient => ({
    id: 'id-cheese' as UUID,
    name: 'Test cheese',
    category: 'other',
    categoryAuto: true,
    unit: 'g',
    currentQty: 0,
    lowThreshold: 0,
    costPerUnitCents: 130,
    packSize: 2000,
    packPriceCents: 260_000,
    priceKind: 'set',
    batchYield: null,
    batchMethod: null,
    defaultSupplierId: null,
    sku: null,
    notes: null,
    isActive: true,
    countWeekly: false,
    latestPrice: {
      source: 'delivery',
      effectiveAt: '2026-09-20T08:00:00.000Z',
      unit: 'g',
      packSize: 2000,
      packPriceCents: 260_000,
      priceKind: 'set',
      unitCostMc: 130_000,
      prevUnitCostMc: 120_000,
    },
    priceFromRecipe: false,
    sheetPrice: { packSize: 1000, packPriceCents: 110_000, priceKind: 'set', unitCostMc: 110_000, at: '2026-09-21T08:00:00.000Z' },
    ...p,
  });

  it("offers the sheet's price quietly beside a bill's price, plainly beside a typed one; a recipe's batch says it in words", () => {
    const bill = renderToStaticMarkup(<SheetCell ingredient={ing()} busy={false} onUse={noop} />);
    expect(bill).toContain('Rs 1,100 / kg');
    expect(bill).toContain('Use the sheet&#x27;s price');
    expect(bill).toContain('border-stone-300');
    expect(bill).not.toContain('bg-violet-100');
    const typed = renderToStaticMarkup(<SheetCell ingredient={ing({ latestPrice: { ...ing().latestPrice!, source: 'manual' } })} busy={false} onUse={noop} />);
    expect(typed).toContain('bg-violet-100');
    const batch = renderToStaticMarkup(<SheetCell ingredient={ing({ priceFromRecipe: true })} busy={false} onUse={noop} />);
    expect(batch).toContain('reference only (made here)');
    expect(batch).not.toContain('<button');
    expect(batch).not.toContain('title=');
  });

  it('the handoff and what the column means are words on the screen, not tooltips', () => {
    expect(COSTING_FILE_NOTE).toMatch(/whoever keeps the costing workbook/);
    expect(COSTING_FILE_NOTE).toMatch(/nothing to run/);
    expect(SHEET_SAYS_NOTE).toMatch(/Only a reference/);
  });
});
