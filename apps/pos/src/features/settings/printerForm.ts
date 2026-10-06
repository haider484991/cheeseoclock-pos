import type { DrawerSettings, PrinterConnectionConfig } from '@cheeseoclock/shared-types';
import { DEFAULT_DRAWER_OPENS_ON } from '@cheeseoclock/shared-types';

/**
 * A saved drawer setting as the form shows it: missing means the usual pin 2,
 * 50 ms, and (0052) opening on every sale — card and wallet sales too.
 */
export function drawerOf(config: PrinterConnectionConfig | null | undefined): Required<DrawerSettings> {
  return {
    pin: config?.drawer?.pin === 5 ? 5 : 2,
    pulseMs: config?.drawer?.pulseMs === 100 ? 100 : 50,
    opensOn: config?.drawer?.opensOn === 'cash' ? 'cash' : DEFAULT_DRAWER_OPENS_ON,
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
    a.pulseMs !== b.pulseMs ||
    a.opensOn !== b.opensOn
  );
}
