import type { DrawerSettings, PrinterConnectionConfig } from '@cheeseoclock/shared-types';

/** A saved drawer setting as the form shows it: missing means the usual pin 2, 50 ms. */
export function drawerOf(config: PrinterConnectionConfig | null | undefined): DrawerSettings {
  return {
    pin: config?.drawer?.pin === 5 ? 5 : 2,
    pulseMs: config?.drawer?.pulseMs === 100 ? 100 : 50,
  };
}

/** Whether the form differs from the saved printer (an unpicked USB printer counts as a change). */
export function isChanged(saved: PrinterConnectionConfig, next: PrinterConnectionConfig | null): boolean {
  if (!next) return true;
  const a = drawerOf(saved);
  const b = drawerOf(next);
  return (
    saved.transport !== next.transport ||
    (saved.network?.host ?? '') !== (next.network?.host ?? '') ||
    (saved.network?.port ?? 9100) !== (next.network?.port ?? 9100) ||
    (saved.usb?.printerName ?? '') !== (next.usb?.printerName ?? '') ||
    (saved.width ?? 48) !== (next.width ?? 48) ||
    a.pin !== b.pin ||
    a.pulseMs !== b.pulseMs
  );
}
