/**
 * Settings → Shop & logo → Shop details: what is typed survives a save of
 * another card. The Extra lines card (same tab) keeps its lines in the same
 * receipt branding, so saving it reloads that branding; up to the first
 * review of the settings polish, that refilled every Shop details box and
 * threw away a tagline or phone typed and not yet saved. Every name is
 * made up.
 */
import { describe, expect, it } from 'vitest';
import {
  EMPTY_SHOP_DETAILS,
  refillShopDetails,
  sameShopDetails,
  shopDetailsFromSaved,
  type ShopDetailsDraft,
} from './shopDetailsForm';

const SAVED = {
  storeName: 'Test Pizza Shop',
  storeTagline: 'Test tagline',
  branchLine: 'Test Street 1',
  phoneLine: '0300 0000000',
  websiteLine: 'test.example',
  footerLine: 'Test thanks',
  logoUrl: 'data:image/png;base64,AAAA',
};

const firstLoad = (saved: Parameters<typeof refillShopDetails>[1]): ShopDetailsDraft =>
  refillShopDetails({ form: EMPTY_SHOP_DETAILS, filledFrom: null }, saved);
/** The branding as printer:getConfig returns it, with the Extra lines card's lines in it. */
const withLines = (lines: string[]) => ({ ...SAVED, extraLines: lines });

describe('Shop details: the boxes and the saved branding', () => {
  it('first load fills every box from what is saved; what is not saved reads as empty', () => {
    expect(firstLoad(SAVED).form).toEqual({ ...SAVED });
    expect(firstLoad({ storeName: 'Test Pizza Shop' }).form).toEqual({
      storeName: 'Test Pizza Shop',
      storeTagline: '',
      branchLine: '',
      phoneLine: '',
      websiteLine: '',
      footerLine: '',
      logoUrl: null,
    });
  });

  it('saving the Extra lines card (same branding, new lines) keeps what is typed and not saved', () => {
    const loaded = firstLoad(withLines([]));
    const typed: ShopDetailsDraft = { ...loaded, form: { ...loaded.form, storeTagline: 'Typed tagline', phoneLine: '0311 1111111' } };
    const after = refillShopDetails(typed, withLines(['Insta @test.example']));
    expect(after.form.storeTagline).toBe('Typed tagline');
    expect(after.form.phoneLine).toBe('0311 1111111');
    // Still "Not saved yet": the typed boxes differ from what is saved.
    expect(sameShopDetails(after.form, shopDetailsFromSaved(SAVED))).toBe(false);
    // Nothing changed at all: the same draft back (no re-render).
    expect(after).toBe(typed);
  });

  it('a printer card saved on another tab (same branding back) keeps it too', () => {
    const loaded = firstLoad(SAVED);
    const typed: ShopDetailsDraft = { ...loaded, form: { ...loaded.form, footerLine: 'Typed thanks' } };
    expect(refillShopDetails(typed, { ...SAVED }).form.footerLine).toBe('Typed thanks');
  });

  it('a change to the saved Shop details themselves (this card’s own Save) refills the boxes', () => {
    const loaded = firstLoad(SAVED);
    const typed: ShopDetailsDraft = { ...loaded, form: { ...loaded.form, storeTagline: 'New tagline ' } };
    const after = refillShopDetails(typed, { ...SAVED, storeTagline: 'New tagline' });
    expect(after.form).toEqual({ ...SAVED, storeTagline: 'New tagline' });
    expect(sameShopDetails(after.form, shopDetailsFromSaved({ ...SAVED, storeTagline: 'New tagline' }))).toBe(true);
  });

  it('the logo taken off counts as a change of the Shop details', () => {
    const loaded = firstLoad(SAVED);
    const { logoUrl: _gone, ...noLogo } = SAVED;
    expect(refillShopDetails(loaded, noLogo).form.logoUrl).toBeNull();
  });
});
