/**
 * The shop's lines on the receipt shown after Pay, from this till's receipt
 * branding (Settings → Shop & logo), the way the paper prints them: the
 * shop's name and tagline on top, the thank-you line and the owner's extra
 * lines at the bottom. It used to say "CheeseOclock", "Pakistani Pizza •
 * Cafe" and "Thank you — visit us again!" whatever was saved.
 *
 * With nothing saved the till answers its own defaults (the name "Cheese O
 * Clock", no tagline) and the thank-you line is the paper's default. Until
 * the till has answered, the name and tagline are left off rather than
 * showing a name that may be wrong.
 */
import { DEFAULT_FOOTER_LINE, receiptExtraLines } from '@cheeseoclock/printer-core';

export interface ReceiptDialogBranding {
  storeName: string;
  storeTagline?: string;
  footerLine?: string;
  extraLines?: readonly string[];
}

export function receiptDialogShop(branding: ReceiptDialogBranding | null | undefined): {
  name: string | null;
  tagline: string | null;
  thanks: string;
  extraLines: string[];
} {
  return {
    name: branding?.storeName.trim() || null,
    tagline: branding?.storeTagline?.trim() || null,
    thanks: branding?.footerLine?.trim() || DEFAULT_FOOTER_LINE,
    extraLines: branding ? receiptExtraLines(branding) : [],
  };
}
