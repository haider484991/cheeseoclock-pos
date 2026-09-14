import type { PrinterWidth } from '@cheeseoclock/shared-types';
import { EscPosBuilder } from '@cheeseoclock/printer-core';

/**
 * A short page to prove the cable, the paper and the ESC/POS path. It names
 * the connection it came through, so a test print from the wrong printer or
 * the wrong setting is obvious on paper.
 */
export function renderTestPage(width: PrinterWidth, connection = 'not set'): Uint8Array {
  const b = new EscPosBuilder(width);

  b.align('center')
    .doubleSize(true)
    .bold(true)
    .text('TEST PAGE')
    .newline()
    .doubleSize(false)
    .bold(false)
    .text('CheeseOclock POS')
    .newline()
    .newline();

  b.align('left')
    .rule()
    .line('Printed', formatLocal(new Date()))
    .line('Connection', connection)
    .line('Paper', width === 48 ? '80 mm (48 columns)' : '58 mm (32 columns)')
    .rule()
    .newline();

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
    .align('left')
    .cut(true);

  return b.build();
}

function formatLocal(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
