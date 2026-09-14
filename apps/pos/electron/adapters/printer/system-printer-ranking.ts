import type { SystemPrinterInfo } from '@cheeseoclock/shared-types';

/**
 * Orders the OS printer list for the settings picker so the receipt printer
 * is at the top and "Microsoft Print to PDF" is at the bottom. Pure so it can
 * be tested; the Electron call that produces the raw list lives in
 * services/system-printers.ts.
 */

export interface RawSystemPrinter {
  name: string;
  displayName?: string;
  isDefault?: boolean;
}

// Queues Windows installs on its own that can never be a receipt printer.
const VIRTUAL_QUEUE = /print to pdf|xps|onenote|fax|send to|microsoft|adobe pdf|foxit/i;

// Names the common 58/80 mm ESC/POS printers give themselves. Black Copper
// (BC-85AC etc.), XPrinter, Epson TM series, Citizen, Bixolon, Star, and the
// generic "POS-80" / "Thermal Receipt" that no-name drivers register as.
const RECEIPT_LIKE =
  /\bpos(?:-?\d+)?\b|receipt|thermal|black ?copper|\bbc-?\d|x-?printer|xp-?\d|epson|\btm-?[a-z]?\d|citizen|bixolon|star\b|rongta|\brp-?\d|(?<![a-z\d])(?:58|80)(?!\d)|\bzj-?\d|goojprt|sunmi/i;

export function rankSystemPrinters(list: RawSystemPrinter[]): SystemPrinterInfo[] {
  const ranked = list
    .filter((p) => typeof p.name === 'string' && p.name.length > 0)
    .map((p) => {
      const label = `${p.name} ${p.displayName ?? ''}`;
      const virtual = VIRTUAL_QUEUE.test(label);
      return {
        name: p.name,
        displayName: p.displayName?.trim() || p.name,
        isDefault: p.isDefault === true,
        likelyReceiptPrinter: !virtual && RECEIPT_LIKE.test(label),
        tier: !virtual && RECEIPT_LIKE.test(label) ? 0 : virtual ? 2 : 1,
      };
    });
  ranked.sort(
    (a, b) =>
      a.tier - b.tier ||
      Number(b.isDefault) - Number(a.isDefault) ||
      a.displayName.localeCompare(b.displayName),
  );
  return ranked.map(({ tier: _tier, ...info }) => info);
}
