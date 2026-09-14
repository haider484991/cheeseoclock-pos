import { describe, expect, it } from 'vitest';
import { rankSystemPrinters } from './system-printer-ranking.js';

describe('rankSystemPrinters', () => {
  it('puts receipt printers first, Windows virtual queues last, default first within a tier', () => {
    const ranked = rankSystemPrinters([
      { name: 'Microsoft Print to PDF', displayName: 'Microsoft Print to PDF', isDefault: true },
      { name: 'HP LaserJet Pro', displayName: 'HP LaserJet Pro', isDefault: false },
      { name: 'OneNote (Desktop)', displayName: 'OneNote (Desktop)', isDefault: false },
      { name: 'BC-85AC G1', displayName: 'BC-85AC G1', isDefault: false },
      { name: 'Fax', displayName: 'Fax', isDefault: false },
      { name: 'POS-80', displayName: 'POS-80 Printer', isDefault: false },
      { name: 'Brother MFC', displayName: 'Brother MFC', isDefault: false },
    ]);
    expect(ranked.map((p) => p.name)).toEqual([
      'BC-85AC G1',
      'POS-80',
      'Brother MFC',
      'HP LaserJet Pro',
      'Microsoft Print to PDF',
      'Fax',
      'OneNote (Desktop)',
    ]);
    expect(ranked.find((p) => p.name === 'BC-85AC G1')?.likelyReceiptPrinter).toBe(true);
    expect(ranked.find((p) => p.name === 'HP LaserJet Pro')?.likelyReceiptPrinter).toBe(false);
    expect(ranked.find((p) => p.name === 'Microsoft Print to PDF')?.isDefault).toBe(true);
  });

  it('recognises the usual ESC/POS names and does not mistake virtual queues for them', () => {
    const likely = (name: string) =>
      rankSystemPrinters([{ name }])[0]?.likelyReceiptPrinter ?? false;
    expect(likely('Black Copper BC-85AC')).toBe(true);
    expect(likely('XP-80C')).toBe(true);
    expect(likely('Xprinter XP-58')).toBe(true);
    expect(likely('EPSON TM-T20III Receipt')).toBe(true);
    expect(likely('Thermal Receipt Printer')).toBe(true);
    expect(likely('POS58 Printer')).toBe(true);
    expect(likely('POS-80')).toBe(true);
    expect(likely('Generic 80mm')).toBe(true);
    expect(likely('HP 8020')).toBe(false);
    expect(likely('Microsoft XPS Document Writer')).toBe(false);
    expect(likely('Send To OneNote 2016')).toBe(false);
    expect(likely('Canon PIXMA')).toBe(false);
  });

  it('falls back to the queue name when there is no display name and drops empty entries', () => {
    const ranked = rankSystemPrinters([
      { name: 'POS-80' },
      { name: '' },
      { name: 'X', displayName: '  ' },
    ]);
    expect(ranked).toEqual([
      { name: 'POS-80', displayName: 'POS-80', isDefault: false, likelyReceiptPrinter: true },
      { name: 'X', displayName: 'X', isDefault: false, likelyReceiptPrinter: false },
    ]);
  });
});
