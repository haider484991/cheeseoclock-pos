/**
 * Settings → Shop & logo → Shop details: the boxes ↔ this till's saved
 * receipt branding (printer:getConfig `branding`). Pure
 * (shopDetailsForm.test.ts).
 *
 * The same branding also holds what other cards save — the Extra lines on
 * receipts card, on this very tab, keeps its lines there — so it reloads
 * when they save. The boxes are refilled only when the Shop details in it
 * changed, never because something else in it did: saving another card must
 * not wipe a tagline or phone typed here and not saved yet.
 */

/** What the Shop details card edits, as printer:getConfig reads it (fields left out are unset). */
export interface SavedShopDetails {
  storeName: string;
  storeTagline?: string | undefined;
  branchLine?: string | undefined;
  phoneLine?: string | undefined;
  websiteLine?: string | undefined;
  footerLine?: string | undefined;
  logoUrl?: string | undefined;
}

/** The boxes, as typed. */
export interface ShopDetailsForm {
  storeName: string;
  storeTagline: string;
  branchLine: string;
  phoneLine: string;
  /** '' = no website (a till that never set one reads the shop's own site). */
  websiteLine: string;
  footerLine: string;
  logoUrl: string | null;
}

export const EMPTY_SHOP_DETAILS: Readonly<ShopDetailsForm> = Object.freeze({
  storeName: '',
  storeTagline: '',
  branchLine: '',
  phoneLine: '',
  websiteLine: '',
  footerLine: '',
  logoUrl: null,
});

/** The boxes filled from what is saved. */
export function shopDetailsFromSaved(saved: SavedShopDetails): ShopDetailsForm {
  return {
    storeName: saved.storeName,
    storeTagline: saved.storeTagline ?? '',
    branchLine: saved.branchLine ?? '',
    phoneLine: saved.phoneLine ?? '',
    websiteLine: saved.websiteLine ?? '',
    footerLine: saved.footerLine ?? '',
    logoUrl: saved.logoUrl ?? null,
  };
}

export function sameShopDetails(a: ShopDetailsForm, b: ShopDetailsForm): boolean {
  return (
    a.storeName === b.storeName &&
    a.storeTagline === b.storeTagline &&
    a.branchLine === b.branchLine &&
    a.phoneLine === b.phoneLine &&
    a.websiteLine === b.websiteLine &&
    a.footerLine === b.footerLine &&
    a.logoUrl === b.logoUrl
  );
}

/** The boxes, and the saved Shop details they were last filled from (null before the first load). */
export interface ShopDetailsDraft {
  form: ShopDetailsForm;
  filledFrom: ShopDetailsForm | null;
}

/**
 * The draft after the saved branding loads or reloads: refilled from it when
 * the saved Shop details changed (the first load, this card's own Save), the
 * same draft back otherwise — whatever else in the branding changed (the
 * Extra lines card's save, a printer card's on another tab).
 */
export function refillShopDetails(draft: ShopDetailsDraft, saved: SavedShopDetails): ShopDetailsDraft {
  const next = shopDetailsFromSaved(saved);
  if (draft.filledFrom !== null && sameShopDetails(draft.filledFrom, next)) return draft;
  return { form: next, filledFrom: next };
}
