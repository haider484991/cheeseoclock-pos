/**
 * The shift report's rules on a till (shared-types shiftReportRules; owner,
 * 2 Oct 2026: the paper prints at every close, the owner's nine section
 * switches in Settings → Printers → Shift report, all on at first). Pure
 * shared-types logic is tested here, where a test runner is.
 */
import { describe, expect, it } from 'vitest';
import { SHIFT_REPORT_SECTIONS, shiftReportRules, type PrintPolicy, type ShiftReportSection } from '@cheeseoclock/shared-types';

const ALL_ON: Record<ShiftReportSection, boolean> = {
  sales: true,
  moneyTaken: true,
  channels: true,
  cancelsRefunds: true,
  drawer: true,
  counted: true,
  unpaid: true,
  items: true,
  orders: true,
};

describe('the shift report’s rules on a till', () => {
  it('nothing saved (a policy from before they existed, or none at all): it prints at every close, every section, every item', () => {
    const first = { onClose: true, sections: ALL_ON, items: 'items' };
    expect(shiftReportRules(undefined)).toEqual(first);
    expect(shiftReportRules(null)).toEqual(first);
    expect(shiftReportRules({})).toEqual(first);
    expect(shiftReportRules({ shiftReportSections: {} })).toEqual(first);
  });

  it('every one of the nine sections is there, in the paper’s order', () => {
    expect(Object.keys(shiftReportRules({}).sections)).toEqual(SHIFT_REPORT_SECTIONS.map((s) => s.key));
    expect(SHIFT_REPORT_SECTIONS).toHaveLength(9);
  });

  it('what is saved: a section switched off is off, the rest stay on', () => {
    const r = shiftReportRules({ shiftReportOnClose: false, shiftReportSections: { orders: false, items: true }, shiftReportItems: 'categories' });
    expect(r).toEqual({ onClose: false, sections: { ...ALL_ON, orders: false }, items: 'categories' });
  });

  it('a value that is not true or false, a section the paper does not have, or another items value reads as the first rules', () => {
    const odd = {
      shiftReportOnClose: 'no',
      shiftReportSections: { orders: 0, sales: 'off', tips: false },
      shiftReportItems: 'none',
    } as unknown as Pick<PrintPolicy, 'shiftReportOnClose' | 'shiftReportSections' | 'shiftReportItems'>;
    const r = shiftReportRules(odd);
    expect(r).toEqual({ onClose: true, sections: ALL_ON, items: 'items' });
    expect(r.sections).not.toHaveProperty('tips');
    expect(shiftReportRules({ shiftReportSections: 'orders' as unknown as Partial<Record<ShiftReportSection, boolean>> }).sections).toEqual(ALL_ON);
  });

  it('a fresh object every time: changing one never changes the next reading', () => {
    const a = shiftReportRules({});
    a.sections.orders = false;
    expect(shiftReportRules({}).sections.orders).toBe(true);
  });
});
