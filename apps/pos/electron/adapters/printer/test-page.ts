import { paperDateTime, type PrinterWidth } from '@cheeseoclock/shared-types';
import { EscPosBuilder, appendLogo, type TestPageOptions } from '@cheeseoclock/printer-core';

/**
 * A short page to prove the cable, the paper and the ESC/POS path. It names
 * the connection it came through, so a test print from the wrong printer or
 * the wrong setting is obvious on paper. On the receipt printer it starts
 * with the shop logo (when there is a usable one), so the owner can see that
 * this printer prints pictures before a customer gets one.
 */
export function renderTestPage(
  width: PrinterWidth,
  connection = 'not set',
  opts: TestPageOptions = {},
): Uint8Array {
  const b = new EscPosBuilder(width);

  b.align('center');
  appendLogo(b, opts.logo, width);
  // Nobody may take this for a bill: it says so at the top and at the bottom.
  b.align('center')
    .doubleSize(true)
    .bold(true)
    .text('TEST PRINT')
    .newline()
    .doubleSize(false)
    .doubleHeight(true)
    .text('NOT A RECEIPT')
    .newline()
    .doubleHeight(false)
    .bold(false)
    .text('CheeseOclock POS')
    .newline()
    .newline();

  b.align('left').rule();
  const station =
    opts.stationNote ??
    (opts.station === 'kitchen'
      ? 'Station: Kitchen printer'
      : opts.station === 'receipt'
        ? 'Station: Receipt printer'
        : null);
  if (station) b.bold(true).wrappedText(station).bold(false);
  // Pakistan time, day first, like every other paper the till prints.
  b.line('Printed', paperDateTime(new Date()))
    .line('Connection', connection)
    .line('Paper', width === 48 ? '80 mm (48 columns)' : '58 mm (32 columns)');
  if (opts.logoNote) b.line('Logo', opts.logoNote);
  if (opts.logoOnReceipts !== undefined) b.line('Logo on receipts', opts.logoOnReceipts ? 'on' : 'off');
  b.rule().newline();

  b.bold(true)
    .text('Alignment')
    .newline()
    .bold(false)
    .align('left')
    .text('LEFT')
    .newline()
    .align('center')
    .text('CENTER')
    .newline()
    .align('right')
    .text('RIGHT')
    .newline()
    .align('left')
    .newline();

  b.bold(true)
    .text('Styles')
    .newline()
    .bold(false)
    .text('normal ')
    .bold(true)
    .text('bold ')
    .bold(false)
    .underline(true)
    .text('underline')
    .underline(false)
    .newline()
    .doubleSize(true)
    .text('BIG')
    .doubleSize(false)
    .newline()
    .newline();

  b.rule()
    .align('center')
    .wrappedText(
      'If you can read this, the printer is wired correctly. Save the settings, then print a receipt to see the real layout.',
    )
    .newline()
    .bold(true)
    .wrappedText('TEST PRINT - NOT A RECEIPT')
    .bold(false)
    .align('left')
    .cut(true);

  return b.build();
}
