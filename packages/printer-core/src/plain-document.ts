/**
 * A plain paper that is not an order (the recipe calculator's prep list) as
 * ESC/POS bytes. Pure, like the receipt renderer: the same document always
 * gives the same bytes.
 *
 * Layout (58 mm / 32 cols):
 *
 *                PREP LIST             <- bold, doubled
 *      27/09 14:05 - Test Manager
 *      --------------------------------
 *      MAKE FIRST (in this order)      <- bold
 *      Pizza Sauce                800 g <- a strong row: bold
 *        1.08 batches of 740 g         <- its notes, indented, wrapped
 *        Tomato                   973 g <- a row inside it (indent 1)
 *      ...
 *      --------------------------------
 *      In stock = this till's own count.
 *
 * Every row goes through the builder's line(): the amount on the right,
 * padded to the width, and a name too long for one row wraps on its own
 * rows with the amount under it — never a row the printer has to break.
 */
import type { PlainDocument, PrinterWidth } from '@cheeseoclock/shared-types';
import { EscPosBuilder, toPrinterAscii as toFit, wrap } from './escpos.js';

export interface RenderPlainDocumentOpts {
  width?: PrinterWidth;
}

export function renderPlainDocument(doc: PlainDocument, opts: RenderPlainDocumentOpts = {}): Uint8Array {
  const width: PrinterWidth = opts.width ?? 48;
  const half = width / 2;
  const b = new EscPosBuilder(width);
  const pad = (n: number) => '  '.repeat(Math.max(0, n));

  b.align('center').bold(true).doubleSize(true).wrappedText(doc.title, half);
  b.doubleSize(false).bold(false);
  for (const s of doc.subtitle) b.wrappedText(s, width);
  b.align('left');

  for (const section of doc.sections) {
    b.rule();
    b.bold(true).wrappedText(section.note ? `${section.heading} (${section.note})` : section.heading, width).bold(false);
    for (const row of section.rows) {
      const lead = pad(row.indent ?? 0);
      if (row.strong) b.bold(true);
      const left = `${lead}${row.text}`;
      if (row.qty && toFit(left).length + 1 + toFit(row.qty).length <= width) {
        b.line(left, row.qty);
      } else {
        // Too long for one row: the name wraps (kept indented), the amount right-aligned under it.
        for (const r of wrap(row.text, width - lead.length)) b.text(lead + r).newline();
        if (row.qty) b.line('', row.qty);
      }
      if (row.strong) b.bold(false);
      const noteLead = pad((row.indent ?? 0) + 1);
      for (const n of row.notes ?? []) {
        for (const r of wrap(n, width - noteLead.length)) b.text(noteLead + r).newline();
      }
    }
  }

  if (doc.footer.length > 0) {
    b.rule();
    for (const f of doc.footer) b.wrappedText(f, width);
  }
  return b.cut().build();
}
