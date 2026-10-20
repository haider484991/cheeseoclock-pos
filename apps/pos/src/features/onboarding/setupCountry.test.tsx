/**
 * First-time setup's country (international edition): asked on a Pixel & Oak
 * till, never on Cheese O'Clock's, and the rest of setup follows the answer.
 *
 * Static renders (react-dom/server, as websiteStep.test.tsx): no browser,
 * nothing calls the till. The Pakistani half pins setup as it was before it
 * asked: the same placeholders, the same tax rows, no country stored.
 */
import { createElement, type ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkedNewShop } from '@cheeseoclock/shared-schemas';
import {
  DEFAULT_STORED_SHOP_LOCALE,
  EDITIONS,
  US_SHOP_LOCALE,
  resetShopLocale,
  setShopLocale,
} from '@cheeseoclock/shared-types';
import { startingTaxRows } from '../menu-mgmt/taxForm';
import { WebsiteStep } from './WebsiteStep';
import { startingWebsiteForm, websiteAnswers, type WebsiteForm } from './websiteStepForm';
import { SETUP_EXAMPLES, startingTaxRowsFor, storedLocaleFor } from './setupCountry';

afterEach(() => {
  resetShopLocale();
  vi.doUnmock('../../edition');
  vi.resetModules();
});

describe('Pakistan: setup as it was before it asked', () => {
  it('keeps every placeholder it showed', () => {
    expect(SETUP_EXAMPLES.PK).toEqual({
      businessName: 'e.g. Karachi Grill House',
      tagline: 'e.g. Pakistani Pizza · Cafe',
      receiptPhone: '+92 51 1234 5678',
      branch: 'F-10 Markaz, Islamabad',
      websiteLine: 'yourshop.pk',
      websitePhone: '0300 1234567',
      street: 'e.g. Shop 2, Main Road, Block 6',
      areaLine: 'e.g. Gulshan-e-Iqbal, Karachi',
      priceRange: 'e.g. PKR 300–1,500',
      taxHelp: "Categories you'll assign per menu item. Pakistani defaults are pre-filled — change them to match your registration.",
    });
  });

  it('starts with the till’s own tax rows, and stores Pakistan time', () => {
    expect(startingTaxRowsFor('PK')).toEqual(startingTaxRows());
    expect(storedLocaleFor('PK', 'America/Chicago')).toBe(DEFAULT_STORED_SHOP_LOCALE);
  });

  it('draws the Website step exactly as before when no country is given', () => {
    const html = renderToStaticMarkup(
      createElement(WebsiteStep, { form: startingWebsiteForm(), problem: null, onChange: () => {} }),
    );
    for (const p of ['0300 1234567', 'e.g. Gulshan-e-Iqbal, Karachi', 'e.g. PKR 300–1,500']) expect(html).toContain(p);
  });
});

describe('the US: setup in the shop’s own terms', () => {
  it('shows US examples on the Website step', () => {
    const html = renderToStaticMarkup(
      createElement(WebsiteStep, {
        form: startingWebsiteForm(),
        problem: null,
        onChange: () => {},
        examples: SETUP_EXAMPLES.US,
      }),
    );
    expect(html).toContain('(415) 555-0123');
    expect(html).toContain('e.g. $10–$40');
    expect(html).not.toContain('Karachi');
    expect(html).not.toContain('PKR');
  });

  it('starts a sales tax row for the owner’s own rate, and stores the zone picked', () => {
    expect(startingTaxRowsFor('US').map((r) => r.name)).toEqual(['Sales tax', 'Not taxed']);
    expect(storedLocaleFor('US', 'America/Chicago')).toEqual({ v: 1, country: 'US', timeZone: 'America/Chicago' });
  });

  it('lets a US shop through the Website step with its own number', () => {
    setShopLocale(US_SHOP_LOCALE);
    const form: WebsiteForm = {
      ...startingWebsiteForm(),
      phone: '(415) 555-0123',
      street: '123 Main St',
      areaLine: 'Springfield, IL',
      postalCode: '62701',
      priceRange: '$10–$40',
    };
    const checked = checkedNewShop('Main Street Pizza', 'Pizza · Wings · Subs', websiteAnswers(form));
    expect(checked.problem).toBeNull();
    expect(checked.value?.['shop.profile'].phone.e164).toBe('+14155550123');
  });

  it('refuses a Pakistani number on a US shop, saying how a US number is written', () => {
    setShopLocale(US_SHOP_LOCALE);
    const form: WebsiteForm = { ...startingWebsiteForm(), phone: '0300 1112233', street: '1 Main St', areaLine: 'X, IL', postalCode: '62701', priceRange: '$' };
    expect(checkedNewShop('Shop', '', websiteAnswers(form)).problem).toBe(
      'Type the shop’s phone number as it is dialled in the US (like (415) 555-0123)',
    );
  });
});

// The first import of the whole setup screen after a module reset transforms its
// full tree (icons, the ui package): seconds, the first time on a cold runner.
describe('who is asked', { timeout: 60_000 }, () => {
  async function setupScreen(edition: 'cheeseoclock' | 'pixelandoak'): Promise<string> {
    vi.resetModules();
    vi.doMock('../../edition', () => ({ EDITION: EDITIONS[edition], APP_NAME: EDITIONS[edition].appName }));
    const { OnboardingPage } = await import('./OnboardingPage');
    const { ToastProvider } = await import('../../components/toast/ToastProvider');
    const tree: ReactElement = createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      createElement(ToastProvider, null, createElement(OnboardingPage, { onComplete: () => {} })),
    );
    return renderToStaticMarkup(tree);
  }

  it("never asks on Cheese O'Clock's till", async () => {
    const html = await setupScreen('cheeseoclock');
    expect(html).not.toContain('data-testid="onboarding-country"');
    expect(html).toContain('Karachi: DHA Phases');
  });

  it('asks on a Pixel & Oak till, starting on Pakistan', async () => {
    const html = await setupScreen('pixelandoak');
    expect(html).toContain('data-testid="onboarding-country"');
    expect(html).toContain('Where is the shop?');
    // Pakistan until the owner says otherwise: the Karachi areas are still offered.
    expect(html).toContain('Karachi: DHA Phases');
  });
});
