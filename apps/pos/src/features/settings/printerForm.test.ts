import { describe, expect, it } from 'vitest';
import type { PrinterConnectionConfig } from '@cheeseoclock/shared-types';
import { drawerOf, isChanged } from './printerForm';

const usb: PrinterConnectionConfig = { transport: 'usb', usb: { printerName: 'BC-85AC' }, width: 48 };

describe('printer form', () => {
  it('reads a printer saved before the drawer setting as pin 2, 50 ms, opening on every sale', () => {
    expect(drawerOf(usb)).toEqual({ pin: 2, pulseMs: 50, opensOn: 'every_sale' });
    expect(drawerOf(null)).toEqual({ pin: 2, pulseMs: 50, opensOn: 'every_sale' });
    expect(drawerOf({ ...usb, drawer: { pin: 5, pulseMs: 100 } })).toEqual({ pin: 5, pulseMs: 100, opensOn: 'every_sale' });
    expect(drawerOf({ ...usb, drawer: { pin: 2, pulseMs: 50, opensOn: 'cash' } })).toEqual({ pin: 2, pulseMs: 50, opensOn: 'cash' });
  });

  it('a saved printer without a drawer setting equals the form at 2 / 50 ms, every sale', () => {
    expect(isChanged(usb, { ...usb, drawer: { pin: 2, pulseMs: 50 } })).toBe(false);
    expect(isChanged(usb, { ...usb, drawer: { pin: 2, pulseMs: 50, opensOn: 'every_sale' } })).toBe(false);
  });

  it('switching the drawer to cash sales only is an unsaved change', () => {
    expect(isChanged(usb, { ...usb, drawer: { pin: 2, pulseMs: 50, opensOn: 'cash' } })).toBe(true);
    expect(isChanged({ ...usb, drawer: { pin: 2, pulseMs: 50, opensOn: 'cash' } }, { ...usb, drawer: { pin: 2, pulseMs: 50, opensOn: 'cash' } })).toBe(false);
  });

  it('a different pin or pulse is an unsaved change', () => {
    expect(isChanged(usb, { ...usb, drawer: { pin: 5, pulseMs: 50 } })).toBe(true);
    expect(isChanged(usb, { ...usb, drawer: { pin: 2, pulseMs: 100 } })).toBe(true);
    expect(isChanged({ ...usb, drawer: { pin: 5, pulseMs: 100 } }, { ...usb, drawer: { pin: 5, pulseMs: 100 } })).toBe(
      false,
    );
  });

  it('still sees the printer itself change', () => {
    expect(isChanged(usb, { ...usb, usb: { printerName: 'Other' } })).toBe(true);
    expect(isChanged(usb, { ...usb, width: 32 })).toBe(true);
    expect(isChanged(usb, null)).toBe(true);
  });
});
