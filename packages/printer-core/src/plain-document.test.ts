import { describe, expect, it } from 'vitest';
import type { PlainDocument } from '@cheeseoclock/shared-types';
import { CUT_MARKER, decodeEscPos, escPosToText } from './escpos-decode.js';
import { renderPlainDocument } from './plain-document.js';

// A made-up prep list: every name and amount here is invented.
const DOC: PlainDocument = {
  title: 'PREP LIST',
  subtitle: ['27 Sep 2026, 14:05 - Test Manager'],
  sections: [
    { heading: 'FOR', rows: [{ text: '10 x Fajita Pizza — Large', strong: true, notes: [] }, { text: '7 x Large: Fajita', indent: 1 }] },
    {
      heading: 'MAKE FIRST',
      note: 'in this order',
      rows: [
        { text: 'Pizza Sauce', qty: '800 g', strong: true, notes: ['1.08 batches of 740 g', 'SHORT 400 g (in stock 400 g)'] },
        { text: 'Tomato', qty: '973 g', indent: 1 },
        { text: 'A very long ingredient name that cannot share a row', qty: '1.234 kg', indent: 1 },
      ],
    },
    { heading: 'EVERYTHING FROM SCRATCH', note: 'each batch made once, in full', rows: [{ text: 'Jalapeño', qty: '12 pcs' }] },
  ],
  footer: ["In stock = this till's own count."],
};

describe('renderPlainDocument: a prep list on the receipt printer', () => {
  for (const width of [32, 48] as const) {
    it(`${width} columns: every row fits, amounts on the right, notes indented, then a cut`, () => {
      const lines = decodeEscPos(renderPlainDocument(DOC, { width }));
      for (const l of lines) expect(l.text.length * l.scale).toBeLessThanOrEqual(width);
      const text = escPosToText(renderPlainDocument(DOC, { width }));
      expect(text).toContain('PREP LIST');
      expect(text).toContain('27 Sep 2026, 14:05 - Test');
      expect(text).toContain('MAKE FIRST (in this order)');
      expect(text).toMatch(new RegExp(`^Pizza Sauce {${width - 'Pizza Sauce'.length - '800 g'.length}}800 g$`, 'm'));
      expect(text).toMatch(/^ {2}Tomato +973 g$/m);
      expect(text).toMatch(/^ {2}SHORT 400 g \(in stock/m);
      // Printed as the printer can: the em dash in plain ASCII, the ñ without its accent.
      expect(text).toContain('10 x Fajita Pizza - Large');
      expect(text).toContain('Jalapeno');
      expect(text).not.toContain('?');
      // Too long to share a row: the name wraps, kept indented, the amount under it.
      expect(text).toMatch(/^ {2}A very long/m);
      expect(text).toMatch(/^ +1\.234 kg$/m);
      expect(text.trim().endsWith(CUT_MARKER)).toBe(true);
      expect(text).not.toMatch(/Rs\b/);
    });
  }

  it('is 80 mm unless told otherwise', () => {
    expect(renderPlainDocument(DOC)).toEqual(renderPlainDocument(DOC, { width: 48 }));
  });
});
